/**
 * LoRa radio contract, version 1 — LOGICAL LEVEL ONLY.
 *
 * This module defines which messages travel between the robot's Ra-02 and the
 * gateway's Ra-02, which fields each carries, how they are validated, and how
 * big a radio payload may be. It deliberately does NOT define the byte layout
 * (field order, widths, scaling, endianness, timestamp and identifier
 * encodings): that is the firmware-owned packet specification, which is not
 * signed off (OPEN_ITEMS #1). The layout plugs in behind `LoRaPayloadCodec`;
 * until it exists, `UNSIGNED_LORA_CODEC` refuses to encode or decode.
 *
 * Plain point-to-point LoRa, not LoRaWAN. Binary on air, never JSON.
 */
import { robotStateFromCode } from '../format/robotState';
import type { RunType } from '../domain/reading';
import {
  COMMAND_ABORT_REASONS,
  COMMAND_REJECT_REASONS,
  DRIVE_DIRECTIONS,
  MANUAL_COMMAND_TYPES,
  assertManualCommandingEnabled,
  type CommandAbortReason,
  type CommandRejectReason,
  type ManualCommand,
  type ManualCommandApproval,
} from './manualCommands';

export const LORA_CONTRACT_VERSION = 1;

/**
 * Largest radio payload in bytes. Hardware limit of the SX1276/77/78 FIFO
 * (the Ra-02 uses an SX1278). The real per-packet budget will be lower once
 * spreading factor / bandwidth and airtime rules are fixed (OPEN_ITEMS #18).
 */
export const LORA_MAX_PAYLOAD_BYTES = 255;

/** Firmware robot and run identifiers are opaque text in the gateway (see local-gateway.md). */
export const LORA_SOURCE_ID_MAX_LENGTH = 64;

/** uplink = robot → gateway; downlink = gateway → robot. */
export const LORA_MESSAGE_DIRECTIONS = {
  READING: 'uplink',
  STATUS: 'uplink',
  COMMAND_ACK: 'uplink',
  COMMAND_STATUS: 'uplink',
  STORAGE_ACK: 'downlink',
  MANUAL_COMMAND: 'downlink',
} as const;

export type LoRaMessageKind = keyof typeof LORA_MESSAGE_DIRECTIONS;
export type LoRaDirection = 'uplink' | 'downlink';

interface LoRaEnvelope {
  contractVersion: typeof LORA_CONTRACT_VERSION;
  /** Firmware robot identifier (opaque). On a downlink: the robot addressed. */
  robotId: string;
  /** Per-sender message counter, for diagnostics and correlation only; NOT a dedupe key. */
  messageId: number;
}

/** One cell reading. Retried by the robot until a STORAGE_ACK arrives. Dedupe key: (runId, cellIndex, seq). */
export interface LoRaReadingMessage extends LoRaEnvelope {
  kind: 'READING';
  runId: string;
  /** Decoded from the verification flag in the record's flags. */
  runType: RunType;
  cellIndex: number;
  seq: number;
  attemptCount: number;
  ph: number;
  ec: number;
  moisturePercent: number;
  temperatureC: number;
  doseVolumeMl: number;
  expectedPostCorrectionPh: number | null;
  gps: { latitude: number; longitude: number } | null;
  rawFlags: number;
  robotRecordedAt: string;
}

/** Sent once after each cell; never retried and never acknowledged. */
export interface LoRaStatusMessage extends LoRaEnvelope {
  kind: 'STATUS';
  stateCode: number;
  errorFlags: number;
  componentFlags: number | null;
  batteryVoltage: number;
  totalLimeCommandedMl: number;
  cellsCompleted: number;
  totalCells: number;
  robotReportedAt: string;
}

/**
 * Gateway → robot after the reading is committed to SQLite (never before).
 * - STORED / DUPLICATE / CONFLICT_RECORDED: durably recorded; the robot may
 *   release the record from flash.
 * - REJECTED: NOT stored; the robot must keep the record in flash.
 * Whether CONFLICT_RECORDED should release flash is OPEN_ITEMS #15.
 */
