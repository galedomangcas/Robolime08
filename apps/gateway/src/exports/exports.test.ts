import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import { DatabaseMissingError, initDatabase } from '../db/init';
import { recordReading } from '../store/readings';
import { provisionField } from '../store/robots';
import { addTestRobot, T0, tempDir, testReading } from '../test/helpers';
import { parseCsv } from '../test/csv';
import { DELIVERY_HEADER, FIRST_ATTEMPT_NOT_COMPUTED } from './deliveryExport';
import { EXPORT_KINDS, ExportArgsError, parseExportArgs, runExport, type ExportArgs } from './exportCommand';
import { PAIRED_HEADER } from './pairedExport';
import { READINGS_HEADER } from './readingsExport';
import { ExportError, openDatabaseReadOnly } from './source';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

/**
 * SYNTHETIC fixture, written through the real ingest path (recordReading), so
 * receipts, duplicates and conflicts are produced by production code:
 * - field with total_cells 5 (cells 0–4)
 * - D-1 (dosing): cells 0 (+1 duplicate copy), 1 (+1 duplicate copy), 2 (+1 conflicting copy),
 *   3 (seq 0 and seq 1), 5 (index = total_cells: first index outside the field)
 * - V-1 (verification): cells 0, 1, 3, 4
 * - N-1 (dosing) on a second robot with no field
 */
function fixture() {
  const tmp = tempDir();
  cleanup = tmp.cleanup;
  const path = tmp.path('gateway.sqlite');
  const db: Database = initDatabase(path, 'field', T0);
  const robot = addTestRobot(db);
  provisionField(
    db,
    {
      robotId: robot.id,
      fieldKey: 'SYNTHETIC-FIELD',
      name: 'Synthetic test field',
      locationLabel: 'Synthetic',
      areaSquareMeters: null,
      cellSizeMeters: 2,
      totalCells: 5,
      cells: [0, 1, 2, 3, 4].map((cellIndex) => ({ cellIndex, gridRow: null, gridColumn: null, center: null })),
      isSynthetic: true,
    },
    T0,
  );
  const dosing = (cellIndex: number, seq = 0, extra = {}) =>
    testReading({ sourceRunId: 'D-1', runType: 'dosing', cellIndex, seq, ph: 5 + cellIndex / 10, robotRecordedAt: at(cellIndex * 60_000), ...extra });
  const verify = (cellIndex: number) =>
    testReading({
      sourceRunId: 'V-1',
      runType: 'verification',
      cellIndex,
      seq: 0,
      ph: 6 + cellIndex / 10,
      expectedPostCorrectionPh: null,
      doseVolumeMl: 0,
      robotRecordedAt: at(DAY + cellIndex * 60_000),
    });
  const received = new Date(T0.getTime() + 1_000);
  for (const r of [dosing(0), dosing(1), dosing(2), dosing(3, 0), dosing(3, 1), dosing(5, 0, { gps: { latitude: 13.88, longitude: 120.63 } })]) {
    recordReading(db, r, received);
  }
  recordReading(db, dosing(1, 0, { attemptCount: 2 }), received); // duplicate copy (retry after lost ACK)
  recordReading(db, dosing(0, 0, { attemptCount: 3 }), received); // a second duplicate, on another reading
  recordReading(db, dosing(2, 0, { attemptCount: 2, ph: 9.99 }), received); // conflicting copy: original kept
  for (const c of [0, 1, 3, 4]) recordReading(db, verify(c), received);
  addTestRobot(db, 'TEST-ROBOT-2');
  recordReading(db, testReading({ sourceRobotId: 'TEST-ROBOT-2', sourceRunId: 'N-1' }), received);
  db.close();
  return { tmp, path };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function exportTo(path: string, out: string, partial: Partial<ExportArgs>) {
  return runExport({ dbPath: path, kind: 'readings', run: 'D-1', verificationRun: null, robot: null, outPath: out, ...partial });
}

function read(out: string) {
  const [header, ...rows] = parseCsv(readFileSync(out, 'utf8'));
  const objects = rows.map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i]])) as Record<string, string>);
  return { header, rows: objects };
}

