import { num, numOrNull, type Database } from '../db/connection';
import { toCsv } from './csv';
import type { ExportRun } from './source';

/**
 * Delivery export (CLAUDE.md §9 export 3; D32). One row for the run.
 *
 * Evidence: `readings` holds one row per reading identity (run, cell_index,
 * seq), stored from the first copy received; `reading_receipts` holds every
 * received copy with its outcome (inserted / duplicate / conflict) and the
 * robot's attempt number. Copies the gateway never received leave no trace.
 *
 * Post-retry completeness = distinct cell indices with at least one stored
 * reading and 0 <= cell_index < expected_cells, divided by expected_cells.
 * expected_cells is the run's field `total_cells` (runs.field_id → fields),
 * whose valid cell indices are 0 … total_cells − 1 (enforced when the field is
 * provisioned). When the run has no field or the field has no total, the
 * metric is left empty and `completeness_note` says why (OPEN_ITEMS #13).
 *
 * First-attempt delivery ratio is NOT computed: whether attempt numbers start
 * at 0 or 1 is unconfirmed (OPEN_ITEMS #15). The column stays in the header,
 * always empty, with the reason in `first_attempt_note`; the raw attempt
 * numbers are in the readings export.
 */
export const DELIVERY_HEADER = [
  'run_id',
  'run_type',
  'robot_id',
  'is_synthetic',
  'readings_stored', // distinct (cell_index, seq)
  'distinct_cells_received',
  'receipts_total', // every copy received
  'receipts_inserted',
  'receipts_duplicate',
  'receipts_conflict',
  'readings_with_retransmissions', // readings received more than once
  'expected_cells',
  'expected_cells_source',
  'completeness_numerator',
  'completeness_denominator',
  'post_retry_completeness',
  'cells_outside_field', // distinct received cells with cell_index >= expected_cells
  'completeness_note',
  'first_attempt_delivery_ratio',
  'first_attempt_note',
] as const;

export const FIRST_ATTEMPT_NOT_COMPUTED =
  'not computed: attempt numbering base (0 or 1) is unconfirmed (OPEN_ITEMS #15)';

export function buildDeliveryCsv(db: Database, run: ExportRun): { csv: string; rows: number } {
  const totals = db
    .prepare('SELECT COUNT(*) AS readings, COUNT(DISTINCT cell_index) AS cells FROM readings WHERE run_id = ?')
    .get(run.id);
  const receipts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(c.outcome = 'inserted'), 0) AS inserted,
              COALESCE(SUM(c.outcome = 'duplicate'), 0) AS duplicate,
              COALESCE(SUM(c.outcome = 'conflict'), 0) AS conflict
       FROM reading_receipts AS c JOIN readings AS r ON r.id = c.reading_id
       WHERE r.run_id = ?`,
    )
    .get(run.id);
  const retransmitted = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT c.reading_id FROM reading_receipts AS c JOIN readings AS r ON r.id = c.reading_id
         WHERE r.run_id = ? GROUP BY c.reading_id HAVING COUNT(*) > 1)`,
    )
    .get(run.id);

  const field = run.fieldId === null ? undefined : db.prepare('SELECT total_cells FROM fields WHERE id = ?').get(run.fieldId);
  const expected = field === undefined ? null : numOrNull(field, 'total_cells');
  let numerator: number | null = null;
  let outside: number | null = null;
  let note: string | null = null;
  if (run.fieldId === null) {
    note = 'expected cell count unknown: the run has no recorded field (OPEN_ITEMS #13)';
  } else if (expected === null) {
    note = 'expected cell count unknown: the field has no total_cells (OPEN_ITEMS #13)';
  } else {
    const inRange = db
      .prepare('SELECT COUNT(DISTINCT cell_index) AS n FROM readings WHERE run_id = ? AND cell_index < ?')
      .get(run.id, expected);
    const beyond = db
      .prepare('SELECT COUNT(DISTINCT cell_index) AS n FROM readings WHERE run_id = ? AND cell_index >= ?')
      .get(run.id, expected);
    numerator = inRange === undefined ? 0 : num(inRange, 'n');
    outside = beyond === undefined ? 0 : num(beyond, 'n');
  }

  const n = (row: typeof totals, column: string) => (row === undefined ? 0 : num(row, column));
  const row = [
    run.sourceRunId,
    run.runType,
    run.sourceRobotId,
    run.isSynthetic,
    n(totals, 'readings'),
    n(totals, 'cells'),
    n(receipts, 'total'),
    n(receipts, 'inserted'),
    n(receipts, 'duplicate'),
    n(receipts, 'conflict'),
    n(retransmitted, 'n'),
    expected,
    expected === null ? null : 'fields.total_cells',
    numerator,
    expected,
    numerator === null || expected === null ? null : numerator / expected,
    outside,
    note,
    null,
    FIRST_ATTEMPT_NOT_COMPUTED,
  ];
  return { csv: toCsv(DELIVERY_HEADER, [row]), rows: 1 };
}
