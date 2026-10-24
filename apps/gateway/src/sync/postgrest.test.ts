import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { seedDemo } from '../seed/demo';
import { FakePostgrest, TEST_ONLY_SERVICE_KEY } from '../test/fakePostgrest';
import { addTestRobot, memoryDb } from '../test/helpers';
import { cloudRowsFor, type CloudTable } from './cloudRows';
import {
  CloudCredential,
  CloudTargetError,
  createPostgrestTransport,
  parseCloudTarget,
  type CloudTarget,
} from './postgrest';
import { uploadEntity } from './uploadEntity';

const LOCAL = 'http://127.0.0.1:54321';

function fakeTarget(): { fake: FakePostgrest; target: CloudTarget } {
  const fake = new FakePostgrest(TEST_ONLY_SERVICE_KEY);
  return { fake, target: parseCloudTarget({ url: LOCAL, serviceRoleKey: TEST_ONLY_SERVICE_KEY }, 'demo') };
}

describe('cloud target configuration', () => {
  const key = TEST_ONLY_SERVICE_KEY;
  it('accepts an https project origin for a field database and a loopback target for any database', () => {
    expect(parseCloudTarget({ url: 'https://abc.supabase.co', serviceRoleKey: key }, 'field')).toMatchObject({
      origin: 'https://abc.supabase.co',
      isLoopback: false,
    });
    for (const url of ['http://127.0.0.1:54321', 'http://localhost:54321/', 'http://[::1]:3000']) {
      expect(parseCloudTarget({ url, serviceRoleKey: key }, 'demo').isLoopback).toBe(true);
    }
  });

  it.each([
    [undefined, 'field', /Set SUPABASE_URL/],
    ['not a url', 'field', /not a valid URL/],
    ['http://abc.supabase.co', 'field', /https/],
    ['http://192.168.1.10:54321', 'field', /https/],
    ['https://user:pw@abc.supabase.co', 'field', /credentials/],
    ['https://abc.supabase.co/rest/v1', 'field', /bare project origin/],
    ['https://abc.supabase.co/?x=1', 'field', /bare project origin/],
    ['https://abc.supabase.co', 'demo', /demo database; it may only sync to a loopback/],
  ] as const)('refuses %s (%s database)', (url, purpose, message) => {
    expect(() => parseCloudTarget({ url, serviceRoleKey: key }, purpose)).toThrow(message);
  });

  it('validates the key without ever echoing it', () => {
    const secretish = 'short-secret-value';
    for (const bad of [undefined, '', secretish, `${key} with spaces`, `${key}\n`]) {
      let message = '';
      try {
        parseCloudTarget({ url: LOCAL, serviceRoleKey: bad }, 'demo');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudTargetError);
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secretish);
      expect(message).not.toContain(key);
    }
  });

  it('never prints or serialises the credential', () => {
    const credential = new CloudCredential(TEST_ONLY_SERVICE_KEY);
    const target = parseCloudTarget({ url: LOCAL, serviceRoleKey: TEST_ONLY_SERVICE_KEY }, 'demo');
    for (const text of [String(credential), JSON.stringify(target), inspect(target, { depth: 5 }), `${credential}`]) {
      expect(text).not.toContain(TEST_ONLY_SERVICE_KEY);
    }
    expect(Object.keys(credential)).toEqual([]);
  });
});

