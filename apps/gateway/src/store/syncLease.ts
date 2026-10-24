import { randomUUID } from 'node:crypto';

import { num, str, strOrNull, withTransaction, type Database, type Row } from '../db/connection';
import { toCanonicalUtc, type Clock } from '../db/time';
import { isVerifiedConfirmation, type VerifiedConfirmation } from '../sync/confirmation';
import { toOutboxEntry, OutboxStateError, type OutboxEntityType, type OutboxEntry } from './outbox';

/**
 * Single-worker lease and fenced outbox operations for the cloud sync worker
 * (M6a; local SQLite only, no network).
 *
 * Invariants (tested in syncLease.test.ts):
 * - At most one live lease (`sync_worker_lease`, id = 1). An unexpired lease
 *   is never taken over, and its claims are never recovered by anyone else.
 * - Owner identity is generated here (`randomUUID`) on every acquisition and
 *   cannot be chosen by the caller, so a restarted process can never reuse a
 *   previous process's identity or complete its claims. A new process waits
 *   for the old lease to expire; the takeover then recovers the old claims.
 * - Every lease-fenced operation reads the injected clock INSIDE its own
 *   `BEGIN IMMEDIATE` transaction and proves the caller still holds an
 *   unexpired lease (owner match and `expires_at > now`) before changing
 *   anything. SQLite's single writer lock means no takeover can happen
 *   between that check and the update. A time captured before an `await`
 *   can therefore never authorise a later mutation. A worker that lost its
 *   lease gets `LeaseLostError` and changes nothing.
 * - Migration 0002's trigger independently rejects claims, owned completions
 *   and ownership changes by anyone but the current lease owner. It checks
 *   identity only; expiry is checked here, not by the database.
 * - An expired (or absent) lease is replaced, and every orphaned owned
 *   'syncing' entry is returned to 'pending', in the same transaction.
 * - An entry is eligible only when every parent's outbox entry is 'synced',
 *   across batch boundaries, and it is not blocked.
 * - Blocked entries stay 'failed' with no retry time until `requeueBlocked`.
 * - Nothing here deletes or discards an outbox entry.
 *
 * Design rule for later milestones (C2): a multi-table aggregate (field,
 * rule set, recommendation) is uploaded as ONE unit; if it exceeds the
 * request limit it is blocked as 'aggregate_too_large', never split.
 */

/** Proposed lease timings (M6 design): TTL = 4 × the 30 s request timeout. */
export const SYNC_LEASE_TTL_MS = 120_000;
export const SYNC_LEASE_RENEW_INTERVAL_MS = 30_000;

/** Fairness: no entity type may take more than half of a claimed batch. */
export const SYNC_TYPE_BATCH_SHARE = 0.5;

/** Diagnostic thresholds only; an entry is never discarded for crossing them. */
export const SYNC_STUCK_AGE_MS = 24 * 60 * 60 * 1000;
export const SYNC_STUCK_ATTEMPTS = 20;

/** Fixed reasons for blocking an entry for operator review. */
export type BlockReason =
  | 'content_conflict'
  | 'identity_conflict'
  | 'constraint_conflict'
  | 'row_rejected'
  | 'aggregate_too_large';

const BLOCK_REASONS: ReadonlySet<string> = new Set<BlockReason>([
  'content_conflict',
  'identity_conflict',
  'constraint_conflict',
  'row_rejected',
  'aggregate_too_large',
]);

/** Failure codes are short lowercase identifiers, never messages or record content. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

export class SyncInputError extends Error {
  override name = 'SyncInputError';
}

/** Handle for a held lease. Only `acquireLease` creates one; the owner id is never caller-chosen. */
export interface WorkerLease {
  readonly owner: string;
}

export type LeaseAcquisition =
  | {
      acquired: true;
      lease: WorkerLease;
      expiresAt: string;
      /** True when an expired lease was replaced (false when no lease row existed). */
      tookOver: boolean;
      /** Orphaned owned 'syncing' entries returned to 'pending' in the same transaction. */
      recovered: number;
    }
  | { acquired: false; heldUntil: string };

const plusMs = (now: Date, ms: number) => toCanonicalUtc(new Date(now.getTime() + ms));

