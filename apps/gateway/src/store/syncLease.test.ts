import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../db/connection';
import { getDatabasePurpose, initDatabase } from '../db/init';
import { loadMigrations, migrate, MigrationError } from '../db/migrate';
import type { Clock } from '../db/time';
import { seedDemo } from '../seed/demo';
import { addTestRobot, count, memoryDb, minutesAfter, T0, tempDir, testReading } from '../test/helpers';
import { claimBatch, getEntry, markFailed, markSynced, OutboxStateError, recoverInterrupted, type OutboxEntityType } from './outbox';
import { recordReading } from './readings';
import { recordStatusReport } from './status';
import {
  acquireLease,
  claimEligible,
  LeaseLostError,
  markBlockedFenced,
  markFailedFenced,
  PARENT_LINKS,
  releaseLease,
  renewLease,
  requeueBlocked,
  SYNC_LEASE_TTL_MS,
  SYNC_STUCK_ATTEMPTS,
  SyncInputError,
  syncDiagnostics,
  type WorkerLease,
} from './syncLease';

const secondsAfter = (s: number, base: Date = T0) => new Date(base.getTime() + s * 1000);
const EXPIRED = secondsAfter(SYNC_LEASE_TTL_MS / 1000); // exactly at expiry: no longer valid
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fake clock that tests move explicitly; the API reads it inside each transaction. */
function fakeClock(start: Date = T0) {
  let t = start.getTime();
  const clock: Clock = () => new Date(t);
  return { clock, set: (d: Date) => void (t = d.getTime()) };
}

function acquire(db: Database, clock: Clock): WorkerLease {
  const result = acquireLease(db, clock);
  if (!result.acquired) throw new Error('expected to acquire the lease');
  return result.lease;
}

