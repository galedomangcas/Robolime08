import { describe, expect, it } from 'vitest';

import {
  LORA_CONTRACT_VERSION,
  LORA_MAX_PAYLOAD_BYTES,
  LoRaEncodeError,
  NonWireCodecError,
  UNSIGNED_LORA_CODEC,
  PacketSpecNotSignedOffError,
  assertHardwareCodec,
  decodeLoRaPayload,
  encodeLoRaMessage,
  validateLoRaMessage,
  type LoRaMessage,
  type LoRaPayloadCodec,
  type LoRaReadingMessage,
} from './lora';
import { ManualCommandsNotApprovedError } from './manualCommands';

const reading: LoRaReadingMessage = {
  contractVersion: LORA_CONTRACT_VERSION,
  kind: 'READING',
  robotId: 'TEST-ROBOT-1',
  messageId: 10,
  runId: 'RUN-1',
  runType: 'dosing',
  cellIndex: 3,
  seq: 3,
  attemptCount: 1,
  ph: 5.42,
  ec: 0.31,
  moisturePercent: 24.5,
  temperatureC: 28.1,
  doseVolumeMl: 40,
  expectedPostCorrectionPh: 5.95,
  gps: { latitude: 13.88, longitude: 120.63 },
  rawFlags: 0,
  robotRecordedAt: '2026-03-01T01:02:03.000Z',
};

/** An in-memory test codec: hands the logical object straight through, with a fixed byte size. */
function passThroughCodec(value: unknown, size = 16): LoRaPayloadCodec {
  return {
    name: 'test-pass-through',
    isWireFormat: false,
    decode: () => value,
    encode: () => new Uint8Array(size).fill(1),
  };
}

