import { describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import type { Clock } from '../db/time';
import { seedDemo } from '../seed/demo';
import { getEntry } from '../store/outbox';
import { recordReading } from '../store/readings';
import {
  acquireLease,
  claimEligible,
  LeaseLostError,
  markSyncedFenced,
  returnClaimsFenced,
  SyncInputError,
  type WorkerLease,
} from '../store/syncLease';
import { addTestRobot, memoryDb, T0, testReading } from '../test/helpers';
import { applyOutcome } from './applyOutcome';
import { cloudRowsFor, type CloudTable, type CloudTableRows } from './cloudRows';
import {
  classifyFailure,
  isVerifiedConfirmation,
  retryDelayMs,
  SYNC_RETRY_CAP_MS,
  verifyReadBack,
  type ReadBack,
  type SyncOutcome,
  type VerifiedConfirmation,
} from './confirmation';

const at = (s: number) => new Date(T0.getTime() + s * 1000);
const CLOUD_TIME = '2026-03-01T00:00:07.123456+00:00';

function fakeClock(start = T0) {
  let t = start.getTime();
  const clock: Clock = () => new Date(t);
  return { clock, set: (d: Date) => void (t = d.getTime()) };
}

function acquire(db: Database, clock: Clock): WorkerLease {
  const result = acquireLease(db, clock);
  if (!result.acquired) throw new Error('expected the lease');
  return result.lease;
}

/** What PostgREST returns for rows the gateway sent: +00:00 timestamps, upper-case-insensitive uuids, reordered jsonb. */
function asCloud(local: readonly CloudTableRows[]): Map<CloudTable, Record<string, unknown>[]> {
  const reorder = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(reorder)
      : typeof v === 'object' && v !== null
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)]))
        : v;
  return new Map(
    local.map(({ table, rows }) => [
      table,
      rows.map((row) => {
        const out: Record<string, unknown> = { cloud_received_at: CLOUD_TIME };
        for (const [column, value] of Object.entries(row)) {
          if (value !== null && typeof value === 'object') out[column] = reorder(JSON.parse(value.jsonb));
          else if (typeof value === 'string' && /Z$/.test(value) && !Number.isNaN(Date.parse(value))) {
            out[column] = value.replace('Z', '+00:00');
          } else out[column] = value;
        }
        return out;
      }),
    ]),
  );
}

function demoRecommendation(db: Database) {
  const row = db.prepare('SELECT id FROM recommendations LIMIT 1').get();
  if (!row) throw new Error('demo has a recommendation');
  const id = String(row.id);
  return { id, local: cloudRowsFor(db, 'recommendation', id) };
}

const readBack = (rows: Map<CloudTable, readonly unknown[]>, insertedRows = 1): ReadBack => ({ rows, insertedRows });

describe('failure classification', () => {
  const cases: [string, Parameters<typeof classifyFailure>, Partial<SyncOutcome>][] = [
    ['connection never made', ['write', { kind: 'not_sent' }], { kind: 'retryable', code: 'network_unavailable' }],
    ['write timeout', ['write', { kind: 'no_response' }], { kind: 'ambiguous', code: 'outcome_unknown' }],
    ['read timeout', ['read', { kind: 'no_response' }], { kind: 'retryable', code: 'verification_unavailable' }],
    ['2xx write with a bad body', ['write', { kind: 'invalid_response', status: 201 }], { kind: 'ambiguous' }],
    ['bad read body', ['read', { kind: 'invalid_response', status: 200 }], { kind: 'retryable', code: 'invalid_response' }],
    ['other natural key taken', ['write', { kind: 'http', status: 409, pgCode: '23505' }], { kind: 'permanent', reason: 'identity_conflict' }],
    ['parent missing in cloud', ['write', { kind: 'http', status: 409, pgCode: '23503' }], { kind: 'permanent', reason: 'constraint_conflict' }],
    ['check / trigger', ['write', { kind: 'http', status: 400, pgCode: '23514' }], { kind: 'permanent', reason: 'row_rejected' }],
    ['bad data', ['write', { kind: 'http', status: 400, pgCode: '22P02' }], { kind: 'permanent', reason: 'row_rejected' }],
    ['permission', ['write', { kind: 'http', status: 403, pgCode: '42501' }], { kind: 'retryable', code: 'auth_rejected' }],
    ['bad key', ['read', { kind: 'http', status: 401, pgCode: null }], { kind: 'retryable', code: 'auth_rejected' }],
    ['JWT error', ['write', { kind: 'http', status: 401, pgCode: 'PGRST301' }], { kind: 'retryable', code: 'auth_rejected' }],
    ['unknown table', ['write', { kind: 'http', status: 404, pgCode: 'PGRST205' }], { kind: 'retryable', code: 'schema_mismatch' }],
    ['rate limited', ['write', { kind: 'http', status: 429, pgCode: null }], { kind: 'retryable', code: 'rate_limited' }],
    ['request timeout status', ['write', { kind: 'http', status: 408, pgCode: null }], { kind: 'ambiguous' }],
    ['db error, rolled back', ['write', { kind: 'http', status: 500, pgCode: 'XX000' }], { kind: 'retryable', code: 'server_error' }],
    ['proxy error on write', ['write', { kind: 'http', status: 502, pgCode: null }], { kind: 'ambiguous' }],
    ['proxy error on read', ['read', { kind: 'http', status: 503, pgCode: null }], { kind: 'retryable', code: 'server_unavailable' }],
    ['malformed request', ['write', { kind: 'http', status: 400, pgCode: 'PGRST102' }], { kind: 'retryable', code: 'request_rejected' }],
    ['redirect (not followed)', ['write', { kind: 'http', status: 307, pgCode: null }], { kind: 'retryable', code: 'request_rejected' }],
    ['row-capped read', ['read', { kind: 'truncated' }], { kind: 'retryable', code: 'read_truncated', stopCycle: false }],
  ];
  it.each(cases)('%s', (_name, args, expected) => {
    expect(classifyFailure(...args)).toMatchObject(expected);
  });

  it('never classifies a timeout or lost response as success or as a permanent failure', () => {
    for (const phase of ['write', 'read'] as const) {
      for (const outcome of [
        classifyFailure(phase, { kind: 'no_response' }),
        classifyFailure(phase, { kind: 'http', status: 504, pgCode: null }),
      ]) {
        expect(['ambiguous', 'retryable']).toContain(outcome.kind);
      }
    }
  });
});