export const STORAGE_ACK_RESULTS = ['STORED', 'DUPLICATE', 'CONFLICT_RECORDED', 'REJECTED'] as const;
export type StorageAckResult = (typeof STORAGE_ACK_RESULTS)[number];

export interface LoRaStorageAckMessage extends LoRaEnvelope {
  kind: 'STORAGE_ACK';
  runId: string;
  cellIndex: number;
  seq: number;
  result: StorageAckResult;
}

/** Gateway → robot. DISABLED: encoding requires manual-command approval (D21). */
export interface LoRaManualCommandMessage extends LoRaEnvelope {
  kind: 'MANUAL_COMMAND';
  /** Strictly increasing per gateway; retransmissions reuse it. Duplicate/stale key on the robot. */
  commandSeq: number;
  /** Time left before the command must no longer be executed, recomputed on every retransmission. */
  ttlRemainingMs: number;
  command: ManualCommand;
}

/** Robot → gateway: the robot RECEIVED the command and decided whether to execute it. Not completion. */
export const COMMAND_DISPOSITIONS = ['ACCEPTED', 'DUPLICATE', 'REJECTED'] as const;
export type CommandDisposition = (typeof COMMAND_DISPOSITIONS)[number];

export interface LoRaCommandAckMessage extends LoRaEnvelope {
  kind: 'COMMAND_ACK';
  commandSeq: number;
  disposition: CommandDisposition;
  rejectReason: CommandRejectReason | null;
}

/** Robot → gateway: what physically happened to an accepted command. */
export const COMMAND_EXECUTION_STATES = ['EXECUTING', 'COMPLETED', 'ABORTED', 'FAILED'] as const;
export type CommandExecutionState = (typeof COMMAND_EXECUTION_STATES)[number];

export interface LoRaCommandStatusMessage extends LoRaEnvelope {
  kind: 'COMMAND_STATUS';
  commandSeq: number;
  execution: CommandExecutionState;
  abortReason: CommandAbortReason | null;
  robotReportedAt: string;
}

export type LoRaUplinkMessage =
  | LoRaReadingMessage
  | LoRaStatusMessage
  | LoRaCommandAckMessage
  | LoRaCommandStatusMessage;
export type LoRaDownlinkMessage = LoRaStorageAckMessage | LoRaManualCommandMessage;
export type LoRaMessage = LoRaUplinkMessage | LoRaDownlinkMessage;

// ---------------------------------------------------------------------------
// Validation of decoded (untrusted) messages
// ---------------------------------------------------------------------------

export interface LoRaValidationIssue {
  field: string;
  detail: string;
}

