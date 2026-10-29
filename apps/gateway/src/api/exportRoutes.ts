import type { ApiErrorCode, ExportCsvResponse, ExportKind, ExportRunSummary } from '@robolime/shared';

import { bool, num, str, strOrNull, type Database } from '../db/connection';
import { buildDeliveryCsv } from '../exports/deliveryExport';
import { buildPairedCsv } from '../exports/pairedExport';
import { buildReadingsCsv } from '../exports/readingsExport';
import { ExportError, type ExportRun } from '../exports/source';

/**
 * Research exports over the loopback API (D54). They build exactly the CSV
 * that `npm run export:csv` writes (same builders, same headers, D32), and
 * return it as JSON for the export area to download. Read-only: nothing is
 * written to the database or the disk. Only the paired session's robot is
 * reachable; any other run is NOT_FOUND. Verification runs are listed here,
 * the research area, and never on farmer screens.
 */
export function listExportRuns(db: Database, robotId: string): ExportRunSummary[] {
  return db
    .prepare(
      `SELECT r.id, r.source_run_id, r.run_type, r.is_synthetic,
              COUNT(x.id) AS reading_count, MIN(x.robot_recorded_at) AS first_recorded
       FROM runs AS r LEFT JOIN readings AS x ON x.run_id = r.id
       WHERE r.robot_id = ?
       GROUP BY r.id ORDER BY first_recorded DESC, r.id`,
    )
    .all(robotId)
    .map((row) => ({
      id: str(row, 'id'),
      sourceRunId: str(row, 'source_run_id'),
      runType: str(row, 'run_type') as ExportRunSummary['runType'],
      readingCount: num(row, 'reading_count'),
      firstRobotRecordedAt: strOrNull(row, 'first_recorded'),
      isSynthetic: bool(row, 'is_synthetic'),
    }));
}

type Result = { ok: true; value: ExportCsvResponse } | { ok: false; code: ApiErrorCode; message: string };
const KINDS: readonly ExportKind[] = ['readings', 'paired', 'delivery'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function exportRun(db: Database, robotId: string, runId: string): ExportRun | null {
  const row = db
    .prepare(
      `SELECT r.id, r.source_run_id, r.run_type, r.robot_id, r.field_id, r.is_synthetic, b.source_robot_id
       FROM runs AS r JOIN robots AS b ON b.id = r.robot_id WHERE r.id = ? AND r.robot_id = ?`,
    )
    .get(runId, robotId);
  if (row === undefined) return null;
  return {
    id: str(row, 'id'),
    sourceRunId: str(row, 'source_run_id'),
    runType: str(row, 'run_type') as ExportRun['runType'],
    robotId: str(row, 'robot_id'),
    sourceRobotId: str(row, 'source_robot_id'),
    fieldId: strOrNull(row, 'field_id'),
    isSynthetic: bool(row, 'is_synthetic'),
  };
}

/** Splits one CSV line (RFC 4180 quoting) into fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

function deliverySummary(csv: string): ExportCsvResponse['delivery'] {
  const [header = '', row = ''] = csv.replace(/\r\n/g, '\n').split('\n');
  const names = splitCsvLine(header);
  const values = splitCsvLine(row);
  const get = (name: string) => values[names.indexOf(name)] ?? '';
  const n = (name: string) => (get(name) === '' ? null : Number(get(name)));
  return {
    completenessNumerator: n('completeness_numerator'),
    completenessDenominator: n('completeness_denominator'),
    completenessNote: get('completeness_note'),
    firstAttemptNote: get('first_attempt_note'),
  };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

export function buildExportCsv(db: Database, robotId: string, body: unknown): Result {
  if (!isRecord(body) || typeof body.kind !== 'string' || !KINDS.includes(body.kind as ExportKind) || typeof body.runId !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'Send {"kind": "readings|paired|delivery", "runId": "<id>"}.' };
  }
  const kind = body.kind as ExportKind;
  const run = exportRun(db, robotId, body.runId);
  if (run === null) return { ok: false, code: 'NOT_FOUND', message: 'No such run for this robot.' };
  try {
    if (kind === 'paired') {
      if (typeof body.verificationRunId !== 'string') {
        return { ok: false, code: 'BAD_REQUEST', message: 'The paired export needs "verificationRunId".' };
      }
      const verification = exportRun(db, robotId, body.verificationRunId);
      if (verification === null) return { ok: false, code: 'NOT_FOUND', message: 'No such verification run for this robot.' };
      const r = buildPairedCsv(db, run, verification);
      return {
        ok: true,
        value: {
          kind, filename: `paired_${safeName(run.sourceRunId)}_${safeName(verification.sourceRunId)}.csv`,
          csv: r.csv, rows: r.rows, pairCounts: r.counts, delivery: null,
        },
      };
    }
    const r = kind === 'readings' ? buildReadingsCsv(db, run) : buildDeliveryCsv(db, run);
    return {
      ok: true,
      value: {
        kind, filename: `${kind}_${safeName(run.sourceRunId)}.csv`, csv: r.csv, rows: r.rows, pairCounts: null,
        delivery: kind === 'delivery' ? deliverySummary(r.csv) : null,
      },
    };
  } catch (error) {
    // assertComparablePair and the builders explain refusals (e.g. a dosing run paired with a dosing run).
    if (error instanceof ExportError) return { ok: false, code: 'BAD_REQUEST', message: error.message };
    throw error;
  }
}
