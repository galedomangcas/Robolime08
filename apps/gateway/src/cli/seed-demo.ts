/**
 * Creates (if needed) a DEMO database and loads the synthetic fixture once.
 *   npm run db:seed:demo -w @robolime/gateway -- --db <demo file>
 * Refuses to touch a database initialised for field use.
 */
import { initDatabase } from '../db/init';
import { seedDemo } from '../seed/demo';
import { fail, parseCli } from './args';

const args = parseCli({ db: { type: 'string' } });
if (!args.db) {
  fail('--db <demo database file> is required (GATEWAY_DB_PATH is not used, to protect the field database).');
}
try {
  const db = initDatabase(args.db, 'demo');
  const seeded = seedDemo(db);
  db.close();
  process.stdout.write(
    seeded ? `Synthetic demo data loaded into ${args.db}\n` : `Synthetic demo data already present in ${args.db}; nothing changed.\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
