import { API_V1_ROUTES, type ApiErrorBody, type PairingResponse, type RunsResponse } from '@robolime/shared';
import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalApi, type LocalApi } from '../api/localApi';
import { initDatabase } from '../db/init';
import { provisionPairingCredential } from '../pairing/sessions';
import { DEMO_DOSING_RUN, DEMO_SOURCE_ROBOT_ID, DEMO_VERIFICATION_RUN, seedDemo } from '../seed/demo';
import { recordReading } from '../store/readings';
import { getRobotBySourceId, provisionRobot } from '../store/robots';
import { T0, TEST_ONLY_OTHER_PAIRING_CODE, TEST_ONLY_PAIRING_CODE, testReading } from '../test/helpers';
import {
  CONNECTIONS_CHECK_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_JSON_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
} from './config';
import {
  allowedHostHeaders,
  isJsonContentType,
  startGatewayHttpServer,
  type HttpErrorLog,
  type HttpRequestLog,
  type RunningGatewayHttpServer,
} from './server';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/** Same fixture shape as localApi.test.ts: seeded demo robot plus a second robot. */
function fixture() {
  const db = initDatabase(':memory:', 'demo', T0);
  seedDemo(db);
  const demo = getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID);
  if (!demo) throw new Error('demo robot missing');
  const other = provisionRobot(db, { sourceRobotId: 'OTHER', displayName: 'Other robot', isSynthetic: true }, T0);
  const otherRun = recordReading(db, testReading({ sourceRobotId: 'OTHER', sourceRunId: 'OTHER-RUN' }), T0).runId;
  provisionPairingCredential(db, { robotId: demo.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
  provisionPairingCredential(db, { robotId: other.id, code: TEST_ONLY_OTHER_PAIRING_CODE, now: T0 });
  const runId = (source: string) => String(db.prepare('SELECT id FROM runs WHERE source_run_id = ?').get(source)?.id);
  return { db, api: createLocalApi({ db, clock: () => NOW }), otherRun, dosingRun: runId(DEMO_DOSING_RUN), verificationRun: runId(DEMO_VERIFICATION_RUN) };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

/** Low-level request so tests control method, headers, chunking and request targets exactly. */
function raw(
  server: RunningGatewayHttpServer,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: server.host, port: server.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.chunks) {
      for (const c of opts.chunks) req.write(c);
      req.end();
    } else {
      req.end(opts.body);
    }
  });
}

const code = (r: RawResponse) => (r.json as ApiErrorBody).error.code;

let running: RunningGatewayHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(api: LocalApi, logs: { req: HttpRequestLog[]; err: HttpErrorLog[] } = { req: [], err: [] }) {
  running = await startGatewayHttpServer({
    api,
    host: '127.0.0.1',
    port: 0,
    onRequest: (e) => logs.req.push(e),
    onError: (e) => logs.err.push(e),
  });
  return running;
}