export type LoRaValidationResult =
  | { ok: true; message: LoRaMessage }
  | { ok: false; code: 'NOT_AN_OBJECT' | 'VERSION_MISMATCH' | 'UNKNOWN_KIND' | 'INVALID_FIELD'; issues: LoRaValidationIssue[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Collects every problem in one pass so a rejected packet's log explains all of it. */
class Fields {
  readonly issues: LoRaValidationIssue[] = [];
  constructor(private readonly o: Obj) {}

  private fail(field: string, detail: string) {
    this.issues.push({ field, detail });
  }

  int(field: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
    const v = this.o[field];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      this.fail(field, `expected an integer in [${min}, ${max}]`);
      return min;
    }
    return v;
  }

  num(field: string, min = -Infinity, max = Infinity): number {
    const v = this.o[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      this.fail(field, `expected a finite number in [${min}, ${max}]`);
      return 0;
    }
    return v;
  }

  numOrNull(field: string, min = -Infinity, max = Infinity): number | null {
    return this.o[field] === null ? null : this.num(field, min, max);
  }

  intOrNull(field: string, min: number, max?: number): number | null {
    return this.o[field] === null ? null : this.int(field, min, max);
  }

  sourceId(field: string): string {
    const v = this.o[field];
    if (typeof v !== 'string' || v.length === 0 || v.length > LORA_SOURCE_ID_MAX_LENGTH) {
      this.fail(field, `expected a non-empty identifier of at most ${LORA_SOURCE_ID_MAX_LENGTH} characters`);
      return '';
    }
    return v;
  }

  timestamp(field: string): string {
    const v = this.o[field];
    if (typeof v !== 'string' || !ISO_UTC.test(v) || !Number.isFinite(Date.parse(v))) {
      this.fail(field, 'expected an ISO-8601 UTC timestamp');
      return '';
    }
    return v;
  }

  oneOf<T extends string>(field: string, allowed: readonly T[]): T {
    const v = this.o[field];
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.fail(field, `expected one of ${allowed.join(', ')}`);
      return allowed[0] as T;
    }
    return v as T;
  }

  oneOfOrNull<T extends string>(field: string, allowed: readonly T[]): T | null {
    return this.o[field] === null ? null : this.oneOf(field, allowed);
  }

  gps(field: string): { latitude: number; longitude: number } | null {
    const v = this.o[field];
    if (v === null) return null;
    if (!isObj(v)) {
      this.fail(field, 'expected null or { latitude, longitude }');
      return null;
    }
    const inner = new Fields(v);
    const fix = { latitude: inner.num('latitude', -90, 90), longitude: inner.num('longitude', -180, 180) };
    inner.issues.forEach((i) => this.fail(`${field}.${i.field}`, i.detail));
    return fix;
  }

  command(field: string): ManualCommand {
    const v = this.o[field];
    const stop: ManualCommand = { type: 'STOP' };
    if (!isObj(v)) {
      this.fail(field, 'expected a command object');
      return stop;
    }
    const inner = new Fields(v);
    const type = inner.oneOf('type', MANUAL_COMMAND_TYPES);
    let command: ManualCommand = stop;
    if (type === 'DRIVE') {
      command = {
        type,
        direction: inner.oneOf('direction', DRIVE_DIRECTIONS),
        durationMs: inner.int('durationMs', 1),
      };
    } else {
      command = { type };
    }
    inner.issues.forEach((i) => this.fail(`${field}.${i.field}`, i.detail));
    return command;
  }
}

const PH_MIN = 0;
const PH_MAX = 14;

/**
 * Validates a codec's output. Checks only physical/representational sanity
 * (pH 0–14, moisture 0–100 %, coordinates, integer counters, 8-bit error
 * flags); it does not impose agronomic or sensor-calibration ranges.
 */