/** Keeps one worker's lease: renews it, or acquires a new one after it expired. */
function holder(db: Database, c: ReturnType<typeof fakeClock>) {
  let lease: WorkerLease | null = null;
  return (): WorkerLease => {
    if (lease) {
      try {
        renewLease(db, lease, c.clock);
        return lease;
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
      }
    }
    lease = acquire(db, c.clock);
    return lease;
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/**
 * Test stand-in for a verified cloud confirmation (M6b adds the real fenced
 * path). The 0002 trigger still enforces that only the current lease owner's
 * claims can become 'synced'.
 */
function confirm(db: Database, id: number): void {
  db.prepare(
    `UPDATE sync_outbox SET state = 'synced', claimed_by = NULL, cloud_confirmed_at = '2026-03-01T01:00:00.000Z' WHERE id = ?`,
  ).run(id);
}

function entryId(db: Database, type: OutboxEntityType, entityId: string): number {
  const entry = getEntry(db, type, entityId);
  if (!entry) throw new Error(`no outbox entry for ${type} ${entityId}`);
  return entry.id;
}

function idsOfType(db: Database, type: OutboxEntityType): string[] {
  return db.prepare('SELECT entity_id FROM sync_outbox WHERE entity_type = ? ORDER BY id').all(type).map((r) => String(r.entity_id));
}

/** Claims everything eligible and confirms it (helper for walking down the parent chain). */
function claimAndConfirmAll(db: Database, hold: () => WorkerLease, clock: Clock, limit = 100): OutboxEntityType[] {
  const claimed = claimEligible(db, hold(), { limit, clock });
  claimed.forEach((e) => confirm(db, e.id));
  return claimed.map((e) => e.entityType);
}

describe('migration 0002 on an existing 0001 database', () => {
  it('preserves every row and state, records checksums, and older builds refuse the result', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('v1.sqlite');
    const [m1, m2] = loadMigrations();
    if (!m1 || !m2) throw new Error('expected migrations 0001 and 0002');

    const v1 = openDatabase(path);
    expect(migrate(v1, [m1], T0).applied).toEqual([1]);
    v1.prepare(`INSERT INTO gateway_settings (key, value, updated_at) VALUES ('database_purpose', 'demo', ?)`).run(
      T0.toISOString(),
    );
    seedDemo(v1);
    // Representative outbox states under 0001 (plain SQL: the current helpers need 0002's columns).
    v1.exec(`UPDATE sync_outbox SET state = 'syncing', attempt_count = 1, last_attempt_at = '${T0.toISOString()}' WHERE id IN (1, 2, 3)`);
    v1.exec(`UPDATE sync_outbox SET state = 'synced', cloud_confirmed_at = '2026-03-01T00:05:00.000Z' WHERE id = 1`);
    v1.exec(`UPDATE sync_outbox SET state = 'failed', last_error = 'network unreachable', next_attempt_at = '${minutesAfter(5).toISOString()}' WHERE id = 2`);
    const before = v1.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    const readingsBefore = count(v1, 'readings');
    v1.close();

    const db = openDatabase(path);
    expect(migrate(db, undefined, T0).applied).toEqual([2]);
    const after = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    expect(after.map(({ blocked_at, block_reason, claimed_by, ...rest }) => {
      expect([blocked_at, block_reason, claimed_by]).toEqual([null, null, null]);
      return rest;
    })).toEqual(before);
    expect(new Set(after.map((r) => r.state))).toEqual(new Set(['synced', 'failed', 'syncing', 'pending']));
    expect(count(db, 'readings')).toBe(readingsBefore);
    expect(getDatabasePurpose(db)).toBe('demo');
    expect(db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, checksum: m1.checksum },
      { version: 2, checksum: m2.checksum },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    // A pre-0002 claim (no owner) is still recoverable by the legacy path.
    expect(recoverInterrupted(db)).toBe(1);
    db.close();

    const old = openDatabase(path);
    expect(() => migrate(old, [m1], T0)).toThrow(MigrationError);
    old.close();
  });

  it('enforces the new column and lease constraints', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const id = entryId(db, 'robot', robot.id);
    const ts = T0.toISOString();
    // Blocked only when failed, with a reason, no retry time, canonical time.
    expect(() => db.prepare(`UPDATE sync_outbox SET blocked_at = ?, block_reason = 'content_conflict' WHERE id = ?`).run(ts, id)).toThrow(/CHECK/);
    db.prepare(`UPDATE sync_outbox SET state = 'syncing' WHERE id = ?`).run(id);
    db.prepare(`UPDATE sync_outbox SET state = 'failed', last_error = 'x' WHERE id = ?`).run(id);
    expect(() => db.prepare(`UPDATE sync_outbox SET blocked_at = ? WHERE id = ?`).run(ts, id)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE sync_outbox SET blocked_at = '2026-03-01 00:00', block_reason = 'content_conflict' WHERE id = ?`).run(id)).toThrow(/CHECK/);
    for (const bad of ['Content_Conflict', 'reading ph=5.5', '', 'x'.repeat(65), '_lead']) {
      expect(() => db.prepare(`UPDATE sync_outbox SET blocked_at = ?, block_reason = ? WHERE id = ?`).run(ts, bad, id), bad).toThrow(/CHECK/);
    }
    db.prepare(`UPDATE sync_outbox SET next_attempt_at = ? WHERE id = ?`).run(ts, id);
    expect(() => db.prepare(`UPDATE sync_outbox SET blocked_at = ?, block_reason = 'content_conflict' WHERE id = ?`).run(ts, id)).toThrow(/CHECK/);
    // claimed_by only while syncing.
    expect(() => db.prepare(`UPDATE sync_outbox SET claimed_by = 'worker-a' WHERE id = ?`).run(id)).toThrow(/CHECK/);
    // Lease: single row, canonical times, expiry after renewal.
    expect(() => db.prepare(`INSERT INTO sync_worker_lease VALUES (2, 'w', ?, ?, ?)`).run(ts, ts, secondsAfter(1).toISOString())).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO sync_worker_lease VALUES (1, 'w', ?, ?, ?)`).run(ts, ts, ts)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO sync_worker_lease VALUES (1, '', ?, ?, ?)`).run(ts, ts, secondsAfter(1).toISOString())).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO sync_worker_lease VALUES (1, 'w', '2026-03-01', ?, ?)`).run(ts, secondsAfter(1).toISOString())).toThrow(/CHECK/);
  });
});

