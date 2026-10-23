import {
  HalfDuplexScheduler,
  MANUAL_COMMAND_APPROVAL,
  SERIAL_FRAME_DELIMITER,
  SerialFrameIdCounter,
  SerialFrameReader,
  decodeLoRaPayload,
  encodeLoRaMessage,
  encodeSerialFrame,
  rejectReasonFor,
  type BridgeFault,
  type LoRaDecodeErrorCode,
  type LoRaPayloadCodec,
  type RadioScheduleConfig,
  type SerialDecodeErrorCode,
  type SerialFrame,
  type SerialFrameType,
  type SerialRejectReason,
  type TxResultOutcome,
} from '@robolime/shared';

import type { Database } from '../db/connection';
import { handleUplink, type AckDraft, type UplinkResult } from './uplink';

export type SessionEvent =
  | { type: 'serial_error'; code: SerialDecodeErrorCode; frameId: number | null }
  | { type: 'bridge_hello'; buildId: string }
  | { type: 'bridge_fault'; fault: BridgeFault; count: number }
  | { type: 'bridge_rejected_frame'; refFrameId: number | null; reason: SerialRejectReason }
  | { type: 'pong'; refFrameId: number }
  | { type: 'unexpected_frame'; frameType: SerialFrameType }
  | { type: 'lora_rejected'; code: LoRaDecodeErrorCode; rssiDbm: number }
  | { type: 'uplink'; result: UplinkResult; rssiDbm: number; snrTenthsDb: number }
  /** SQLite write failed: nothing acknowledged, the robot keeps the record and retries. */
  | { type: 'storage_failed'; error: string }
  /** The codec refused to encode a downlink (e.g. the byte layout is unsigned). */
  | { type: 'downlink_blocked'; key: string; error: string }
  | { type: 'tx_result'; key: string; outcome: TxResultOutcome };

export interface SessionOutput {
  /** Serial frames to write to the port, in order. */
  outgoing: Uint8Array[];
  events: SessionEvent[];
}

export interface BridgeSessionOptions {
  db: Database;
  codec: LoRaPayloadCodec;
  schedule: RadioScheduleConfig;
  hostBuildId: string;
}

/**
 * Protocol core of the laptop ⇄ gateway-ESP32 link: serial bytes in, serial
 * bytes out. It owns no port and no timers — the Phase 4 service connects it
 * to `serialport` and calls `poll` on a timer — so every rule here is
 * testable with plain byte arrays.
 *
 * Ordering guarantee: a STORAGE_ACK is queued only after `handleUplink`
 * returned, i.e. after the SQLite commit. Manual commands have no path
 * through this class: they are not approved (D21).
 */
export class BridgeProtocolSession {
  private readonly reader = new SerialFrameReader();
  private readonly frameIds = new SerialFrameIdCounter();
  private readonly scheduler: HalfDuplexScheduler<AckDraft>;
  /** Serial frame id of each LORA_TX → scheduler key, to match LORA_TX_RESULT. */
  private readonly txFrames = new Map<number, string>();
  private loraMessageId = 0;

  constructor(private readonly options: BridgeSessionOptions) {
    this.scheduler = new HalfDuplexScheduler(options.schedule);
  }

  get pendingDownlinks(): number {
    return this.scheduler.pending;
  }

  private frame(message: SerialFrame['message']): Uint8Array {
    return encodeSerialFrame({ frameId: this.frameIds.take(), message });
  }

  /** Call when the port (re)opens: drops partial input, forgets in-flight radio state, greets the bridge. */
  open(): Uint8Array[] {
    this.reader.reset();
    this.scheduler.resetLink();
    this.txFrames.clear();
    // A lone delimiter terminates any partial frame left in the bridge's buffer.
    return [Uint8Array.of(SERIAL_FRAME_DELIMITER), this.frame({ type: 'HELLO', role: 'host', buildId: this.options.hostBuildId })];
  }