function readLease(db: Database): Row | undefined {
  return db.prepare('SELECT owner, expires_at FROM sync_worker_lease WHERE id = 1').get();
}

/**
 * Runs `fn` in a write transaction after proving `lease` is still held. The
 * clock is read inside the transaction, so the expiry check always uses the
 * current time.
 */
function fenced<T>(db: Database, lease: WorkerLease, clock: Clock, fn: (now: Date) => T): T {
  return withTransaction(db, () => {
    const now = clock();
    const row = readLease(db);
    if (row === undefined || str(row, 'owner') !== lease.owner || Date.parse(str(row, 'expires_at')) <= now.getTime()) {
      throw new LeaseLostError('This worker does not hold a valid sync lease');
    }
    return fn(now);
  });
}

/**
 * Acquires the lease for a NEW worker identity if no live lease exists.
 * A live lease (whoever holds it) is left alone: `acquired: false`. Replacing
 * an expired or absent lease recovers all orphaned owned claims atomically.
 * Call once per worker process; extend with `renewLease`.
 */
export function acquireLease(db: Database, clock: Clock, ttlMs = SYNC_LEASE_TTL_MS): LeaseAcquisition {
  return withTransaction(db, () => {
    const now = clock();
    const row = readLease(db);
    if (row !== undefined && Date.parse(str(row, 'expires_at')) > now.getTime()) {
      return { acquired: false, heldUntil: str(row, 'expires_at') };
    }
    const lease: WorkerLease = { owner: randomUUID() };
    const nowText = toCanonicalUtc(now);
    const expiresAt = plusMs(now, ttlMs);
    // No live lease: every owned claim belongs to a worker that no longer holds one.
    const recovered = Number(
      db
        .prepare(`UPDATE sync_outbox SET state = 'pending', claimed_by = NULL WHERE state = 'syncing' AND claimed_by IS NOT NULL`)
        .run().changes,
    );
    db.prepare(
      `INSERT INTO sync_worker_lease (id, owner, acquired_at, renewed_at, expires_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at,
         renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`,
    ).run(lease.owner, nowText, nowText, expiresAt);
    return { acquired: true, lease, expiresAt, tookOver: row !== undefined, recovered };
  });
}

/** Extends a still-valid lease. Throws `LeaseLostError` if it expired or was taken over. */
export function renewLease(db: Database, lease: WorkerLease, clock: Clock, ttlMs = SYNC_LEASE_TTL_MS): string {
  return fenced(db, lease, clock, (now) => {
    const expiresAt = plusMs(now, ttlMs);
    db.prepare('UPDATE sync_worker_lease SET renewed_at = ?, expires_at = ? WHERE id = 1 AND owner = ?').run(
      toCanonicalUtc(now),
      expiresAt,
      lease.owner,
    );
    return expiresAt;
  });
}

/** Returns this owner's in-flight claims to 'pending' and deletes the lease, atomically. Fenced. */
export function releaseLease(db: Database, lease: WorkerLease, clock: Clock): number {
  return fenced(db, lease, clock, () => {
    const returned = Number(
      db
        .prepare(`UPDATE sync_outbox SET state = 'pending', claimed_by = NULL WHERE state = 'syncing' AND claimed_by = ?`)
        .run(lease.owner).changes,
    );
    db.prepare('DELETE FROM sync_worker_lease WHERE id = 1 AND owner = ?').run(lease.owner);
    return returned;
  });
}

// ------------------------------------------------------------- parent map

interface ParentLink {
  parentType: OutboxEntityType;
  /** Scalar subquery giving the parent's id for outbox row `o`. */
  parentIdSql: string;
  /** True only where the local schema allows no parent (runs.field_id). */
  nullable: boolean;
}

/**
 * Every parent relationship that cloud foreign keys depend on (M6 design):
 * field → robot; run → robot and (if set) field; reading → run;
 * status_report → robot; recommendation → run and rule_set.
 */