describe('worker lease and identity', () => {
  it('generates a fresh UUID owner per acquisition and allows only one live lease', () => {
    const db = memoryDb();
    const c = fakeClock();
    const first = acquireLease(db, c.clock);
    expect(first).toMatchObject({ acquired: true, expiresAt: secondsAfter(120).toISOString(), tookOver: false, recovered: 0 });
    if (!first.acquired) throw new Error('unreachable');
    expect(first.lease.owner).toMatch(UUID);
    // While it is live, nobody — including a "new process" — can acquire.
    c.set(secondsAfter(119));
    expect(acquireLease(db, c.clock)).toEqual({ acquired: false, heldUntil: secondsAfter(120).toISOString() });
    expect(renewLease(db, first.lease, c.clock)).toBe(secondsAfter(239).toISOString());
    c.set(secondsAfter(200));
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: false });
    expect(() => renewLease(db, { owner: 'forged' }, c.clock)).toThrow(LeaseLostError);
    // After expiry the next acquisition gets a different identity.
    c.set(secondsAfter(239));
    const second = acquire(db, c.clock);
    expect(second.owner).toMatch(UUID);
    expect(second.owner).not.toBe(first.lease.owner);
  });

  it('a restarted process cannot reuse the old identity; the old claims are recovered only by expiry takeover', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const oldProcess = acquire(db, c.clock);
    expect(claimEligible(db, oldProcess, { limit: 10, clock: c.clock })).toHaveLength(2);

    // "Restart": a new process starts while the old lease is live. It gets no lease and the claims stay owned.
    c.set(secondsAfter(30));
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: false });
    expect(db.prepare(`SELECT DISTINCT state, claimed_by FROM sync_outbox`).all()).toEqual([
      { state: 'syncing', claimed_by: oldProcess.owner },
    ]);

    // Once it expires, the new process takes over with a NEW identity and recovers the old claims atomically.
    c.set(EXPIRED);
    const takeover = acquireLease(db, c.clock);
    expect(takeover).toMatchObject({ acquired: true, tookOver: true, recovered: 2 });
    if (!takeover.acquired) throw new Error('unreachable');
    expect(takeover.lease.owner).not.toBe(oldProcess.owner);
    expect(count(db, `sync_outbox WHERE state = 'syncing'`)).toBe(0);

    // The new worker reclaims them under its own identity; the old handle can do nothing.
    const reclaimed = claimEligible(db, takeover.lease, { limit: 10, clock: c.clock });
    expect(reclaimed.every((e) => e.claimedBy === takeover.lease.owner)).toBe(true);
    const [first] = reclaimed;
    if (!first) throw new Error('expected a claim');
    const outboxBefore = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    const leaseBefore = db.prepare('SELECT * FROM sync_worker_lease').all();
    expect(() => claimEligible(db, oldProcess, { limit: 10, clock: c.clock })).toThrow(LeaseLostError);
    expect(() => renewLease(db, oldProcess, c.clock)).toThrow(LeaseLostError);
    expect(() => markFailedFenced(db, oldProcess, first.id, 'timeout', minutesAfter(5), c.clock)).toThrow(LeaseLostError);
    expect(() => markBlockedFenced(db, oldProcess, first.id, 'content_conflict', c.clock)).toThrow(LeaseLostError);
    expect(() => releaseLease(db, oldProcess, c.clock)).toThrow(LeaseLostError);
    // Neither the new owner's claims nor its lease changed, and the new owner can still act on them.
    expect(db.prepare('SELECT * FROM sync_outbox ORDER BY id').all()).toEqual(outboxBefore);
    expect(db.prepare('SELECT * FROM sync_worker_lease').all()).toEqual(leaseBefore);
    expect(getEntry(db, first.entityType, first.entityId)).toMatchObject({ state: 'syncing', claimedBy: takeover.lease.owner });
    markFailedFenced(db, takeover.lease, first.id, 'timeout', minutesAfter(5), c.clock);
    expect(releaseLease(db, takeover.lease, c.clock)).toBe(1);
  });

  it('recovers orphaned owned claims when acquiring an absent lease', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const lost = acquire(db, c.clock);
    claimEligible(db, lost, { limit: 10, clock: c.clock });
    db.exec('DELETE FROM sync_worker_lease'); // e.g. removed outside release()
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: true, tookOver: false, recovered: 2 });
    expect(db.prepare(`SELECT DISTINCT state, claimed_by FROM sync_outbox`).all()).toEqual([{ state: 'pending', claimed_by: null }]);
  });

  it('takes over an expired lease and recovers its claims in the same transaction, across connections', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('gw.sqlite');
    const c = fakeClock();
    const a = initDatabase(path, 'field', T0);
    addTestRobot(a);
    recordReading(a, testReading(), T0);
    const leaseA = acquire(a, c.clock);
    expect(claimEligible(a, leaseA, { limit: 10, clock: c.clock }).map((e) => e.entityType)).toEqual(['robot']);

    const b = initDatabase(path, 'field', T0);
    c.set(secondsAfter(119));
    expect(acquireLease(b, c.clock)).toMatchObject({ acquired: false });
    expect(b.prepare(`SELECT state, claimed_by FROM sync_outbox WHERE entity_type = 'robot'`).get()).toEqual({
      state: 'syncing',
      claimed_by: leaseA.owner,
    });
    // The legacy recovery path never touches owned claims.
    expect(recoverInterrupted(b)).toBe(0);
    c.set(EXPIRED);
    expect(acquireLease(b, c.clock)).toMatchObject({ acquired: true, expiresAt: secondsAfter(240).toISOString(), tookOver: true, recovered: 1 });
    expect(b.prepare(`SELECT state, claimed_by FROM sync_outbox WHERE entity_type = 'robot'`).get()).toEqual({
      state: 'pending',
      claimed_by: null,
    });
    a.close();
    b.close();
  });

  it('a takeover whose recovery fails leaves the old lease and claims unchanged (one transaction)', () => {
    const db = memoryDb();
    addTestRobot(db);
    const c = fakeClock();
    const leaseA = acquire(db, c.clock);
    claimEligible(db, leaseA, { limit: 10, clock: c.clock });
    db.exec(`CREATE TEMP TRIGGER fail_recovery BEFORE UPDATE OF state ON sync_outbox WHEN NEW.state = 'pending'
             BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`);
    c.set(EXPIRED);
    expect(() => acquireLease(db, c.clock)).toThrow(/injected recovery failure/);
    expect(db.prepare('SELECT owner FROM sync_worker_lease').get()).toEqual({ owner: leaseA.owner });
    expect(db.prepare(`SELECT state, claimed_by FROM sync_outbox`).get()).toEqual({ state: 'syncing', claimed_by: leaseA.owner });
  });

  it('a worker resuming after losing its lease cannot claim or change any outbox state', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    const c = fakeClock();
    const leaseA = acquire(db, c.clock);
    const [robotClaim] = claimEligible(db, leaseA, { limit: 10, clock: c.clock });
    if (!robotClaim) throw new Error('expected a claim');

    // Expired but not yet taken over: A is fenced by expiry.
    c.set(EXPIRED);
    expect(() => claimEligible(db, leaseA, { limit: 10, clock: c.clock })).toThrow(LeaseLostError);
    expect(() => markFailedFenced(db, leaseA, robotClaim.id, 'timeout', minutesAfter(5), c.clock)).toThrow(LeaseLostError);
    expect(() => markBlockedFenced(db, leaseA, robotClaim.id, 'content_conflict', c.clock)).toThrow(LeaseLostError);
    expect(() => renewLease(db, leaseA, c.clock)).toThrow(LeaseLostError);
    expect(() => releaseLease(db, leaseA, c.clock)).toThrow(LeaseLostError);

    // Taken over: A is fenced by owner too.
    acquire(db, c.clock);
    const snapshot = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    expect(() => claimEligible(db, leaseA, { limit: 10, clock: c.clock })).toThrow(LeaseLostError);
    expect(() => markFailedFenced(db, leaseA, robotClaim.id, 'timeout', minutesAfter(5), c.clock)).toThrow(LeaseLostError);
    expect(db.prepare('SELECT * FROM sync_outbox ORDER BY id').all()).toEqual(snapshot);
  });

  it('release returns only the owner’s claims and frees the lease', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const leaseA = acquire(db, c.clock);
    expect(claimEligible(db, leaseA, { limit: 10, clock: c.clock })).toHaveLength(2);
    c.set(secondsAfter(10));
    expect(releaseLease(db, leaseA, c.clock)).toBe(2);
    expect(count(db, `sync_outbox WHERE state = 'syncing'`)).toBe(0);
    expect(count(db, 'sync_worker_lease')).toBe(0);
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: true, tookOver: false, recovered: 0 });
  });
});

