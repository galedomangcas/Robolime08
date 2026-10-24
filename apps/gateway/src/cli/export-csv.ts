/**
 * Writes one research CSV from a local gateway database (D32). Read-only,
 * offline; never overwrites an existing file.
 *   npm run export:csv -w @robolime/gateway -- --db <file> --kind readings  --run <run id> --out <new.csv>
 *   npm run export:csv -w @robolime/gateway -- --db <file> --kind delivery  --run <run id> --out <new.csv>
 *   npm run export:csv -w @robolime/gateway -- --db <file> --kind paired    --run <dosing run id>
 *                                                   --verification-run <verification run id> --out <new.csv>
 * Add --robot <firmware robot id> if the run id exists for more than one robot.
 */
import { parseExportArgs, runExport } from '../exports/exportCommand';
import { fail, parseCli } from './args';

const values = parseCli({
  db: { type: 'string' },
  kind: { type: 'string' },
  run: { type: 'string' },
  'verification-run': { type: 'string' },
  robot: { type: 'string' },
  out: { type: 'string' },
});

try {
  const summary = runExport(parseExportArgs(values));
  const pairs = summary.pairCounts
    ? ` (paired ${summary.pairCounts.paired}, missing verification ${summary.pairCounts.missing_verification}, missing dosing ${summary.pairCounts.missing_dosing}, ambiguous ${summary.pairCounts.ambiguous_multiple_readings})`
    : '';
  process.stdout.write(
    `Wrote ${summary.kind} export from a ${summary.databasePurpose} database: ${summary.rows} rows${pairs} -> ${summary.outPath}\n`,
  );
  if (summary.leftoverTempFile) {
    process.stderr.write(`Warning: the temporary file ${summary.leftoverTempFile} could not be removed; delete it manually.\n`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