describe('validateLoRaMessage', () => {
  it('accepts a well-formed reading', () => {
    expect(validateLoRaMessage(reading)).toEqual({ ok: true, message: reading });
  });

  it('rejects a version mismatch before reading any other field', () => {
    const result = validateLoRaMessage({ ...reading, contractVersion: 2, ph: 'nonsense' });
    expect(result).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
  });

  it('rejects unknown message kinds and non-objects', () => {
    expect(validateLoRaMessage({ ...reading, kind: 'FIRMWARE_UPDATE' })).toMatchObject({ ok: false, code: 'UNKNOWN_KIND' });
    expect(validateLoRaMessage({ ...reading, kind: 'toString' })).toMatchObject({ ok: false, code: 'UNKNOWN_KIND' });
    expect(validateLoRaMessage(null)).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
    expect(validateLoRaMessage([reading])).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
  });

  it('lists every invalid field at once', () => {
    const result = validateLoRaMessage({
      ...reading,
      ph: 14.01,
      cellIndex: -1,
      seq: 1.5,
      moisturePercent: Number.NaN,
      gps: { latitude: 91, longitude: 0 },
      robotRecordedAt: '2026-03-01 01:02:03',
      runId: 'x'.repeat(65),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_FIELD');
    expect(result.issues.map((i) => i.field).sort()).toEqual(
      ['cellIndex', 'gps.latitude', 'moisturePercent', 'ph', 'robotRecordedAt', 'runId', 'seq'].sort(),
    );
  });

  describe('timestamps (READING robotRecordedAt, STATUS and COMMAND_STATUS robotReportedAt)', () => {
    const timestamped: { kind: string; field: string; message: object }[] = [
      { kind: 'READING', field: 'robotRecordedAt', message: reading },
      {
        kind: 'STATUS',
        field: 'robotReportedAt',
        message: {
          contractVersion: 1, kind: 'STATUS', robotId: 'TEST-ROBOT-1', messageId: 11, stateCode: 1, errorFlags: 0, componentFlags: null,
          batteryVoltage: 12.4, totalLimeCommandedMl: 0, cellsCompleted: 0, totalCells: 20, robotReportedAt: '2026-03-01T01:02:03Z',
        },
      },
      {
        kind: 'COMMAND_STATUS',
        field: 'robotReportedAt',
        message: {
          contractVersion: 1, kind: 'COMMAND_STATUS', robotId: 'R', messageId: 2, commandSeq: 4, execution: 'COMPLETED', abortReason: null,
          robotReportedAt: '2026-03-01T00:00:00Z',
        },
      },
    ];

    const valid = ['2024-02-29T12:00:00Z', '2000-02-29T12:00:00Z', '2026-01-31T23:59:59Z', '2026-03-01T01:02:03.000Z'];
    const invalid = [
      '2025-02-29T12:00:00Z', // not a leap year
      '1900-02-29T12:00:00Z', // century, not a leap year
      '2026-02-30T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-00-10T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-03-00T12:00:00Z',
      '2026-03-01T24:00:00Z',
      '2026-03-01T12:60:00Z',
      '2026-03-01T12:00:60Z',
      '2026-03-01 12:00:00', // space instead of T
    ];

    for (const { kind, field, message } of timestamped) {
      it(`${kind}.${field} accepts real calendar timestamps and keeps them exactly as sent`, () => {
        for (const ts of valid) {
          const result = validateLoRaMessage({ ...message, [field]: ts });
          expect(result.ok, ts).toBe(true);
          if (result.ok) expect((result.message as unknown as Record<string, unknown>)[field]).toBe(ts);
        }
      });

      it(`${kind}.${field} rejects impossible dates and times instead of shifting them`, () => {
        for (const ts of invalid) {
          const result = validateLoRaMessage({ ...message, [field]: ts });
          expect(result, ts).toMatchObject({ ok: false, code: 'INVALID_FIELD' });
          if (!result.ok) expect(result.issues.map((i) => i.field), ts).toEqual([field]);
        }
      });
    }
  });

  it('accepts pH boundary values 0 and 14 and a missing GPS fix / expected pH', () => {
    for (const ph of [0, 14]) expect(validateLoRaMessage({ ...reading, ph }).ok).toBe(true);
    expect(validateLoRaMessage({ ...reading, gps: null, expectedPostCorrectionPh: null }).ok).toBe(true);
  });

  it('checks status packets against the documented state codes and 8-bit error flags', () => {
    const status = {
      contractVersion: 1,
      kind: 'STATUS',
      robotId: 'TEST-ROBOT-1',
      messageId: 11,
      stateCode: 2,
      errorFlags: 0b1000_0001,
      componentFlags: null,
      batteryVoltage: 12.4,
      totalLimeCommandedMl: 400,
      cellsCompleted: 7,
      totalCells: 20,
      robotReportedAt: '2026-03-01T01:02:03Z',
    };
    expect(validateLoRaMessage(status).ok).toBe(true);
    expect(validateLoRaMessage({ ...status, stateCode: 7 })).toMatchObject({ ok: false, code: 'INVALID_FIELD' });
    expect(validateLoRaMessage({ ...status, errorFlags: 0x100 })).toMatchObject({ ok: false, code: 'INVALID_FIELD' });
    expect(validateLoRaMessage({ ...status, cellsCompleted: 21 })).toMatchObject({ ok: false, code: 'INVALID_FIELD' });
  });

  it('requires a reject reason exactly when a command is rejected, and an abort reason exactly when aborted', () => {
    const ack = { contractVersion: 1, kind: 'COMMAND_ACK', robotId: 'R', messageId: 1, commandSeq: 4 };
    expect(validateLoRaMessage({ ...ack, disposition: 'ACCEPTED', rejectReason: null }).ok).toBe(true);
    expect(validateLoRaMessage({ ...ack, disposition: 'REJECTED', rejectReason: null }).ok).toBe(false);
    expect(validateLoRaMessage({ ...ack, disposition: 'ACCEPTED', rejectReason: 'EXPIRED' }).ok).toBe(false);
    const st = { contractVersion: 1, kind: 'COMMAND_STATUS', robotId: 'R', messageId: 2, commandSeq: 4, robotReportedAt: '2026-03-01T00:00:00Z' };
    expect(validateLoRaMessage({ ...st, execution: 'ABORTED', abortReason: 'LINK_LOST' }).ok).toBe(true);
    expect(validateLoRaMessage({ ...st, execution: 'ABORTED', abortReason: null }).ok).toBe(false);
  });

  it('rejects invalid manual-command parameters', () => {
    const cmd = { contractVersion: 1, kind: 'MANUAL_COMMAND', robotId: 'R', messageId: 1, commandSeq: 1, ttlRemainingMs: 500 };
    expect(validateLoRaMessage({ ...cmd, command: { type: 'DRIVE', direction: 'FORWARD', durationMs: 200 } }).ok).toBe(true);
    expect(validateLoRaMessage({ ...cmd, command: { type: 'DRIVE', direction: 'UP', durationMs: 200 } }).ok).toBe(false);
    expect(validateLoRaMessage({ ...cmd, command: { type: 'DRIVE', direction: 'FORWARD', durationMs: 0 } }).ok).toBe(false);
    expect(validateLoRaMessage({ ...cmd, command: { type: 'DISPENSE' } }).ok).toBe(false);
    expect(validateLoRaMessage({ ...cmd, ttlRemainingMs: -1, command: { type: 'STOP' } }).ok).toBe(false);
  });
});

describe('decodeLoRaPayload', () => {
  const bytes = new Uint8Array(20).fill(7);

  it('refuses to decode anything while the byte layout is unsigned', () => {
    expect(decodeLoRaPayload(UNSIGNED_LORA_CODEC, bytes, 'uplink')).toMatchObject({ ok: false, code: 'SPEC_NOT_SIGNED_OFF' });
  });

  it('rejects empty and oversized payloads before calling the codec', () => {
    const codec = passThroughCodec(reading);
    expect(decodeLoRaPayload(codec, new Uint8Array(0), 'uplink')).toMatchObject({ ok: false, code: 'EMPTY_PAYLOAD' });
    expect(decodeLoRaPayload(codec, new Uint8Array(LORA_MAX_PAYLOAD_BYTES + 1), 'uplink')).toMatchObject({
      ok: false,
      code: 'OVERSIZED_PAYLOAD',
    });
    expect(decodeLoRaPayload(codec, new Uint8Array(LORA_MAX_PAYLOAD_BYTES), 'uplink').ok).toBe(true);
  });

  it('reports codec failures as CODEC_ERROR instead of throwing', () => {
    const broken: LoRaPayloadCodec = { ...passThroughCodec(null), decode: () => { throw new Error('truncated'); } };
    expect(decodeLoRaPayload(broken, bytes, 'uplink')).toMatchObject({ ok: false, code: 'CODEC_ERROR' });
  });

  it('rejects a message travelling the wrong way (a robot cannot send STORAGE_ACK)', () => {
    const ack = { contractVersion: 1, kind: 'STORAGE_ACK', robotId: 'R', messageId: 1, runId: 'RUN-1', cellIndex: 0, seq: 0, result: 'STORED' };
    expect(decodeLoRaPayload(passThroughCodec(ack), bytes, 'uplink')).toMatchObject({ ok: false, code: 'WRONG_DIRECTION' });
    expect(decodeLoRaPayload(passThroughCodec(ack), bytes, 'downlink').ok).toBe(true);
  });
});

describe('encodeLoRaMessage', () => {
  const command: LoRaMessage = {
    contractVersion: 1,
    kind: 'MANUAL_COMMAND',
    robotId: 'R',
    messageId: 1,
    commandSeq: 1,
    ttlRemainingMs: 500,
    command: { type: 'STOP' },
  };

  it('blocks manual commands before touching the codec', () => {
    let codecCalled = false;
    const codec: LoRaPayloadCodec = { ...passThroughCodec(null), encode: () => { codecCalled = true; return Uint8Array.of(1); } };
    expect(() => encodeLoRaMessage(codec, command)).toThrow(ManualCommandsNotApprovedError);
    expect(codecCalled).toBe(false);
  });

  it('cannot encode anything with the unsigned placeholder codec', () => {
    const ack: LoRaMessage = { contractVersion: 1, kind: 'STORAGE_ACK', robotId: 'R', messageId: 1, runId: 'RUN-1', cellIndex: 0, seq: 0, result: 'STORED' };
    expect(() => encodeLoRaMessage(UNSIGNED_LORA_CODEC, ack)).toThrow(PacketSpecNotSignedOffError);
  });

  it('validates messages and enforces the radio payload size limit', () => {
    const ack: LoRaMessage = { contractVersion: 1, kind: 'STORAGE_ACK', robotId: 'R', messageId: 1, runId: 'RUN-1', cellIndex: 0, seq: 0, result: 'STORED' };
    expect(() => encodeLoRaMessage(passThroughCodec(null), { ...reading, ph: 15 })).toThrow(LoRaEncodeError);
    expect(() => encodeLoRaMessage(passThroughCodec(null, 256), ack)).toThrow(/exceeds 255/);
    expect(() => encodeLoRaMessage(passThroughCodec(null, 0), ack)).toThrow(LoRaEncodeError);
    expect(encodeLoRaMessage(passThroughCodec(null, 255), ack)).toHaveLength(255);
  });
});

describe('assertHardwareCodec', () => {
  it('rejects simulation codecs and accepts a codec declared as the wire format', () => {
    expect(() => assertHardwareCodec(passThroughCodec(null))).toThrow(NonWireCodecError);
    expect(() => assertHardwareCodec(UNSIGNED_LORA_CODEC)).not.toThrow();
  });
});