describe('export:csv arguments', () => {
  it('requires explicit --db, --kind, --run and --out, and --verification-run exactly for paired', () => {
    const ok = { db: 'g.sqlite', kind: 'readings', run: 'D-1', out: 'o.csv' };
    expect(parseExportArgs(ok)).toEqual({ dbPath: 'g.sqlite', kind: 'readings', run: 'D-1', verificationRun: null, robot: null, outPath: 'o.csv' });
    expect(EXPORT_KINDS).toEqual(['readings', 'paired', 'delivery']);
    expect(() => parseExportArgs({ ...ok, db: undefined })).toThrow(/--db/);
    expect(() => parseExportArgs({ ...ok, kind: 'readings|paired|delivery' })).toThrow(ExportArgsError);
    expect(() => parseExportArgs({ ...ok, run: ' ' })).toThrow(/--run/);
    expect(() => parseExportArgs({ ...ok, out: undefined })).toThrow(/--out/);
    expect(() => parseExportArgs({ ...ok, kind: 'paired' })).toThrow(/--verification-run .* required/);
    expect(() => parseExportArgs({ ...ok, 'verification-run': 'V-1' })).toThrow(/only used with --kind paired/);
    expect(parseExportArgs({ ...ok, kind: 'paired', 'verification-run': 'V-1', robot: 'TEST-ROBOT-1' })).toMatchObject({
      verificationRun: 'V-1',
      robot: 'TEST-ROBOT-1',
    });
  });
});

describe('readings export', () => {
  it('has a stable header and one row per stored reading, ordered by cell then seq, with values exactly as stored', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('readings.csv');
    expect(exportTo(path, out, {})).toMatchObject({ kind: 'readings', rows: 6, databasePurpose: 'field' });
    const { header, rows } = read(out);
    expect(header).toEqual([...READINGS_HEADER]);
    expect(rows.map((r) => [r.cell_index, r.seq])).toEqual([['0', '0'], ['1', '0'], ['2', '0'], ['3', '0'], ['3', '1'], ['5', '0']]);
    const cell2 = rows[2] as Record<string, string>;
    expect(cell2).toMatchObject({
      run_id: 'D-1',
      run_type: 'dosing',
      robot_id: 'TEST-ROBOT-1',
      is_synthetic: 'true',
      attempt_count: '1', // the first copy, not the conflicting retry
      ph: '5.2', // the original, not the conflicting 9.99
      ec_unit_unconfirmed: '0.3',
      moisture_percent: '25',
      temperature_c: '27',
      dose_volume_ml: '50',
      expected_post_correction_ph: '5.9',
      gps_latitude: '',
      gps_longitude: '',
      raw_flags: '0',
      robot_recorded_at: '2026-03-01T00:02:00.000Z',
      gateway_received_at: '2026-03-01T00:00:01.000Z',
    });
    expect(rows[5]).toMatchObject({ cell_index: '5', gps_latitude: '13.88', gps_longitude: '120.63' });
  });

  it('exports a verification run too (research data), with an empty expected pH where none was reported', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('v.csv');
    exportTo(path, out, { run: 'V-1' });
    const { rows } = read(out);
    expect(rows.map((r) => r.cell_index)).toEqual(['0', '1', '3', '4']);
    expect(rows.every((r) => r.run_type === 'verification' && r.expected_post_correction_ph === '')).toBe(true);
  });

  it('quotes awkward identifiers so they round-trip exactly', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('g.sqlite');
    const db = initDatabase(path, 'demo', T0);
    addTestRobot(db);
    const awkward = 'R,"7"\nüñ土';
    recordReading(db, testReading({ sourceRunId: awkward }), T0);
    db.close();
    exportTo(path, tmp.path('a.csv'), { run: awkward });
    expect(read(tmp.path('a.csv')).rows[0]?.run_id).toBe(awkward);
  });
});

