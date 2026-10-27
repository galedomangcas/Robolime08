/**
 * Creates a new local pairing code for a robot, revoking the previous code and
 * every device session paired with it. The code is generated here and shown
 * ONCE on this terminal; only a salted scrypt verifier is stored.
 *   npm run pairing:provision -w @robolime/gateway -- --db <file> --robot <firmware robot id>
 *
 * Works fully offline. Do not paste the code into chats, tickets, or Git.
 *
 * DEMO ONLY (D47): --demo-code makes the fixed demo code the active credential
 * instead. It refuses unless the database is a demo database and the robot is
 * synthetic, and prints no code. The gateway accepts it only when started with
 * --demo-pairing on loopback. Never use it for a field database.
 */
import { openExistingDatabase } from '../db/init';
import { migrate } from '../db/migrate';
import { provisionDemoPairingCredential, provisionPairingCredential } from '../pairing/sessions';
import { getRobotBySourceId } from '../store/robots';
import { fail, parseCli, resolveDbPath } from './args';

const args = parseCli({
  db: { type: 'string' },
  robot: { type: 'string' },
  label: { type: 'string' },
  'demo-code': { type: 'boolean' },
});
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
  if (args['demo-code'] === true) {
    provisionDemoPairingCredential(db, { robotId: robot.id, now: new Date() });
    db.close();
    process.stdout.write(
      [
        `Demo-only fixed pairing code provisioned for ${robot.displayName} (decision D47).`,
        'It is a predictable demonstration credential: never use it in a field deployment.',
        'The gateway accepts it only when started with --demo-pairing on loopback.',
        'Any previously paired device must pair again.',
        '',
      ].join('\n'),
    );
    process.exit(0);
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
