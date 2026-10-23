/**
 * USB serial contract, version 1 — laptop (TypeScript gateway) ⇄ gateway ESP32.
 *
 * The laptop never talks to the Ra-02 directly: the gateway ESP32 drives the
 * radio over SPI and relays radio payloads to the laptop over USB serial. This
 * contract is owned by the software team (it is not the robot's packet
 * format) and is PROPOSED until the bridge firmware implements it and a
 * hardware loopback test passes (OPEN_ITEMS #19). Radio payloads cross it as
 * opaque bytes, so it is independent of the unsigned LoRa byte layout.
 *
 * Frame on the wire:  COBS( header | payload | crc16 )  0x00
 *
 *   offset  size  field
 *   0       1     version          (frozen at offset 0 in every version)
 *   1       1     frame type
 *   2       2     frame id, uint16 LE (per sender, wraps 0..0xFFFE)
 *   4       2     payload length, uint16 LE
 *   6       n     payload
 *   6+n     2     CRC-16/CCITT-FALSE of bytes 0..5+n, uint16 LE (frozen)
 *
 * Because the version byte and CRC trailer never move, any receiver can
 * detect a version mismatch reliably and answer FRAME_REJECTED.
 */
import { cobsDecode, cobsEncode, cobsMaxEncodedLength } from './cobs';
import { crc16CcittFalse } from './crc16';
import { LORA_MAX_PAYLOAD_BYTES } from './lora';

export const SERIAL_PROTOCOL_VERSION = 1;
export const SERIAL_FRAME_DELIMITER = 0x00;
export const SERIAL_HEADER_BYTES = 6;
export const SERIAL_CRC_BYTES = 2;
export const SERIAL_MAX_PAYLOAD_BYTES = 512;
export const SERIAL_MAX_UNSTUFFED_FRAME_BYTES = SERIAL_HEADER_BYTES + SERIAL_MAX_PAYLOAD_BYTES + SERIAL_CRC_BYTES;
export const SERIAL_MAX_STUFFED_FRAME_BYTES = cobsMaxEncodedLength(SERIAL_MAX_UNSTUFFED_FRAME_BYTES);
/** Reserved: "frame id unknown" in FRAME_REJECTED. Counters never emit it. */
export const SERIAL_NO_FRAME_ID = 0xffff;
/** rssi int16 + snr int16 + bridge uptime uint32, before the radio payload. */
export const LORA_RX_METADATA_BYTES = 8;
export const SERIAL_BUILD_ID_MAX_BYTES = 32;

export const SERIAL_FRAME_TYPE_CODES = {
  HELLO: 0x01,
  PING: 0x02,
  PONG: 0x03,
  LORA_RX: 0x10,
  LORA_TX: 0x11,
  LORA_TX_RESULT: 0x12,
  BRIDGE_FAULT: 0x20,
  FRAME_REJECTED: 0x7f,
} as const;
export type SerialFrameType = keyof typeof SERIAL_FRAME_TYPE_CODES;

/** What the bridge reports after a LORA_TX request. SENT means "left the antenna", not "robot received". */
export const LORA_TX_RESULT_CODES = {
  SENT: 0,
  CHANNEL_BUSY_RX: 1,
  RADIO_ERROR: 2,
  REJECTED_TOO_LARGE: 3,
  TX_TIMEOUT: 4,
} as const;
export type LoRaTxResult = keyof typeof LORA_TX_RESULT_CODES;

export const BRIDGE_FAULT_CODES = {
  RADIO_INIT_FAILED: 1,
  RADIO_RX_OVERFLOW: 2,
  SERIAL_RX_OVERFLOW: 3,
  RADIO_CRC_ERROR: 4,
} as const;
export type BridgeFault = keyof typeof BRIDGE_FAULT_CODES;

export const SERIAL_REJECT_REASON_CODES = {
  BAD_CRC: 1,
  UNSUPPORTED_VERSION: 2,
  UNKNOWN_TYPE: 3,
  BAD_LENGTH: 4,
  MALFORMED_PAYLOAD: 5,
  OVERSIZED: 6,
  COBS_INVALID: 7,
} as const;
export type SerialRejectReason = keyof typeof SERIAL_REJECT_REASON_CODES;