describe('paired dosing/verification export', () => {
  it('pairs only by cell index and reports every unmatched or ambiguous cell explicitly', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('paired.csv');
    const summary = exportTo(path, out, { kind: 'paired', run: 'D-1', verificationRun: 'V-1' });
    expect(summary.pairCounts).toEqual({ paired: 2, missing_verification: 2, missing_dosing: 1, ambiguous_multiple_readings: 1 });
    const { header, rows } = read(out);
    expect(header).toEqual([...PAIRED_HEADER]);
    expect(rows.map((r) => [r.cell_index, r.pair_status])).toEqual([
      ['0', 'paired'],
      ['1', 'paired'],
      ['2', 'missing_verification'],
      ['3', 'ambiguous_multiple_readings'],
      ['4', 'missing_dosing'],
      ['5', 'missing_verification'],
    ]);

    const cell1 = rows[1] as Record<string, string>;
    expect(cell1).toMatchObject({
      dosing_run_id: 'D-1',
      verification_run_id: 'V-1',
      dosing_reading_count: '1',
      verification_reading_count: '1',
      baseline_ph: '5.1',
      expected_post_correction_ph: '5.9', // stored robot value, not recalculated
      observed_post_treatment_ph: '6.1',
      elapsed_seconds: '86400', // verification minus dosing, robot clock
      dosing_robot_recorded_at: '2026-03-01T00:01:00.000Z',
      verification_robot_recorded_at: '2026-03-02T00:01:00.000Z',
    });
  });

  it('never chooses between multiple readings: an ambiguous cell has counts but no values', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('p.csv');
    exportTo(path, out, { kind: 'paired', run: 'D-1', verificationRun: 'V-1' });
    const cell3 = read(out).rows[3] as Record<string, string>;
    expect(cell3.dosing_reading_count).toBe('2');
    expect(cell3.verification_reading_count).toBe('1');
    for (const column of ['dosing_seq', 'verification_seq', 'baseline_ph', 'expected_post_correction_ph', 'observed_post_treatment_ph', 'elapsed_seconds']) {
      expect(cell3[column], column).toBe('');
    }
  });

  it('treats multiple readings on the verification side as ambiguous too', () => {
    const { tmp, path } = fixture();
    const db = initDatabase(path, 'field', T0);
    recordReading(
      db,
      testReading({ sourceRunId: 'V-1', runType: 'verification', cellIndex: 1, seq: 1, expectedPostCorrectionPh: null, robotRecordedAt: at(DAY) }),
      T0,
    );
    db.close();
    const out = tmp.path('p.csv');
    const summary = exportTo(path, out, { kind: 'paired', run: 'D-1', verificationRun: 'V-1' });
    expect(summary.pairCounts).toMatchObject({ paired: 1, ambiguous_multiple_readings: 2 });
    expect(read(out).rows[1]).toMatchObject({
      cell_index: '1',
      pair_status: 'ambiguous_multiple_readings',
      dosing_reading_count: '1',
      verification_reading_count: '2',
      baseline_ph: '',
      observed_post_treatment_ph: '',
    });
  });

  it('fills only the side that exists for an unmatched cell, and never invents the other', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('p.csv');
    exportTo(path, out, { kind: 'paired', run: 'D-1', verificationRun: 'V-1' });
    const { rows } = read(out);
    expect(rows[2]).toMatchObject({ baseline_ph: '5.2', observed_post_treatment_ph: '', elapsed_seconds: '', verification_seq: '' });
    expect(rows[4]).toMatchObject({ baseline_ph: '', expected_post_correction_ph: '', observed_post_treatment_ph: '6.4', elapsed_seconds: '' });
  });

  it('refuses incompatible pairs: wrong run types, swapped runs, different robots', () => {
    const { tmp, path } = fixture();
    const paired = (run: string, verificationRun: string, n: number) =>
      exportTo(path, tmp.path(`x${n}.csv`), { kind: 'paired', run, verificationRun });
    expect(() => paired('V-1', 'D-1', 1)).toThrow(/not a dosing run/);
    expect(() => paired('D-1', 'D-1', 2)).toThrow(/not a verification run/);
    expect(() => paired('N-1', 'V-1', 3)).toThrow(/different robots/);
    for (const n of [1, 2, 3]) expect(existsSync(tmp.path(`x${n}.csv`))).toBe(false); // nothing written on refusal
  });
});

