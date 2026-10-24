import { nodeFileOps, publishNewFile, type FileOps, type PublishResult } from './atomicWrite';
import { buildDeliveryCsv } from './deliveryExport';
import { buildPairedCsv, type PairCounts } from './pairedExport';
import { buildReadingsCsv } from './readingsExport';
import { ExportError, openDatabaseReadOnly, resolveRun } from './source';

/**
 * `export:csv` (D32): writes one research CSV from a local gateway database.
 * Read-only on the database, offline, and never overwrites a file.
 */
export const EXPORT_KINDS = ['readings', 'paired', 'delivery'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportArgs {
  dbPath: string;
  kind: ExportKind;
  run: string;
  verificationRun: string | null;
  robot: string | null;
  outPath: string;
}

export class ExportArgsError extends Error {
  override name = 'ExportArgsError';
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

/** Validates CLI values. `--db` and `--out` are always explicit; GATEWAY_DB_PATH is not used. */
export function parseExportArgs(values: {
  db?: string;
  kind?: string;
  run?: string;
  'verification-run'?: string;
  robot?: string;
  out?: string;
}): ExportArgs {
  if (!present(values.db)) throw new ExportArgsError('--db <database file> is required.');
  if (!present(values.kind) || !(EXPORT_KINDS as readonly string[]).includes(values.kind)) {
    throw new ExportArgsError(`--kind must be one of: ${EXPORT_KINDS.join(', ')}.`);
  }
  const kind = values.kind as ExportKind;
  if (!present(values.run)) throw new ExportArgsError('--run <firmware run id> is required.');
  const verification = values['verification-run'];
  if (kind === 'paired' && !present(verification)) {
    throw new ExportArgsError('--verification-run <firmware run id> is required for --kind paired.');
  }
  if (kind !== 'paired' && verification !== undefined) {
    throw new ExportArgsError('--verification-run is only used with --kind paired.');
  }
  if (!present(values.out)) throw new ExportArgsError('--out <new file> is required.');
  return {
    dbPath: values.db,
    kind,
    run: values.run,
    verificationRun: kind === 'paired' ? (verification as string) : null,
    robot: present(values.robot) ? values.robot : null,
    outPath: values.out,
  };
}

export interface ExportSummary {
  kind: ExportKind;
  outPath: string;
  rows: number;
  /** Paired export only. */
  pairCounts: PairCounts | null;
  databasePurpose: 'field' | 'demo';
  /** A temporary file that could not be removed after a successful export, if any. */
  leftoverTempFile: string | null;
}

/**
 * Builds the CSV completely, then publishes it atomically under the new name
 * (`publishNewFile`): never overwrites, and never leaves a partial file under
 * that name. `ops` is for tests only.
 */
export function runExport(args: ExportArgs, ops: FileOps = nodeFileOps): ExportSummary {
  const { db, purpose } = openDatabaseReadOnly(args.dbPath);
  let result: { csv: string; rows: number; counts?: PairCounts };
  try {
    const run = resolveRun(db, args.run, args.robot ?? undefined);
    if (args.kind === 'readings') result = buildReadingsCsv(db, run);
    else if (args.kind === 'delivery') result = buildDeliveryCsv(db, run);
    else result = buildPairedCsv(db, run, resolveRun(db, args.verificationRun ?? '', args.robot ?? undefined));
  } finally {
    db.close();
  }
  let published: PublishResult;
  try {
    published = publishNewFile(args.outPath, result.csv, ops);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Keep publishNewFile's note about a temporary file it could not remove.
    const note = error instanceof Error ? (/ \(the temporary file .+ could not be removed\)$/.exec(error.message)?.[0] ?? '') : '';
    if (code === 'EEXIST') throw new ExportError(`${args.outPath} already exists; refusing to overwrite it. Choose a new --out file.${note}`);
    if (code === 'ENOENT') throw new ExportError(`Cannot create ${args.outPath}: its folder does not exist.${note}`);
    throw error;
  }
  return {
    kind: args.kind,
    outPath: args.outPath,
    rows: result.rows,
    pairCounts: result.counts ?? null,
    databasePurpose: purpose,
    leftoverTempFile: published.leftoverTempFile,
  };
}
