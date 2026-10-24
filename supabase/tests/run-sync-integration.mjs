// TEST-ONLY runner: cloud-sync worker against a REAL local PostgREST.
//
// Creates a THROWAWAY PostgreSQL cluster in a temp directory (127.0.0.1 only),
// applies the test-only auth shim and the cloud-mirror migrations (no seed:
// the worker uploads the synthetic demo data itself), adds a test-only
// `authenticator` login role, starts two standalone PostgREST servers on
// 127.0.0.1 (one uncapped, one with a small db-max-rows), then runs
// apps/gateway/src/sync/worker.integration.test.ts with the targets in its
// environment. Everything is stopped and deleted afterwards.
//
//   POSTGREST_BIN=<path to an already installed postgrest executable> \
//     node supabase/tests/run-sync-integration.mjs
//
// Safety:
// * It never downloads anything. PostgREST must already be installed and
//   POSTGREST_BIN must point at it (approval A1); PostgreSQL binaries as in
//   run-local-postgres.mjs (PG_BIN, default C:/Program Files/PostgreSQL/17/bin).
// * It never reads .env files, connection strings or credentials. The JWT
//   secret and tokens are generated here per run, held only in memory, the
//   PostgREST config files inside the temp directory, and the test child's
//   environment; they are never printed.
// * Every child gets an isolated environment: SUPABASE_*, proxy variables
//   (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NODE_USE_ENV_PROXY, NODE_OPTIONS, …,
//   any letter case) are removed and NO_PROXY is set to loopback. The runner
//   refuses to start if its own process was started with environment-proxy
//   support enabled, and its readiness probes use a private http.Agent.
// * Like run-local-postgres.mjs, it proves the PostgreSQL server on the port is
//   the throwaway cluster (`show data_directory`) before applying anything.
// * PostgREST identity: a fresh random nonce is written as the throwaway
//   database's `public` schema comment. Each PostgREST is accepted only after
//   its UNAUTHENTICATED root (OpenAPI) response carries that nonce, and only
//   while the spawned child is still running. No token is sent to a port
//   before that check passes; any other responder makes the run fail closed.
// * The test uses a demo-purpose SQLite database, which the worker refuses to
//   sync to any non-loopback target.
//
// Cleanup (idempotent): children are force-stopped (Windows: `taskkill /T /F`
// on the child's own PID tree) BEFORE PostgreSQL is stopped and the unique
// temp directory is deleted. It runs on normal completion, errors, child spawn
// failures, uncaught exceptions, Ctrl+C/SIGTERM and process exit. It CANNOT
// run if the runner itself is killed uncatchably (SIGKILL, Task Manager
// "End task", power loss); the temp directory path is printed at start so a
// leftover cluster can be stopped by hand (`pg_ctl -D <dir>/pgdata stop`).
// Optional: SYNC_IT_PG_PORT (default 54339), SYNC_IT_MAX_ROWS (default 5).

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const supabaseDir = join(here, '..');
const repoRoot = join(supabaseDir, '..');
const gatewayDir = join(repoRoot, 'apps', 'gateway');
const host = '127.0.0.1';
const pgPort = Number(process.env.SYNC_IT_PG_PORT ?? 54339);
const maxRows = Number(process.env.SYNC_IT_MAX_ROWS ?? 5);
const READY_TIMEOUT_MS = 30_000;

const defaultWindowsBin = 'C:/Program Files/PostgreSQL/17/bin';
const pgBin = process.env.PG_BIN ?? (process.platform === 'win32' && existsSync(defaultWindowsBin) ? defaultWindowsBin : '');
const bin = (name) => (pgBin ? join(pgBin, process.platform === 'win32' ? `${name}.exe` : name) : name);
const postgrestBin = process.env.POSTGREST_BIN ?? '';
const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

const log = (message) => console.log(`-- ${message}`);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- environment

const STRIPPED_VARS = new Set([
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_use_env_proxy', 'node_options',
  'npm_config_proxy', 'npm_config_https_proxy', 'global_agent_http_proxy', 'global_agent_https_proxy',
]);