export type SerialMessage =
  /** Both directions, first frame after the port opens. */
  | { type: 'HELLO'; role: 'host' | 'bridge'; buildId: string }
  /** Host → bridge liveness probe (USB link only; says nothing about the radio). */
  | { type: 'PING' }
  | { type: 'PONG'; refFrameId: number }
  /** Bridge → host: one radio packet as received, with link metadata. */
  | { type: 'LORA_RX'; rssiDbm: number; snrTenthsDb: number; bridgeUptimeMs: number; radioPayload: Uint8Array }
  /** Host → bridge: transmit these radio bytes once. The bridge never retries on its own. */
  | { type: 'LORA_TX'; radioPayload: Uint8Array }
  | { type: 'LORA_TX_RESULT'; refFrameId: number; result: LoRaTxResult }
  | { type: 'BRIDGE_FAULT'; fault: BridgeFault; count: number }
  | { type: 'FRAME_REJECTED'; refFrameId: number | null; reason: SerialRejectReason };

export interface SerialFrame {
  frameId: number;
  message: SerialMessage;
}

export class SerialEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialEncodeError';
  }
}

const HELLO_ROLES = { host: 1, bridge: 2 } as const;

function codeOf<K extends string>(table: Readonly<Record<K, number>>, key: K): number {
  return table[key];
}

function keyOf<K extends string>(table: Readonly<Record<K, number>>, code: number): K | null {
  for (const key of Object.keys(table) as K[]) if (table[key] === code) return key;
  return null;
}

const isUint16 = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffff;
const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

function assertRadioPayload(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > LORA_MAX_PAYLOAD_BYTES) {
    throw new SerialEncodeError(`radio payload must be 1..${LORA_MAX_PAYLOAD_BYTES} bytes, got ${bytes.length}`);
  }
}

function encodePayload(message: SerialMessage): Uint8Array {
  switch (message.type) {
    case 'HELLO': {
      if (message.buildId.length > SERIAL_BUILD_ID_MAX_BYTES || !isPrintableAscii(message.buildId)) {
        throw new SerialEncodeError(`buildId must be printable ASCII, at most ${SERIAL_BUILD_ID_MAX_BYTES} bytes`);
      }
      const out = new Uint8Array(1 + message.buildId.length);
      out[0] = HELLO_ROLES[message.role];
      for (let i = 0; i < message.buildId.length; i++) out[1 + i] = message.buildId.charCodeAt(i);
      return out;
    }
    case 'PING':
      return new Uint8Array(0);
    case 'PONG':
    case 'LORA_TX_RESULT':
    case 'FRAME_REJECTED': {
      const ref = message.type === 'FRAME_REJECTED' ? (message.refFrameId ?? SERIAL_NO_FRAME_ID) : message.refFrameId;
      if (!isUint16(ref)) throw new SerialEncodeError('refFrameId must be a uint16');
      const out = new Uint8Array(message.type === 'PONG' ? 2 : 3);
      const view = new DataView(out.buffer);
      view.setUint16(0, ref, true);
      if (message.type === 'LORA_TX_RESULT') out[2] = codeOf(LORA_TX_RESULT_CODES, message.result);
      if (message.type === 'FRAME_REJECTED') out[2] = codeOf(SERIAL_REJECT_REASON_CODES, message.reason);
      return out;
    }
    case 'LORA_RX': {
      assertRadioPayload(message.radioPayload);
      const { rssiDbm, snrTenthsDb, bridgeUptimeMs } = message;
      const int16 = (n: number) => Number.isInteger(n) && n >= -0x8000 && n <= 0x7fff;
      if (!int16(rssiDbm) || !int16(snrTenthsDb) || !Number.isInteger(bridgeUptimeMs) || bridgeUptimeMs < 0 || bridgeUptimeMs > 0xffffffff) {
        throw new SerialEncodeError('LORA_RX metadata out of range');
      }
      const out = new Uint8Array(LORA_RX_METADATA_BYTES + message.radioPayload.length);
      const view = new DataView(out.buffer);
      view.setInt16(0, rssiDbm, true);
      view.setInt16(2, snrTenthsDb, true);
      view.setUint32(4, bridgeUptimeMs, true);
      out.set(message.radioPayload, LORA_RX_METADATA_BYTES);
      return out;
    }
    case 'LORA_TX':
      assertRadioPayload(message.radioPayload);
      return message.radioPayload.slice();
    case 'BRIDGE_FAULT': {
      if (!isUint16(message.count)) throw new SerialEncodeError('fault count must be a uint16');
      const out = new Uint8Array(3);
      out[0] = codeOf(BRIDGE_FAULT_CODES, message.fault);
      new DataView(out.buffer).setUint16(1, message.count, true);
      return out;
    }
  }
}

