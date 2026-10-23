/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no input or
 * output reflection, no final XOR. Check value for ASCII "123456789" is 0x29B1.
 * Chosen for the USB serial contract because it is cheap on an ESP32 and has
 * widely available reference implementations.
 */
export function crc16CcittFalse(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= (bytes[i] ?? 0) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
