import type { Database } from '../db/connection';
import { toCsv, type CsvValue } from './csv';
import { readingsByCell, type StoredReading } from './readingsExport';
import { ExportError, type ExportRun } from './source';

/**
 * Paired dosing and verification export (CLAUDE.md §9 export 2; D32).
 *
 * The schema records no link between a dosing run and its verification run,
 * so the researcher names both; rows are paired ONLY by cell index. One row
 * per cell index present in either run, in ascending order. `pair_status`:
 * - `paired`: exactly one stored reading for the cell in each run.
 * - `missing_verification` / `missing_dosing`: the cell is in one run only;
 *   that run's values are filled, the other side is empty.
 * - `ambiguous_multiple_readings`: a run holds more than one reading (seq)
 *   for the cell. No reading is chosen: every value column is empty and only
 *   the counts are given.
 * `elapsed_seconds` = verification `robot_recorded_at` − dosing
 * `robot_recorded_at` (both robot clock, OPEN_ITEMS #8); positive when the
 * verification reading is later. Nothing is calculated except this
 * difference; expected post-correction pH is the robot's stored value.
 * Verification values are research data and appear only in this export.
 */
export const PAIRED_HEADER = [
  'cell_index',
  'pair_status',
  'dosing_run_id',
  'verification_run_id',
  'robot_id',
  'is_synthetic',
  'dosing_reading_count',
  'verification_reading_count',
  'dosing_seq',
  'verification_seq',
  'baseline_ph', // measured in the dosing run
  'baseline_ec_unit_unconfirmed', // unit not confirmed (OPEN_ITEMS #7)
  'baseline_moisture_percent',
  'baseline_temperature_c',
  'dose_volume_ml', // commanded volume
  'expected_post_correction_ph', // robot-calculated, from the dosing reading
  'observed_post_treatment_ph', // measured in the verification run
  'verification_ec_unit_unconfirmed',
  'verification_moisture_percent',
  'verification_temperature_c',
  'dosing_gps_latitude',
  'dosing_gps_longitude',
  'dosing_robot_recorded_at',
  'verification_robot_recorded_at',
  'elapsed_seconds', // verification minus dosing, robot clock
] as const;

export type PairStatus = 'paired' | 'missing_verification' | 'missing_dosing' | 'ambiguous_multiple_readings';

export type PairCounts = Record<PairStatus, number>;

/** Refuses run combinations that cannot be compared. */
export function assertComparablePair(dosing: ExportRun, verification: ExportRun): void {
  if (dosing.runType !== 'dosing') throw new ExportError(`Run "${dosing.sourceRunId}" is a ${dosing.runType} run, not a dosing run.`);
  if (verification.runType !== 'verification') {
    throw new ExportError(`Run "${verification.sourceRunId}" is a ${verification.runType} run, not a verification run.`);
  }
  if (dosing.robotId !== verification.robotId) {
    throw new ExportError('The dosing and verification runs belong to different robots and cannot be paired.');
  }
  if (dosing.fieldId !== null && verification.fieldId !== null && dosing.fieldId !== verification.fieldId) {
    throw new ExportError('The dosing and verification runs were recorded on different fields and cannot be paired.');
  }
}

export function buildPairedCsv(
  db: Database,
  dosing: ExportRun,
  verification: ExportRun,
): { csv: string; rows: number; counts: PairCounts } {
  assertComparablePair(dosing, verification);
  const d = readingsByCell(db, dosing);
  const v = readingsByCell(db, verification);
  const cells = [...new Set([...d.keys(), ...v.keys()])].sort((a, b) => a - b);
  const counts: PairCounts = { paired: 0, missing_verification: 0, missing_dosing: 0, ambiguous_multiple_readings: 0 };

  const rows = cells.map((cellIndex): CsvValue[] => {
    const ds = d.get(cellIndex) ?? [];
    const vs = v.get(cellIndex) ?? [];
    const status: PairStatus =
      ds.length > 1 || vs.length > 1
        ? 'ambiguous_multiple_readings'
        : ds.length === 0
          ? 'missing_dosing'
          : vs.length === 0
            ? 'missing_verification'
            : 'paired';
    counts[status] += 1;
    const one = (list: StoredReading[]): StoredReading | null => (status !== 'ambiguous_multiple_readings' && list.length === 1 ? (list[0] ?? null) : null);
    const dr = one(ds);
    const vr = one(vs);
    const elapsed = dr && vr ? (Date.parse(vr.robotRecordedAt) - Date.parse(dr.robotRecordedAt)) / 1000 : null;
    return [
      cellIndex,
      status,
      dosing.sourceRunId,
      verification.sourceRunId,
      dosing.sourceRobotId,
      dosing.isSynthetic || verification.isSynthetic,
      ds.length,
      vs.length,
      dr?.seq ?? null,
      vr?.seq ?? null,
      dr?.ph ?? null,
      dr?.ec ?? null,
      dr?.moisturePercent ?? null,
      dr?.temperatureC ?? null,
      dr?.doseVolumeMl ?? null,
      dr?.expectedPostCorrectionPh ?? null,
      vr?.ph ?? null,
      vr?.ec ?? null,
      vr?.moisturePercent ?? null,
      vr?.temperatureC ?? null,
      dr?.gpsLatitude ?? null,
      dr?.gpsLongitude ?? null,
      dr?.robotRecordedAt ?? null,
      vr?.robotRecordedAt ?? null,
      elapsed,
    ];
  });
  return { csv: toCsv(PAIRED_HEADER, rows), rows: rows.length, counts };
}