describe('PostgREST transport (fake endpoint)', () => {
  it('inserts with the primary key as conflict target, ignore-duplicates, and the key only in headers', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb('demo');
    seedDemo(db);
    const rec = String(db.prepare('SELECT id FROM recommendations LIMIT 1').get()?.id);
    const ruleSet = String(db.prepare('SELECT rule_set_id FROM recommendations LIMIT 1').get()?.rule_set_id);
    // Parents first so the fake's foreign keys are satisfied.
    const robot = String(db.prepare('SELECT id FROM robots LIMIT 1').get()?.id);
    for (const [type, id] of [['robot', robot], ['rule_set', ruleSet]] as const) {
      for (const t of cloudRowsFor(db, type, id)) expect((await transport.insert(t.table, t.rows)).ok).toBe(true);
    }
    const scores = cloudRowsFor(db, 'recommendation', rec)[1];
    if (!scores) throw new Error('missing');
    const post = fake.requests.find((r) => r.table === 'rule_crops');
    expect(post?.query).toBe('?on_conflict=rule_set_id%2Ccrop_key');
    expect(post?.headers).toMatchObject({
      prefer: 'resolution=ignore-duplicates,return=representation',
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_ONLY_SERVICE_KEY}`,
    });
    expect(post?.query).not.toContain(TEST_ONLY_SERVICE_KEY);
    // Replaying an insert inserts nothing.
    const robots = cloudRowsFor(db, 'robot', robot)[0];
    if (!robots) throw new Error('missing');
    expect(await transport.insert('robots', robots.rows)).toEqual({ ok: true, value: 0 });
    expect(await transport.insert('robots', [])).toEqual({ ok: true, value: 0 });
    expect(fake.count('robots')).toBe(1);
  });

  it('selects by an encoded equality filter and keeps only the error code, never the message', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    expect(await transport.select('robots', 'id', 'a b&c=d')).toEqual({ ok: true, value: [] });
    expect(fake.requests[0]?.query).toBe('?select=*&id=eq.a%20b%26c%3Dd');
    fake.fault = () => ({ status: 409, code: '23505', message: 'Key (ph)=(5.4321) secret' });
    const result = await transport.insert('robots', [{ id: 'x' }]);
    expect(result).toEqual({ ok: false, failure: { kind: 'http', status: 409, pgCode: '23505' } });
    expect(JSON.stringify(result)).not.toContain('5.4321');
    fake.fault = () => ({ status: 500, code: 'not a code; DROP' });
    expect(await transport.select('robots', 'id', 'x')).toEqual({ ok: false, failure: { kind: 'http', status: 500, pgCode: null } });
  });

  it('maps refused connections to not_sent and lost responses to no_response', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    fake.fault = () => 'refuse';
    expect(await transport.insert('robots', [{ id: 'x' }])).toEqual({ ok: false, failure: { kind: 'not_sent' } });
    fake.fault = () => 'timeout';
    expect(await transport.insert('robots', [{ id: 'x' }])).toEqual({ ok: false, failure: { kind: 'no_response' } });
  });
});

describe('uploadEntity (fake endpoint)', () => {
  it('confirms an upload, then confirms a replay as a duplicate without new rows', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toMatchObject({ kind: 'confirmed', duplicate: false });
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toMatchObject({ kind: 'confirmed', duplicate: true });
    expect(fake.count('robots')).toBe(1);
  });

  it('a lost response after the cloud committed is ambiguous, and the retry confirms it as a duplicate', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    fake.fault = (r) => (r.method === 'POST' ? 'commit_then_timeout' : undefined);
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toEqual({ kind: 'ambiguous', code: 'outcome_unknown', stopCycle: true });
    expect(fake.count('robots')).toBe(1); // it DID land
    fake.fault = () => undefined;
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toMatchObject({ kind: 'confirmed', duplicate: true });
  });

  it('a partial aggregate (failure after the first table) is never confirmed and completes on retry', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb('demo');
    seedDemo(db);
    const ruleSet = String(db.prepare('SELECT id FROM rule_sets LIMIT 1').get()?.id);
    const local = cloudRowsFor(db, 'rule_set', ruleSet);
    fake.fault = (r) => (r.table === 'rule_suitability_ranges' ? { status: 503 } : undefined);
    expect(await uploadEntity(transport, 'rule_set', ruleSet, local)).toMatchObject({ kind: 'ambiguous' });
    expect(fake.count('rule_sets')).toBe(1);
    expect(fake.count('rule_suitability_ranges')).toBe(0);
    fake.fault = () => undefined;
    expect(await uploadEntity(transport, 'rule_set', ruleSet, local)).toMatchObject({ kind: 'confirmed', duplicate: false });
    const tables: CloudTable[] = ['rule_sets', 'rule_crops', 'rule_suitability_ranges', 'rule_seasons', 'rule_seasonal_weather_defaults'];
    for (const t of tables) expect(fake.count(t), t).toBe(local.find((x) => x.table === t)?.rows.length);
  });

  it('blocks different cloud content under the same key (content conflict)', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    await uploadEntity(transport, 'robot', robot.id, local);
    const stored = fake.rows('robots')[0];
    if (!stored) throw new Error('missing');
    stored.display_name = 'changed in the cloud';
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toEqual({ kind: 'permanent', reason: 'content_conflict' });
  });

  it('blocks a natural-key clash with a different primary key (identity conflict)', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    const [robots] = local;
    if (!robots) throw new Error('missing');
    fake.tables.set('robots', [{ ...robots.rows[0], id: '00000000-0000-4000-8000-000000000000' }]);
    expect(await uploadEntity(transport, 'robot', robot.id, local)).toEqual({ kind: 'permanent', reason: 'identity_conflict' });
  });

  it('blocks an aggregate over the request budget without sending anything', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb();
    const robot = addTestRobot(db);
    expect(await uploadEntity(transport, 'robot', robot.id, cloudRowsFor(db, 'robot', robot.id), 10)).toEqual({
      kind: 'permanent',
      reason: 'aggregate_too_large',
    });
    expect(fake.requests).toEqual([]);
  });

  it('rejected credentials are retryable and target-wide, never a data block', async () => {
    const fake = new FakePostgrest('A-DIFFERENT-TEST-ONLY-KEY-VALUE');
    const target = parseCloudTarget({ url: LOCAL, serviceRoleKey: TEST_ONLY_SERVICE_KEY }, 'demo');
    const db = memoryDb();
    const robot = addTestRobot(db);
    expect(
      await uploadEntity(createPostgrestTransport(target, { fetch: fake.fetch }), 'robot', robot.id, cloudRowsFor(db, 'robot', robot.id)),
    ).toEqual({ kind: 'retryable', code: 'auth_rejected', stopCycle: true });
  });
});

describe('PostgREST transport over real loopback HTTP', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const s = createServer(handler);
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  const target = (url: string) => parseCloudTarget({ url, serviceRoleKey: TEST_ONLY_SERVICE_KEY }, 'demo');

  it('aborts at the timeout when the server never answers', async () => {
    const url = await listen(() => undefined); // never responds
    const started = Date.now();
    const result = await createPostgrestTransport(target(url), { timeoutMs: 200 }).select('robots', 'id', 'x');
    expect(result).toEqual({ ok: false, failure: { kind: 'no_response' } });
    expect(Date.now() - started).toBeLessThan(5_000);
    server?.closeAllConnections();
  });

  it('times out a response body that stalls part-way', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[{"id":');
    });
    expect(await createPostgrestTransport(target(url), { timeoutMs: 200 }).select('robots', 'id', 'x')).toEqual({
      ok: false,
      failure: { kind: 'no_response' },
    });
    server?.closeAllConnections();
  });

  it('rejects oversized, non-JSON, wrongly shaped and wrong-status bodies', async () => {
    let body = '';
    let type = 'application/json';
    let status = 200;
    const url = await listen((_req, res) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    });
    const transport = createPostgrestTransport(target(url), { maxResponseBytes: 1024 });
    const cases: [string, string, number][] = [
      ['x'.repeat(5000), 'application/json', 200],
      ['<html>', 'text/html', 200],
      ['{"not":"an array"}', 'application/json', 200],
      ['[1, 2]', 'application/json', 200],
      ['[]', 'application/json', 204],
    ];
    for ([body, type, status] of cases) {
      expect(await transport.select('robots', 'id', 'x')).toMatchObject({ ok: false, failure: { kind: 'invalid_response' } });
    }
    body = '[{"id":"x"}]';
    type = 'application/json; charset=utf-8';
    status = 200;
    expect(await transport.select('robots', 'id', 'x')).toEqual({ ok: true, value: [{ id: 'x' }] });
  });

  it('a refused connection is not_sent', async () => {
    const url = await listen(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await createPostgrestTransport(target(url)).select('robots', 'id', 'x')).toEqual({
      ok: false,
      failure: { kind: 'not_sent' },
    });
  });

  it('does not follow redirects: the key is never forwarded, and the 3xx is an HTTP failure', async () => {
    let elsewhereHits = 0;
    const elsewhere = createServer((_req, res) => {
      elsewhereHits += 1;
      res.end('[]');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', () => resolve()));
    try {
      const location = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/rest/v1/robots`;
      const url = await listen((_req, res) => {
        res.writeHead(307, { location });
        res.end();
      });
      const transport = createPostgrestTransport(target(url));
      expect(await transport.select('robots', 'id', 'x')).toEqual({ ok: false, failure: { kind: 'http', status: 307, pgCode: null } });
      expect(await transport.insert('robots', [{ id: 'x' }])).toEqual({ ok: false, failure: { kind: 'http', status: 307, pgCode: null } });
      expect(elsewhereHits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
    }
  });

  it('detects a read truncated by a server row cap from the exact count', async () => {
    let range = '0-0/1';
    const url = await listen((req, res) => {
      expect(req.headers.prefer).toBe('count=exact');
      res.writeHead(200, { 'content-type': 'application/json', 'content-range': range });
      res.end('[{"id":"x"}]');
    });
    const transport = createPostgrestTransport(target(url));
    expect(await transport.select('robots', 'id', 'x')).toEqual({ ok: true, value: [{ id: 'x' }] });
    range = '0-0/1001';
    expect(await transport.select('robots', 'id', 'x')).toEqual({ ok: false, failure: { kind: 'truncated' } });
    range = '0-0/*'; // no exact count available: cannot tell, accepted (missing rows still fail verification)
    expect((await transport.select('robots', 'id', 'x')).ok).toBe(true);
  });

  it('handles 206 Partial Content on reads: truncated unless the exact count proves it complete', async () => {
    let status = 206;
    let range = '0-0/1001';
    const url = await listen((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-range': range });
      res.end('[{"id":"x"}]');
    });
    const transport = createPostgrestTransport(target(url));
    const cases: [number, string, unknown][] = [
      [206, '0-0/1001', { ok: false, failure: { kind: 'truncated' } }], // what PostgREST sends at its row cap
      [206, '0-0/*', { ok: false, failure: { kind: 'truncated' } }], // partial, with no count to prove otherwise
      [206, 'garbage', { ok: false, failure: { kind: 'truncated' } }],
      [206, '0-0/1', { ok: true, value: [{ id: 'x' }] }], // a valid 206 whose exact count matches
      [200, '0-0/1', { ok: true, value: [{ id: 'x' }] }], // ordinary complete read
      [200, '0-0/1001', { ok: false, failure: { kind: 'truncated' } }],
      [203, '0-0/1', { ok: false, failure: { kind: 'invalid_response', status: 203 } }], // other 2xx still refused
    ];
    for ([status, range] of cases.map(([s, r]) => [s, r] as const)) {
      const expected = cases.find(([s, r]) => s === status && r === range)?.[2];
      expect(await transport.select('robots', 'id', 'x'), `${status} ${range}`).toEqual(expected);
    }
  });

  it('never accepts 206 on a write', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(206, { 'content-type': 'application/json', 'content-range': '0-0/1' });
      res.end('[{"id":"x"}]');
    });
    expect(await createPostgrestTransport(target(url)).insert('robots', [{ id: 'x' }])).toEqual({
      ok: false,
      failure: { kind: 'invalid_response', status: 206 },
    });
  });
});

