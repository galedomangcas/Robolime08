/**
 * Creates a new local pairing code for a robot, revoking the previous code and
 * every device session paired with it. The code is generated here and shown
 * ONCE on this terminal; only a salted scrypt verifier is stored.
 *   npm run pairing:provision -w @robolime/gateway -- --db <file> --robot <firmware robot id>
 *
 * Works fully offline. Do not paste the code into chats, tickets, or Git.
 */
import { openExistingDatabase } from '../db/init';
import { migrate } from '../db/migrate';
import { provisionPairingCredential } from '../pairing/sessions';
import { getRobotBySourceId } from '../store/robots';
import { fail, parseCli, resolveDbPath } from './args';

const args = parseCli({ db: { type: 'string' }, robot: { type: 'string' }, label: { type: 'string' } });
if (!args.robot) {
  fail('--robot <firmware robot id> is required');
}
try {
  const db = openExistingDatabase(resolveDbPath(args.db));
  migrate(db);
  const robot = getRobotBySourceId(db, args.robot);
  if (!robot) {
    fail(`Robot ${args.robot} is not provisioned. Run robot:provision first.`);
  }
  const { generatedCode } = provisionPairingCredential(db, {
    robotId: robot.id,
    label: args.label ?? 'operator-provisioned',
    now: new Date(),
  });
  db.close();
  process.stdout.write(
    [
      `New pairing code for ${robot.displayName}:`,
      '',
      `    ${generatedCode ?? ''}`,
      '',
      'Enter it on the phone or browser to pair. It is shown only once and is not stored.',
      'Any previously paired device must pair again.',
      '',
    ].join('\n'),
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