/** A copy of the environment with no hosted target, no proxy and no injected Node options. */
function isolatedEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    const lower = key.toLowerCase();
    if (STRIPPED_VARS.has(lower) || lower.startsWith('supabase_') || lower.startsWith('robolime_sync_it')) continue;
    env[key] = value;
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  return env;
}

const childEnv = isolatedEnv(process.env);

/** True if THIS process may route requests through an environment proxy (cannot be undone in-process). */
function ownProcessUsesEnvProxy() {
  const enabled = Object.entries(process.env).some(
    ([key, value]) => key.toLowerCase() === 'node_use_env_proxy' && value !== undefined && value !== '' && value !== '0',
  );
  const options = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'node_options')?.[1] ?? '';
  return enabled || /--use-env-proxy/.test(options) || process.execArgv.some((a) => a.startsWith('--use-env-proxy'));
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, { allowFail = false, capture = false, detached = false } = {}) {
  const stdio = detached ? 'ignore' : capture ? 'pipe' : 'inherit';
  const result = spawnSync(cmd, args, { stdio, encoding: 'utf8', env: childEnv });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}\n${result.stderr ?? ''}`);
  }
  return result;
}

const psql = (args, options) =>
  run(bin('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(pgPort), '-U', 'postgres', '-d', 'postgres', ...args], options);

function assertPortFree(port) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Refusing to continue: ${host}:${port} is already in use`)));
    probe.listen(port, host, () => probe.close(() => resolvePort()));
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const b64url = (value) => Buffer.from(value).toString('base64url');

/** HS256 JWT signed locally with a throwaway secret (no dependency). */
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

function postgrestConfig({ port, secret, rowCap }) {
  return [
    `db-uri = "postgres://authenticator@${host}:${pgPort}/postgres"`,
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    `jwt-secret = "${secret}"`,
    `server-host = "${host}"`,
    `server-port = ${port}`,
    rowCap === null ? '' : `db-max-rows = ${rowCap}`,
    'log-level = "error"',
    '',
  ].join('\n');
}

// ------------------------------------------------------------ child state

const children = [];

/** Spawns a tracked child; a spawn failure is recorded instead of crashing the runner. */
function spawnTracked(cmd, args, options) {
  const child = spawn(cmd, args, { ...options, env: options.env ?? childEnv, windowsHide: true });
  child.spawnError = null;
  child.once('error', (error) => {
    child.spawnError = error;
  });
  children.push(child);
  return child;
}

const isRunning = (child) => child.spawnError === null && child.exitCode === null && child.signalCode === null;

/** Force-stops one child (and, on Windows, only its own process tree) and waits for it, synchronously. */
function stopChildSync(child) {
  if (child.pid === undefined || !isRunning(child)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', env: childEnv });
    return; // taskkill returns after the processes are terminated
  }
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    return;
  }
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(child.pid, 0);
    } catch {
      return; // gone
    }
    sleepSync(100);
  }
}

// ------------------------------------------------------- PostgREST identity

