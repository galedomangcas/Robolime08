/**
 * Byte transport between the laptop gateway and the gateway ESP32 bridge
 * (Phase 4, milestone 3; decision D31).
 *
 * The bridge runtime only sees this interface. In this build the ONLY
 * implementation is the in-memory `SimulatedBridgeTransport`; no serial-port
 * adapter exists, because the bridge hardware, USB details and firmware are
 * not confirmed (OPEN_ITEMS #19). A future serial adapter must declare
 * `kind: 'hardware'`, and the runtime refuses hardware while the radio
 * schedule and wire codec are unconfirmed (OPEN_ITEMS #1, #20).
 */
export type TransportKind = 'simulation' | 'hardware';

export interface ByteTransportHandlers {
  /** Bytes as the driver delivered them: any chunking, frames may be split or merged. */
  onData(chunk: Uint8Array): void;
  /**
   * The connection ended without `close()` being called (unplugged, driver
   * error). Never called after `close()`.
   */
  onClose(error: Error | null): void;
}

export interface ByteTransport {
  readonly kind: TransportKind;
  readonly isOpen: boolean;
  /** Connects; resolves once bytes can flow, rejects if the connection cannot be made. May be called again after a close. */
  open(handlers: ByteTransportHandlers): Promise<void>;
  /** Resolves once the bytes were handed to the driver; rejects on failure. Delivery to the radio is reported separately (LORA_TX_RESULT). */
  write(bytes: Uint8Array): Promise<void>;
  /** Idempotent. After it resolves no handler is called and pending writes have settled. */
  close(): Promise<void>;
}

export class TransportClosedError extends Error {
  override name = 'TransportClosedError';
}