/** Builds the stuffed frame including the trailing 0x00 delimiter, ready to write to the port. */
export function encodeSerialFrame(frame: SerialFrame): Uint8Array {
  if (!Number.isInteger(frame.frameId) || frame.frameId < 0 || frame.frameId >= SERIAL_NO_FRAME_ID) {
    throw new SerialEncodeError('frameId must be in 0..0xFFFE');
  }
  const payload = encodePayload(frame.message);
  if (payload.length > SERIAL_MAX_PAYLOAD_BYTES) throw new SerialEncodeError('payload too large');

  const raw = new Uint8Array(SERIAL_HEADER_BYTES + payload.length + SERIAL_CRC_BYTES);
  const view = new DataView(raw.buffer);
  raw[0] = SERIAL_PROTOCOL_VERSION;
  raw[1] = SERIAL_FRAME_TYPE_CODES[frame.message.type];
  view.setUint16(2, frame.frameId, true);
  view.setUint16(4, payload.length, true);
  raw.set(payload, SERIAL_HEADER_BYTES);
  view.setUint16(SERIAL_HEADER_BYTES + payload.length, crc16CcittFalse(raw, 0, SERIAL_HEADER_BYTES + payload.length), true);

  const stuffed = cobsEncode(raw);
  const out = new Uint8Array(stuffed.length + 1);
  out.set(stuffed);
  out[stuffed.length] = SERIAL_FRAME_DELIMITER;
  return out;
}

export type SerialDecodeErrorCode =
  | 'COBS_INVALID'
  | 'TOO_SHORT'
  | 'BAD_CRC'
  | 'UNSUPPORTED_VERSION'
  | 'BAD_LENGTH'
  | 'UNKNOWN_TYPE'
  | 'MALFORMED_PAYLOAD'
  | 'OVERSIZED';

export interface SerialDecodeError {
  code: SerialDecodeErrorCode;
  /** Known only once the CRC has verified the header. */
  frameId: number | null;
  detail: string;
}

export type SerialDecodeResult = { ok: true; frame: SerialFrame } | { ok: false; error: SerialDecodeError };

/** Maps a decode error onto the reason a FRAME_REJECTED reply carries. */
export function rejectReasonFor(code: SerialDecodeErrorCode): SerialRejectReason {
  return code === 'TOO_SHORT' ? 'BAD_LENGTH' : code;
}

function decodePayload(type: SerialFrameType, p: Uint8Array): SerialMessage | string {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  switch (type) {
    case 'HELLO': {
      if (p.length < 1 || p.length > 1 + SERIAL_BUILD_ID_MAX_BYTES) return 'HELLO length';
      const role = keyOf(HELLO_ROLES, p[0] ?? 0);
      if (!role) return 'HELLO role';
      let buildId = '';
      for (let i = 1; i < p.length; i++) {
        const c = p[i] ?? 0;
        if (c < 0x20 || c > 0x7e) return 'HELLO buildId not printable ASCII';
        buildId += String.fromCharCode(c);
      }
      return { type, role, buildId };
    }
    case 'PING':
      return p.length === 0 ? { type } : 'PING must be empty';
    case 'PONG':
      return p.length === 2 ? { type, refFrameId: view.getUint16(0, true) } : 'PONG length';
    case 'LORA_RX': {
      const n = p.length - LORA_RX_METADATA_BYTES;
      if (n < 1 || n > LORA_MAX_PAYLOAD_BYTES) return 'LORA_RX radio payload length';
      return {
        type,
        rssiDbm: view.getInt16(0, true),
        snrTenthsDb: view.getInt16(2, true),
        bridgeUptimeMs: view.getUint32(4, true),
        radioPayload: p.slice(LORA_RX_METADATA_BYTES),
      };
    }
    case 'LORA_TX':
      return p.length >= 1 && p.length <= LORA_MAX_PAYLOAD_BYTES ? { type, radioPayload: p.slice() } : 'LORA_TX length';
    case 'LORA_TX_RESULT': {
      if (p.length !== 3) return 'LORA_TX_RESULT length';
      const result = keyOf(LORA_TX_RESULT_CODES, p[2] ?? 0xff);
      return result ? { type, refFrameId: view.getUint16(0, true), result } : 'LORA_TX_RESULT code';
    }
    case 'BRIDGE_FAULT': {
      if (p.length !== 3) return 'BRIDGE_FAULT length';
      const fault = keyOf(BRIDGE_FAULT_CODES, p[0] ?? 0);
      return fault ? { type, fault, count: view.getUint16(1, true) } : 'BRIDGE_FAULT code';
    }
    case 'FRAME_REJECTED': {
      if (p.length !== 3) return 'FRAME_REJECTED length';
      const reason = keyOf(SERIAL_REJECT_REASON_CODES, p[2] ?? 0);
      const ref = view.getUint16(0, true);
      return reason ? { type, refFrameId: ref === SERIAL_NO_FRAME_ID ? null : ref, reason } : 'FRAME_REJECTED reason';
    }
  }
}