  receive(chunk: Uint8Array, now: Date): SessionOutput {
    const out: SessionOutput = { outgoing: [], events: [] };
    for (const event of this.reader.push(chunk)) {
      if (event.kind === 'error') {
        out.events.push({ type: 'serial_error', code: event.error.code, frameId: event.error.frameId });
        out.outgoing.push(this.frame({ type: 'FRAME_REJECTED', refFrameId: event.error.frameId, reason: rejectReasonFor(event.error.code) }));
        continue;
      }
      this.handleFrame(event.frame, now, out);
    }
    this.drain(now, out);
    return out;
  }

  /** Transmits queued downlinks whose response window is open. Call periodically. */
  poll(now: Date): SessionOutput {
    const out: SessionOutput = { outgoing: [], events: [] };
    this.drain(now, out);
    return out;
  }

  private handleFrame(frame: SerialFrame, now: Date, out: SessionOutput): void {
    const m = frame.message;
    switch (m.type) {
      case 'HELLO':
        if (m.role === 'bridge') out.events.push({ type: 'bridge_hello', buildId: m.buildId });
        else out.events.push({ type: 'unexpected_frame', frameType: m.type });
        return;
      case 'PONG':
        out.events.push({ type: 'pong', refFrameId: m.refFrameId });
        return;
      case 'BRIDGE_FAULT':
        out.events.push({ type: 'bridge_fault', fault: m.fault, count: m.count });
        return;
      case 'FRAME_REJECTED': {
        out.events.push({ type: 'bridge_rejected_frame', refFrameId: m.refFrameId, reason: m.reason });
        const key = m.refFrameId === null ? undefined : this.txFrames.get(m.refFrameId);
        if (key !== undefined && m.refFrameId !== null) {
          this.txFrames.delete(m.refFrameId);
          out.events.push({ type: 'tx_result', key, outcome: this.scheduler.onTransmissionResult(key, 'RADIO_ERROR') });
        }
        return;
      }
      case 'LORA_TX_RESULT': {
        const key = this.txFrames.get(m.refFrameId);
        if (key === undefined) {
          out.events.push({ type: 'unexpected_frame', frameType: m.type });
          return;
        }
        this.txFrames.delete(m.refFrameId);
        out.events.push({ type: 'tx_result', key, outcome: this.scheduler.onTransmissionResult(key, m.result) });
        return;
      }
      case 'LORA_RX':
        this.handleRadioPacket(m.radioPayload, m.rssiDbm, m.snrTenthsDb, now, out);
        return;
      case 'PING':
      case 'LORA_TX':
        out.events.push({ type: 'unexpected_frame', frameType: m.type });
        return;
    }
  }

  private handleRadioPacket(payload: Uint8Array, rssiDbm: number, snrTenthsDb: number, now: Date, out: SessionOutput): void {
    const decoded = decodeLoRaPayload(this.options.codec, payload, 'uplink');
    if (!decoded.ok) {
      out.events.push({ type: 'lora_rejected', code: decoded.code, rssiDbm });
      return;
    }
    // The robot listens right after any uplink it sent, whatever its kind.
    this.scheduler.onUplinkReceived(now.getTime());
    let result: UplinkResult;
    try {
      result = handleUplink(this.options.db, decoded.message, now);
    } catch (error) {
      out.events.push({ type: 'storage_failed', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    out.events.push({ type: 'uplink', result, rssiDbm, snrTenthsDb });
    if ((result.kind === 'reading_stored' || result.kind === 'reading_rejected') && result.ack) {
      const a = result.ack;
      this.scheduler.enqueue(`ack:${a.robotId}:${a.runId}:${a.cellIndex}:${a.seq}`, 'storage_ack', a);
    }
  }

  private drain(now: Date, out: SessionOutput): void {
    for (let next = this.scheduler.next(now.getTime()); next; next = this.scheduler.next(now.getTime())) {
      let radioPayload: Uint8Array;
      try {
        radioPayload = encodeLoRaMessage(this.options.codec, { ...next.item, messageId: this.loraMessageId }, MANUAL_COMMAND_APPROVAL);
      } catch (error) {
        this.scheduler.discard(next.key);
        out.events.push({ type: 'downlink_blocked', key: next.key, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      this.loraMessageId += 1;
      const frameId = this.frameIds.take();
      this.txFrames.set(frameId, next.key);
      out.outgoing.push(encodeSerialFrame({ frameId, message: { type: 'LORA_TX', radioPayload } }));
    }
  }
}