async function pair(server: RunningGatewayHttpServer, pairingCode = TEST_ONLY_PAIRING_CODE): Promise<string> {
  const res = await raw(server, {
    method: 'POST',
    path: API_V1_ROUTES.pairing,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode }),
  });
  expect(res.status).toBe(201);
  return (res.json as PairingResponse).sessionToken;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('gateway HTTP server: binding and limits', () => {
  it('listens on loopback with an ephemeral port and configured timeouts', async () => {
    const server = await start(fixture().api);
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    // Node's default sweep is 30 s, which let stalled requests live ~30–45 s.
    expect((server.server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval).toBe(
      CONNECTIONS_CHECK_INTERVAL_MS,
    );
    expect(CONNECTIONS_CHECK_INTERVAL_MS).toBe(1_000);
    expect([HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS]).toEqual([10_000, 15_000, 5_000]);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10'])('refuses to bind the non-loopback address %s', async (host) => {
    await expect(startGatewayHttpServer({ api: fixture().api, host, port: 0 })).rejects.toThrow(/loopback/);
  });
});

describe('gateway HTTP server: authorization is delegated unchanged to the local API', () => {
  it('rejects unpaired requests to protected routes with JSON 401 UNPAIRED', async () => {
    const server = await start(fixture().api);
    for (const path of [API_V1_ROUTES.session, API_V1_ROUTES.robotStatus, API_V1_ROUTES.field, API_V1_ROUTES.runs]) {
      const res = await raw(server, { method: 'GET', path });
      expect(res.status).toBe(401);
      expect(code(res)).toBe('UNPAIRED');
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('rejects a wrong pairing code and an invalid token', async () => {
    const server = await start(fixture().api);
    const wrong = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'WRNG-WRNG-WRNG' }),
    });
    expect(wrong.status).toBe(401);
    expect(code(wrong)).toBe('INVALID_PAIRING_CODE');
    const bad = await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: bearer('rlg1.nope.nope') });
    expect(bad.status).toBe(401);
    expect(code(bad)).toBe('INVALID_SESSION');
  });

  it('pairs over HTTP and then serves the paired robot’s data only', async () => {
    const { api, dosingRun, verificationRun, otherRun } = fixture();
    const server = await start(api);
    const token = await pair(server);

    expect((await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: bearer(token) })).status).toBe(200);
    expect((await raw(server, { method: 'GET', path: API_V1_ROUTES.robotStatus, headers: bearer(token) })).status).toBe(200);

    const runs = await raw(server, { method: 'GET', path: API_V1_ROUTES.runs, headers: bearer(token) });
    expect(runs.status).toBe(200);
    expect((runs.json as RunsResponse).runs.map((r) => r.id)).toEqual([dosingRun]);

    const readings = await raw(server, { method: 'GET', path: API_V1_ROUTES.runReadings(dosingRun), headers: bearer(token) });
    expect(readings.status).toBe(200);

    // Verification runs and another robot's runs stay invisible (same 404).
    for (const runId of [verificationRun, otherRun]) {
      const hidden = await raw(server, { method: 'GET', path: API_V1_ROUTES.runReadings(runId), headers: bearer(token) });
      expect(hidden.status).toBe(404);
      expect(code(hidden)).toBe('NOT_FOUND');
    }
  });

  it('ignores the query string for routing', async () => {
    const server = await start(fixture().api);
    const token = await pair(server);
    const res = await raw(server, { method: 'GET', path: `${API_V1_ROUTES.runs}?x=1`, headers: bearer(token) });
    expect(res.status).toBe(200);
  });

  it('exposes no robot-control routes', async () => {
    const server = await start(fixture().api);
    const token = await pair(server);
    for (const path of ['/api/v1/robot/command', '/api/v1/robot/commands', '/api/v1/robot/manual', '/api/v1/robot/drive', '/api/v1/robot/stop', '/api/v1/commands']) {
      const res = await raw(server, {
        method: 'POST',
        path,
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'DRIVE', direction: 'FORWARD', durationMs: 100 }),
      });
      expect(res.status).toBe(404);
      expect(code(res)).toBe('NOT_FOUND');
    }
  });
});

