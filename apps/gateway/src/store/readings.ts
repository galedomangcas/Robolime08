import type { CellReading, GpsFix, RunType } from '@robolime/shared';

import { bool, num, numOrNull, str, strOrNull, withTransaction, type Database, type Row } from '../db/connection';
import { stableIds } from '../db/ids';
import { toCanonicalUtc } from '../db/time';
import { enqueue } from './outbox';
import { getActiveField, getRobotBySourceId } from './robots';

/**
 * A reading record after packet decoding (Phase 3). Transport-agnostic: no
 * byte offsets or wire encodings are assumed here. All measured and
 * robot-calculated values are stored exactly as decoded — the gateway never
 * computes dose volume or expected post-correction pH.
 */
export interface DecodedReading {
  sourceRobotId: string;
  sourceRunId: string;
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
  gps: GpsFix | null;
  rawFlags: number;
  /** Robot-side measurement time (decoded by Phase 3 from the firmware encoding). */
  robotRecordedAt: string;
}

/**
 * - inserted:  first copy; stored and queued for cloud sync.
 * - duplicate: same logical reading with an identical payload (e.g. a retry
 *              after a lost ACK); the stored reading is unchanged.
 * - conflict:  same (run, cell, seq) but a different payload; the ORIGINAL is
 *              kept and the differing copy is logged for review.
 * All three outcomes are durably recorded when this function returns, so the
 * record is safe to acknowledge.
 */
export type RecordOutcome = 'inserted' | 'duplicate' | 'conflict';

export interface RecordReadingResult {
  outcome: RecordOutcome;
  readingId: string;
  runId: string;
}

