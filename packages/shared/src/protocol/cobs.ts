/**
 * Consistent Overhead Byte Stuffing. Removes every 0x00 from a frame so that
 * 0x00 can delimit frames on the USB serial stream: a receiver that joins
 * mid-stream (or after a dropped byte) resynchronises at the next 0x00.
 */

/** Worst-case stuffed length of `length` input bytes (without the delimiter). */
export function cobsMaxEncodedLength(length: number): number {
  return length + Math.floor(length / 254) + 1;
}

export function cobsEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(cobsMaxEncodedLength(input.length));
  let codeIndex = 0;
  let outIndex = 1;
  let code = 1;
  for (const byte of input) {
    if (byte === 0) {
      out[codeIndex] = code;
      codeIndex = outIndex++;
      code = 1;
      continue;
    }
    out[outIndex++] = byte;
    code++;
    if (code === 0xff) {
      out[codeIndex] = code;
      codeIndex = outIndex++;
      code = 1;
    }
  }
  out[codeIndex] = code;
  return out.slice(0, outIndex);
}

/** Returns null for input that is not valid COBS (contains 0x00 or a block overruns the end). */
export function cobsDecode(input: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(input.length);
  let i = 0;
  let o = 0;
  while (i < input.length) {
    const code = input[i] ?? 0;
    if (code === 0) return null;
    i++;
    const blockEnd = i + code - 1;
    if (blockEnd > input.length) return null;
    while (i < blockEnd) {
      const byte = input[i++] ?? 0;
      if (byte === 0) return null;
      out[o++] = byte;
    }
    if (code !== 0xff && i < input.length) out[o++] = 0;
  }
  return out.slice(0, o);
}