describe('clock read inside each fenced transaction', () => {
  it('reads the injected clock only inside a transaction, for every lease operation', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const reads: boolean[] = [];
    const spy: Clock = () => {
      reads.push(db.isTransaction);
      return T0;
    };
    const lease = acquire(db, spy);
    renewLease(db, lease, spy);
    const claims = claimEligible(db, lease, { limit: 10, clock: spy });
    const [first, second] = claims;
    if (!first || !second) throw new Error('expected two claims');
    markFailedFenced(db, lease, first.id, 'timeout', minutesAfter(1), spy);
    markBlockedFenced(db, lease, second.id, 'content_conflict', spy);
    requeueBlocked(db, second.entityType, second.entityId, spy);
    releaseLease(db, lease, spy);
    // acquire, renew, claim, fail, block, requeue, release: one read each, all inside a transaction.
    expect(reads).toEqual([true, true, true, true, true, true, true]);
  });

  it('a lease that expires between the start of an operation and its validation authorises nothing', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const [first, second] = claimEligible(db, lease, { limit: 10, clock: c.clock });
    if (!first || !second) throw new Error('expected two claims');
    const snapshot = () => db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    const before = snapshot();
    // The worker decided to act while the lease was valid (s=119, renewed to expire at s=239), then awaited
    // past expiry. The API takes no caller time; only the clock read inside the transaction (s=239) counts.
    c.set(secondsAfter(119));
    expect(renewLease(db, lease, c.clock)).toBe(secondsAfter(239).toISOString());
    const decidedAt = c.clock();
    const leaseBefore = db.prepare('SELECT * FROM sync_worker_lease').all();
    const operations: (() => unknown)[] = [
      () => claimEligible(db, lease, { limit: 10, clock: c.clock }),
      () => renewLease(db, lease, c.clock),
      () => markFailedFenced(db, lease, first.id, 'timeout', minutesAfter(5), c.clock),
      () => markBlockedFenced(db, lease, second.id, 'content_conflict', c.clock),
      () => releaseLease(db, lease, c.clock),
    ];
    c.set(secondsAfter(239)); // exactly the renewed expiry
    expect(decidedAt.getTime()).toBeLessThan(c.clock().getTime());
    for (const run of operations) expect(run).toThrow(LeaseLostError);
    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT * FROM sync_worker_lease').all()).toEqual(leaseBefore);
  });
});