/** Decodes one stuffed frame (delimiter already removed). Checks CRC before trusting any header field. */
export function decodeSerialFrame(stuffed: Uint8Array): SerialDecodeResult {
  const fail = (code: SerialDecodeErrorCode, detail: string, frameId: number | null = null): SerialDecodeResult => ({
    ok: false,
    error: { code, frameId, detail },
  });
  if (stuffed.length > SERIAL_MAX_STUFFED_FRAME_BYTES) return fail('OVERSIZED', `${stuffed.length} stuffed bytes`);
  const raw = cobsDecode(stuffed);
  if (!raw) return fail('COBS_INVALID', 'invalid byte stuffing');
  if (raw.length < SERIAL_HEADER_BYTES + SERIAL_CRC_BYTES) return fail('TOO_SHORT', `${raw.length} bytes`);

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const bodyEnd = raw.length - SERIAL_CRC_BYTES;
  if (view.getUint16(bodyEnd, true) !== crc16CcittFalse(raw, 0, bodyEnd)) return fail('BAD_CRC', 'checksum mismatch');

  const frameId = view.getUint16(2, true);
  const version = raw[0] ?? 0;
  if (version !== SERIAL_PROTOCOL_VERSION) return fail('UNSUPPORTED_VERSION', `version ${version}`, frameId);
  const declared = view.getUint16(4, true);
  if (declared !== bodyEnd - SERIAL_HEADER_BYTES) {
    return fail('BAD_LENGTH', `declared ${declared}, actual ${bodyEnd - SERIAL_HEADER_BYTES}`, frameId);
  }
  if (declared > SERIAL_MAX_PAYLOAD_BYTES) return fail('OVERSIZED', `payload ${declared} bytes`, frameId);
  const type = keyOf(SERIAL_FRAME_TYPE_CODES, raw[1] ?? 0);
  if (!type) return fail('UNKNOWN_TYPE', `type 0x${(raw[1] ?? 0).toString(16)}`, frameId);

  const message = decodePayload(type, raw.subarray(SERIAL_HEADER_BYTES, bodyEnd));
  if (typeof message === 'string') return fail('MALFORMED_PAYLOAD', message, frameId);
  return { ok: true, frame: { frameId, message } };
}

export type SerialReadEvent = { kind: 'frame'; frame: SerialFrame } | { kind: 'error'; error: SerialDecodeError };

/**
 * Turns arbitrary serial chunks into frames. Handles partial frames split
 * across reads, several frames in one read, empty frames (repeated 0x00, used
 * to resynchronise), and runaway input: a frame that grows past the maximum
 * is reported once as OVERSIZED and discarded up to the next delimiter, so
 * memory use is bounded.
 */
export class SerialFrameReader {
  private readonly buffer = new Uint8Array(SERIAL_MAX_STUFFED_FRAME_BYTES);
  private length = 0;
  private discarding = false;

  push(chunk: Uint8Array): SerialReadEvent[] {
    const events: SerialReadEvent[] = [];
    for (const byte of chunk) {
      if (byte === SERIAL_FRAME_DELIMITER) {
        if (!this.discarding && this.length > 0) {
          const result = decodeSerialFrame(this.buffer.subarray(0, this.length));
          events.push(result.ok ? { kind: 'frame', frame: result.frame } : { kind: 'error', error: result.error });
        }
        this.discarding = false;
        this.length = 0;
        continue;
      }
      if (this.discarding) continue;
      if (this.length === this.buffer.length) {
        this.discarding = true;
        this.length = 0;
        events.push({ kind: 'error', error: { code: 'OVERSIZED', frameId: null, detail: 'no delimiter within the maximum frame size' } });
        continue;
      }
      this.buffer[this.length++] = byte;
    }
    return events;
  }

  /** Bytes held for an incomplete frame. */
  get pendingBytes(): number {
    return this.length;
  }

  /** Drops any partial frame; call when the port is (re)opened. */
  reset(): void {
    this.length = 0;
    this.discarding = false;
  }
}

/** Per-sender frame id: 0..0xFFFE, wrapping; never the reserved 0xFFFF. */
export class SerialFrameIdCounter {
  private nextId: number;
  constructor(start = 0) {
    this.nextId = start % SERIAL_NO_FRAME_ID;
  }
  take(): number {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) % SERIAL_NO_FRAME_ID;
    return id;
  }
}