export function validateLoRaMessage(input: unknown): LoRaValidationResult {
  if (!isObj(input)) return { ok: false, code: 'NOT_AN_OBJECT', issues: [{ field: '', detail: 'not an object' }] };
  if (input.contractVersion !== LORA_CONTRACT_VERSION) {
    return {
      ok: false,
      code: 'VERSION_MISMATCH',
      issues: [{ field: 'contractVersion', detail: `expected ${LORA_CONTRACT_VERSION}, got ${String(input.contractVersion)}` }],
    };
  }
  const kind = input.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(LORA_MESSAGE_DIRECTIONS, kind)) {
    return { ok: false, code: 'UNKNOWN_KIND', issues: [{ field: 'kind', detail: `unknown kind ${String(kind)}` }] };
  }

  const f = new Fields(input);
  const envelope = {
    contractVersion: LORA_CONTRACT_VERSION,
    robotId: f.sourceId('robotId'),
    messageId: f.int('messageId', 0),
  } as const;

  let message: LoRaMessage;
  switch (kind as LoRaMessageKind) {
    case 'READING':
      message = {
        ...envelope,
        kind: 'READING',
        runId: f.sourceId('runId'),
        runType: f.oneOf('runType', ['dosing', 'verification'] as const),
        cellIndex: f.int('cellIndex', 0),
        seq: f.int('seq', 0),
        attemptCount: f.int('attemptCount', 0),
        ph: f.num('ph', PH_MIN, PH_MAX),
        ec: f.num('ec', 0),
        moisturePercent: f.num('moisturePercent', 0, 100),
        temperatureC: f.num('temperatureC'),
        doseVolumeMl: f.num('doseVolumeMl', 0),
        expectedPostCorrectionPh: f.numOrNull('expectedPostCorrectionPh', PH_MIN, PH_MAX),
        gps: f.gps('gps'),
        rawFlags: f.int('rawFlags', 0),
        robotRecordedAt: f.timestamp('robotRecordedAt'),
      };
      break;
    case 'STATUS': {
      const stateCode = f.int('stateCode', 0, 255);
      if (robotStateFromCode(stateCode) === null) f.issues.push({ field: 'stateCode', detail: `undocumented state ${stateCode}` });
      const cellsCompleted = f.int('cellsCompleted', 0);
      const totalCells = f.int('totalCells', 0);
      if (cellsCompleted > totalCells) f.issues.push({ field: 'cellsCompleted', detail: 'exceeds totalCells' });
      message = {
        ...envelope,
        kind: 'STATUS',
        stateCode,
        errorFlags: f.int('errorFlags', 0, 0xff),
        componentFlags: f.intOrNull('componentFlags', 0),
        batteryVoltage: f.num('batteryVoltage', 0),
        totalLimeCommandedMl: f.num('totalLimeCommandedMl', 0),
        cellsCompleted,
        totalCells,
        robotReportedAt: f.timestamp('robotReportedAt'),
      };
      break;
    }
    case 'STORAGE_ACK':
      message = {
        ...envelope,
        kind: 'STORAGE_ACK',
        runId: f.sourceId('runId'),
        cellIndex: f.int('cellIndex', 0),
        seq: f.int('seq', 0),
        result: f.oneOf('result', STORAGE_ACK_RESULTS),
      };
      break;
    case 'MANUAL_COMMAND':
      message = {
        ...envelope,
        kind: 'MANUAL_COMMAND',
        commandSeq: f.int('commandSeq', 0),
        ttlRemainingMs: f.int('ttlRemainingMs', 0),
        command: f.command('command'),
      };
      break;
    case 'COMMAND_ACK': {
      const disposition = f.oneOf('disposition', COMMAND_DISPOSITIONS);
      const rejectReason = f.oneOfOrNull('rejectReason', COMMAND_REJECT_REASONS);
      if ((disposition === 'REJECTED') !== (rejectReason !== null)) {
        f.issues.push({ field: 'rejectReason', detail: 'required exactly when disposition is REJECTED' });
      }
      message = { ...envelope, kind: 'COMMAND_ACK', commandSeq: f.int('commandSeq', 0), disposition, rejectReason };
      break;
    }
    case 'COMMAND_STATUS': {
      const execution = f.oneOf('execution', COMMAND_EXECUTION_STATES);
      const abortReason = f.oneOfOrNull('abortReason', COMMAND_ABORT_REASONS);
      if ((execution === 'ABORTED') !== (abortReason !== null)) {
        f.issues.push({ field: 'abortReason', detail: 'required exactly when execution is ABORTED' });
      }
      message = {
        ...envelope,
        kind: 'COMMAND_STATUS',
        commandSeq: f.int('commandSeq', 0),
        execution,
        abortReason,
        robotReportedAt: f.timestamp('robotReportedAt'),
      };
      break;
    }
  }
  return f.issues.length > 0 ? { ok: false, code: 'INVALID_FIELD', issues: f.issues } : { ok: true, message };
}

// ---------------------------------------------------------------------------
// Codec boundary
// ---------------------------------------------------------------------------

/**
 * Converts between logical messages and radio payload bytes. The ONLY place a
 * byte layout may live. `isWireFormat` is false for simulator codecs so they
 * can never be mistaken for the signed-off format.
 */
export interface LoRaPayloadCodec {
  readonly name: string;
  readonly isWireFormat: boolean;
  /** Returns an untrusted structure; the caller validates it. */
  decode(payload: Uint8Array): unknown;
  encode(message: LoRaMessage): Uint8Array;
}

export class PacketSpecNotSignedOffError extends Error {
  constructor() {
    super('The firmware LoRa byte layout is not signed off (OPEN_ITEMS #1); no wire codec exists yet.');
    this.name = 'PacketSpecNotSignedOffError';
  }
}