/** Unauthenticated GET / over a private agent (no proxy, no keep-alive, size- and time-bounded). */
function getRoot(port) {
  return new Promise((resolveGet, reject) => {
    const req = httpRequest(
      { host, port, path: '/', method: 'GET', agent: new Agent({ keepAlive: false }), timeout: 2_000, headers: { accept: 'application/openapi+json, application/json' } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) req.destroy(new Error('root response too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolveGet({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('root request timed out')));
    req.on('error', reject);
    req.end();
  });
}

class IdentityError extends Error {}

/**
 * Waits until `child` serves this run's database on `port`. Fails at once if the
 * child exits or fails to spawn, or if anything answering on the port is not
 * PostgREST serving the nonce-marked throwaway schema. Sends no credentials.
 */
async function verifyPostgrest(child, port, nonce, name) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.spawnError) throw new Error(`PostgREST (${name}) failed to start: ${child.spawnError.code ?? child.spawnError.message}`);
    if (!isRunning(child)) throw new Error(`PostgREST (${name}) exited during startup (code ${child.exitCode}); see its log`);
    let reply;
    try {
      reply = await getRoot(port);
    } catch {
      await sleep(250); // not listening yet
      continue;
    }
    if (reply.status === 503) {
      await sleep(250); // PostgREST is still loading its schema cache
      continue;
    }
    let info = null;
    try {
      const parsed = JSON.parse(reply.body);
      info = typeof parsed === 'object' && parsed !== null ? parsed.info : null;
    } catch {
      info = null;
    }
    const marked = info !== null && typeof info === 'object' && `${info.title ?? ''}\n${info.description ?? ''}`.includes(nonce);
    if (reply.status !== 200 || !marked) {
      throw new IdentityError(
        `Refusing to continue: the server on ${host}:${port} is not the PostgREST started for this run ` +
          '(its root response does not carry this run\'s schema nonce). No credentials were sent to it.',
      );
    }
    if (!isRunning(child)) throw new Error(`PostgREST (${name}) exited during startup; see its log`);
    const server = reply.headers.server;
    return typeof server === 'string' ? server : 'unknown (no Server header)';
  }
  throw new Error(`PostgREST (${name}) on ${host}:${port} did not become ready within ${READY_TIMEOUT_MS / 1000} s`);
}

// ------------------------------------------------------------------ cleanup

let tempDir = null;
let clusterStarted = false;
let cleanedUp = false;

/** Idempotent and synchronous, so it is safe from exit handlers and signal handlers. */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children) stopChildSync(child); // stop users of the config and database first
  if (clusterStarted && tempDir) {
    run(bin('pg_ctl'), ['-D', join(tempDir, 'pgdata'), '-m', 'fast', '-w', 'stop'], { allowFail: true, capture: true });
  }
  if (tempDir) {
    for (let attempt = 0; attempt < 10 && existsSync(tempDir); attempt += 1) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        sleepSync(300); // Windows may release file handles a moment after termination
      }
    }
    log(existsSync(tempDir) ? `WARNING: could not delete ${tempDir}; delete it manually` : 'temporary cluster and files deleted');
  }
}