describe('read-back verification', () => {
  it('confirms an aggregate whose cloud copy matches exactly, despite cloud formatting', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { id, local } = demoRecommendation(db);
    const cloud = asCloud(local);
    // UUIDs may come back in another case; jsonb keys come back reordered (asCloud).
    const rec = cloud.get('recommendations')?.[0];
    if (!rec) throw new Error('missing');
    rec.id = String(rec.id).toUpperCase();
    const outcome = verifyReadBack('recommendation', id, local, readBack(cloud, 3));
    expect(outcome).toMatchObject({ kind: 'confirmed', duplicate: false });
    if (outcome.kind !== 'confirmed') throw new Error('unreachable');
    expect(outcome.confirmation).toMatchObject({
      entityType: 'recommendation',
      entityId: id,
      cloudReceivedAt: '2026-03-01T00:00:07.123Z',
    });
    expect(isVerifiedConfirmation(outcome.confirmation)).toBe(true);
    expect(Object.isFrozen(outcome.confirmation)).toBe(true);
  });

  it('reports a confirmed duplicate when nothing new was inserted', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    expect(verifyReadBack('robot', robot.id, local, readBack(asCloud(local), 0))).toMatchObject({
      kind: 'confirmed',
      duplicate: true,
    });
  });

  it('blocks on differing content, an extra cloud row, or duplicate cloud keys', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { id, local } = demoRecommendation(db);

    const changed = asCloud(local);
    const score = changed.get('recommendation_scores')?.[0];
    if (!score) throw new Error('missing');
    score.score = Number(score.score) + 0.0001;
    expect(verifyReadBack('recommendation', id, local, readBack(changed))).toEqual({ kind: 'permanent', reason: 'content_conflict' });

    const typed = asCloud(local);
    const rec = typed.get('recommendations')?.[0];
    if (!rec) throw new Error('missing');
    rec.weather_source = 42; // same text as a different JSON type
    expect(verifyReadBack('recommendation', id, local, readBack(typed))).toMatchObject({ reason: 'content_conflict' });

    const extra = asCloud(local);
    extra.get('recommendation_scores')?.push({ ...extra.get('recommendation_scores')?.[0], crop_key: 'not-sent-by-gateway' });
    expect(verifyReadBack('recommendation', id, local, readBack(extra))).toMatchObject({ reason: 'content_conflict' });

    const doubled = asCloud(local);
    const first = doubled.get('recommendation_scores')?.[0];
    doubled.get('recommendation_scores')?.push({ ...first });
    expect(verifyReadBack('recommendation', id, local, readBack(doubled))).toMatchObject({ reason: 'content_conflict' });
  });

  it('treats missing cloud rows as incomplete (retry), never as confirmed', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const { id, local } = demoRecommendation(db);
    const partial = asCloud(local);
    partial.set('recommendation_scores', partial.get('recommendation_scores')?.slice(1) ?? []);
    expect(verifyReadBack('recommendation', id, local, readBack(partial))).toEqual({
      kind: 'retryable',
      code: 'verification_incomplete',
      stopCycle: false,
    });
    const noRoot = asCloud(local);
    noRoot.set('recommendations', []);
    expect(verifyReadBack('recommendation', id, local, readBack(noRoot))).toMatchObject({ code: 'verification_incomplete' });
  });

  it('rejects malformed read-back data as invalid, never confirmed', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const local = cloudRowsFor(db, 'robot', robot.id);
    const good = asCloud(local);
    const row = good.get('robots')?.[0];
    if (!row) throw new Error('missing');
    for (const bad of [
      new Map<CloudTable, unknown[]>(),
      new Map<CloudTable, unknown[]>([['robots', ['not an object']]]),
      new Map<CloudTable, unknown[]>([['robots', [{ ...row, id: null }]]]),
      new Map<CloudTable, unknown[]>([['robots', [{ ...row, cloud_received_at: 'yesterday' }]]]),
      new Map<CloudTable, unknown[]>([['robots', [{ ...row, cloud_received_at: undefined }]]]),
    ]) {
      expect(verifyReadBack('robot', robot.id, local, readBack(bad))).toMatchObject({ kind: 'retryable', code: 'invalid_response' });
    }
  });

  it('cannot be forged by a type cast', () => {
    const forged = { entityType: 'robot', entityId: 'x', cloudReceivedAt: T0.toISOString() } as unknown as VerifiedConfirmation;
    expect(isVerifiedConfirmation(forged)).toBe(false);
    expect(isVerifiedConfirmation(null)).toBe(false);
  });
});