describe('gateway HTTP server: malformed and hostile requests', () => {
  it('rejects malformed JSON with 400 and does not echo the body', async () => {
    const server = await start(fixture().api);
    const res = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'application/json' },
      body: '{"pairingCode": "TEST-ONLY-SECRET-LIKE"',
    });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('BAD_REQUEST');
    expect(res.text).not.toContain('TEST-ONLY-SECRET-LIKE');
  });

  it('treats an empty JSON POST body as a bad request from the API, not a crash', async () => {
    const server = await start(fixture().api);
    const res = await raw(server, { method: 'POST', path: API_V1_ROUTES.pairing, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('BAD_REQUEST');
  });

  it('rejects an oversized body announced by Content-Length with 413', async () => {
    const server = await start(fixture().api);
    const body = Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x20);
    const res = await raw(server, { method: 'POST', path: API_V1_ROUTES.pairing, headers: { 'Content-Type': 'application/json' }, body });
    expect(res.status).toBe(413);
    expect(code(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an oversized chunked body (no Content-Length) with 413', async () => {
    const server = await start(fixture().api);
    const chunk = Buffer.alloc(4096, 0x20);
    const chunks = Array.from({ length: Math.ceil(MAX_JSON_BODY_BYTES / chunk.length) + 2 }, () => chunk);
    const res = await raw(server, { method: 'POST', path: API_V1_ROUTES.pairing, headers: { 'Content-Type': 'application/json' }, chunks });
    expect(res.status).toBe(413);
    expect(code(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('answers the unsupported method %s with 405 and an Allow header', async (method) => {
    const server = await start(fixture().api);
    const res = await raw(server, { method, path: API_V1_ROUTES.runs });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, POST');
    if (method !== 'HEAD') expect(code(res)).toBe('METHOD_NOT_ALLOWED');
  });

  it('answers a supported method on the wrong route with the API’s 405', async () => {
    const server = await start(fixture().api);
    const token = await pair(server);
    const res = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.runs,
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(code(res)).toBe('METHOD_NOT_ALLOWED');
  });

  it.each(['/', '/index.html', '/api', '/api/v2/runs', '/favicon.ico'])('serves nothing outside /api/v1 (%s → 404)', async (path) => {
    const server = await start(fixture().api);
    const res = await raw(server, { method: 'GET', path });
    expect(res.status).toBe(404);
    expect(code(res)).toBe('NOT_FOUND');
  });

  it('returns 404 for an unknown route under /api/v1 once authorized', async () => {
    const server = await start(fixture().api);
    const token = await pair(server);
    const res = await raw(server, { method: 'GET', path: '/api/v1/nothing-here', headers: bearer(token) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed percent-encoding in a run id', async () => {
    const server = await start(fixture().api);
    const token = await pair(server);
    const res = await raw(server, { method: 'GET', path: '/api/v1/runs/%E0%A4%A/readings', headers: bearer(token) });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('BAD_REQUEST');
  });
});

describe('gateway HTTP server: internal errors and logging', () => {
  it('returns a generic 500 without leaking the error, and logs only the error class', async () => {
    const logs = { req: [] as HttpRequestLog[], err: [] as HttpErrorLog[] };
    const exploding = {
      handle: () => {
        throw new TypeError('TEST-ONLY internal detail that must not leak');
      },
    } as unknown as LocalApi;
    const server = await start(exploding, logs);
    const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.runs });
    expect(res.status).toBe(500);
    expect(code(res)).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('TEST-ONLY internal detail');
    expect(logs.err).toEqual([{ errorName: 'TypeError', method: 'GET', path: API_V1_ROUTES.runs }]);
    expect(JSON.stringify(logs)).not.toContain('TEST-ONLY internal detail');
  });

  it('never logs pairing codes, tokens, headers, bodies or query strings', async () => {
    const logs = { req: [] as HttpRequestLog[], err: [] as HttpErrorLog[] };
    const server = await start(fixture().api, logs);
    const token = await pair(server);
    await raw(server, { method: 'GET', path: `${API_V1_ROUTES.runs}?token=${token}`, headers: bearer(token) });
    await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: TEST_ONLY_OTHER_PAIRING_CODE }),
    });

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(TEST_ONLY_PAIRING_CODE);
    expect(serialized).not.toContain(TEST_ONLY_OTHER_PAIRING_CODE);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('?');
    expect(logs.req.map((e) => [e.method, e.path, e.status])).toEqual([
      ['POST', API_V1_ROUTES.pairing, 201],
      ['GET', API_V1_ROUTES.runs, 200],
      ['POST', API_V1_ROUTES.pairing, 201],
    ]);
    expect(Object.keys(logs.req[0] ?? {}).sort()).toEqual(['durationMs', 'method', 'path', 'status']);
  });
});

describe('gateway HTTP server: pairing-attempt rate limiting (D30)', () => {
  const wrongPairing = (server: RunningGatewayHttpServer, headers: Record<string, string> = {}) =>
    raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ pairingCode: 'WRNG-WRNG-WRNG' }),
    });

  it('limits by the socket address and ignores forwarded headers', async () => {
    const inner = fixture().api;
    const seen: (string | null | undefined)[] = [];
    const recording = {
      handle: (req: Parameters<LocalApi['handle']>[0]) => {
        seen.push(req.clientAddress);
        return inner.handle(req);
      },
    } as LocalApi;
    const server = await start(recording);
    // Every request claims a different origin; all really come from 127.0.0.1.
    for (let i = 1; i <= 5; i += 1) {
      const res = await wrongPairing(server, { 'X-Forwarded-For': `203.0.113.${i}`, Forwarded: `for=198.51.100.${i}`, 'X-Real-IP': `192.0.2.${i}` });
      expect(res.status).toBe(401);
    }
    const spoofed = await wrongPairing(server, { 'X-Forwarded-For': '203.0.113.200' });
    expect(spoofed.status).toBe(429);
    expect(code(spoofed)).toBe('PAIRING_RATE_LIMITED');
    // The handler received the socket's real peer address every time (not null, not a header value).
    expect(seen).toEqual(Array(6).fill('127.0.0.1'));
  });

  it('answers 429 with Retry-After, the usual JSON headers, and no secrets; logs only method, path and status', async () => {
    const logs = { req: [] as HttpRequestLog[], err: [] as HttpErrorLog[] };
    const { api, db } = fixture();
    const server = await start(api, logs);
    const token = await pair(server); // before the limit: a valid session
    for (let i = 0; i < 5; i += 1) await wrongPairing(server);

    const limited = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: TEST_ONLY_OTHER_PAIRING_CODE }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('900');
    expect(limited.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.text).not.toContain(TEST_ONLY_OTHER_PAIRING_CODE);
    expect(limited.text).not.toContain('sessionToken');
    expect(sessionCount(db)).toBe(1);

    // Other routes are unaffected for the same client.
    expect((await raw(server, { method: 'GET', path: API_V1_ROUTES.runs, headers: bearer(token) })).status).toBe(200);
    // Still limited: every further pairing attempt carries Retry-After; ordinary responses do not.
    expect((await wrongPairing(server)).headers['retry-after']).toBe('900');
    expect((await raw(server, { method: 'GET', path: API_V1_ROUTES.runs })).headers['retry-after']).toBeUndefined();

    const serialized = JSON.stringify(logs);
    for (const secret of [token, TEST_ONLY_PAIRING_CODE, TEST_ONLY_OTHER_PAIRING_CODE, 'WRNG-WRNG-WRNG', '127.0.0.1']) {
      expect(serialized).not.toContain(secret);
    }
    expect(logs.req.map((e) => e.status)).toEqual([201, 401, 401, 401, 401, 401, 429, 200, 429, 401]);
  });
});

