/**
 * Registers the robot this gateway serves (idempotent).
 *   npm run robot:provision -w @robolime/gateway -- --db <file> --source-id <firmware robot id> --name "<display name>"
 * The database must already exist (create it with db:init). The firmware robot
 * identifier format is pending the packet specification.
 */
import { getDatabasePurpose, openExistingDatabase } from '../db/init';
import { migrate } from '../db/migrate';
import { provisionRobot } from '../store/robots';
import { fail, parseCli, resolveDbPath } from './args';

const args = parseCli({ db: { type: 'string' }, 'source-id': { type: 'string' }, name: { type: 'string' } });
const sourceRobotId = args['source-id'];
if (!sourceRobotId || !args.name) {
  fail('--source-id and --name are required');
}
try {
  const db = openExistingDatabase(resolveDbPath(args.db));
  migrate(db);
  if (getDatabasePurpose(db) !== 'field') {
    db.close();
    fail('Real robots are provisioned only into a field database (created with db:init).');
  }
  const robot = provisionRobot(db, { sourceRobotId, displayName: args.name, isSynthetic: false }, new Date());
  db.close();
  process.stdout.write(`Robot provisioned: ${robot.displayName} (id ${robot.id})\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
