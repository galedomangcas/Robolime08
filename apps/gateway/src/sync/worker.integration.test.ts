import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../db/connection';
import { initDatabase } from '../db/init';
import { systemClock, toCanonicalUtc, type Clock } from '../db/time';
import { DEMO_VERIFICATION_RUN, seedDemo } from '../seed/demo';
import { countByState, getEntry, type OutboxEntityType } from '../store/outbox';
import { acquireLease, LeaseLostError, syncDiagnostics, type WorkerLease } from '../store/syncLease';
import { count, memoryDb } from '../test/helpers';
import { CLOUD_PRIMARY_KEYS, ROOT_TABLE } from './cloudContract';
import { allOutboxEntities, cloudRowsFor, type CloudTable } from './cloudRows';
import { classifyFailure } from './confirmation';
import { createPostgrestTransport, parseCloudTarget, type CloudTransport, type FetchLike } from './postgrest';
import { uploadEntity } from './uploadEntity';
import { runSyncCycle, type CycleCounts } from './worker';

/**
 * OPT-IN INTEGRATION TEST against a REAL local PostgREST + throwaway
 * PostgreSQL. It runs only when started by
 * `supabase/tests/run-sync-integration.mjs`, which sets ROBOLIME_SYNC_IT=1 and
 * the loopback targets below; in every ordinary test run it is skipped and
 * starts nothing. All data is the synthetic demo dataset in an in-memory
 * demo-purpose SQLite database (which the worker refuses to sync to any
 * non-loopback target). Tokens come from the runner, are signed with a
 * per-run throwaway secret, and are never printed.
 *
 * Requests go through sync_proxy.mjs (in-process, 127.0.0.1), which strips the
 * `/rest/v1` prefix and injects faults into explicitly matched requests only.
 *
 * NOT covered here: real-time lease expiry across two OS processes (R14,
 * ~2 min wait), Supabase's API gateway and key formats (needs the official
 * stack, OPEN_ITEMS #17). Lines marked [observation] record behaviour the
 * plan could not confirm in advance (HTTP 206, row cap on insert responses).
 */

interface ItEnv {
  postgrest: string;
  capped: string;
  maxRows: number;
  version: string;
  token: string;
  badToken: string;
  anonToken: string;
  proxyModule: string;
}

function readEnv(): ItEnv | null {
  const e = process.env;
  if (e.ROBOLIME_SYNC_IT !== '1') return null;
  const need = (key: string): string => {
    const value = e[key];
    if (!value) throw new Error(`${key} is not set (start this test through run-sync-integration.mjs)`);
    return value;
  };
  const loopback = (key: string): string => {
    const url = new URL(need(key));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`${key} must be an http://127.0.0.1 URL`);
    return url.origin;
  };
  return {
    postgrest: loopback('ROBOLIME_SYNC_IT_POSTGREST_URL'),
    capped: loopback('ROBOLIME_SYNC_IT_CAPPED_URL'),
    maxRows: Number(need('ROBOLIME_SYNC_IT_MAX_ROWS')),
    version: need('ROBOLIME_SYNC_IT_POSTGREST_VERSION'),
    token: need('ROBOLIME_SYNC_IT_TOKEN'),
    badToken: need('ROBOLIME_SYNC_IT_BAD_TOKEN'),
    anonToken: need('ROBOLIME_SYNC_IT_ANON_TOKEN'),
    proxyModule: need('ROBOLIME_SYNC_IT_PROXY_MODULE'),
  };
}

const IT = readEnv();
function env(): ItEnv {
  if (IT === null) throw new Error('integration environment missing');
  return IT;
}

type ProxyAction =
  | { type: 'drop_after_commit' }
  | { type: 'status'; status: number; code?: string }
  | { type: 'delay'; ms: number; onDelay?: () => void | Promise<void> }
  | { type: 'hold_after_commit'; onHeld?: () => void | Promise<void> };

interface SyncProxy {
  url: string;
  addFault(rule: { method?: 'GET' | 'POST'; table?: CloudTable; times?: number; action: ProxyAction }): void;
  clearFaults(): void;
  setRefusing(refuse: boolean): Promise<void>;
  requestCount(): number;
  close(): Promise<void>;
}

interface ProxyModule {
  startSyncProxy(options: { upstream: string }): Promise<SyncProxy>;
}