describe('ownership trigger', () => {
  it('rejects raw ownership reassignment or removal while an entry stays syncing', () => {
    const db = memoryDb();
    addTestRobot(db);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const [owned] = claimEligible(db, lease, { limit: 1, clock: c.clock });
    if (!owned) throw new Error('expected a claim');
    expect(() => db.prepare(`UPDATE sync_outbox SET claimed_by = 'intruder' WHERE id = ?`).run(owned.id)).toThrow(/not owned/);
    expect(() => db.prepare(`UPDATE sync_outbox SET claimed_by = NULL WHERE id = ?`).run(owned.id)).toThrow(/not owned/);
    // An unowned legacy claim cannot be given an owner without a transition either.
    const [legacy] = claimBatch(db, 1, T0);
    if (!legacy) throw new Error('expected a legacy claim');
    expect(() => db.prepare(`UPDATE sync_outbox SET claimed_by = ? WHERE id = ?`).run(lease.owner, legacy.id)).toThrow(/not owned/);
    // Rewriting the lease owner does not let an old claim complete or be re-owned.
    db.prepare(`UPDATE sync_worker_lease SET owner = 'someone-else'`).run();
    expect(() => confirm(db, owned.id)).toThrow(/not owned/);
    expect(() =>
      db.prepare(`UPDATE sync_outbox SET state = 'failed', claimed_by = NULL, last_error = 'x' WHERE id = ?`).run(owned.id),
    ).toThrow(/not owned/);
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'pending', claimed_by = NULL WHERE id = ?`).run(owned.id)).not.toThrow();
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'syncing', claimed_by = ? WHERE id = ?`).run(lease.owner, owned.id)).toThrow(/not owned/);
  });

  it('still allows every legitimate lifecycle transition', () => {
    const db = memoryDb();
    for (const n of [1, 2, 3, 4]) addTestRobot(db, `TEST-ROBOT-${n}`);
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const claims = claimEligible(db, lease, { limit: 4, clock: c.clock }); // claim (cap 2)
    expect(claims).toHaveLength(2);
    const [a, b] = claims;
    if (!a || !b) throw new Error('expected claims');
    confirm(db, a.id); // completion by the current owner
    markBlockedFenced(db, lease, b.id, 'row_rejected', c.clock); // block
    requeueBlocked(db, b.entityType, b.entityId, c.clock); // operator requeue
    const [c3, c4] = claimEligible(db, lease, { limit: 4, clock: c.clock });
    if (!c3 || !c4) throw new Error('expected claims');
    markFailedFenced(db, lease, c3.id, 'timeout', minutesAfter(1), c.clock); // failure
    expect(releaseLease(db, lease, c.clock)).toBe(1); // release returns c4
    const next = acquire(db, c.clock);
    claimEligible(db, next, { limit: 4, clock: c.clock });
    c.set(secondsAfter(500));
    expect(acquireLease(db, c.clock)).toMatchObject({ acquired: true, tookOver: true }); // takeover recovery
  });

  it('legacy helpers refuse owned claims', () => {
    const db = memoryDb();
    addTestRobot(db);
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const [claim] = claimEligible(db, lease, { limit: 1, clock: c.clock });
    if (!claim) throw new Error('expected a claim');
    expect(() => markSynced(db, claim.id, { cloudReceivedAt: T0.toISOString() })).toThrow(OutboxStateError);
    expect(() => markFailed(db, claim.id, 'x', minutesAfter(1))).toThrow(OutboxStateError);
    expect(recoverInterrupted(db)).toBe(0);
  });
});

