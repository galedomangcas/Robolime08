import { describe, expect, it } from 'vitest';

import { cobsDecode, cobsEncode, cobsMaxEncodedLength } from './cobs';
import { crc16CcittFalse } from './crc16';
import { LORA_MAX_PAYLOAD_BYTES } from './lora';
import {
  SERIAL_FRAME_DELIMITER,
  SERIAL_MAX_STUFFED_FRAME_BYTES,
  SERIAL_NO_FRAME_ID,
  SerialEncodeError,
  SerialFrameIdCounter,
  SerialFrameReader,
  decodeSerialFrame,
  encodeSerialFrame,
  rejectReasonFor,
  type SerialFrame,
  type SerialReadEvent,
} from './serial';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** Stuffed bytes of a frame without the trailing delimiter. */
const body = (encoded: Uint8Array) => encoded.subarray(0, encoded.length - 1);

/** Hand-builds a frame with arbitrary header values (for version/length/type tests). */
function rawFrame(opts: { version?: number; type?: number; frameId?: number; payload?: Uint8Array; declaredLength?: number; badCrc?: boolean }) {
  const payload = opts.payload ?? new Uint8Array(0);
  const raw = new Uint8Array(6 + payload.length + 2);
  const view = new DataView(raw.buffer);
  raw[0] = opts.version ?? 1;
  raw[1] = opts.type ?? 0x02;
  view.setUint16(2, opts.frameId ?? 7, true);
  view.setUint16(4, opts.declaredLength ?? payload.length, true);
  raw.set(payload, 6);
  const crc = crc16CcittFalse(raw, 0, 6 + payload.length);
  view.setUint16(6 + payload.length, opts.badCrc ? crc ^ 0xffff : crc, true);
  return cobsEncode(raw);
}

const frames = (events: SerialReadEvent[]) => events.flatMap((e) => (e.kind === 'frame' ? [e.frame] : []));
const errors = (events: SerialReadEvent[]) => events.flatMap((e) => (e.kind === 'error' ? [e.error.code] : []));

describe('CRC-16/CCITT-FALSE', () => {
  it('matches the standard check value', () => {
    expect(crc16CcittFalse(ascii('123456789'))).toBe(0x29b1);
  });
});

describe('COBS', () => {
  const cases: [string, number[]][] = [
    ['empty', []],
    ['single zero', [0]],
    ['zeros', [0, 0, 0]],
    ['mixed', [1, 0, 2, 3, 0, 0, 4]],
    ['254 non-zero bytes', Array.from({ length: 254 }, (_, i) => (i % 255) + 1)],
    ['254 non-zero bytes then a zero', [...Array.from({ length: 254 }, () => 7), 0]],
    ['255 non-zero bytes', Array.from({ length: 255 }, () => 9)],
    ['508 non-zero bytes', Array.from({ length: 508 }, () => 0xff)],
    ['trailing zero', [5, 6, 0]],
    ['600 bytes with zeros', Array.from({ length: 600 }, (_, i) => i % 256)],
  ];
  it.each(cases)('round-trips %s without emitting 0x00', (_, bytes) => {
    const input = Uint8Array.from(bytes);
    const encoded = cobsEncode(input);
    expect(encoded.includes(0)).toBe(false);
    expect(encoded.length).toBeLessThanOrEqual(cobsMaxEncodedLength(input.length));
    expect(Array.from(cobsDecode(encoded) ?? [])).toEqual(bytes);
  });

  it('rejects a zero byte and a block that overruns the input', () => {
    expect(cobsDecode(Uint8Array.from([2, 0]))).toBeNull();
    expect(cobsDecode(Uint8Array.from([5, 1, 2]))).toBeNull();
  });
});