process.on('exit', cleanup);
process.on('uncaughtException', (error) => {
  console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  cleanup();
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

// --------------------------------------------------------------------- main

async function main() {
  if (ownProcessUsesEnvProxy()) {
    console.error('BLOCKED: this Node process has environment-proxy support enabled (NODE_USE_ENV_PROXY or --use-env-proxy). Start the runner without it.');
    return 3;
  }
  if (!postgrestBin || !existsSync(postgrestBin)) {
    console.error('BLOCKED: set POSTGREST_BIN to an already installed PostgREST executable. This runner never downloads it.');
    return 3;
  }
  if (!existsSync(vitestEntry)) {
    console.error('BLOCKED: vitest is not installed in node_modules (run npm install first; this runner never downloads it).');
    return 3;
  }
  await assertPortFree(pgPort);
  tempDir = mkdtempSync(join(tmpdir(), 'robolime-sync-it-'));
  log(`temporary directory: ${tempDir}`);
  const dataDir = join(tempDir, 'pgdata');

  run(bin('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], { capture: true });
  // Set before the attempt: `pg_ctl start -w` can fail or time out after the server has actually
  // started. Cleanup's `pg_ctl stop` runs with allowFail, so a cluster that never started is harmless.
  clusterStarted = true;
  run(bin('pg_ctl'), ['-D', dataDir, '-l', join(tempDir, 'postgres.log'), '-w', '-o', `-p ${pgPort} -c listen_addresses=${host}`, 'start'], { detached: true });
  const probe = psql(['-tA', '-c', 'show data_directory'], { capture: true });
  const normalise = (p) => resolve(p.trim()).replace(/\\/g, '/').toLowerCase();
  if (normalise(probe.stdout) !== normalise(dataDir)) {
    throw new Error(`Refusing to continue: server on ${host}:${pgPort} is not the throwaway cluster`);
  }

  log('applying test-only auth shim and cloud-mirror migrations (no seed)');
  psql(['-f', join(here, 'plain_postgres_auth_shim.sql')]);
  const migrationsDir = join(supabaseDir, 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    psql(['-f', join(migrationsDir, file)]);
  }
  // TEST-ONLY: PostgREST connects as `authenticator` and switches to the role in the JWT.
  psql(['-c', 'create role authenticator login noinherit; grant anon to authenticator; grant service_role to authenticator;']);
  // Identity marker served by PostgREST's root (OpenAPI) endpoint; hex only, so safe to inline.
  const nonce = randomBytes(16).toString('hex');
  psql(['-c', `comment on schema public is 'robolime-sync-it ${nonce}'`]);

  const secret = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'robolime-sync-it', iat: now, exp: now + 2 * 60 * 60 };
  const token = signJwt({ ...claims, role: 'service_role' }, secret);
  const badToken = signJwt({ ...claims, role: 'service_role' }, randomBytes(32).toString('hex'));
  const anonToken = signJwt({ ...claims, role: 'anon' }, secret);

  const servers = {};
  for (const [name, rowCap] of [['full', null], ['capped', maxRows]]) {
    const port = await freePort();
    await assertPortFree(port);
    const configPath = join(tempDir, `postgrest-${name}.conf`);
    writeFileSync(configPath, postgrestConfig({ port, secret, rowCap }), { mode: 0o600 });
    const logFd = openSync(join(tempDir, `postgrest-${name}.log`), 'a');
    const child = spawnTracked(postgrestBin, [configPath], { stdio: ['ignore', logFd, logFd] });
    closeSync(logFd);
    const version = await verifyPostgrest(child, port, nonce, name);
    servers[name] = { url: `http://${host}:${port}`, version, child };
    log(`PostgREST (${name}${rowCap === null ? '' : `, db-max-rows=${rowCap}`}) verified on ${host}:${port} — ${version}`);
  }

  const env = {
    ...childEnv,
    ROBOLIME_SYNC_IT: '1',
    ROBOLIME_SYNC_IT_POSTGREST_URL: servers.full.url,
    ROBOLIME_SYNC_IT_CAPPED_URL: servers.capped.url,
    ROBOLIME_SYNC_IT_MAX_ROWS: String(maxRows),
    ROBOLIME_SYNC_IT_POSTGREST_VERSION: servers.full.version,
    ROBOLIME_SYNC_IT_TOKEN: token,
    ROBOLIME_SYNC_IT_BAD_TOKEN: badToken,
    ROBOLIME_SYNC_IT_ANON_TOKEN: anonToken,
    ROBOLIME_SYNC_IT_PROXY_MODULE: join(here, 'sync_proxy.mjs'),
  };

  log('running apps/gateway/src/sync/worker.integration.test.ts');
  const tests = spawnTracked(process.execPath, [vitestEntry, 'run', 'src/sync/worker.integration.test.ts'], {
    cwd: gatewayDir,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise((resolveExit, reject) => {
    tests.once('error', (error) => reject(new Error(`could not start the test process: ${error.code ?? error.message}`)));
    tests.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  for (const [name, server] of Object.entries(servers)) {
    if (!isRunning(server.child)) console.error(`-- WARNING: PostgREST (${name}) on ${server.url} exited during the tests`);
  }
  if (code !== 0) {
    for (const name of ['full', 'capped']) {
      const file = join(tempDir, `postgrest-${name}.log`);
      if (!existsSync(file)) continue;
      // PostgREST error logs carry no tokens, but redact defensively before printing.
      const tail = readFileSync(file, 'utf8').split('\n').slice(-15).join('\n');
      console.error(`-- last PostgREST (${name}) log lines:\n${[token, badToken, anonToken, secret].reduce((t, s) => t.split(s).join('[redacted]'), tail)}`);
    }
  }
  return code;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