export class IngestError extends Error {
  constructor(
    readonly code: 'UNKNOWN_ROBOT' | 'RUN_TYPE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/** Finds the run for (robot, source run ID), creating it on first sight. */
function ensureRun(
  db: Database,
  robotId: string,
  isSynthetic: boolean,
  sourceRunId: string,
  runType: RunType,
  receivedAt: string,
  now: Date,
): string {
  const runId = stableIds.run(robotId, sourceRunId);
  const existing = db.prepare('SELECT run_type FROM runs WHERE id = ?').get(runId);
  if (existing) {
    if (str(existing, 'run_type') !== runType) {
      throw new IngestError(
        'RUN_TYPE_MISMATCH',
        `Run ${sourceRunId} is stored as ${str(existing, 'run_type')} but a record says ${runType}`,
      );
    }
    return runId;
  }
  const activeField = getActiveField(db, robotId);
  db.prepare(
    `INSERT INTO runs (id, robot_id, source_run_id, run_type, field_id, gateway_first_received_at, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, robotId, sourceRunId, runType, activeField?.field.id ?? null, receivedAt, isSynthetic ? 1 : 0);
  enqueue(db, 'run', runId, now);
  return runId;
}

/** Fields compared for duplicate-vs-conflict (attempt count legitimately differs on retries). */
function payloadOf(r: DecodedReading) {
  return {
    ph: r.ph,
    ec: r.ec,
    moisturePercent: r.moisturePercent,
    temperatureC: r.temperatureC,
    doseVolumeMl: r.doseVolumeMl,
    expectedPostCorrectionPh: r.expectedPostCorrectionPh,
    gpsLatitude: r.gps?.latitude ?? null,
    gpsLongitude: r.gps?.longitude ?? null,
    rawFlags: r.rawFlags,
    robotRecordedAt: toCanonicalUtc(r.robotRecordedAt),
  };
}

function storedPayload(row: Row) {
  return {
    ph: num(row, 'ph'),
    ec: num(row, 'ec'),
    moisturePercent: num(row, 'moisture_percent'),
    temperatureC: num(row, 'temperature_c'),
    doseVolumeMl: num(row, 'dose_volume_ml'),
    expectedPostCorrectionPh: numOrNull(row, 'expected_post_correction_ph'),
    gpsLatitude: numOrNull(row, 'gps_latitude'),
    gpsLongitude: numOrNull(row, 'gps_longitude'),
    rawFlags: num(row, 'raw_flags'),
    robotRecordedAt: str(row, 'robot_recorded_at'),
  };
}

/**
 * Durably records one decoded reading, idempotently on (run_id, cell_index, seq).
 * Late and out-of-order arrivals are simply stored; no ordering is assumed.
 * The caller may acknowledge the robot only after this returns without throwing.
 */
export function recordReading(db: Database, input: DecodedReading, receivedAt: Date): RecordReadingResult {
  const receivedText = toCanonicalUtc(receivedAt);
  return withTransaction(db, () => {
    const robot = getRobotBySourceId(db, input.sourceRobotId);
    if (!robot) {
      throw new IngestError('UNKNOWN_ROBOT', `Robot ${input.sourceRobotId} is not provisioned on this gateway`);
    }
    const runId = ensureRun(
      db,
      robot.id,
      robot.isSynthetic,
      input.sourceRunId,
      input.runType,
      receivedText,
      receivedAt,
    );
    const readingId = stableIds.reading(runId, input.cellIndex, input.seq);
    const payload = payloadOf(input);

    const insert = db
      .prepare(
        `INSERT INTO readings (id, run_id, cell_index, seq, attempt_count, ph, ec, moisture_percent, temperature_c,
           dose_volume_ml, expected_post_correction_ph, gps_latitude, gps_longitude, raw_flags,
           robot_recorded_at, gateway_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, cell_index, seq) DO NOTHING`,
      )
      .run(
        readingId,
        runId,
        input.cellIndex,
        input.seq,
        input.attemptCount,
        payload.ph,
        payload.ec,
        payload.moisturePercent,
        payload.temperatureC,
        payload.doseVolumeMl,
        payload.expectedPostCorrectionPh,
        payload.gpsLatitude,
        payload.gpsLongitude,
        payload.rawFlags,
        payload.robotRecordedAt,
        receivedText,
      );

    let outcome: RecordOutcome;
    let conflictingPayload: string | null = null;
    if (Number(insert.changes) === 1) {
      outcome = 'inserted';
      enqueue(db, 'reading', readingId, receivedAt);
    } else {
      const stored = db.prepare('SELECT * FROM readings WHERE id = ?').get(readingId);
      if (stored === undefined) {
        throw new Error(`Reading ${readingId} vanished during upsert`);
      }
      const same = JSON.stringify(storedPayload(stored)) === JSON.stringify(payload);
      outcome = same ? 'duplicate' : 'conflict';
      conflictingPayload = same ? null : JSON.stringify(payload);
    }

    db.prepare(
      `INSERT INTO reading_receipts (reading_id, attempt_count, gateway_received_at, outcome, conflicting_payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(readingId, input.attemptCount, receivedText, outcome, conflictingPayload);

    return { outcome, readingId, runId };
  });
}

export function toCellReading(row: Row, runType: RunType, cloudSyncedAt: string | null): CellReading {
  const latitude = numOrNull(row, 'gps_latitude');
  const longitude = numOrNull(row, 'gps_longitude');
  return {
    runId: str(row, 'run_id'),
    runType,
    cellIndex: num(row, 'cell_index'),
    seq: num(row, 'seq'),
    attemptCount: num(row, 'attempt_count'),
    ph: num(row, 'ph'),
    ec: num(row, 'ec'),
    moisturePercent: num(row, 'moisture_percent'),
    temperatureC: num(row, 'temperature_c'),
    doseVolumeMl: num(row, 'dose_volume_ml'),
    expectedPostCorrectionPh: numOrNull(row, 'expected_post_correction_ph'),
    gps: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    rawFlags: num(row, 'raw_flags'),
    timestamps: {
      robotAt: str(row, 'robot_recorded_at'),
      gatewayReceivedAt: str(row, 'gateway_received_at'),
      cloudSyncedAt,
    },
  };
}

export interface RunRecord {
  id: string;
  robotId: string;
  sourceRunId: string;
  runType: RunType;
  fieldId: string | null;
  isSynthetic: boolean;
}

export function getRun(db: Database, runId: string): RunRecord | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (row === undefined) {
    return null;
  }
  return {
    id: str(row, 'id'),
    robotId: str(row, 'robot_id'),
    sourceRunId: str(row, 'source_run_id'),
    runType: str(row, 'run_type') as RunType,
    fieldId: strOrNull(row, 'field_id'),
    isSynthetic: bool(row, 'is_synthetic'),
  };
}

/** Readings of a run ordered by cell then sequence, with cloud confirmation times. */
export function listRunReadings(db: Database, run: RunRecord): CellReading[] {
  return db
    .prepare(
      `SELECT r.*, o.cloud_confirmed_at
       FROM readings AS r
       LEFT JOIN sync_outbox AS o ON o.entity_type = 'reading' AND o.entity_id = r.id
       WHERE r.run_id = ?
       ORDER BY r.cell_index, r.seq`,
    )
    .all(run.id)
    .map((row) => toCellReading(row, run.runType, strOrNull(row, 'cloud_confirmed_at')));
}