export const PARENT_LINKS: Readonly<Record<OutboxEntityType, readonly ParentLink[]>> = {
  robot: [],
  rule_set: [],
  field: [{ parentType: 'robot', parentIdSql: 'SELECT robot_id FROM fields WHERE id = o.entity_id', nullable: false }],
  run: [
    { parentType: 'robot', parentIdSql: 'SELECT robot_id FROM runs WHERE id = o.entity_id', nullable: false },
    { parentType: 'field', parentIdSql: 'SELECT field_id FROM runs WHERE id = o.entity_id', nullable: true },
  ],
  reading: [{ parentType: 'run', parentIdSql: 'SELECT run_id FROM readings WHERE id = o.entity_id', nullable: false }],
  status_report: [
    { parentType: 'robot', parentIdSql: 'SELECT robot_id FROM robot_status_reports WHERE id = o.entity_id', nullable: false },
  ],
  recommendation: [
    { parentType: 'run', parentIdSql: 'SELECT run_id FROM recommendations WHERE id = o.entity_id', nullable: false },
    { parentType: 'rule_set', parentIdSql: 'SELECT rule_set_id FROM recommendations WHERE id = o.entity_id', nullable: false },
  ],
};

const ENTITY_TYPES = Object.keys(PARENT_LINKS) as OutboxEntityType[];

function parentStateExists(link: ParentLink, condition: string): string {
  return `EXISTS (SELECT 1 FROM sync_outbox p WHERE p.entity_type = '${link.parentType}'
            AND p.entity_id = (${link.parentIdSql}) AND ${condition})`;
}

/** SQL boolean: every parent of outbox row `o` is synced. A missing entity row is never eligible. */
const PARENTS_SYNCED_SQL = `CASE o.entity_type ${ENTITY_TYPES.map((type) => {
  const links = PARENT_LINKS[type];
  if (links.length === 0) return `WHEN '${type}' THEN 1`;
  const conditions = links.map((link) => {
    const synced = parentStateExists(link, `p.state = 'synced'`);
    return link.nullable ? `((${link.parentIdSql}) IS NULL OR ${synced})` : synced;
  });
  return `WHEN '${type}' THEN (${conditions.join(' AND ')})`;
}).join(' ')} ELSE 0 END`;

// ------------------------------------------------------------- claiming

export interface ClaimOptions {
  limit: number;
  clock: Clock;
}

/**
 * Atomically claims up to `limit` eligible entries for `lease`:
 * not blocked; 'pending', or 'failed' whose retry time is absent or due;
 * every parent 'synced'. Throws `LeaseLostError` without claiming anything
 * if the lease is not held at the time read inside the transaction.
 *
 * Ordering and fairness — exactly what is guaranteed:
 * - Per batch: no entity type takes more than half of `limit` (at least 1).
 * - Order is oldest first by due time (`next_attempt_at`, else
 *   `enqueued_at`), then id, across all types; there is no fixed type order.
 * - Across batches: an eligible entry waits only for eligible entries that
 *   are older than it (a finite backlog) plus the cap, so it is eventually
 *   claimed as long as due times follow the gateway clock forward.
 * - NOT guaranteed: a slot for every eligible type in every batch. With three
 *   or more busy types, the oldest two can fill whole batches; a backward
 *   clock change can lengthen such waits. A single eligible type fills at
 *   most half a batch.
 */