describe('serial frame encode/decode', () => {
  const samples: SerialFrame[] = [
    { frameId: 0, message: { type: 'HELLO', role: 'host', buildId: 'gateway-0.1.0' } },
    { frameId: 1, message: { type: 'PING' } },
    { frameId: 2, message: { type: 'PONG', refFrameId: 1 } },
    {
      frameId: 3,
      message: { type: 'LORA_RX', rssiDbm: -97, snrTenthsDb: -45, bridgeUptimeMs: 123456, radioPayload: Uint8Array.from([0, 1, 0, 255]) },
    },
    { frameId: 4, message: { type: 'LORA_TX', radioPayload: new Uint8Array(LORA_MAX_PAYLOAD_BYTES).fill(0) } },
    { frameId: 5, message: { type: 'LORA_TX_RESULT', refFrameId: 4, result: 'CHANNEL_BUSY_RX' } },
    { frameId: 6, message: { type: 'BRIDGE_FAULT', fault: 'RADIO_RX_OVERFLOW', count: 3 } },
    { frameId: 7, message: { type: 'FRAME_REJECTED', refFrameId: null, reason: 'BAD_CRC' } },
    { frameId: 0xfffe, message: { type: 'FRAME_REJECTED', refFrameId: 12, reason: 'UNKNOWN_TYPE' } },
  ];

  it.each(samples.map((s) => [s.message.type, s] as const))('round-trips %s', (_, frame) => {
    const encoded = encodeSerialFrame(frame);
    expect(encoded[encoded.length - 1]).toBe(SERIAL_FRAME_DELIMITER);
    expect(body(encoded).includes(0)).toBe(false);
    expect(decodeSerialFrame(body(encoded))).toEqual({ ok: true, frame });
  });

  it('refuses to encode out-of-contract frames', () => {
    const tooBig = new Uint8Array(LORA_MAX_PAYLOAD_BYTES + 1);
    expect(() => encodeSerialFrame({ frameId: 1, message: { type: 'LORA_TX', radioPayload: tooBig } })).toThrow(SerialEncodeError);
    expect(() => encodeSerialFrame({ frameId: 1, message: { type: 'LORA_TX', radioPayload: new Uint8Array(0) } })).toThrow(SerialEncodeError);
    expect(() => encodeSerialFrame({ frameId: SERIAL_NO_FRAME_ID, message: { type: 'PING' } })).toThrow(SerialEncodeError);
    expect(() => encodeSerialFrame({ frameId: 1, message: { type: 'HELLO', role: 'host', buildId: 'naïve' } })).toThrow(SerialEncodeError);
    expect(() =>
      encodeSerialFrame({ frameId: 1, message: { type: 'LORA_RX', rssiDbm: 40000, snrTenthsDb: 0, bridgeUptimeMs: 0, radioPayload: Uint8Array.of(1) } }),
    ).toThrow(SerialEncodeError);
  });

  it('detects a corrupted byte through the CRC before trusting the header', () => {
    const encoded = body(encodeSerialFrame({ frameId: 9, message: { type: 'PONG', refFrameId: 3 } })).slice();
    encoded[3] = encoded[3] === 0x55 ? 0x56 : 0x55;
    const result = decodeSerialFrame(encoded);
    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_CRC', frameId: null } });
  });

  it('reports a version mismatch with the frame id, so the sender can be told', () => {
    expect(decodeSerialFrame(rawFrame({ version: 2, frameId: 41 }))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_VERSION', frameId: 41 },
    });
    expect(rejectReasonFor('UNSUPPORTED_VERSION')).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects unknown types, wrong declared lengths, malformed payloads and short frames', () => {
    expect(decodeSerialFrame(rawFrame({ type: 0x55 }))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE' } });
    expect(decodeSerialFrame(rawFrame({ payload: Uint8Array.of(1, 2), declaredLength: 5 }))).toMatchObject({
      ok: false,
      error: { code: 'BAD_LENGTH' },
    });
    // PING must have an empty payload; LORA_TX_RESULT with an undefined result code.
    expect(decodeSerialFrame(rawFrame({ type: 0x02, payload: Uint8Array.of(1) }))).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_PAYLOAD' },
    });
    expect(decodeSerialFrame(rawFrame({ type: 0x12, payload: Uint8Array.of(1, 0, 99) }))).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_PAYLOAD' },
    });
    // LORA_RX carrying metadata but no radio payload.
    expect(decodeSerialFrame(rawFrame({ type: 0x10, payload: new Uint8Array(8).fill(1) }))).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_PAYLOAD' },
    });
    expect(decodeSerialFrame(cobsEncode(Uint8Array.of(1, 2, 3)))).toMatchObject({ ok: false, error: { code: 'TOO_SHORT' } });
    expect(rejectReasonFor('TOO_SHORT')).toBe('BAD_LENGTH');
    expect(decodeSerialFrame(Uint8Array.of(9, 1))).toMatchObject({ ok: false, error: { code: 'COBS_INVALID' } });
  });
});