describe('server row cap (fake endpoint)', () => {
  it('a truncated read-back is never confirmed; it is a row-specific retry', async () => {
    const { fake, target } = fakeTarget();
    const transport = createPostgrestTransport(target, { fetch: fake.fetch });
    const db = memoryDb('demo');
    seedDemo(db);
    const ruleSet = String(db.prepare('SELECT id FROM rule_sets LIMIT 1').get()?.id);
    const local = cloudRowsFor(db, 'rule_set', ruleSet);
    fake.maxRows = 1;
    expect(await uploadEntity(transport, 'rule_set', ruleSet, local)).toEqual({
      kind: 'retryable',
      code: 'read_truncated',
      stopCycle: false,
    });
    // The rows did land; the fake (like PostgREST) answers the capped read with 206 Partial Content.
    const statuses: number[] = [];
    const recording = createPostgrestTransport(target, {
      fetch: async (url, init) => {
        const response = await fake.fetch(url, init);
        statuses.push(response.status);
        return response;
      },
    });
    expect(await recording.select('rule_crops', 'rule_set_id', ruleSet)).toEqual({ ok: false, failure: { kind: 'truncated' } });
    expect(statuses).toEqual([206]);
    fake.maxRows = Number.POSITIVE_INFINITY;
    expect(await uploadEntity(transport, 'rule_set', ruleSet, local)).toMatchObject({ kind: 'confirmed', duplicate: true });
  });
});
