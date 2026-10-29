/**
 * Serves the local API over HTTP: LOOPBACK by default (Phase 4, milestone 1).
 *   npm run serve -w @robolime/gateway -- --db <file> [--host 127.0.0.1] [--port 8780] [--web-dir <export>]
 *   npm run serve -w @robolime/gateway -- --db <file> --lan --host <private IPv4>   # LAN mode (D36)
 * Defaults: GATEWAY_HOST / GATEWAY_PORT, else 127.0.0.1:8780. LAN mode needs
 * --lan or GATEWAY_LAN_MODE=on AND an RFC 1918 IPv4 address assigned to this
 * computer; otherwise it refuses to start (no fallback). The exported web app
 * is served at / only with --web-dir or GATEWAY_WEB_DIR (decision D33).
 * The telemetry serial bridge and cloud sync are NOT started by this command.
 * Firewall settings are never changed. Stop with Ctrl+C.
 * MANUAL CONTROL (D57): --serial-port <COM5 | /dev/ttyUSB0> (or GATEWAY_SERIAL_PORT)
 * connects the LoRa bridge so the app's "Manual control" tab can command the
 * robot. Loopback only; refused with --lan.
 * DEMO ONLY (D47): --demo-pairing (or GATEWAY_DEMO_PAIRING=on) accepts the fixed
 * demo pairing code; it requires loopback binding and a demo database, and is
 * never for field use.
 */
import { startGateway } from '../http/serve';
import { fail, parseCli, resolveDbPath } from './args';

const SHUTDOWN_GRACE_MS = 5_000;

const args = parseCli({
  db: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'web-dir': { type: 'string' },
  lan: { type: 'boolean' },
  'demo-pairing': { type: 'boolean' },
  'serial-port': { type: 'string' },
});
const dbPath = resolveDbPath(args.db);

let gateway;
try {
  gateway = await startGateway({
    dbPath,
    env: process.env,
    host: args.host,
    port: args.port,
    webDir: args['web-dir'],
    lan: args.lan, // undefined when the flag is absent: GATEWAY_LAN_MODE decides
    demoPairing: args['demo-pairing'], // undefined when absent: GATEWAY_DEMO_PAIRING decides (default off)
    serialPort: args['serial-port'], // undefined when absent: GATEWAY_SERIAL_PORT decides (default off)
    onRequest: ({ method, path, status, durationMs }) =>
      process.stdout.write(`${new Date().toISOString()} ${method} ${path} ${status} ${durationMs}ms\n`),
    onError: ({ errorName, method, path }) =>
      process.stderr.write(`${new Date().toISOString()} internal error (${errorName}) on ${method} ${path}\n`),
  });
} catch (error) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') fail('That port is already in use. Choose another with --port or GATEWAY_PORT.');
  if (code === 'EACCES') fail('Not permitted to listen on that port. Choose a port above 1023.');
  if (code === 'EADDRNOTAVAIL') {
    fail('That address is not available on this computer (check the Wi-Fi or hotspot address). Nothing was started.');
  }
  fail(error instanceof Error ? error.message : String(error));
}

const running = gateway;
const banner =
  running.mode === 'lan'
    ? [
        `RoboLime gateway API listening on ${running.url} (LAN mode, plain HTTP).`,
        'WARNING: LAN mode uses plain, unencrypted HTTP. Use it only on a trusted, password-protected',
        'field Wi-Fi or hotspot - never a public network or the internet. Any device on the same',
        'network can observe pairing codes, session tokens and data.',
        running.servesWebApp
          ? `Web app: open ${running.url}/ (use this LAN address; localhost is not accepted in LAN mode).`
          : `Web app not served (use --web-dir or GATEWAY_WEB_DIR). API clients must use ${running.url}.`,
        `Firewall: allow inbound TCP ${running.port} only for the Private profile and the local subnet,`,
        'and remove the rule after use. This gateway never changes firewall settings.',
        'The serial bridge and cloud sync are not enabled by this command.',
      ]
    : [
        `RoboLime gateway API listening on ${running.url} (loopback only).`,
        running.servesWebApp
          ? `Web app: open ${running.url}/ in a browser on this computer.`
          : 'Web app not served (use --web-dir or GATEWAY_WEB_DIR to enable it).',
        'LAN access (--lan, decision D36), the telemetry serial bridge and cloud sync are not enabled by this command.',
      ];
const manualNotice = running.serialPort
  ? [
      `MANUAL CONTROL ON (D57): LoRa bridge on ${running.serialPort}. The app can drive the robot, pump and`,
      'actuator. Keep people clear of the robot; every manual output stops by itself after 5 s.',
    ]
  : ['Manual control off (start with --serial-port <port> to connect the LoRa bridge).'];
const demoWarning = running.demoPairing
  ? [
      'DEMO PAIRING MODE (D47): the fixed, publicly known demo pairing code is accepted on this',
      'synthetic demo database. Never use this mode, or that code, in a field deployment.',
    ]
  : [];
process.stdout.write([...banner, ...manualNotice, ...demoWarning, 'Press Ctrl+C to stop.', ''].join('\n'));

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