describe('SerialFrameReader (streaming)', () => {
  const a = encodeSerialFrame({ frameId: 1, message: { type: 'PING' } });
  const b = encodeSerialFrame({ frameId: 2, message: { type: 'PONG', refFrameId: 1 } });
  const c = encodeSerialFrame({
    frameId: 3,
    message: { type: 'LORA_RX', rssiDbm: -80, snrTenthsDb: 70, bridgeUptimeMs: 1, radioPayload: Uint8Array.from([1, 0, 2]) },
  });

  it('reassembles a frame split across many reads', () => {
    const reader = new SerialFrameReader();
    const events: SerialReadEvent[] = [];
    for (const byte of c) events.push(...reader.push(Uint8Array.of(byte)));
    expect(frames(events).map((f) => f.frameId)).toEqual([3]);
    expect(reader.pendingBytes).toBe(0);
  });

  it('returns every frame contained in a single read, in order', () => {
    const reader = new SerialFrameReader();
    expect(frames(reader.push(concat(a, b, c))).map((f) => f.frameId)).toEqual([1, 2, 3]);
  });

  it('keeps the tail of a read for the next one', () => {
    const reader = new SerialFrameReader();
    const stream = concat(a, b);
    const first = reader.push(stream.subarray(0, a.length + 2));
    expect(frames(first).map((f) => f.frameId)).toEqual([1]);
    expect(reader.pendingBytes).toBe(2);
    expect(frames(reader.push(stream.subarray(a.length + 2))).map((f) => f.frameId)).toEqual([2]);
  });

  it('ignores repeated delimiters (resync bytes) and recovers after garbage', () => {
    const reader = new SerialFrameReader();
    const events = reader.push(concat(Uint8Array.of(0, 0, 0), Uint8Array.of(0x13, 0x37, 0), a));
    expect(errors(events)).toEqual(['COBS_INVALID']);
    expect(frames(events).map((f) => f.frameId)).toEqual([1]);
  });

  it('bounds memory on oversized input: reports once, discards to the next delimiter, then resumes', () => {
    const reader = new SerialFrameReader();
    const runaway = new Uint8Array(SERIAL_MAX_STUFFED_FRAME_BYTES * 3).fill(0x41);
    const events = [...reader.push(runaway), ...reader.push(Uint8Array.of(0)), ...reader.push(b)];
    expect(errors(events)).toEqual(['OVERSIZED']);
    expect(frames(events).map((f) => f.frameId)).toEqual([2]);
    expect(reader.pendingBytes).toBe(0);
  });

  it('drops a partial frame on reset (port reopened mid-frame)', () => {
    const reader = new SerialFrameReader();
    reader.push(a.subarray(0, 3));
    reader.reset();
    expect(frames(reader.push(b)).map((f) => f.frameId)).toEqual([2]);
  });

  it('reports a corrupted frame and still delivers its neighbours', () => {
    const reader = new SerialFrameReader();
    const corrupted = b.slice();
    corrupted[2] = corrupted[2] === 0x11 ? 0x12 : 0x11;
    const events = reader.push(concat(a, corrupted, c));
    expect(frames(events).map((f) => f.frameId)).toEqual([1, 3]);
    expect(errors(events)).toEqual(['BAD_CRC']);
  });
});

describe('SerialFrameIdCounter', () => {
  it('wraps without ever emitting the reserved id', () => {
    const counter = new SerialFrameIdCounter(0xfffd);
    expect([counter.take(), counter.take(), counter.take()]).toEqual([0xfffd, 0xfffe, 0]);
  });
});

/**
 * Regression guard from the firmware inspection of 2026-10-27 (D44): the only
 * receiver sketch, `Robot Code/Test Cases/SPRINT_1_Gateway.ino` (origin/main
 * 432d5b3), writes human-readable text lines at 115200 baud. Its
 * "[Robolime] MSG:..." lines are HARD-CODED sample strings printed on a timer
 * (lines 34 and 49), not data received from the robot. None of this output may
 * ever be accepted as a USB serial v1 frame.
 */
describe('Sprint 1 receiver text output (not a serial v1 stream)', () => {
  const SPRINT1_OUTPUT = [
    '[Gateway] Initializing LoRa...',
    '[Gateway] LoRa Initialized Successfully!',
    '[Robolime] MSG:ROBOT_STATUS,STATE:ACTIVE,ERR:0,BATTERY:88,TOTAL_LIME:120.5,TS:1771920000',
    '[Gateway] Sending manual command: get_pH',
    '[Robolime] MSG:SOIL_STATUS,PH:6.52,EC:1.20,MOISTURE:42.5,TEMP:24.1,LIME:15.0,LAT:14.5995,LON:120.9842,FLAG:0',
    '[Gateway] Received --> hello',
  ]
    .map((line) => `${line}\r\n`)
    .join('');

  it('yields no frame, however much text arrives', () => {
    const reader = new SerialFrameReader();
    const events: SerialReadEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(...reader.push(ascii(SPRINT1_OUTPUT)));
    expect(frames(events)).toEqual([]);
    // Text never contains the 0x00 delimiter, so the reader only reports bounded OVERSIZED errors.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 'error' && e.error.code === 'OVERSIZED')).toBe(true);
    expect(reader.pendingBytes).toBeLessThanOrEqual(SERIAL_MAX_STUFFED_FRAME_BYTES);
  });

  it('rejects each line even if something delimited it with 0x00', () => {
    for (const line of SPRINT1_OUTPUT.split('\r\n').filter((l) => l.length > 0)) {
      const reader = new SerialFrameReader();
      const events = reader.push(Uint8Array.from([...ascii(line), SERIAL_FRAME_DELIMITER]));
      expect(frames(events)).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('error');
    }
  });
});