/** Wraps an API so tests can prove a rejected request never reached the handler. */
function counted(api: LocalApi) {
  let calls = 0;
  const wrapped = {
    handle: (req: Parameters<LocalApi['handle']>[0]) => {
      calls += 1;
      return api.handle(req);
    },
  } as LocalApi;
  return { api: wrapped, calls: () => calls };
}

/** Exact bytes on the wire, for requests node:http would not produce (e.g. no Host header). */
function rawSocket(server: RunningGatewayHttpServer, text: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, server.host);
    let out = '';
    socket.on('data', (d) => (out += String(d)));
    socket.on('error', reject);
    socket.on('close', () => {
      const [head = '', body = ''] = out.split('\r\n\r\n');
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      resolve({ status: Number(head.split(' ')[1] ?? 0), headers: {}, text: out, json });
    });
    socket.write(text);
  });
}

const pairingBody = (pairingCode: string) => JSON.stringify({ pairingCode });
const sessionCount = (db: ReturnType<typeof fixture>['db']) => Number(db.prepare('SELECT COUNT(*) AS n FROM local_sessions').get()?.n);

describe('gateway HTTP server: Host header validation (DNS-rebinding defence)', () => {
  it('accepts its own loopback address and localhost with the right port (case-insensitive)', async () => {
    const { api, calls } = counted(fixture().api);
    const server = await start(api);
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `LOCALHOST:${server.port}`]) {
      const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: { Host: host } });
      expect(res.status).toBe(401); // reached the API, which still requires a session
      expect(code(res)).toBe('UNPAIRED');
    }
    expect(calls()).toBe(3);
  });

  it('rejects unexpected and malformed Host values before the API, without echoing them', async () => {
    const fx = fixture();
    const { api, calls } = counted(fx.api);
    const server = await start(api);
    const p = server.port;
    const rejected = [
      'evil.example',
      `evil.example:${p}`,
      `attacker.rebind.example:${p}`,
      '127.0.0.1', // no port
      `127.0.0.1:${p + 1}`, // port mismatch
      `127.0.0.1:0${p}`,
      `127.0.0.2:${p}`, // a different loopback address than the bound one
      `0.0.0.0:${p}`,
      `[::1]:${p}`, // IPv6 form while bound to IPv4
      'localhost', // no port
      `localhost.:${p}`,
      `[127.0.0.1]:${p}`,
      `127.0.0.1:${p}:1`,
    ];
    const before = sessionCount(fx.db);
    for (const host of rejected) {
      // A correctly coded pairing POST: without the Host check it would create a session.
      const res = await raw(server, {
        method: 'POST',
        path: API_V1_ROUTES.pairing,
        headers: { Host: host, 'Content-Type': 'application/json' },
        body: pairingBody(TEST_ONLY_PAIRING_CODE),
      });
      expect(res.status, host).toBe(400);
      expect(code(res)).toBe('BAD_REQUEST');
      expect(res.text).not.toContain(host);
    }
    expect(calls()).toBe(0);
    expect(sessionCount(fx.db)).toBe(before);
  });

  it('rejects a request without a Host header (HTTP/1.0); Node itself rejects one under HTTP/1.1', async () => {
    const { api, calls } = counted(fixture().api);
    const server = await start(api);
    const http10 = await rawSocket(server, `GET ${API_V1_ROUTES.session} HTTP/1.0\r\n\r\n`);
    expect(http10.status).toBe(400);
    expect((http10.json as ApiErrorBody).error.code).toBe('BAD_REQUEST');
    const http11 = await rawSocket(server, `GET ${API_V1_ROUTES.session} HTTP/1.1\r\nConnection: close\r\n\r\n`);
    expect(http11.status).toBe(400);
    expect(calls()).toBe(0);
  });

  it('on IPv6 loopback accepts only the bracketed form with the right port', async (ctx) => {
    const { api, calls } = counted(fixture().api);
    try {
      running = await startGatewayHttpServer({ api, host: '::1', port: 0 });
    } catch {
      ctx.skip(); // no IPv6 loopback on this machine
      return;
    }
    const server = running;
    const p = server.port;
    for (const host of [`[::1]:${p}`, `localhost:${p}`]) {
      const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: { Host: host } });
      expect(res.status, host).toBe(401);
    }
    for (const host of [`::1:${p}`, `127.0.0.1:${p}`, '[::1]', `[::1]:${p + 1}`]) {
      const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: { Host: host } });
      expect(res.status, host).toBe(400);
    }
    expect(calls()).toBe(2);
  });

  it('allows the port-less form only for port 80', () => {
    expect([...allowedHostHeaders('127.0.0.1', 8780)].sort()).toEqual(['127.0.0.1:8780', 'localhost:8780']);
    expect([...allowedHostHeaders('::1', 80)].sort()).toEqual(['[::1]', '[::1]:80', 'localhost', 'localhost:80']);
  });
});