/** Placeholder for the real codec. Refuses both directions rather than guessing a layout. */
export const UNSIGNED_LORA_CODEC: LoRaPayloadCodec = Object.freeze({
  name: 'unsigned-placeholder',
  isWireFormat: true,
  decode(): never {
    throw new PacketSpecNotSignedOffError();
  },
  encode(): never {
    throw new PacketSpecNotSignedOffError();
  },
});

export type LoRaDecodeErrorCode =
  | 'EMPTY_PAYLOAD'
  | 'OVERSIZED_PAYLOAD'
  | 'SPEC_NOT_SIGNED_OFF'
  | 'CODEC_ERROR'
  | 'NOT_AN_OBJECT'
  | 'VERSION_MISMATCH'
  | 'UNKNOWN_KIND'
  | 'INVALID_FIELD'
  | 'WRONG_DIRECTION';

export type LoRaDecodeResult<M extends LoRaMessage> =
  | { ok: true; message: M }
  | { ok: false; code: LoRaDecodeErrorCode; issues: LoRaValidationIssue[] };

/** Size check → codec → validation → direction check. Never throws. */
export function decodeLoRaPayload(codec: LoRaPayloadCodec, payload: Uint8Array, expected: 'uplink'): LoRaDecodeResult<LoRaUplinkMessage>;
export function decodeLoRaPayload(codec: LoRaPayloadCodec, payload: Uint8Array, expected: 'downlink'): LoRaDecodeResult<LoRaDownlinkMessage>;
export function decodeLoRaPayload(codec: LoRaPayloadCodec, payload: Uint8Array, expected: LoRaDirection): LoRaDecodeResult<LoRaMessage> {
  if (payload.length === 0) return { ok: false, code: 'EMPTY_PAYLOAD', issues: [] };
  if (payload.length > LORA_MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'OVERSIZED_PAYLOAD', issues: [{ field: '', detail: `${payload.length} bytes` }] };
  }
  let raw: unknown;
  try {
    raw = codec.decode(payload);
  } catch (error) {
    const code = error instanceof PacketSpecNotSignedOffError ? 'SPEC_NOT_SIGNED_OFF' : 'CODEC_ERROR';
    return { ok: false, code, issues: [{ field: '', detail: error instanceof Error ? error.message : String(error) }] };
  }
  const validated = validateLoRaMessage(raw);
  if (!validated.ok) return validated;
  if (LORA_MESSAGE_DIRECTIONS[validated.message.kind] !== expected) {
    return { ok: false, code: 'WRONG_DIRECTION', issues: [{ field: 'kind', detail: `${validated.message.kind} is not ${expected}` }] };
  }
  return validated;
}

export class LoRaEncodeError extends Error {
  constructor(
    readonly code: 'INVALID_MESSAGE' | 'OVERSIZED_PAYLOAD' | 'EMPTY_PAYLOAD',
    message: string,
  ) {
    super(message);
    this.name = 'LoRaEncodeError';
  }
}

/**
 * Validates and encodes an outgoing message. A MANUAL_COMMAND is refused
 * (ManualCommandsNotApprovedError) before the codec is touched unless manual
 * commanding is approved.
 */
export function encodeLoRaMessage(codec: LoRaPayloadCodec, message: LoRaMessage, approval: ManualCommandApproval): Uint8Array {
  if (message.kind === 'MANUAL_COMMAND') assertManualCommandingEnabled(approval);
  const validated = validateLoRaMessage(message);
  if (!validated.ok) {
    throw new LoRaEncodeError('INVALID_MESSAGE', validated.issues.map((i) => `${i.field}: ${i.detail}`).join('; '));
  }
  const bytes = codec.encode(message);
  if (bytes.length === 0) throw new LoRaEncodeError('EMPTY_PAYLOAD', 'codec produced no bytes');
  if (bytes.length > LORA_MAX_PAYLOAD_BYTES) {
    throw new LoRaEncodeError('OVERSIZED_PAYLOAD', `${bytes.length} bytes exceeds ${LORA_MAX_PAYLOAD_BYTES}`);
  }
  return bytes;
}
