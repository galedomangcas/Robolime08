import {
  SERIAL_FRAME_DELIMITER,
  SerialFrameIdCounter,
  SerialFrameReader,
  encodeSerialFrame,
  type LoRaTxResult,
  type SerialFrame,
} from '@robolime/shared';

import { TransportClosedError, type ByteTransport, type ByteTransportHandlers } from './byteTransport';

/**
 * SIMULATION-ONLY stand-in for the gateway ESP32 bridge on the far end of
 * the USB cable. It is not a model of real USB behaviour (reset on open,
 * flow control and driver chunking are unconfirmed, OPEN_ITEMS #19).
 *
 * - `deliver(bytes)` plays robot → bridge → laptop bytes (e.g. LORA_RX frames
 *   from `toBridgeStream`), in whatever chunks the caller chooses.
 * - Every complete LORA_TX frame the laptop writes is answered with a
 *   LORA_TX_RESULT (`txResult`, default SENT). Like a real bridge, replies
 *   are only inserted between complete frames, never inside a partly
 *   delivered one.
 * - Faults can be scripted: failed opens, failed or held writes, disconnects.
 */
export class SimulatedBridgeTransport implements ByteTransport {
  readonly kind = 'simulation' as const;
  /** Every complete frame the laptop wrote, decoded, in order (all connections). */
  readonly hostFrames: SerialFrame[] = [];
  /** Every completed write's bytes, in order (includes the lone resync delimiter, which is not a frame). */
  readonly rawWrites: Uint8Array[] = [];
  /** Successful opens so far. */
  opens = 0;
  txResult: LoRaTxResult = 'SENT';
  autoReplyToTx = true;

  private handlers: ByteTransportHandlers | null = null;
  private readonly reader = new SerialFrameReader();
  private readonly frameIds = new SerialFrameIdCounter();
  private openFailuresLeft = 0;
  private writeFailuresLeft = 0;
  private holding = false;
  private readonly held: { bytes: Uint8Array; resolve: () => void; reject: (error: Error) => void }[] = [];
  /** True while the last delivered chunk ended inside a frame. */
  private midFrame = false;
  private readonly pendingReplies: Uint8Array[] = [];

  get isOpen(): boolean {
    return this.handlers !== null;
  }

  /** Writes currently held by `holdWrites()`. */
  get heldWrites(): number {
    return this.held.length;
  }

  failNextOpens(count: number): void {
    this.openFailuresLeft = count;
  }

  failNextWrites(count: number): void {
    this.writeFailuresLeft = count;
  }

  /** Writes stay pending until `releaseWrites()` (a slow or stalled USB driver). */
  holdWrites(): void {
    this.holding = true;
  }

  releaseWrites(): void {
    this.holding = false;
    for (const w of this.held.splice(0)) {
      this.accept(w.bytes);
      w.resolve();
    }
  }

  open(handlers: ByteTransportHandlers): Promise<void> {
    if (this.openFailuresLeft > 0) {
      this.openFailuresLeft -= 1;
      return Promise.reject(new Error('simulated open failure'));
    }
    this.handlers = handlers;
    this.reader.reset();
    this.midFrame = false;
    this.pendingReplies.length = 0;
    this.opens += 1;
    return Promise.resolve();
  }

  write(bytes: Uint8Array): Promise<void> {
    if (!this.handlers) return Promise.reject(new TransportClosedError('simulated transport is not open'));
    if (this.writeFailuresLeft > 0) {
      this.writeFailuresLeft -= 1;
      return Promise.reject(new Error('simulated write failure'));
    }
    if (this.holding) {
      return new Promise((resolve, reject) => this.held.push({ bytes: Uint8Array.from(bytes), resolve, reject }));
    }
    this.accept(bytes);
    return Promise.resolve();
  }

  /** Robot/bridge → laptop bytes. Ignored while closed (bytes on an unplugged cable are lost). */
  deliver(chunk: Uint8Array): void {
    if (!this.handlers) return;
    this.handlers.onData(chunk);
    if (chunk.length > 0) this.midFrame = chunk[chunk.length - 1] !== SERIAL_FRAME_DELIMITER;
    if (!this.midFrame) this.flushReplies();
  }

  /** Simulates the cable being pulled or the driver failing. */
  disconnect(error: Error | null = null): void {
    const handlers = this.handlers;
    if (!handlers) return;
    this.detach();
    handlers.onClose(error);
  }

  close(): Promise<void> {
    this.detach();
    return Promise.resolve();
  }

  private detach(): void {
    this.handlers = null;
    this.pendingReplies.length = 0;
    for (const w of this.held.splice(0)) w.reject(new TransportClosedError('simulated transport closed'));
  }

  private accept(bytes: Uint8Array): void {
    this.rawWrites.push(Uint8Array.from(bytes));
    for (const event of this.reader.push(bytes)) {
      if (event.kind !== 'frame') continue;
      this.hostFrames.push(event.frame);
      if (event.frame.message.type === 'LORA_TX' && this.autoReplyToTx) {
        const reply = encodeSerialFrame({
          frameId: this.frameIds.take(),
          message: { type: 'LORA_TX_RESULT', refFrameId: event.frame.frameId, result: this.txResult },
        });
        // Asynchronous, as from a real device; never inside a partly delivered frame.
        queueMicrotask(() => {
          if (!this.handlers) return;
          if (this.midFrame) this.pendingReplies.push(reply);
          else this.handlers.onData(reply);
        });
      }
    }
  }

  private flushReplies(): void {
    for (const reply of this.pendingReplies.splice(0)) this.handlers?.onData(reply);
  }
}