describe('gateway HTTP server: POST requires application/json (cross-origin defence)', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON; Charset="UTF-8"', 'application/json;charset=utf8'])(
    'accepts %s',
    async (contentType) => {
      const { api, calls } = counted(fixture().api);
      const server = await start(api);
      const res = await raw(server, {
        method: 'POST',
        path: API_V1_ROUTES.pairing,
        headers: { 'Content-Type': contentType },
        body: pairingBody('WRNG-WRNG-WRNG'),
      });
      expect(res.status).toBe(401);
      expect(code(res)).toBe('INVALID_PAIRING_CODE');
      expect(calls()).toBe(1);
    },
  );

  it.each([
    ['missing', undefined],
    ['text/plain', 'text/plain'],
    ['form-urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['text/json', 'text/json'],
    ['application/jsonp', 'application/jsonp'],
    ['a non-UTF-8 charset', 'application/json; charset=iso-8859-1'],
  ])('rejects %s with 415 before the API and without a pairing attempt', async (_label, contentType) => {
    const fx = fixture();
    const { api, calls } = counted(fx.api);
    const server = await start(api);
    const before = sessionCount(fx.db);
    const res = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: contentType ? { 'Content-Type': contentType } : {},
      body: pairingBody(TEST_ONLY_PAIRING_CODE),
    });
    expect(res.status).toBe(415);
    expect(code(res)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.headers.connection).toBe('close');
    expect(calls()).toBe(0);
    expect(sessionCount(fx.db)).toBe(before);
  });

  it('checks the content type before reading the body (an oversized text/plain body gets 415, not 413)', async () => {
    const server = await start(fixture().api);
    const res = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.pairing,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.alloc(MAX_JSON_BODY_BYTES * 4, 0x20),
    });
    expect(res.status).toBe(415);
  });

  it('does not require a content type on GET', async () => {
    const server = await start(fixture().api);
    const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.session, headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(401);
    expect(code(res)).toBe('UNPAIRED');
  });

  it('keeps legitimate JSON POSTs working and authorization enforced', async () => {
    const server = await start(fixture().api);
    const unauth = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.fieldSelections,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: 'x' }),
    });
    expect(unauth.status).toBe(401);
    expect(code(unauth)).toBe('UNPAIRED');

    const token = await pair(server);
    const field = await raw(server, { method: 'GET', path: API_V1_ROUTES.field, headers: bearer(token) });
    expect(field.status).toBe(200);
    const fieldId = (field.json as { field: { id: string } }).field.id;
    const selected = await raw(server, {
      method: 'POST',
      path: API_V1_ROUTES.fieldSelections,
      headers: { ...bearer(token), 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fieldId }),
    });
    expect(selected.status).toBe(201);
  });

  it('isJsonContentType accepts only application/json with an optional UTF-8 charset', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType(' application/json ; charset=UTF-8')).toBe(true);
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType('application/json; charset=latin1')).toBe(false);
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
  });
});