export function claimEligible(db: Database, lease: WorkerLease, options: ClaimOptions): OutboxEntry[] {
  const { limit, clock } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new SyncInputError('limit must be a positive integer');
  const perTypeCap = Math.max(1, Math.floor(limit * SYNC_TYPE_BATCH_SHARE));
  return fenced(db, lease, clock, (now) => {
    const nowText = toCanonicalUtc(now);
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT o.*, ROW_NUMBER() OVER (
             PARTITION BY o.entity_type ORDER BY COALESCE(o.next_attempt_at, o.enqueued_at), o.id) AS type_rank
           FROM sync_outbox o
           WHERE o.blocked_at IS NULL
             AND (o.state = 'pending' OR (o.state = 'failed' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)))
             AND ${PARENTS_SYNCED_SQL}
         )
         WHERE type_rank <= ?
         ORDER BY COALESCE(next_attempt_at, enqueued_at), id
         LIMIT ?`,
      )
      .all(nowText, perTypeCap, limit);
    const claim = db.prepare(
      `UPDATE sync_outbox SET state = 'syncing', claimed_by = ?, attempt_count = attempt_count + 1, last_attempt_at = ?
       WHERE id = ?`,
    );
    return rows.map((row) => {
      claim.run(lease.owner, nowText, num(row, 'id'));
      return toOutboxEntry(db.prepare('SELECT * FROM sync_outbox WHERE id = ?').get(num(row, 'id')) as Row);
    });
  });
}

// ------------------------------------------------------- fenced transitions

/** Inside the caller's transaction: the entry must be 'syncing' and claimed by `owner`. */
function requireOwnedClaim(db: Database, owner: string, id: number): void {
  const row = db.prepare('SELECT state, claimed_by FROM sync_outbox WHERE id = ?').get(id);
  if (row === undefined) throw new OutboxStateError(`Outbox entry ${id} does not exist`);
  if (str(row, 'state') !== 'syncing' || strOrNull(row, 'claimed_by') !== owner) {
    throw new OutboxStateError(`Outbox entry ${id} is not a claim held by this worker`);
  }
}

/** Records a failed attempt with a safe error code; retried at `nextAttemptAt`. Fenced. */
export function markFailedFenced(
  db: Database,
  lease: WorkerLease,
  id: number,
  errorCode: string,
  nextAttemptAt: Date,
  clock: Clock,
): void {
  if (!ERROR_CODE.test(errorCode)) throw new SyncInputError('errorCode must be a short lowercase code');
  fenced(db, lease, clock, () => {
    requireOwnedClaim(db, lease.owner, id);
    db.prepare(
      `UPDATE sync_outbox SET state = 'failed', claimed_by = NULL, last_error = ?, next_attempt_at = ? WHERE id = ?`,
    ).run(errorCode, toCanonicalUtc(nextAttemptAt), id);
  });
}

/**
 * Blocks an owned claim for operator review: state 'failed', no retry time,
 * `last_error` and `block_reason` set to the fixed reason code. Fenced.
 */
export function markBlockedFenced(db: Database, lease: WorkerLease, id: number, reason: BlockReason, clock: Clock): void {
  if (!BLOCK_REASONS.has(reason)) throw new SyncInputError('Unknown block reason');
  fenced(db, lease, clock, (now) => {
    requireOwnedClaim(db, lease.owner, id);
    db.prepare(
      `UPDATE sync_outbox SET state = 'failed', claimed_by = NULL, last_error = ?, next_attempt_at = NULL,
         blocked_at = ?, block_reason = ? WHERE id = ?`,
    ).run(reason, toCanonicalUtc(now), reason, id);
  });
}

/**
 * Marks an owned claim 'synced' (M6b). Requires a `VerifiedConfirmation`
 * issued by read-back verification for THIS entry; a cast object, another
 * entry's confirmation, or a stale lease is refused without any change.
 */
export function markSyncedFenced(
  db: Database,
  lease: WorkerLease,
  id: number,
  confirmation: VerifiedConfirmation,
  clock: Clock,
): void {
  if (!isVerifiedConfirmation(confirmation)) throw new SyncInputError('Not a verified cloud confirmation');
  fenced(db, lease, clock, () => {
    requireOwnedClaim(db, lease.owner, id);
    const row = db.prepare('SELECT entity_type, entity_id FROM sync_outbox WHERE id = ?').get(id) as Row;
    if (str(row, 'entity_type') !== confirmation.entityType || str(row, 'entity_id') !== confirmation.entityId) {
      throw new SyncInputError(`Confirmation does not belong to outbox entry ${id}`);
    }
    db.prepare(
      `UPDATE sync_outbox SET state = 'synced', claimed_by = NULL, cloud_confirmed_at = ?, last_error = NULL,
         next_attempt_at = NULL WHERE id = ?`,
    ).run(confirmation.cloudReceivedAt, id);
  });
}

/**
 * Returns owned claims that were never attempted (e.g. the cycle stopped on a
 * target-wide failure) to 'pending', without recording an error. Fenced;
 * entries not claimed by this worker are left alone. Returns the count.
 */
export function returnClaimsFenced(db: Database, lease: WorkerLease, ids: readonly number[], clock: Clock): number {
  return fenced(db, lease, clock, () => {
    const back = db.prepare(
      `UPDATE sync_outbox SET state = 'pending', claimed_by = NULL WHERE id = ? AND state = 'syncing' AND claimed_by = ?`,
    );
    return ids.reduce((n, id) => n + Number(back.run(id, lease.owner).changes), 0);
  });
}

/**
 * Operator action: clears both block fields and makes the entry due now
 * (clock read inside the transaction). It stays 'failed' (with its last
 * error) and is claimed normally next time. Refuses entries that are not
 * blocked. Does not require the worker lease.
 */
export function requeueBlocked(db: Database, entityType: OutboxEntityType, entityId: string, clock: Clock): void {
  withTransaction(db, () => {
    const now = clock();
    const row = db
      .prepare('SELECT blocked_at FROM sync_outbox WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId);
    if (row === undefined) throw new OutboxStateError('Outbox entry does not exist');
    if (strOrNull(row, 'blocked_at') === null) throw new OutboxStateError('Outbox entry is not blocked');
    db.prepare(
      `UPDATE sync_outbox SET blocked_at = NULL, block_reason = NULL, next_attempt_at = ?
       WHERE entity_type = ? AND entity_id = ?`,
    ).run(toCanonicalUtc(now), entityType, entityId);
  });
}

// ------------------------------------------------------------- diagnostics

export interface EntryRef {
  entityType: OutboxEntityType;
  entityId: string;
}

/**
 * Read-only health view. Contains identifiers, states, counts, timestamps
 * and fixed reason codes only — never record content or error messages.
 */
export interface SyncDiagnostics {
  blocked: (EntryRef & { blockReason: string; blockedAt: string })[];
  /** Unsynced entries whose direct parent entry is blocked (they cannot proceed until it is requeued). */
  waitingOnBlockedParent: (EntryRef & { parent: EntryRef })[];
  /** Unsynced, unblocked entries enqueued over 24 h ago or attempted at least 20 times. */
  stuck: (EntryRef & { state: string; attemptCount: number; enqueuedAt: string })[];
}

export function syncDiagnostics(db: Database, clock: Clock): SyncDiagnostics {
  const now = clock();
  const ref = (row: Row): EntryRef => ({
    entityType: str(row, 'entity_type') as OutboxEntityType,
    entityId: str(row, 'entity_id'),
  });
  const blocked = db
    .prepare(
      `SELECT entity_type, entity_id, block_reason, blocked_at FROM sync_outbox
       WHERE blocked_at IS NOT NULL ORDER BY blocked_at, id`,
    )
    .all()
    .map((row) => ({ ...ref(row), blockReason: str(row, 'block_reason'), blockedAt: str(row, 'blocked_at') }));

  const waitingOnBlockedParent: SyncDiagnostics['waitingOnBlockedParent'] = [];
  for (const type of ENTITY_TYPES) {
    for (const link of PARENT_LINKS[type]) {
      const rows = db
        .prepare(
          `SELECT o.entity_type, o.entity_id, (${link.parentIdSql}) AS parent_id FROM sync_outbox o
           WHERE o.entity_type = ? AND o.state <> 'synced'
             AND ${parentStateExists(link, 'p.blocked_at IS NOT NULL')}
           ORDER BY o.id`,
        )
        .all(type);
      for (const row of rows) {
        waitingOnBlockedParent.push({ ...ref(row), parent: { entityType: link.parentType, entityId: str(row, 'parent_id') } });
      }
    }
  }

  const stuck = db
    .prepare(
      `SELECT entity_type, entity_id, state, attempt_count, enqueued_at FROM sync_outbox
       WHERE state <> 'synced' AND blocked_at IS NULL AND (enqueued_at <= ? OR attempt_count >= ?)
       ORDER BY enqueued_at, id`,
    )
    .all(toCanonicalUtc(new Date(now.getTime() - SYNC_STUCK_AGE_MS)), SYNC_STUCK_ATTEMPTS)
    .map((row) => ({
      ...ref(row),
      state: str(row, 'state'),
      attemptCount: num(row, 'attempt_count'),
      enqueuedAt: str(row, 'enqueued_at'),
    }));

  return { blocked, waitingOnBlockedParent, stuck };
}