describe('blocking and requeue', () => {
  function blockedRobot() {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const other = addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const hold = holder(db, c);
    const claims = claimEligible(db, hold(), { limit: 10, clock: c.clock });
    const claim = claims.find((x) => x.entityId === robot.id);
    const otherClaim = claims.find((x) => x.entityId === other.id);
    if (!claim || !otherClaim) throw new Error('expected claims');
    c.set(secondsAfter(5));
    markBlockedFenced(db, hold(), claim.id, 'content_conflict', c.clock);
    markFailedFenced(db, hold(), otherClaim.id, 'timeout', secondsAfter(5), c.clock);
    return { db, robot, other, id: claim.id, c, hold };
  }

  it('a blocked row stays failed with safe fields and is never claimed, without aborting other claims', () => {
    const { db, robot, other, id, c, hold } = blockedRobot();
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({
      state: 'failed',
      blockedAt: secondsAfter(5).toISOString(),
      blockReason: 'content_conflict',
      lastError: 'content_conflict',
      nextAttemptAt: null,
      claimedBy: null,
    });
    c.set(minutesAfter(30));
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock }).map((e) => e.entityId)).toEqual([other.id]);
    expect(claimBatch(db, 10, minutesAfter(60))).toEqual([]);
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'syncing' WHERE id = ?`).run(id)).toThrow(/CHECK/);
  });

  it('requeue clears both block fields and makes the entry due at the injected time', () => {
    const { db, robot, c, hold } = blockedRobot();
    c.set(minutesAfter(10));
    requeueBlocked(db, 'robot', robot.id, c.clock);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({
      state: 'failed',
      blockedAt: null,
      blockReason: null,
      nextAttemptAt: minutesAfter(10).toISOString(),
    });
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock }).map((e) => e.entityId)).toContain(robot.id);
    expect(() => requeueBlocked(db, 'robot', robot.id, c.clock)).toThrow(OutboxStateError);
    expect(() => requeueBlocked(db, 'robot', 'missing', c.clock)).toThrow(OutboxStateError);
  });

  it('rejects invalid blocking and failure transitions', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const id = entryId(db, 'robot', robot.id);
    expect(() => markBlockedFenced(db, lease, id, 'content_conflict', c.clock)).toThrow(OutboxStateError);
    expect(() => markFailedFenced(db, lease, id, 'timeout', minutesAfter(1), c.clock)).toThrow(OutboxStateError);
    claimEligible(db, lease, { limit: 1, clock: c.clock });
    expect(() => markBlockedFenced(db, lease, id, 'not_a_reason' as 'content_conflict', c.clock)).toThrow(SyncInputError);
    expect(() => markFailedFenced(db, lease, id, 'Network unreachable at 10.0.0.1', minutesAfter(1), c.clock)).toThrow(SyncInputError);
    expect(() => markBlockedFenced(db, lease, 999, 'content_conflict', c.clock)).toThrow(OutboxStateError);
    markFailedFenced(db, lease, id, 'timeout', minutesAfter(1), c.clock);
    expect(() => markBlockedFenced(db, lease, id, 'content_conflict', c.clock)).toThrow(OutboxStateError);
  });
});

describe('parent eligibility', () => {
  it('covers every parent relationship of the M6 design', () => {
    const links = Object.fromEntries(
      Object.entries(PARENT_LINKS).map(([type, list]) => [type, list.map((l) => l.parentType)]),
    );
    expect(links).toEqual({
      robot: [],
      rule_set: [],
      field: ['robot'],
      run: ['robot', 'field'],
      reading: ['run'],
      status_report: ['robot'],
      recommendation: ['run', 'rule_set'],
    });
  });

  it('walks the demo data parents-first across successive batches until everything is synced', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const c = fakeClock();
    const hold = holder(db, c);
    const order: OutboxEntityType[][] = [];
    for (let batch = 0; batch < 10 && count(db, `sync_outbox WHERE state <> 'synced'`) > 0; batch++) {
      c.set(secondsAfter(batch));
      const claimed = claimEligible(db, hold(), { limit: 100, clock: c.clock });
      for (const entry of claimed) {
        for (const link of PARENT_LINKS[entry.entityType]) {
          const parentId = db.prepare(link.parentIdSql.replace('o.entity_id', '?')).get(entry.entityId);
          const pid = parentId === undefined ? null : Object.values(parentId)[0];
          if (pid === null && link.nullable) continue;
          expect(getEntry(db, link.parentType, String(pid))?.state, `${entry.entityType} → ${link.parentType}`).toBe('synced');
        }
      }
      claimed.forEach((e) => confirm(db, e.id));
      order.push([...new Set(claimed.map((e) => e.entityType))].sort());
    }
    expect(count(db, `sync_outbox WHERE state <> 'synced'`)).toBe(0);
    expect(order.slice(0, 4)).toEqual([
      ['robot', 'rule_set'],
      ['field', 'status_report'],
      ['run'],
      ['reading', 'recommendation'],
    ]);
  });

  it('keeps a child ineligible while its parent is failed with a future retry, syncing, outside the batch, or blocked', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const { runId } = recordReading(db, testReading(), T0);
    const c = fakeClock();
    const hold = holder(db, c);
    const runEntry = () => entryId(db, 'run', runId);

    expect(claimEligible(db, hold(), { limit: 1, clock: c.clock }).map((e) => e.entityType)).toEqual(['robot']);
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock })).toEqual([]);
    confirm(db, entryId(db, 'robot', robot.id));
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock }).map((e) => e.entityType)).toEqual(['run']);
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock })).toEqual([]);
    markFailedFenced(db, hold(), runEntry(), 'timeout', minutesAfter(5), c.clock);
    c.set(minutesAfter(1));
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock })).toEqual([]);
    c.set(minutesAfter(5));
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock }).map((e) => e.entityType)).toEqual(['run']);
    markBlockedFenced(db, hold(), runEntry(), 'identity_conflict', c.clock);
    c.set(minutesAfter(100));
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock })).toEqual([]);
    expect(syncDiagnostics(db, c.clock).waitingOnBlockedParent).toEqual([
      { entityType: 'reading', entityId: idsOfType(db, 'reading')[0], parent: { entityType: 'run', entityId: runId } },
    ]);
    requeueBlocked(db, 'run', runId, c.clock);
    claimAndConfirmAll(db, hold, c.clock);
    expect(claimEligible(db, hold(), { limit: 10, clock: c.clock }).map((e) => e.entityType)).toEqual(['reading']);
  });

  it('allows a run without a field once its robot is synced (field is the only optional parent)', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    expect(db.prepare('SELECT field_id FROM runs').get()).toEqual({ field_id: null });
    const c = fakeClock();
    const hold = holder(db, c);
    expect(claimAndConfirmAll(db, hold, c.clock)).toEqual(['robot']);
    expect(claimAndConfirmAll(db, hold, c.clock)).toEqual(['run']);
  });
});

describe('fairness', () => {
  const status = (robotSourceId: string, i: number, at: Date) => ({
    sourceRobotId: robotSourceId, state: 'WORKING' as const, errorFlags: 0, componentFlags: null, batteryVoltage: 12.3,
    totalLimeCommandedMl: 0, cellsCompleted: i, totalCells: 9999, robotReportedAt: secondsAfter(5000 + i, at).toISOString(),
  });

  it('caps each type at half a batch, so a steady stream of readings cannot crowd out a status report', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    for (let i = 0; i < 40; i++) recordReading(db, testReading({ cellIndex: i, seq: i }), secondsAfter(i));
    const c = fakeClock(minutesAfter(20));
    const hold = holder(db, c);
    expect(claimAndConfirmAll(db, hold, c.clock)).toEqual(['robot']);
    expect(claimAndConfirmAll(db, hold, c.clock, 1)).toEqual(['run']);
    recordStatusReport(db, status(robot.sourceRobotId, 0, T0), minutesAfter(30));
    c.set(minutesAfter(31));
    const batch = claimEligible(db, hold(), { limit: 10, clock: c.clock });
    expect(batch.filter((e) => e.entityType === 'reading')).toHaveLength(5);
    expect(batch.map((e) => e.entityType)).toContain('status_report');
    expect(() => claimEligible(db, hold(), { limit: 0, clock: c.clock })).toThrow(SyncInputError);
  });

  /**
   * Three eligible types. Guarantee tested: per batch, no type exceeds the cap;
   * across batches, an entry waits only for the OLDER backlog (oldest first),
   * so it is claimed after a bounded, deterministic number of batches even
   * while newer work keeps arriving. Not guaranteed (and asserted as such):
   * a slot for every type in every batch.
   */
  it('with three busy types, a newer type waits only for the older backlog, then progresses', () => {
    for (const continuous of [false, true]) {
      const db = memoryDb();
      const robot = addTestRobot(db);
      const reading = (run: string, i: number, at: Date) =>
        recordReading(db, testReading({ sourceRunId: run, cellIndex: i, seq: i }), at);
      for (let i = 0; i < 30; i++) reading('RUN-1', i, secondsAfter(i)); // oldest: 30 readings (+ RUN-1)
      for (let i = 0; i < 30; i++) recordStatusReport(db, status(robot.sourceRobotId, i, T0), secondsAfter(40 + i)); // next: 30 status
      reading('RUN-2', 0, secondsAfter(200)); // newest: a second run (third type)
      const c = fakeClock(secondsAfter(300));
      const hold = holder(db, c);
      expect(claimAndConfirmAll(db, hold, c.clock, 1)).toEqual(['robot']);
      expect(claimAndConfirmAll(db, hold, c.clock, 1)).toEqual(['run']); // RUN-1 (oldest run)

      let firstRunBatch = 0;
      for (let b = 1; b <= 40 && firstRunBatch === 0; b++) {
        c.set(secondsAfter(300 + b * 10));
        if (continuous) {
          // Newer readings and status reports keep arriving faster than they drain.
          reading('RUN-1', 1000 + b, c.clock());
          recordStatusReport(db, status(robot.sourceRobotId, 1000 + b, T0), c.clock());
        }
        const batch = claimEligible(db, hold(), { limit: 4, clock: c.clock });
        const perType = new Map<string, number>();
        for (const e of batch) perType.set(e.entityType, (perType.get(e.entityType) ?? 0) + 1);
        expect(Math.max(...perType.values())).toBeLessThanOrEqual(2); // cap = 50% of 4
        if (batch.some((e) => e.entityType === 'run')) firstRunBatch = b;
        batch.forEach((e) => confirm(db, e.id));
      }
      // 60 older entries at 4 per batch: the newer run is claimed in batch 16, not before
      // (no per-batch slot for every type), and never later, even under continuous load.
      expect(firstRunBatch, continuous ? 'continuous arrivals' : 'fixed backlog').toBe(16);
    }
  });
});

describe('diagnostics', () => {
  it('reports blocked, stuck and blocked-parent-dependent entries without row content or error text', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { runId } = recordReading(db, testReading({ ph: 5.4321 }), T0);
    addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const hold = holder(db, c);
    claimAndConfirmAll(db, hold, c.clock); // both robots
    const [run] = claimEligible(db, hold(), { limit: 10, clock: c.clock });
    if (!run) throw new Error('expected the run claim');
    markBlockedFenced(db, hold(), run.id, 'identity_conflict', c.clock);
    db.prepare(`UPDATE sync_outbox SET attempt_count = ? WHERE entity_type = 'reading'`).run(SYNC_STUCK_ATTEMPTS);

    c.set(new Date(T0.getTime() + 25 * 60 * 60 * 1000));
    const diagnostics = syncDiagnostics(db, c.clock);
    expect(diagnostics.blocked).toEqual([
      { entityType: 'run', entityId: runId, blockReason: 'identity_conflict', blockedAt: T0.toISOString() },
    ]);
    expect(diagnostics.waitingOnBlockedParent).toHaveLength(1);
    expect(diagnostics.stuck).toEqual([
      { entityType: 'reading', entityId: idsOfType(db, 'reading')[0], state: 'pending', attemptCount: SYNC_STUCK_ATTEMPTS, enqueuedAt: T0.toISOString() },
    ]);
    const text = JSON.stringify(diagnostics);
    expect(text).not.toContain('5.4321');
    expect(text).not.toMatch(/last_?error/i);
    const before = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    syncDiagnostics(db, c.clock);
    expect(db.prepare('SELECT * FROM sync_outbox ORDER BY id').all()).toEqual(before);
  });
});