describe('gateway HTTP server: connection timeouts are actually enforced', () => {
  // Short TEST-ONLY timeouts so enforcement is observable in under a second; the
  // production values (10 s / 15 s, 1 s sweep) are asserted in the binding test above.
  const T = { headersMs: 400, requestMs: 800, keepAliveMs: 5_000, checkIntervalMs: 100 };
  // Upper tolerance for slow machines: Node closes a stalled connection on the first
  // sweep after the timeout, i.e. within timeout + checkIntervalMs, plus scheduling delay.
  const SLACK_MS = 1_000;
  // Lower tolerance: timers are measured from the client side, so allow a little early.
  const EARLY_MS = 50;

  async function startWithTimeouts(api: LocalApi) {
    running = await startGatewayHttpServer({ api, host: '127.0.0.1', port: 0, timeouts: T });
    return running;
  }

  /** Writes `payload`, optionally trickles one byte per tick, and reports when the server closed the socket. */
  function stall(server: RunningGatewayHttpServer, payload: string, trickleEveryMs?: number): Promise<{ elapsedMs: number; statusLine: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(server.port, server.host);
      let out = '';
      let trickle: NodeJS.Timeout | undefined;
      const started = performance.now();
      const cap = setTimeout(() => {
        socket.destroy();
        reject(new Error('connection was not closed within 10 s'));
      }, 10_000);
      socket.on('data', (d) => (out += String(d)));
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(cap);
        if (trickle) clearInterval(trickle);
        resolve({ elapsedMs: performance.now() - started, statusLine: out.split('\r\n')[0] ?? '' });
      });
      socket.write(payload);
      if (trickleEveryMs) trickle = setInterval(() => socket.write('a'), trickleEveryMs);
    });
  }

  it('closes a connection whose headers stall, with 408, shortly after headersMs', async () => {
    const { api, calls } = counted(fixture().api);
    const server = await startWithTimeouts(api);
    const r = await stall(server, `GET ${API_V1_ROUTES.session} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n`);
    expect(r.statusLine).toBe('HTTP/1.1 408 Request Timeout');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(T.headersMs - EARLY_MS);
    expect(r.elapsedMs).toBeLessThanOrEqual(T.headersMs + T.checkIntervalMs + SLACK_MS);
    expect(calls()).toBe(0);
  });

  it('closes a stalled request body, with 408, shortly after requestMs and before the API runs', async () => {
    const { api, calls } = counted(fixture().api);
    const server = await startWithTimeouts(api);
    const r = await stall(
      server,
      `POST ${API_V1_ROUTES.pairing} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"pairingCode":`,
    );
    expect(r.statusLine).toBe('HTTP/1.1 408 Request Timeout');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(T.requestMs - EARLY_MS);
    expect(r.elapsedMs).toBeLessThanOrEqual(T.requestMs + T.checkIntervalMs + SLACK_MS);
    expect(calls()).toBe(0);
  });

  it('a body trickled one byte at a time cannot keep the request open past requestMs', async () => {
    const { api, calls } = counted(fixture().api);
    const server = await startWithTimeouts(api);
    const r = await stall(
      server,
      `POST ${API_V1_ROUTES.pairing} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n`,
      50,
    );
    // The guarantee: the connection is cut off at requestMs, before the API runs.
    expect(r.elapsedMs).toBeGreaterThanOrEqual(T.requestMs - EARLY_MS);
    expect(r.elapsedMs).toBeLessThanOrEqual(T.requestMs + T.checkIntervalMs + SLACK_MS);
    expect(calls()).toBe(0);
    // Because this client is still writing when the server closes, a trickled
    // byte can arrive after the close and trigger a TCP reset, which may make
    // the client discard the 408 it already received (observed intermittently
    // under parallel test load). Either outcome means the request was refused.
    expect(['HTTP/1.1 408 Request Timeout', '']).toContain(r.statusLine);
  });

  it('still serves a normal request completed within the limits', async () => {
    const server = await startWithTimeouts(fixture().api);
    const res = await raw(server, { method: 'GET', path: API_V1_ROUTES.session });
    expect(res.status).toBe(401);
    expect(code(res)).toBe('UNPAIRED');
  });
});
