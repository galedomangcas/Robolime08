/**
 * Creates or migrates the gateway SQLite database. Never seeds data.
 *   npm run db:init -w @robolime/gateway -- --db <file> [--purpose field|demo]
 */
import { initDatabase } from '../db/init';
import { fail, parseCli, resolveDbPath } from './args';

const args = parseCli({ db: { type: 'string' }, purpose: { type: 'string' } });
const purpose = args.purpose ?? 'field';
if (purpose !== 'field' && purpose !== 'demo') {
  fail('--purpose must be "field" or "demo"');
}
const path = resolveDbPath(args.db);
try {
  const db = initDatabase(path, purpose);
  db.close();
  process.stdout.write(`Database ready (${purpose}): ${path}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
