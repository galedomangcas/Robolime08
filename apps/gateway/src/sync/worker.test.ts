import { describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import { initDatabase } from '../db/init';
import type { Clock } from '../db/time';
import { seedDemo } from '../seed/demo';
import { countByState, getEntry } from '../store/outbox';
import { recordReading } from '../store/readings';
import {
  acquireLease,
  claimEligible,
  LeaseLostError,
  releaseLease,
  SYNC_LEASE_TTL_MS,
  syncDiagnostics,
  type WorkerLease,
} from '../store/syncLease';
import { FakePostgrest, TEST_ONLY_SERVICE_KEY, type Fault, type RecordedRequest } from '../test/fakePostgrest';
import { addTestRobot, count, memoryDb, T0, tempDir, testReading } from '../test/helpers';
import { allOutboxEntities, cloudRowsFor, type CloudTable } from './cloudRows';
import { CloudTargetError, createPostgrestTransport, parseCloudTarget, type CloudTransport } from './postgrest';
import { uploadEntity } from './uploadEntity';
import { runSyncCycle, SyncWorker, type CycleCounts, type SyncEvent } from './worker';

const LOCAL = 'http://127.0.0.1:54321';

function fakeClock(start = T0) {
  let t = start.getTime();
  const clock: Clock = () => new Date(t);
  return { clock, set: (d: Date) => void (t = d.getTime()), advance: (ms: number) => void (t += ms) };
}

function setup(purpose: 'field' | 'demo' = 'demo') {
  const fake = new FakePostgrest(TEST_ONLY_SERVICE_KEY);
  const target = parseCloudTarget({ url: LOCAL, serviceRoleKey: TEST_ONLY_SERVICE_KEY }, purpose);
  const transport = createPostgrestTransport(target, { fetch: fake.fetch });
  const c = fakeClock();
  return { fake, target, transport, c };
}

function acquire(db: Database, clock: Clock): WorkerLease {
  const r = acquireLease(db, clock);
  if (!r.acquired) throw new Error('expected the lease');
  return r.lease;
}

/** Every cloud row the local database should produce, per table. */
function expectedCloudCounts(db: Database): Map<CloudTable, number> {
  const counts = new Map<CloudTable, number>();
  for (const { entityType, entityId } of allOutboxEntities(db)) {
    for (const { table, rows } of cloudRowsFor(db, entityType, entityId)) counts.set(table, (counts.get(table) ?? 0) + rows.length);
  }
  return counts;
}

function expectCloudMatchesLocal(db: Database, fake: FakePostgrest): void {
  for (const [table, n] of expectedCloudCounts(db)) expect(fake.count(table), table).toBe(n);
}

/** Runs cycles until nothing is left to sync. Each cycle is a fresh worker that takes over after the TTL. */
async function syncUntilDone(db: Database, transport: CloudTransport, c: ReturnType<typeof fakeClock>, maxCycles = 50) {
  const all: CycleCounts[] = [];
  for (let i = 0; i < maxCycles && countByState(db).synced < count(db, 'sync_outbox'); i++) {
    c.advance(SYNC_LEASE_TTL_MS); // any earlier lease has expired and early retry times are due
    const lease = acquire(db, c.clock);
    all.push(await runSyncCycle({ db, transport, lease, clock: c.clock, random: () => 0.5, limit: 10 }));
  }
  return all;
}

describe('sync cycle against the fake endpoint', () => {
  it('syncs the whole demo dataset parents-first, exactly once, with verified confirmations', async () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { fake, transport, c } = setup();
    await syncUntilDone(db, transport, c);
    expect(countByState(db)).toMatchObject({ pending: 0, syncing: 0, failed: 0 });
    expectCloudMatchesLocal(db, fake);
    // Every synced entry carries the cloud's own receipt time, never a local time.
    const confirmed = db.prepare(`SELECT DISTINCT substr(cloud_confirmed_at, 1, 10) AS d FROM sync_outbox`).all();
    expect(confirmed).toEqual([{ d: '2026-03-02' }]);
    // The fake enforces foreign keys: no request ever hit a missing parent, so nothing was blocked.
    expect(syncDiagnostics(db, c.clock).blocked).toEqual([]);
  });

  it('replaying the same records twice creates no cloud duplicates', async () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { fake, transport, c } = setup();
    await syncUntilDone(db, transport, c);
    const snapshot = JSON.stringify([...fake.tables.entries()]);
    // Simulate a lost local confirmation (e.g. restored backup): every entry pending again.
    db.exec(`UPDATE sync_outbox SET state = 'pending', cloud_confirmed_at = NULL`);
    const cycles = await syncUntilDone(db, transport, c);
    expect(countByState(db).synced).toBe(count(db, 'sync_outbox'));
    expect(cycles.reduce((n, x) => n + x.duplicates, 0)).toBe(count(db, 'sync_outbox'));
    expect(JSON.stringify([...fake.tables.entries()])).toBe(snapshot);
  });

  it('internet loss mid-run: stops the cycle, keeps durable retry state, and finishes exactly once later', async () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { fake, transport, c } = setup();
    let requests = 0;
    fake.fault = () => (++requests > 7 ? 'refuse' : undefined);
    const lease = acquire(db, c.clock);
    const first = await runSyncCycle({ db, transport, lease, clock: c.clock, random: () => 0.5, limit: 10 });
    expect(first.stoppedBy).toBe('network_unavailable');
    expect(first.returned).toBeGreaterThan(0);
    expect(first.claimed).toBe(first.confirmed + first.retried + first.returned);
    expect(countByState(db).syncing).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE state = 'failed' AND last_error = 'network_unavailable'`).get()).toEqual({ n: 1 });

    fake.fault = () => undefined; // internet is back
    await syncUntilDone(db, transport, c);
    expect(countByState(db).synced).toBe(count(db, 'sync_outbox'));
    expectCloudMatchesLocal(db, fake);
  });

  it('a lost response (cloud committed) is retried and confirmed as a duplicate, never double-inserted', async () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    const { fake, transport, c } = setup('field');
    let dropped = false;
    fake.fault = (r: RecordedRequest): Fault | undefined => {
      if (r.method === 'POST' && r.table === 'robots' && !dropped) {
        dropped = true;
        return 'commit_then_timeout';
      }
      return undefined;
    };
    const lease = acquire(db, c.clock);
    const first = await runSyncCycle({ db, transport, lease, clock: c.clock, random: () => 0.5 });
    expect(first).toMatchObject({ ambiguous: 1, stoppedBy: 'outcome_unknown', confirmed: 0 });
    expect(fake.count('robots')).toBe(1);
    const robotEntry = db.prepare(`SELECT state, last_error, cloud_confirmed_at FROM sync_outbox WHERE entity_type = 'robot'`).get();
    expect(robotEntry).toEqual({ state: 'failed', last_error: 'outcome_unknown', cloud_confirmed_at: null });
    await syncUntilDone(db, transport, c);
    expect(countByState(db).synced).toBe(3);
    expect(fake.count('robots')).toBe(1);
    expect(fake.count('readings')).toBe(1);
  });

  it('gateway restart mid-run: an expired lease is taken over and the cloud gets every record exactly once', async () => {
    const tmp = tempDir();
    try {
      const path = tmp.path('field.sqlite');
      const { fake, transport, c } = setup('field');
      const db1 = initDatabase(path, 'field', T0);
      addTestRobot(db1);
      for (let i = 0; i < 5; i++) recordReading(db1, testReading({ cellIndex: i, seq: i }), T0);
      // Process 1 claims, uploads the robot to the cloud, then "crashes" before recording anything.
      const crashed = acquire(db1, c.clock);
      const [robotClaim] = claimEligible(db1, crashed, { limit: 10, clock: c.clock });
      if (!robotClaim) throw new Error('expected a claim');
      await uploadEntity(transport, 'robot', robotClaim.entityId, cloudRowsFor(db1, 'robot', robotClaim.entityId));
      db1.close();

      // Process 2 starts on the same file: it must wait for the old lease, then take over.
      const db2 = initDatabase(path, 'field', T0);
      expect(acquireLease(db2, c.clock).acquired).toBe(false);
      c.advance(120_000);
      const takeover = acquireLease(db2, c.clock);
      expect(takeover).toMatchObject({ acquired: true, tookOver: true, recovered: 1 });
      await syncUntilDone(db2, transport, c);
      expect(countByState(db2).synced).toBe(7); // robot + run + 5 readings
      expectCloudMatchesLocal(db2, fake);
      expect(fake.count('robots')).toBe(1);
      db2.close();
    } finally {
      tmp.cleanup();
    }
  });

  it('a worker that loses its lease during an upload records nothing; the new owner completes', async () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const { fake, transport, c } = setup('field');
    const stale = acquire(db, c.clock);
    let newOwner: WorkerLease | null = null;
    fake.fault = (r) => {
      if (r.method === 'GET' && newOwner === null) {
        c.advance(130_000); // the slow request outlives the lease…
        newOwner = acquire(db, c.clock); // …and another worker takes over
      }
      return undefined;
    };
    await expect(runSyncCycle({ db, transport, lease: stale, clock: c.clock, random: () => 0.5 })).rejects.toThrow(LeaseLostError);
    expect(countByState(db)).toMatchObject({ synced: 0, failed: 0, syncing: 0, pending: 2 }); // takeover returned them
    if (newOwner === null) throw new Error('expected a takeover');
    fake.fault = () => undefined;
    const done = await runSyncCycle({ db, transport, lease: newOwner, clock: c.clock, random: () => 0.5 });
    expect(done).toMatchObject({ confirmed: 2 });
    expect(fake.count('robots')).toBe(2);
  });

  it('renews the lease before requests on a slow cycle so it never silently expires', async () => {
    const db = memoryDb();
    for (const n of [1, 2, 3, 4, 5, 6]) addTestRobot(db, `TEST-ROBOT-${n}`);
    const { fake, transport, c } = setup('field');
    fake.fault = () => {
      c.advance(25_000); // every request takes 25 s
      return undefined;
    };
    const lease = acquire(db, c.clock);
    const counts = await runSyncCycle({ db, transport, lease, clock: c.clock, random: () => 0.5, limit: 6 });
    expect(counts.confirmed).toBe(3); // per-type cap: 3 of 6 robots
    // 6 requests × 25 s = 150 s > the 120 s TTL, yet the lease is still valid.
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: false });
  });

  it('a row-capped (206) read-back never marks the aggregate synced and does not stop the cycle', async () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { fake, transport, c } = setup();
    fake.maxRows = 1; // every multi-row read-back comes back 206 Partial Content
    const lease = acquire(db, c.clock);
    const counts = await runSyncCycle({ db, transport, lease, clock: c.clock, random: () => 0.5, limit: 10 });
    const ruleSet = String(db.prepare('SELECT id FROM rule_sets LIMIT 1').get()?.id);
    expect(getEntry(db, 'rule_set', ruleSet)).toMatchObject({
      state: 'failed',
      lastError: 'read_truncated',
      cloudConfirmedAt: null,
      blockedAt: null,
    });
    expect(counts.stoppedBy).toBeNull(); // row-specific: other entries in the batch still ran
    expect(counts.confirmed).toBeGreaterThan(0);
    expect(fake.count('rule_suitability_ranges')).toBeGreaterThan(1); // the rows are there; only the read was capped
    // Once the cap no longer truncates, the same entry confirms (as a duplicate).
    fake.maxRows = Number.POSITIVE_INFINITY;
    await syncUntilDone(db, transport, c);
    expect(getEntry(db, 'rule_set', ruleSet)?.state).toBe('synced');
    expectCloudMatchesLocal(db, fake);
  });

  it('keeps children waiting behind a blocked parent and reports it, without blocking them', async () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    recordReading(db, testReading(), T0);
    const { fake, transport, c } = setup('field');
    const [robotRows] = cloudRowsFor(db, 'robot', robot.id);
    fake.tables.set('robots', [{ ...robotRows?.rows[0], id: '00000000-0000-4000-8000-000000000000' }]); // natural-key clash
    await syncUntilDone(db, transport, c, 5);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ state: 'failed', blockReason: 'identity_conflict' });
    expect(countByState(db)).toMatchObject({ pending: 2, synced: 0 });
    const diagnostics = syncDiagnostics(db, c.clock);
    expect(diagnostics.waitingOnBlockedParent.map((x) => x.entityType)).toEqual(['run']);
    expect(fake.requests.filter((r) => r.table === 'runs' || r.table === 'readings')).toEqual([]);
  });

  it('honours durable retry times across a restart', async () => {
    const tmp = tempDir();
    const open: Database[] = [];
    try {
      const path = tmp.path('field.sqlite');
      const { fake, transport, c } = setup('field');
      const db1 = initDatabase(path, 'field', T0);
      open.push(db1);
      addTestRobot(db1);
      fake.fault = () => ({ status: 503 });
      const lease = acquire(db1, c.clock);
      await runSyncCycle({ db: db1, transport, lease, clock: c.clock, random: () => 0.9 });
      const retryAt = Date.parse(String(db1.prepare('SELECT next_attempt_at FROM sync_outbox').get()?.next_attempt_at));
      expect(retryAt).toBe(T0.getTime() + 4_500); // attempt 1: 0.9 x 5 s
      releaseLease(db1, lease, c.clock); // graceful shutdown
      db1.close();

      fake.fault = () => undefined;
      const db2 = initDatabase(path, 'field', T0);
      open.push(db2);
      c.set(new Date(retryAt - 1));
      const next = acquire(db2, c.clock);
      expect((await runSyncCycle({ db: db2, transport, lease: next, clock: c.clock, random: () => 0.5 })).claimed).toBe(0);
      c.set(new Date(retryAt));
      expect(await runSyncCycle({ db: db2, transport, lease: next, clock: c.clock, random: () => 0.5 })).toMatchObject({ confirmed: 1 });
    } finally {
      for (const db of open) if (db.isOpen) db.close();
      tmp.cleanup();
    }
  });
});

describe('SyncWorker', () => {
  it('runs until aborted, then releases its lease; events carry counts only', async () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { fake, target, c } = setup();
    const events: SyncEvent[] = [];
    const controller = new AbortController();
    const worker = new SyncWorker({
      db, target, fetch: fake.fetch, clock: c.clock, random: () => 0.5, limit: 10,
      sleep: async (ms) => {
        c.advance(ms);
        if (countByState(db).synced === count(db, 'sync_outbox')) controller.abort();
      },
      onEvent: (e) => events.push(e),
    });
    await worker.run(controller.signal);
    expect(countByState(db).synced).toBe(count(db, 'sync_outbox'));
    expectCloudMatchesLocal(db, fake);
    expect(count(db, 'sync_worker_lease')).toBe(0);
    expect(events[0]).toMatchObject({ event: 'lease_acquired' });
    expect(events.at(-1)).toEqual({ event: 'stopped', returnedClaims: 0 });
    const text = JSON.stringify(events);
    expect(text).not.toContain(TEST_ONLY_SERVICE_KEY);
    expect(text).not.toContain('127.0.0.1');
  });

  it('waits (does not spin) while another worker holds the lease', async () => {
    const db = memoryDb();
    addTestRobot(db);
    const { fake, target, c } = setup('field');
    acquire(db, c.clock); // another live worker
    const sleeps: number[] = [];
    const controller = new AbortController();
    const worker = new SyncWorker({
      db, target, fetch: fake.fetch, clock: c.clock, random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        c.advance(ms);
        if (fake.requests.length > 0 || sleeps.length >= 20) controller.abort();
      },
    });
    await worker.run(controller.signal);
    expect(sleeps[0]).toBeGreaterThanOrEqual(5_000);
    expect(fake.requests.length).toBeGreaterThan(0); // took over once the other lease expired
  });

  it('backs off after target-wide failures instead of hammering the endpoint', async () => {
    const db = memoryDb();
    addTestRobot(db);
    const { fake, target, c } = setup('field');
    fake.fault = () => 'refuse';
    const sleeps: number[] = [];
    const controller = new AbortController();
    const worker = new SyncWorker({
      db, target, fetch: fake.fetch, clock: c.clock, random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        c.advance(ms);
        if (sleeps.length >= 4) controller.abort();
      },
    });
    await worker.run(controller.signal);
    expect(sleeps.every((ms) => ms >= 5_000)).toBe(true);
    expect(getEntry(db, 'robot', String(db.prepare('SELECT id FROM robots').get()?.id))?.state).not.toBe('synced');
  });

  it('keeps its lease through long idle periods and backoff (renews while sleeping)', async () => {
    const db = memoryDb();
    addTestRobot(db);
    const { fake, target, c } = setup('field');
    const events: SyncEvent[] = [];
    const controller = new AbortController();
    let slept = 0;
    const worker = new SyncWorker({
      db, target, fetch: fake.fetch, clock: c.clock, random: () => 0.999,
      sleep: async (ms) => {
        c.advance(ms);
        slept += ms;
        if (slept > 30 * 60_000) controller.abort(); // 30 minutes of idle time and backoff
      },
      onEvent: (e) => events.push(e),
    });
    fake.fault = () => (slept < 10 * 60_000 ? 'refuse' : undefined); // offline for the first 10 minutes
    await worker.run(controller.signal);
    expect(events.filter((e) => e.event === 'lease_lost')).toEqual([]);
    expect(events.filter((e) => e.event === 'lease_acquired')).toHaveLength(1);
    expect(countByState(db).synced).toBe(1);
  });

  it('re-acquires after the lease really expires during a stall (e.g. the laptop slept)', async () => {
    const db = memoryDb();
    addTestRobot(db);
    const { fake, target, c } = setup('field');
    const events: SyncEvent[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    const worker = new SyncWorker({
      db, target, fetch: fake.fetch, clock: c.clock, random: () => 0.5,
      sleep: async (ms) => {
        sleeps += 1;
        c.advance(sleeps === 1 ? 10 * 60_000 : ms); // the first sleep overshoots by 10 minutes
        if (sleeps >= 6) controller.abort();
      },
      onEvent: (e) => events.push(e),
    });
    await worker.run(controller.signal);
    expect(events.map((e) => e.event)).toContain('lease_lost');
    expect(events.filter((e) => e.event === 'lease_acquired')).toHaveLength(2);
    expect(count(db, 'sync_worker_lease')).toBe(0); // released on stop
  });

  it('refuses to sync a demo database to a non-loopback target', () => {
    const db = memoryDb('demo');
    const fieldTarget = parseCloudTarget({ url: 'https://abc.supabase.co', serviceRoleKey: TEST_ONLY_SERVICE_KEY }, 'field');
    expect(() => new SyncWorker({ db, target: fieldTarget })).toThrow(CloudTargetError);
    expect(count(db, 'sync_worker_lease')).toBe(0);
  });
});