/** Child tables first, so deletes never hit a foreign key. */
const CHILD_FIRST: CloudTable[] = [
  'recommendation_scores', 'recommendations', 'rule_seasonal_weather_defaults', 'rule_seasons',
  'rule_suitability_ranges', 'rule_crops', 'readings', 'robot_status_reports', 'runs', 'field_cells', 'fields',
  'rule_sets', 'robots',
];

/** Direct request to the uncapped PostgREST (no proxy, no /rest/v1 prefix). */
function direct(path: string, init: { method?: string; body?: unknown; prefer?: string; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? env().token}`, accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.prefer) headers.prefer = init.prefer;
  return fetch(`${env().postgrest}/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function cloudCount(table: CloudTable): Promise<number> {
  const response = await direct(`${table}?select=*&limit=1`, { prefer: 'count=exact' });
  await response.arrayBuffer();
  const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
  if (!response.ok || total === undefined) throw new Error(`cannot count ${table} (HTTP ${response.status})`);
  return Number(total);
}

async function resetCloud(): Promise<void> {
  for (const table of CHILD_FIRST) {
    const pk = (CLOUD_PRIMARY_KEYS[table] as readonly string[])[0];
    const response = await direct(`${table}?${pk}=not.is.null`, { method: 'DELETE', prefer: 'return=minimal' });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`cannot reset ${table} (HTTP ${response.status})`);
  }
}

function transportTo(url: string, options: { token?: string; fetch?: FetchLike } = {}): CloudTransport {
  // 'demo' purpose: proves the demo-database guard accepts this loopback target.
  const target = parseCloudTarget({ url, serviceRoleKey: options.token ?? env().token }, 'demo');
  return createPostgrestTransport(target, { fetch: options.fetch, timeoutMs: 15_000 });
}

interface Observed {
  method: string;
  table: string;
  status: number;
  contentRange: string | null;
}

function recordingFetch(log: Observed[]): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    const table = new URL(url).pathname.split('/').pop() ?? '';
    log.push({ method: init.method ?? 'GET', table, status: response.status, contentRange: response.headers.get('content-range') });
    return response;
  };
}

// Written straight to stderr so the runner's output always includes it (no secrets are ever passed here).
const observe = (what: string, value: unknown) => {
  process.stderr.write(`[observation] ${what}: ${JSON.stringify(value)}\n`);
};

function demoDb(): Database {
  const db = memoryDb('demo');
  seedDemo(db);
  return db;
}

function acquire(db: Database, clock: Clock = systemClock): WorkerLease {
  const result = acquireLease(db, clock);
  if (!result.acquired) throw new Error('expected the lease');
  return result.lease;
}

const allSynced = (db: Database) => countByState(db).synced === count(db, 'sync_outbox');

/** Cycles until everything is synced (retry jitter 0, so failed entries are due again at once). */
async function syncAll(db: Database, transport: CloudTransport, lease = acquire(db), maxCycles = 30): Promise<CycleCounts[]> {
  const cycles: CycleCounts[] = [];
  for (let i = 0; i < maxCycles && !allSynced(db); i++) {
    cycles.push(await runSyncCycle({ db, transport, lease, clock: systemClock, random: () => 0, limit: 10 }));
  }
  return cycles;
}

function expectedCloudCounts(db: Database): Map<CloudTable, number> {
  const counts = new Map<CloudTable, number>();
  for (const { entityType, entityId } of allOutboxEntities(db)) {
    for (const { table, rows } of cloudRowsFor(db, entityType, entityId)) counts.set(table, (counts.get(table) ?? 0) + rows.length);
  }
  return counts;
}

async function expectCloudMatchesLocal(db: Database): Promise<void> {
  for (const [table, n] of expectedCloudCounts(db)) expect(await cloudCount(table), table).toBe(n);
}

const idOf = (db: Database, sql: string, ...params: string[]) => String(db.prepare(sql).get(...params)?.id);

