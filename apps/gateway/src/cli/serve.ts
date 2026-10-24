/**
 * Serves the local API over HTTP on LOOPBACK ONLY (Phase 4, milestone 1).
 *   npm run serve -w @robolime/gateway -- --db <file> [--host 127.0.0.1] [--port 8780] [--web-dir <export>]
 * Defaults: GATEWAY_HOST / GATEWAY_PORT, else 127.0.0.1:8780. The exported web
 * app is served at / only with --web-dir or GATEWAY_WEB_DIR (decision D33).
 * LAN binding, the serial bridge and cloud sync are NOT started by this command.
 * Stop with Ctrl+C.
 */
import { startGateway } from '../http/serve';
import { fail, parseCli, resolveDbPath } from './args';

const SHUTDOWN_GRACE_MS = 5_000;

const args = parseCli({ db: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, 'web-dir': { type: 'string' } });
const dbPath = resolveDbPath(args.db);

let gateway;
try {
  gateway = await startGateway({
    dbPath,
    env: process.env,
    host: args.host,
    port: args.port,
    webDir: args['web-dir'],
    onRequest: ({ method, path, status, durationMs }) =>
      process.stdout.write(`${new Date().toISOString()} ${method} ${path} ${status} ${durationMs}ms\n`),
    onError: ({ errorName, method, path }) =>
      process.stderr.write(`${new Date().toISOString()} internal error (${errorName}) on ${method} ${path}\n`),
  });
} catch (error) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') fail('That port is already in use. Choose another with --port or GATEWAY_PORT.');
  if (code === 'EACCES') fail('Not permitted to listen on that port. Choose a port above 1023.');
  fail(error instanceof Error ? error.message : String(error));
}

const running = gateway;
process.stdout.write(
  [
    `RoboLime gateway API listening on ${running.url} (loopback only).`,
    running.servesWebApp
      ? `Web app: open ${running.url}/ in a browser on this computer.`
      : 'Web app not served (use --web-dir or GATEWAY_WEB_DIR to enable it).',
    'LAN access, the serial bridge and cloud sync are not enabled by this command.',
    'Press Ctrl+C to stop.',
    '',
  ].join('\n'),
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    process.stderr.write(`Received ${signal} again; exiting immediately.\n`);
    process.exit(1);
  }
  stopping = true;
  process.stdout.write(`Received ${signal}; closing the API and database...\n`);
  const force = setTimeout(() => {
    process.stderr.write('Shutdown timed out; closing open connections.\n');
    running.forceCloseConnections();
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  running.close().then(
    () => {
      process.stdout.write('Gateway stopped.\n');
      process.exit(0);
    },
    (error: unknown) => {
      process.stderr.write(`Error while stopping: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