describe('delivery export', () => {
  it('reports counts with explicit numerator and denominator; first-attempt ratio is not computed (OPEN_ITEMS #15)', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('delivery.csv');
    exportTo(path, out, { kind: 'delivery' });
    const { header, rows } = read(out);
    expect(header).toEqual([...DELIVERY_HEADER]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      run_id: 'D-1',
      run_type: 'dosing',
      robot_id: 'TEST-ROBOT-1',
      is_synthetic: 'true',
      readings_stored: '6',
      distinct_cells_received: '5',
      receipts_total: '9',
      receipts_inserted: '6',
      receipts_duplicate: '2',
      receipts_conflict: '1',
      readings_with_retransmissions: '3',
      expected_cells: '5',
      expected_cells_source: 'fields.total_cells',
      completeness_numerator: '4', // cells 0–3 of 0–4; cell 5 (= total_cells) is outside the field
      completeness_denominator: '5',
      post_retry_completeness: '0.8',
      cells_outside_field: '1',
      completeness_note: '',
      first_attempt_delivery_ratio: '',
      first_attempt_note: FIRST_ATTEMPT_NOT_COMPUTED,
    });
  });

  it('leaves completeness empty, with the reason, when the run has no field', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('d.csv');
    exportTo(path, out, { kind: 'delivery', run: 'N-1' });
    expect(read(out).rows[0]).toMatchObject({
      readings_stored: '1',
      expected_cells: '',
      expected_cells_source: '',
      completeness_numerator: '',
      completeness_denominator: '',
      post_retry_completeness: '',
      cells_outside_field: '',
      completeness_note: 'expected cell count unknown: the run has no recorded field (OPEN_ITEMS #13)',
    });
  });

  it('leaves completeness empty when the field has no total_cells', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('g.sqlite');
    const db = initDatabase(path, 'demo', T0);
    const robot = addTestRobot(db);
    provisionField(
      db,
      { robotId: robot.id, fieldKey: 'F', name: 'F', locationLabel: 'S', areaSquareMeters: null, cellSizeMeters: 2, totalCells: null, cells: [], isSynthetic: true },
      T0,
    );
    recordReading(db, testReading(), T0);
    db.close();
    exportTo(path, tmp.path('d.csv'), { kind: 'delivery', run: 'RUN-1' });
    expect(read(tmp.path('d.csv')).rows[0]).toMatchObject({
      post_retry_completeness: '',
      completeness_note: 'expected cell count unknown: the field has no total_cells (OPEN_ITEMS #13)',
    });
  });
});

describe('spreadsheet formula injection', () => {
  /** SYNTHETIC: robot and run identifiers chosen to look like formulas. */
  function hostileFixture() {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('g.sqlite');
    const db = initDatabase(path, 'demo', T0);
    const robot = addTestRobot(db, '@ROBOT');
    provisionField(
      db,
      { robotId: robot.id, fieldKey: 'F', name: 'F', locationLabel: 'S', areaSquareMeters: null, cellSizeMeters: 2, totalCells: 2, cells: [], isSynthetic: true },
      T0,
    );
    const base = { sourceRobotId: '@ROBOT', cellIndex: 0, seq: 0, ph: 5.25, temperatureC: -1.5 };
    recordReading(db, testReading({ ...base, sourceRunId: '=HYPERLINK("http://example.invalid")', runType: 'dosing' }), T0);
    recordReading(db, testReading({ ...base, sourceRunId: ' +V-1', runType: 'verification', expectedPostCorrectionPh: null }), T0);
    db.close();
    return { tmp, path, before: sha256(path) };
  }
  const D = '=HYPERLINK("http://example.invalid")';
  const V = ' +V-1';

  it('neutralizes formula-like identifiers in every export, and leaves measurements numeric', () => {
    const { tmp, path, before } = hostileFixture();
    exportTo(path, tmp.path('r.csv'), { run: D, robot: '@ROBOT' });
    exportTo(path, tmp.path('p.csv'), { kind: 'paired', run: D, verificationRun: V, robot: '@ROBOT' });
    exportTo(path, tmp.path('d.csv'), { kind: 'delivery', run: D, robot: '@ROBOT' });

    expect(read(tmp.path('r.csv')).rows[0]).toMatchObject({ run_id: `'${D}`, robot_id: "'@ROBOT", ph: '5.25', temperature_c: '-1.5' });
    expect(read(tmp.path('p.csv')).rows[0]).toMatchObject({
      dosing_run_id: `'${D}`,
      verification_run_id: `' +V-1`,
      robot_id: "'@ROBOT",
      pair_status: 'paired',
      baseline_temperature_c: '-1.5',
      verification_temperature_c: '-1.5',
      elapsed_seconds: '0',
    });
    expect(read(tmp.path('d.csv')).rows[0]).toMatchObject({
      run_id: `'${D}`,
      robot_id: "'@ROBOT",
      post_retry_completeness: '0.5',
      completeness_note: '',
    });
    // No raw cell anywhere starts with a formula trigger.
    for (const file of ['r.csv', 'p.csv', 'd.csv']) {
      for (const row of parseCsv(readFileSync(tmp.path(file), 'utf8'))) {
        for (const cell of row) expect(/^[\s\u0000-\u001f]*[=+@]/.test(cell) || /^-(?!\d)/.test(cell), `${file}: ${cell}`).toBe(false);
      }
    }
    expect(sha256(path)).toBe(before); // the database keeps the original identifiers
  });

  it('still resolves runs by their real (un-neutralized) identifiers', () => {
    const { tmp, path } = hostileFixture();
    expect(() => exportTo(path, tmp.path('x.csv'), { run: `'${D}`, robot: '@ROBOT' })).toThrow(/No run/);
    expect(exportTo(path, tmp.path('y.csv'), { run: D, robot: '@ROBOT' }).rows).toBe(1);
  });
});