describe.skipIf(IT === null)('cloud sync against a real local PostgREST (opt-in, run-sync-integration.mjs)', () => {
  let proxyModule: ProxyModule;
  let proxy: SyncProxy;
  let cappedProxy: SyncProxy;

  beforeAll(async () => {
    proxyModule = (await import(pathToFileURL(env().proxyModule).href)) as ProxyModule;
    proxy = await proxyModule.startSyncProxy({ upstream: env().postgrest });
    cappedProxy = await proxyModule.startSyncProxy({ upstream: env().capped });
    observe('PostgREST server header', env().version);
  });

  afterAll(async () => {
    await proxy?.close();
    await cappedProxy?.close();
  });

  beforeEach(async () => {
    for (const p of [proxy, cappedProxy]) {
      p.clearFaults();
      await p.setRefusing(false);
    }
    await resetCloud();
  });

  // R1 + R11. Pre: empty cloud. Expect: every entry synced with the cloud's receipt
  // time, parents before children (real foreign keys: no 23503, nothing blocked),
  // cloud row counts equal to the local aggregates.
  it('R1/R11 syncs the whole demo dataset parents-first with verified confirmations', async () => {
    const db = demoDb();
    await syncAll(db, transportTo(proxy.url));
    expect(allSynced(db)).toBe(true);
    await expectCloudMatchesLocal(db);
    expect(syncDiagnostics(db, systemClock).blocked).toEqual([]);
    const local = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE cloud_confirmed_at IS NULL`).get();
    expect(local).toEqual({ n: 0 });
    // The recorded confirmation time is the cloud's own cloud_received_at (one entry per type).
    const samples = db
      .prepare(`SELECT entity_type, entity_id, cloud_confirmed_at FROM sync_outbox WHERE id IN (SELECT MIN(id) FROM sync_outbox GROUP BY entity_type)`)
      .all();
    expect(samples.length).toBe(7);
    for (const sample of samples) {
      const type = String(sample.entity_type) as OutboxEntityType;
      const response = await direct(`${ROOT_TABLE[type]}?select=cloud_received_at&id=eq.${String(sample.entity_id)}`);
      const rows = (await response.json()) as { cloud_received_at?: unknown }[];
      expect(rows, type).toHaveLength(1);
      const received = String(rows[0]?.cloud_received_at);
      expect(toCanonicalUtc(new Date(Date.parse(received))), type).toBe(sample.cloud_confirmed_at);
    }
  });

  // R2. Pre: R1 state, local outbox reset to pending. Expect: no new cloud rows; every
  // entry confirmed again as a duplicate.
  it('R2 replaying the whole dataset creates no duplicates', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    const lease = acquire(db); // one worker; each cycle renews it
    await syncAll(db, transport, lease);
    const before = expectedCloudCounts(db);
    db.exec(`UPDATE sync_outbox SET state = 'pending', cloud_confirmed_at = NULL`);
    const cycles = await syncAll(db, transport, lease);
    expect(allSynced(db)).toBe(true);
    expect(cycles.reduce((n, c) => n + c.duplicates, 0)).toBe(count(db, 'sync_outbox'));
    for (const [table, n] of before) expect(await cloudCount(table), table).toBe(n);
  });

  // R3/R4. Expect: insert 201 returning only new rows (then 0); complete read 200
  // with an exact Content-Range total equal to the rows returned.
  it('R3/R4 insert and read responses are what the transport expects', async () => {
    const db = demoDb();
    const log: Observed[] = [];
    const transport = transportTo(proxy.url, { fetch: recordingFetch(log) });
    const robotId = idOf(db, 'SELECT id FROM robots');
    const [robots] = cloudRowsFor(db, 'robot', robotId);
    if (!robots) throw new Error('missing robot rows');
    expect(await transport.insert('robots', robots.rows)).toEqual({ ok: true, value: 1 });
    expect(await transport.insert('robots', robots.rows)).toEqual({ ok: true, value: 0 });
    const read = await transport.select('robots', 'id', robotId);
    expect(read.ok && read.value.length).toBe(1);
    observe('insert/read statuses', log);
    expect(log.map((l) => l.status)).toEqual([201, 201, 200]);
    expect(log[2]?.contentRange).toMatch(/^0-0\/1$/);
  });

  // R5/R6. Pre: capped PostgREST (db-max-rows = SYNC_IT_MAX_ROWS < 20 field cells).
  // Expect (D35): a capped read is detected as truncated (206 + exact total expected)
  // and the field is never confirmed through the capped target.
  // UNRESOLVED (observed, not assumed): the exact status, and whether the cap also
  // limits the rows returned by an insert (`return=representation`).
  it('R5/R6 a row-capped read-back is truncated and never confirmed', async () => {
    const db = demoDb();
    const fieldId = idOf(db, 'SELECT id FROM fields');
    const robotId = idOf(db, 'SELECT id FROM robots');
    const local = cloudRowsFor(db, 'field', fieldId);
    const cells = local.find((t) => t.table === 'field_cells')?.rows ?? [];
    expect(cells.length).toBeGreaterThan(env().maxRows); // precondition
    const full = transportTo(proxy.url);
    expect(await uploadEntity(full, 'robot', robotId, cloudRowsFor(db, 'robot', robotId))).toMatchObject({ kind: 'confirmed' });

    const log: Observed[] = [];
    const capped = transportTo(cappedProxy.url, { fetch: recordingFetch(log) });
    const [fields] = local;
    if (!fields) throw new Error('missing field rows');
    expect((await capped.insert('fields', fields.rows)).ok).toBe(true);
    const inserted = await capped.insert('field_cells', cells);
    observe(`rows reported by a capped insert of ${cells.length} cells (R6)`, inserted);
    expect(await cloudCount('field_cells')).toBe(cells.length); // all rows landed, whatever was reported
    const read = await capped.select('field_cells', 'field_id', fieldId);
    observe('capped read', log.at(-1));
    expect(read).toEqual({ ok: false, failure: { kind: 'truncated' } });
    expect(await uploadEntity(capped, 'field', fieldId, local)).toMatchObject({ kind: 'retryable', code: 'read_truncated' });
    expect(await uploadEntity(full, 'field', fieldId, local)).toMatchObject({ kind: 'confirmed', duplicate: true });

    // Worker level: through the capped target the field entry never becomes synced.
    const workerDb = demoDb();
    await resetCloud();
    const cycles = await syncAll(workerDb, transportTo(cappedProxy.url), acquire(workerDb), 4);
    observe('capped worker cycles', cycles);
    // The target itself works (the one-row robot read is complete) …
    expect(getEntry(workerDb, 'robot', robotId)?.state).toBe('synced');
    // … and the field fails for the row cap specifically, never confirmed.
    expect(getEntry(workerDb, 'field', fieldId)).toMatchObject({
      state: 'failed',
      lastError: 'read_truncated',
      cloudConfirmedAt: null,
      blockedAt: null,
    });
  });

  // R7. Expect: a token signed with another secret, and a valid anon-role token, are
  // both rejected as auth_rejected (retryable, target-wide), never confirmed.
  it('R7 rejects a wrongly signed token and an anon-role token', async () => {
    const db = demoDb();
    const robotId = idOf(db, 'SELECT id FROM robots');
    const local = cloudRowsFor(db, 'robot', robotId);
    for (const token of [env().badToken, env().anonToken]) {
      const outcome = await uploadEntity(transportTo(proxy.url, { token }), 'robot', robotId, local);
      expect(outcome).toEqual({ kind: 'retryable', code: 'auth_rejected', stopCycle: true });
    }
    expect(await cloudCount('robots')).toBe(0);
  });

  // R8. Pre: the cloud holds a robot with the same source_robot_id under another id.
  // Expect: 23505 → blocked identity_conflict; its children are never uploaded.
  it('R8 blocks a natural-key clash and keeps children waiting', async () => {
    const db = demoDb();
    const robotId = idOf(db, 'SELECT id FROM robots');
    const [robots] = cloudRowsFor(db, 'robot', robotId);
    const clash = { ...robots?.rows[0], id: randomUUID() };
    const created = await direct('robots', { method: 'POST', body: [clash], prefer: 'return=minimal' });
    expect(created.status).toBe(201);
    await syncAll(db, transportTo(proxy.url), acquire(db), 4);
    expect(getEntry(db, 'robot', robotId)).toMatchObject({ state: 'failed', blockReason: 'identity_conflict' });
    expect(await cloudCount('runs')).toBe(0);
    expect(await cloudCount('fields')).toBe(0);
    expect(syncDiagnostics(db, systemClock).waitingOnBlockedParent.length).toBeGreaterThan(0);
  });

  // R9. Pre: synced robot whose cloud row was changed; the entry is re-queued by hand.
  // Expect: read-back mismatch → blocked content_conflict (the mirror never updates).
  it('R9 blocks differing cloud content as content_conflict', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    const lease = acquire(db); // one worker; each cycle renews it
    await syncAll(db, transport, lease);
    const robotId = idOf(db, 'SELECT id FROM robots');
    const patched = await direct(`robots?id=eq.${robotId}`, { method: 'PATCH', body: { display_name: 'changed in the cloud' } });
    expect(patched.ok).toBe(true);
    db.exec(`UPDATE sync_outbox SET state = 'pending', cloud_confirmed_at = NULL WHERE entity_type = 'robot'`);
    await runSyncCycle({ db, transport, lease, clock: systemClock, random: () => 0 });
    expect(getEntry(db, 'robot', robotId)).toMatchObject({ state: 'failed', blockReason: 'content_conflict' });
  });

  // R10. Expect: the cloud's dosing-only trigger rejects a recommendation for a
  // verification run with 23514 → row_rejected; updating a mirrored reading is
  // rejected by the immutability trigger with 23514.
  it('R10 cloud checks and triggers map to row_rejected', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    await syncAll(db, transport);
    const recId = idOf(db, 'SELECT id FROM recommendations');
    const verificationRun = idOf(db, 'SELECT id FROM runs WHERE source_run_id = ?', DEMO_VERIFICATION_RUN);
    const [recs] = cloudRowsFor(db, 'recommendation', recId);
    if (!recs?.rows[0]) throw new Error('missing recommendation');
    const bad = { ...recs.rows[0], id: randomUUID(), run_id: verificationRun };
    const result = await transport.insert('recommendations', [bad]);
    observe('dosing-only trigger response', result);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'http', pgCode: '23514' } });
    if (!result.ok) expect(classifyFailure('write', result.failure)).toEqual({ kind: 'permanent', reason: 'row_rejected' });
    const readingId = idOf(db, 'SELECT id FROM readings LIMIT 1');
    const update = await direct(`readings?id=eq.${readingId}`, { method: 'PATCH', body: { ph: 1 } });
    const body = (await update.json()) as { code?: unknown };
    observe('immutable reading update', { status: update.status, code: body.code });
    expect(body.code).toBe('23514');
  });

  // R12. Pre: the proxy forwards the first robots insert, the database commits, and
  // the response is dropped. Expect: outcome_unknown (failed, retry), exactly one
  // cloud row, then confirmed as a duplicate on retry.
  it('R12 an ambiguous write is retried and confirmed as a duplicate', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    proxy.addFault({ method: 'POST', table: 'robots', action: { type: 'drop_after_commit' } });
    const lease = acquire(db); // one worker; each cycle renews it
    const first = await runSyncCycle({ db, transport, lease, clock: systemClock, random: () => 0, limit: 10 });
    expect(first).toMatchObject({ ambiguous: 1, stoppedBy: 'outcome_unknown', confirmed: expect.any(Number) as number });
    const robotId = idOf(db, 'SELECT id FROM robots');
    expect(getEntry(db, 'robot', robotId)).toMatchObject({ state: 'failed', lastError: 'outcome_unknown', cloudConfirmedAt: null });
    expect(await cloudCount('robots')).toBe(1);
    const later = await syncAll(db, transport, lease);
    expect(allSynced(db)).toBe(true);
    expect(later.reduce((n, c) => n + c.duplicates, 0)).toBeGreaterThanOrEqual(1);
    expect(await cloudCount('robots')).toBe(1);
    await expectCloudMatchesLocal(db);
  });

  // R13. Pre: the proxy refuses connections. Expect: network_unavailable stops the
  // cycle, unattempted claims return to pending; after recovery everything syncs once.
  it('R13 network loss stops the cycle and recovers exactly once', async () => {
    // Isolation: a fresh proxy whose listener is closed BEFORE it ever accepts a connection.
    // The shared fetch connection pool therefore cannot hold a kept-alive socket to this port
    // (which earlier tests' proxy can leave behind and which fails as a reset, not a refusal),
    // so every attempt is a brand-new connection to a closed port: refused, nothing sent.
    const isolated = await proxyModule.startSyncProxy({ upstream: env().postgrest });
    try {
      await isolated.setRefusing(true);
      const errors: { name: string; causeCode: string | null }[] = [];
      const errorRecordingFetch: FetchLike = async (url, init) => {
        try {
          return await fetch(url, init);
        } catch (error) {
          const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
          errors.push({
            name: error instanceof Error ? error.name : typeof error,
            causeCode: typeof cause?.code === 'string' ? cause.code : null,
          });
          throw error;
        }
      };
      await runR13(isolated, transportTo(isolated.url, { fetch: errorRecordingFetch }), errors);
    } finally {
      await isolated.close();
    }
  });

  async function runR13(
    isolated: SyncProxy,
    transport: CloudTransport,
    errors: { name: string; causeCode: string | null }[],
  ): Promise<void> {
    const db = demoDb();
    const lease = acquire(db);
    const offline = await runSyncCycle({ db, transport, lease, clock: systemClock, random: () => 0, limit: 10 });
    observe('R13 transport errors while refusing', errors);
    expect(isolated.requestCount()).toBe(0); // nothing reached the proxy: refused at connect time
    expect(offline.stoppedBy).toBe('network_unavailable');
    expect(offline.claimed).toBeGreaterThan(0);
    expect(countByState(db).syncing).toBe(0);
    // Exactly the attempted entry failed with network_unavailable …
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE state = 'failed'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE last_error = 'network_unavailable'`).get()).toEqual({ n: 1 });
    // … and every other claimed entry went back to pending without an error.
    expect(offline.returned).toBe(offline.claimed - 1);
    const returned = db
      .prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE state = 'pending' AND last_attempt_at IS NOT NULL AND last_error IS NULL`)
      .get();
    expect(returned).toEqual({ n: offline.returned });
    await isolated.setRefusing(false);
    await syncAll(db, transport, lease);
    expect(allSynced(db)).toBe(true);
    await expectCloudMatchesLocal(db);
  }

  // R15. Injected clock (no real-time wait): a read stalls past the lease TTL while
  // another worker takes over. Expect: the stale worker records nothing
  // (LeaseLostError); the new owner confirms; one cloud row.
  it('R15 a worker that loses its lease during a request records nothing', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    let now = Date.now();
    const clock: Clock = () => new Date(now);
    const stale = acquire(db, clock);
    const takeover: { lease: WorkerLease | null } = { lease: null };
    proxy.addFault({
      method: 'GET',
      action: {
        type: 'delay',
        ms: 0,
        onDelay: () => {
          now += 130_000;
          takeover.lease = acquire(db, clock);
        },
      },
    });
    await expect(runSyncCycle({ db, transport, lease: stale, clock, random: () => 0, limit: 1 })).rejects.toThrow(LeaseLostError);
    expect(countByState(db).synced).toBe(0);
    const next = takeover.lease;
    if (next === null) throw new Error('expected a takeover');
    const counts = await runSyncCycle({ db, transport, lease: next, clock, random: () => 0, limit: 1 });
    expect(counts).toMatchObject({ confirmed: 1, duplicates: 1 });
    const synced = db.prepare(`SELECT entity_type FROM sync_outbox WHERE state = 'synced'`).all();
    expect(synced).toHaveLength(1);
  });

  // R16. Pre: the second table of the rule-set aggregate fails (503 without a database
  // code). Expect: ambiguous, rule set row present but not confirmed; the retry
  // completes the aggregate and confirms it.
  it('R16 a partial aggregate is never confirmed and completes on retry', async () => {
    const db = demoDb();
    const transport = transportTo(proxy.url);
    proxy.addFault({ method: 'POST', table: 'rule_suitability_ranges', action: { type: 'status', status: 503 } });
    const lease = acquire(db); // one worker; each cycle renews it
    await runSyncCycle({ db, transport, lease, clock: systemClock, random: () => 0, limit: 10 });
    const ruleSetId = idOf(db, 'SELECT id FROM rule_sets');
    expect(getEntry(db, 'rule_set', ruleSetId)).toMatchObject({ state: 'failed', lastError: 'outcome_unknown', cloudConfirmedAt: null });
    expect(await cloudCount('rule_sets')).toBe(1);
    expect(await cloudCount('rule_suitability_ranges')).toBe(0);
    await syncAll(db, transport, lease);
    expect(allSynced(db)).toBe(true);
    await expectCloudMatchesLocal(db);
  });

  // R14. Two real OS processes, real lease expiry (no injected clock). Process A (the CLI,
  // `--once`) is killed while its claims are `syncing` and right after the cloud committed its
  // robot insert. Process B is refused while A's lease is live, then, after real expiry, takes
  // over, recovers the claims and completes. Expect exactly-once cloud rows and confirmations
  // that are the cloud's own receipt times. Evidence comes from exit codes, CLI output and the
  // database (the `--once` CLI prints no takeover message; no production logging is added).
  it(
    'R14 a restart across two real processes recovers after real lease expiry, exactly once',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'robolime-r14-'));
      const dbPath = join(dir, 'r14.sqlite');
      const isolated = await proxyModule.startSyncProxy({ upstream: env().postgrest });
      const spawned: ChildProcess[] = [];
      try {
        const seeded = initDatabase(dbPath, 'demo');
        seedDemo(seeded);
        const expected = expectedCloudCounts(seeded);
        const total = count(seeded, 'sync_outbox');
        const localIds = seeded.prepare('SELECT entity_type, entity_id FROM sync_outbox ORDER BY id').all();
        seeded.close();

        // ---- Process A: hold its robot insert after the cloud committed it.
        let signalHeld: () => void = () => undefined;
        const held = new Promise<void>((r) => {
          signalHeld = r;
        });
        isolated.addFault({ method: 'POST', table: 'robots', action: { type: 'hold_after_commit', onHeld: () => signalHeld() } });
        const a = runCli(dbPath, isolated.url, spawned);
        const first = await Promise.race([held.then(() => 'held' as const), a.done.then(() => 'exited' as const)]);
        if (first === 'exited') throw new Error(`process A exited before the hold: ${JSON.stringify(await a.done)}`);

        const beforeKill = readLeaseState(dbPath);
        expect(beforeKill.lease, 'A holds the lease').not.toBeNull();
        const aOwner = beforeKill.lease?.owner ?? '';
        const aExpires = beforeKill.lease?.expiresAt ?? '';
        expect(Date.parse(aExpires)).toBeGreaterThan(Date.now());
        expect(beforeKill.syncing.length).toBeGreaterThanOrEqual(1);
        expect(beforeKill.syncing.every((s) => s.claimedBy === aOwner)).toBe(true);
        expect(beforeKill.syncing.some((s) => s.entityType === 'robot')).toBe(true);
        expect(await cloudCount('robots')).toBe(1); // A's insert committed before the kill

        // ---- Kill A for real and prove it is gone.
        killTree(a.child);
        const aExit = await withTimeout(a.done, 15_000, 'process A did not exit after the kill');
        observe('R14 process A exit', { code: aExit.code, signal: aExit.signal });
        expect(processExists(a.pid)).toBe(false);
        const afterKill = readLeaseState(dbPath);
        expect(afterKill.lease).toEqual({ owner: aOwner, expiresAt: aExpires }); // still held: nothing ran on exit
        expect(afterKill.syncing).toEqual(beforeKill.syncing);

        // ---- Process B before expiry: must be refused and change nothing.
        expect(Date.parse(aExpires) - Date.now(), 'enough time left for the early attempt').toBeGreaterThanOrEqual(60_000);
        const early = await withTimeout(runCli(dbPath, isolated.url, spawned).done, 60_000, 'early process B did not finish');
        observe('R14 early process B', { code: early.code, stderr: early.stderr.trim() });
        expect(early.code).toBe(1);
        expect(early.stderr).toContain(`Another sync worker holds the lease until ${aExpires}`);
        const afterEarly = readLeaseState(dbPath);
        expect(afterEarly.lease).toEqual({ owner: aOwner, expiresAt: aExpires });
        expect(afterEarly.syncing).toEqual(beforeKill.syncing);
        expect(await cloudCount('robots')).toBe(1);

        // ---- Wait for REAL expiry (bounded; computed from the stored expiry, no injected clock).
        const wait = Date.parse(aExpires) + 2_000 - Date.now();
        expect(wait).toBeLessThanOrEqual(125_000);
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));

        // ---- Process B after expiry: takes over, recovers A's claims, completes (repeated --once).
        const runs: CliResult[] = [];
        for (let i = 0; i < 10 && countSyncedInFile(dbPath) < total; i++) {
          const run = await withTimeout(runCli(dbPath, isolated.url, spawned).done, 60_000, `process B run ${i + 1} timed out`);
          runs.push(run);
          expect(run.code, `process B run ${i + 1}: ${run.stderr.trim()}`).toBe(0);
          if (i === 0) {
            const afterTakeover = readLeaseState(dbPath);
            // A's claims were recovered: none is still syncing under A, and the lease was released.
            expect(afterTakeover.syncing).toEqual([]);
            expect(afterTakeover.lease).toBeNull();
            const robot = readEntry(dbPath, 'robot');
            expect(robot).toMatchObject({ state: 'synced', attemptCount: 2 }); // A's attempt + B's
            const duplicates = [...run.stdout.matchAll(/\((\d+) already in the cloud\)/g)].reduce((n, m) => n + Number(m[1]), 0);
            expect(duplicates, 'A\'s committed robot confirmed as a duplicate').toBeGreaterThanOrEqual(1);
          }
        }
        observe('R14 process B runs', runs.map((r) => ({ code: r.code, stdout: r.stdout.trim() })));

        // ---- Final state: everything synced exactly once, with the cloud's own receipt times.
        const final = openDatabase(dbPath);
        try {
          expect(countByState(final)).toEqual({ pending: 0, syncing: 0, synced: total, failed: 0 });
          expect(count(final, 'sync_worker_lease')).toBe(0);
          const entries = final.prepare('SELECT entity_type, entity_id, cloud_confirmed_at FROM sync_outbox ORDER BY id').all();
          for (const entry of entries) {
            const type = String(entry.entity_type) as OutboxEntityType;
            const response = await direct(`${ROOT_TABLE[type]}?select=cloud_received_at&id=eq.${String(entry.entity_id)}`);
            const rows = (await response.json()) as { cloud_received_at?: unknown }[];
            expect(rows, `${type} ${String(entry.entity_id)}`).toHaveLength(1);
            expect(toCanonicalUtc(new Date(Date.parse(String(rows[0]?.cloud_received_at))))).toBe(entry.cloud_confirmed_at);
          }
        } finally {
          final.close();
        }
        for (const [table, n] of expected) expect(await cloudCount(table), table).toBe(n);
        expect(await cloudCount('robots')).toBe(1);
        const byType = new Map<OutboxEntityType, string[]>();
        for (const row of localIds) {
          const type = String(row.entity_type) as OutboxEntityType;
          byType.set(type, [...(byType.get(type) ?? []), String(row.entity_id).toLowerCase()]);
        }
        for (const [type, ids] of byType) {
          const response = await direct(`${ROOT_TABLE[type]}?select=id`);
          const cloudIds = ((await response.json()) as { id: string }[]).map((r) => r.id.toLowerCase());
          expect(cloudIds.sort(), `${ROOT_TABLE[type]} ids`).toEqual(ids.sort());
        }
      } finally {
        for (const child of spawned) killTree(child);
        await isolated.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      }
    },
    240_000,
  );
});

// ------------------------------------------------------------- R14 helpers

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runs the real sync CLI (`--once`) as a separate OS process against the given loopback target. */
function runCli(dbPath: string, url: string, spawned: ChildProcess[]): { child: ChildProcess; pid: number; done: Promise<CliResult> } {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase();
    if (value === undefined || lower.startsWith('robolime_sync_it') || lower.startsWith('supabase_') || lower === 'node_options') continue;
    childEnv[key] = value;
  }
  childEnv.SUPABASE_URL = url; // loopback proxy only (the demo database refuses anything else)
  childEnv.SUPABASE_SERVICE_ROLE_KEY = env().token; // per-run test token, never printed
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/sync.ts', '--db', dbPath, '--once'], {
    cwd: gatewayDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  spawned.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const done = new Promise<CliResult>((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveDone({ code, signal, stdout, stderr }));
  });
  if (child.pid === undefined) throw new Error('the sync CLI did not start');
  return { child, pid: child.pid, done };
}

/** Force-stops a test-spawned process and its own process tree only. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface LeaseState {
  lease: { owner: string; expiresAt: string } | null;
  syncing: { entityType: string; entityId: string; claimedBy: string | null }[];
}

/** Reads the shared database file through its own short-lived connection. */
function readLeaseState(dbPath: string): LeaseState {
  const db = openDatabase(dbPath);
  try {
    const lease = db.prepare('SELECT owner, expires_at FROM sync_worker_lease WHERE id = 1').get();
    const syncing = db
      .prepare(`SELECT entity_type, entity_id, claimed_by FROM sync_outbox WHERE state = 'syncing' ORDER BY id`)
      .all()
      .map((r) => ({ entityType: String(r.entity_type), entityId: String(r.entity_id), claimedBy: r.claimed_by === null ? null : String(r.claimed_by) }));
    return { lease: lease === undefined ? null : { owner: String(lease.owner), expiresAt: String(lease.expires_at) }, syncing };
  } finally {
    db.close();
  }
}

function readEntry(dbPath: string, type: OutboxEntityType): { state: string; attemptCount: number } | null {
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT state, attempt_count FROM sync_outbox WHERE entity_type = ? ORDER BY id LIMIT 1').get(type);
    return row === undefined ? null : { state: String(row.state), attemptCount: Number(row.attempt_count) };
  } finally {
    db.close();
  }
}

function countSyncedInFile(dbPath: string): number {
  const db = openDatabase(dbPath);
  try {
    return countByState(db).synced;
  } finally {
    db.close();
  }
}
