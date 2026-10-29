/**
 * DEMO ONLY (D47, D52): serves the demo database prepared by `demo:pairing`
 * with demo pairing on loopback and the exported web app.
 *   npm run demo:serve                      (from the repository root)
 *   npm run demo:serve -- --db <demo file> [--port 8780] [--serial-port COM5]   (manual control, D57)
 * It only forwards fixed flags to `serve`, which still enforces loopback and
 * the demo-database purpose.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseCli } from './args';
import { defaultDemoDbPath } from './demoPaths';

const args = parseCli({ db: { type: 'string' }, port: { type: 'string' }, 'serial-port': { type: 'string' } });
const dbPath = args.db ?? defaultDemoDbPath();
const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..', '..', '..', 'mobile', 'dist');
if (!existsSync(dbPath)) {
  fail(`No demo database at ${dbPath}. Run "npm run demo:pairing" first.`);
}
if (!existsSync(join(webDir, 'index.html'))) {
  fail(`No web export at ${webDir}. Run "npm run build:web" first.`);
}
const child = spawn(
  process.execPath,
  [...process.execArgv, join(here, 'serve.ts'), '--db', dbPath, '--host', '127.0.0.1', '--demo-pairing', '--web-dir', webDir, ...(args.port ? ['--port', args.port] : []), ...(args['serial-port'] ? ['--serial-port', args['serial-port']] : [])],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
