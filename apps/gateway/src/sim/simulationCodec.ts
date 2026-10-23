import type { LoRaMessage, LoRaPayloadCodec } from '@robolime/shared';

/** ASCII "SIM": a simulated payload can never be mistaken for a firmware packet. */
const MAGIC = [0x53, 0x49, 0x4d] as const;
const HEADER_BYTES = MAGIC.length + 4;

/**
 * SIMULATION-ONLY codec. It is NOT the radio byte layout and must never be
 * used with real hardware (`isWireFormat` is false). Payloads are a magic
 * tag plus an opaque handle into an in-memory registry, so the simulator can
 * drive the real serial framing, size limits, validation and storage paths
 * without anyone inventing byte offsets. Optional padding emulates payload
 * sizes for the 255-byte limit.
 */
export class SimulationLoRaCodec implements LoRaPayloadCodec {
  readonly name = 'simulation-only';
  readonly isWireFormat = false;
  private readonly registry = new Map<number, unknown>();
  private nextHandle = 1;

  encode(message: LoRaMessage): Uint8Array {
    return this.encodeRaw(message);
  }

  /** Registers any structure, including deliberately invalid ones, for rejection tests. */
  encodeRaw(value: unknown, totalBytes = HEADER_BYTES): Uint8Array {
    const handle = this.nextHandle++;
    this.registry.set(handle, structuredClone(value));
    const out = new Uint8Array(Math.max(totalBytes, HEADER_BYTES));
    out.set(MAGIC);
    new DataView(out.buffer).setUint32(MAGIC.length, handle, true);
    return out;
  }

  decode(payload: Uint8Array): unknown {
    if (payload.length < HEADER_BYTES || MAGIC.some((b, i) => payload[i] !== b)) {
      throw new Error('not a simulation payload');
    }
    const handle = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(MAGIC.length, true);
    if (!this.registry.has(handle)) throw new Error(`unknown simulation handle ${handle}`);
    return structuredClone(this.registry.get(handle));
  }
}