describe('retry backoff', () => {
  it('is full-jitter exponential from 5 s, capped at 15 min', () => {
    expect(retryDelayMs(1, () => 0)).toBe(0);
    expect(retryDelayMs(1, () => 0.5)).toBe(2_500);
    expect(retryDelayMs(3, () => 0.5)).toBe(10_000);
    expect(retryDelayMs(1000, () => 0.999999)).toBeLessThan(SYNC_RETRY_CAP_MS);
    expect(retryDelayMs(1000, () => 2)).toBeLessThan(SYNC_RETRY_CAP_MS); // out-of-range random is clamped
    expect(retryDelayMs(0, () => 0.5)).toBe(2_500);
  });
});

describe('fenced confirmation and outcomes', () => {
  function claimedRobot() {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const other = addTestRobot(db, 'TEST-ROBOT-2');
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const claims = claimEligible(db, lease, { limit: 10, clock: c.clock });
    const entry = claims.find((e) => e.entityId === robot.id);
    const otherEntry = claims.find((e) => e.entityId === other.id);
    if (!entry || !otherEntry) throw new Error('expected claims');
    const local = cloudRowsFor(db, 'robot', robot.id);
    const outcome = verifyReadBack('robot', robot.id, local, readBack(asCloud(local)));
    if (outcome.kind !== 'confirmed') throw new Error('expected confirmation');
    return { db, robot, entry, otherEntry, c, lease, confirmation: outcome.confirmation };
  }

  it('marks synced only with a verified confirmation for the same entry', () => {
    const { db, robot, entry, otherEntry, c, lease, confirmation } = claimedRobot();
    const forged = { ...confirmation } as VerifiedConfirmation;
    expect(() => markSyncedFenced(db, lease, entry.id, forged, c.clock)).toThrow(SyncInputError);
    expect(() => markSyncedFenced(db, lease, otherEntry.id, confirmation, c.clock)).toThrow(/does not belong/);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ state: 'syncing' });
    markSyncedFenced(db, lease, entry.id, confirmation, c.clock);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({
      state: 'synced',
      cloudConfirmedAt: '2026-03-01T00:00:07.123Z',
      claimedBy: null,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(() => markSyncedFenced(db, lease, entry.id, confirmation, c.clock)).toThrow(); // no longer a claim
  });

  it('a stale or expired worker cannot confirm, and changes nothing', () => {
    const { db, robot, entry, c, lease, confirmation } = claimedRobot();
    c.set(at(120)); // lease expired
    expect(() => markSyncedFenced(db, lease, entry.id, confirmation, c.clock)).toThrow(LeaseLostError);
    const next = acquire(db, c.clock); // takeover recovers the claim
    const [reclaimed] = claimEligible(db, next, { limit: 1, clock: c.clock });
    expect(reclaimed?.entityId).toBe(robot.id);
    const before = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    expect(() => markSyncedFenced(db, lease, entry.id, confirmation, c.clock)).toThrow(LeaseLostError);
    expect(() => applyOutcome(db, lease, entry, { kind: 'confirmed', confirmation, duplicate: false }, { clock: c.clock, random: () => 0 })).toThrow(LeaseLostError);
    expect(() => returnClaimsFenced(db, lease, [entry.id], c.clock)).toThrow(LeaseLostError);
    expect(db.prepare('SELECT * FROM sync_outbox ORDER BY id').all()).toEqual(before);
    // The current owner's late duplicate confirmation still works (idempotent re-upload).
    if (!reclaimed) throw new Error('unreachable');
    markSyncedFenced(db, next, reclaimed.id, confirmation, c.clock);
    expect(getEntry(db, 'robot', robot.id)?.state).toBe('synced');
  });

  it('rolls back completely when the synced transition fails inside the transaction', () => {
    const { db, robot, entry, c, lease, confirmation } = claimedRobot();
    db.exec(`CREATE TEMP TRIGGER fail_sync BEFORE UPDATE OF state ON sync_outbox WHEN NEW.state = 'synced'
             BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
    const before = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
    expect(() => markSyncedFenced(db, lease, entry.id, confirmation, c.clock)).toThrow(/injected/);
    expect(db.prepare('SELECT * FROM sync_outbox ORDER BY id').all()).toEqual(before);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ state: 'syncing', claimedBy: lease.owner });
    expect(db.isTransaction).toBe(false);
  });

  it('applies retryable, ambiguous and permanent outcomes with the right durable state', () => {
    const { db, robot, entry, otherEntry, c, lease } = claimedRobot();
    applyOutcome(db, lease, entry, { kind: 'ambiguous', code: 'outcome_unknown', stopCycle: true }, { clock: c.clock, random: () => 0.5 });
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({
      state: 'failed',
      lastError: 'outcome_unknown',
      nextAttemptAt: at(2.5).toISOString(), // attempt 1: half of 5 s
      blockedAt: null,
      cloudConfirmedAt: null,
    });
    applyOutcome(db, lease, otherEntry, { kind: 'permanent', reason: 'identity_conflict' }, { clock: c.clock, random: () => 0.5 });
    expect(getEntry(db, 'robot', otherEntry.entityId)).toMatchObject({ state: 'failed', blockReason: 'identity_conflict', nextAttemptAt: null });

    // Retry eligibility: not before the retry time, then eligible again (the blocked one never).
    c.set(at(2));
    expect(claimEligible(db, lease, { limit: 10, clock: c.clock })).toEqual([]);
    c.set(at(3));
    const [retried] = claimEligible(db, lease, { limit: 10, clock: c.clock });
    expect(retried).toMatchObject({ entityId: robot.id, attemptCount: 2 });
    if (!retried) throw new Error('unreachable');
    applyOutcome(db, lease, retried, { kind: 'retryable', code: 'server_unavailable', stopCycle: true }, { clock: c.clock, random: () => 0.5 });
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ lastError: 'server_unavailable', nextAttemptAt: at(3 + 5).toISOString() });
  });

  it('keeps children ineligible while a parent awaits retry after an ambiguous write, then releases them on confirmation', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    recordReading(db, testReading(), T0);
    const c = fakeClock();
    const lease = acquire(db, c.clock);
    const ctx = { clock: c.clock, random: () => 0.5 };
    const [robotEntry] = claimEligible(db, lease, { limit: 10, clock: c.clock });
    if (!robotEntry) throw new Error('expected the robot');
    applyOutcome(db, lease, robotEntry, { kind: 'ambiguous', code: 'outcome_unknown', stopCycle: true }, ctx);
    // The run (child) cannot go even though the robot write may have landed.
    c.set(at(1));
    expect(claimEligible(db, lease, { limit: 10, clock: c.clock })).toEqual([]);
    c.set(at(3));
    const [again] = claimEligible(db, lease, { limit: 10, clock: c.clock });
    expect(again?.entityType).toBe('robot');
    if (!again) throw new Error('unreachable');
    const local = cloudRowsFor(db, 'robot', robot.id);
    applyOutcome(db, lease, again, verifyReadBack('robot', robot.id, local, readBack(asCloud(local), 0)), ctx);
    expect(getEntry(db, 'robot', robot.id)?.state).toBe('synced');
    expect(claimEligible(db, lease, { limit: 10, clock: c.clock }).map((e) => e.entityType)).toEqual(['run']);
  });

  it('returns unattempted claims to pending without an error, only for this worker', () => {
    const { db, entry, otherEntry, c, lease } = claimedRobot();
    expect(returnClaimsFenced(db, lease, [entry.id, otherEntry.id, 9999], c.clock)).toBe(2);
    expect(db.prepare(`SELECT DISTINCT state, claimed_by, last_error FROM sync_outbox`).all()).toEqual([
      { state: 'pending', claimed_by: null, last_error: null },
    ]);
  });
});
