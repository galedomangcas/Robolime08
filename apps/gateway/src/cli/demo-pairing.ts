/**
 * DEMO ONLY (D47, D52): one command that prepares the local demo and shows the
 * fixed demo pairing code. It creates (or reuses) a DEMO database outside the
 * repository, loads the synthetic fixture, provisions the demo code for the
 * synthetic robot, and prints the code and the command that serves the demo.
 *   npm run demo:pairing                      (from the repository root)
 *   npm run demo:pairing -- --db <demo file>  (another demo file)
 *
 * Refuses a field database (initDatabase checks the stored purpose). Prints no
 * database path secrets, keys or other credentials: only the publicly known
 * demo code. Never use it for a field deployment.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initDatabase } from '../db/init';
import { DEMO_PAIRING_CODE } from '../pairing/codes';
import { provisionDemoPairingCredential } from '../pairing/sessions';
import { DEMO_SOURCE_ROBOT_ID, seedDemo } from '../seed/demo';
import { getRobotBySourceId } from '../store/robots';
import { fail, parseCli } from './args';
import { defaultDemoDbPath } from './demoPaths';

const args = parseCli({ db: { type: 'string' } });
const dbPath = args.db ?? defaultDemoDbPath();
try {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = initDatabase(dbPath, 'demo');
  seedDemo(db);
  const robot = getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID);
  if (!robot) {
    db.close();
    fail(`Synthetic robot ${DEMO_SOURCE_ROBOT_ID} is missing from ${dbPath}.`);
  }
  provisionDemoPairingCredential(db, { robotId: robot.id, now: new Date() });
  db.close();
  process.stdout.write(
    [
      'RoboLime DEMO pairing (synthetic data only, decision D47).',
      '',
      `    Pairing code: ${DEMO_PAIRING_CODE}`,
      '',
      `Demo database: ${dbPath}`,
      'Start the local demo (loopback only), then open http://127.0.0.1:8780/ on this computer:',
      '    npm run build:web',
      `    npm run demo:serve${args.db ? ` -- --db "${dbPath}"` : ''}`,
      '',
      'This code is predictable and publicly known. Never use it in a field deployment.',
      'It is the LOCAL pairing code only; online access uses a separate cloud claim code.',
      'Any previously paired device must pair again.',
      '',
    ].join('\n'),
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