describe('export safety', () => {
  it('never changes the database: byte-identical after every export kind, and the connection cannot write', () => {
    const { tmp, path } = fixture();
    const before = sha256(path);
    exportTo(path, tmp.path('1.csv'), {});
    exportTo(path, tmp.path('2.csv'), { kind: 'paired', run: 'D-1', verificationRun: 'V-1' });
    exportTo(path, tmp.path('3.csv'), { kind: 'delivery' });
    expect(sha256(path)).toBe(before);
    const { db } = openDatabaseReadOnly(path);
    expect(() => db.exec("UPDATE gateway_settings SET value = 'x'")).toThrow(/readonly/i);
    db.close();
    expect(sha256(path)).toBe(before);
  });

  it('refuses to overwrite an existing file and leaves it untouched', () => {
    const { tmp, path } = fixture();
    const out = tmp.path('existing.csv');
    writeFileSync(out, 'keep me');
    expect(() => exportTo(path, out, {})).toThrow(/already exists; refusing to overwrite/);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
  });

  it('reports a missing database, a non-gateway file, an unknown run and a missing output folder clearly', () => {
    const { tmp, path } = fixture();
    expect(() => exportTo(tmp.path('typo.sqlite'), tmp.path('o.csv'), {})).toThrow(DatabaseMissingError);
    writeFileSync(tmp.path('not-a-db.sqlite'), 'plain text');
    expect(() => exportTo(tmp.path('not-a-db.sqlite'), tmp.path('o.csv'), {})).toThrow();
    expect(() => exportTo(path, tmp.path('o.csv'), { run: 'NOPE' })).toThrow(/No run "NOPE"/);
    expect(() => exportTo(path, tmp.path('missing-folder/o.csv'), {})).toThrow(/folder does not exist/);
    expect(existsSync(tmp.path('o.csv'))).toBe(false);
  });

  it('asks for --robot when a run id exists for more than one robot', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('g.sqlite');
    const db = initDatabase(path, 'demo', T0);
    addTestRobot(db, 'TEST-ROBOT-1');
    addTestRobot(db, 'TEST-ROBOT-2');
    recordReading(db, testReading({ sourceRobotId: 'TEST-ROBOT-1', sourceRunId: 'SAME' }), T0);
    recordReading(db, testReading({ sourceRobotId: 'TEST-ROBOT-2', sourceRunId: 'SAME' }), T0);
    db.close();
    expect(() => exportTo(path, tmp.path('o.csv'), { run: 'SAME' })).toThrow(ExportError);
    expect(() => exportTo(path, tmp.path('o.csv'), { run: 'SAME' })).toThrow(/--robot/);
    expect(exportTo(path, tmp.path('o.csv'), { run: 'SAME', robot: 'TEST-ROBOT-2' }).rows).toBe(1);
    expect(read(tmp.path('o.csv')).rows[0]?.robot_id).toBe('TEST-ROBOT-2');
  });
});
