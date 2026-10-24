import { num, numOrNull, str, type Database, type Row } from '../db/connection';
import { toCsv } from './csv';
import type { ExportRun } from './source';

/**
 * Readings per run (CLAUDE.md §9 export 1; D32). One row per stored reading,
 * i.e. per (run, cell_index, seq) — the reading identity. Retransmitted copies
 * are not repeated: the stored reading is the first copy received, and later
 * copies (duplicates, conflicts) are only counted in the delivery export.
 * Values are exactly as stored; nothing is recalculated.
 */
export const READINGS_HEADER = [
  'run_id', // firmware run id
  'run_type', // dosing | verification
  'robot_id', // firmware robot id
  'is_synthetic', // true for simulated/demo data
  'cell_index',
  'seq',
  'attempt_count', // robot's attempt number of the first copy received; numbering base unconfirmed (OPEN_ITEMS #15)
  'ph',
  'ec_unit_unconfirmed', // stored EC value; unit not confirmed (OPEN_ITEMS #7)
  'moisture_percent',
  'temperature_c',
  'dose_volume_ml', // robot's commanded volume, not a flow measurement
  'expected_post_correction_ph', // calculated on the robot
  'gps_latitude',
  'gps_longitude',
  'raw_flags',
  'robot_recorded_at', // robot clock, UTC ISO-8601
  'gateway_received_at', // gateway clock, UTC ISO-8601
] as const;

export function buildReadingsCsv(db: Database, run: ExportRun): { csv: string; rows: number } {
  const rows = db
    .prepare(
      `SELECT cell_index, seq, attempt_count, ph, ec, moisture_percent, temperature_c, dose_volume_ml,
              expected_post_correction_ph, gps_latitude, gps_longitude, raw_flags, robot_recorded_at, gateway_received_at
       FROM readings WHERE run_id = ? ORDER BY cell_index, seq`,
    )
    .all(run.id)
    .map((r) => [
      run.sourceRunId,
      run.runType,
      run.sourceRobotId,
      run.isSynthetic,
      num(r, 'cell_index'),
      num(r, 'seq'),
      num(r, 'attempt_count'),
      num(r, 'ph'),
      num(r, 'ec'),
      num(r, 'moisture_percent'),
      num(r, 'temperature_c'),
      num(r, 'dose_volume_ml'),
      numOrNull(r, 'expected_post_correction_ph'),
      numOrNull(r, 'gps_latitude'),
      numOrNull(r, 'gps_longitude'),
      num(r, 'raw_flags'),
      str(r, 'robot_recorded_at'),
      str(r, 'gateway_received_at'),
    ]);
  return { csv: toCsv(READINGS_HEADER, rows), rows: rows.length };
}

/** Internal: all stored readings of a run, keyed by cell index (used by the paired export). */
export function readingsByCell(db: Database, run: ExportRun): Map<number, StoredReading[]> {
  const byCell = new Map<number, StoredReading[]>();
  for (const r of db
    .prepare(
      `SELECT cell_index, seq, ph, ec, moisture_percent, temperature_c, dose_volume_ml, expected_post_correction_ph,
              gps_latitude, gps_longitude, robot_recorded_at
       FROM readings WHERE run_id = ? ORDER BY cell_index, seq`,
    )
    .all(run.id)) {
    const stored = toStored(r);
    byCell.set(stored.cellIndex, [...(byCell.get(stored.cellIndex) ?? []), stored]);
  }
  return byCell;
}

function toStored(r: Row) {
  return {
    cellIndex: num(r, 'cell_index'),
    seq: num(r, 'seq'),
    ph: num(r, 'ph'),
    ec: num(r, 'ec'),
    moisturePercent: num(r, 'moisture_percent'),
    temperatureC: num(r, 'temperature_c'),
    doseVolumeMl: num(r, 'dose_volume_ml'),
    expectedPostCorrectionPh: numOrNull(r, 'expected_post_correction_ph'),
    gpsLatitude: numOrNull(r, 'gps_latitude'),
    gpsLongitude: numOrNull(r, 'gps_longitude'),
    robotRecordedAt: str(r, 'robot_recorded_at'),
  };
}

export type StoredReading = ReturnType<typeof toStored>;
