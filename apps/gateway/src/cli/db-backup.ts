/**
 * Consistent online backup of the gateway database (safe while running).
 *   npm run db:backup -w @robolime/gateway -- --db <file> --out <new backup file>
 * Restore procedure: see docs/local-gateway.md ("Backup and restore").
 */
import { backupDatabase } from '../db/backup';
import { openExistingDatabase } from '../db/init';
import { fail, parseCli, resolveDbPath } from './args';

const args = parseCli({ db: { type: 'string' }, out: { type: 'string' } });
if (!args.out) {
  fail('--out <backup file> is required');
}
try {
  const db = openExistingDatabase(resolveDbPath(args.db));
  backupDatabase(db, args.out);
  db.close();
  process.stdout.write(`Backup written and verified: ${args.out}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
