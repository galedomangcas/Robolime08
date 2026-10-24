import type { SyncState } from '@robolime/shared';

import { num, str, strOrNull, withTransaction, type Database, type Row } from '../db/connection';
import { toCanonicalUtc } from '../db/time';

/**
 * Durable transactional outbox for the one-way local → cloud mirror.
 *
 * Producers call `enqueue` in the SAME transaction that stores the entity, so
 * a stored record can never lack its sync row. The cloud sync worker (Phase 4)
 * drives the state machine below; this module only enforces it.
 */
export type OutboxEntityType =
  | 'robot'
  | 'field'
  | 'run'
  | 'reading'
  | 'status_report'
  | 'rule_set'
  | 'recommendation';

/** Parents sync before children so cloud foreign keys are satisfied. */
export const OUTBOX_SYNC_ORDER: readonly OutboxEntityType[] = [
  'robot',
  'field',
  'rule_set',
  'run',
  'reading',
  'status_report',
  'recommendation',
];

export interface OutboxEntry {
  id: number;
  entityType: OutboxEntityType;
  entityId: string;
  state: SyncState;
  attemptCount: number;
  enqueuedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  cloudConfirmedAt: string | null;
  /** Set only on a blocked entry (state 'failed', no retry time) awaiting operator requeue (migration 0002). */
  blockedAt: string | null;
  /** Fixed lowercase code; never record content, credentials or server messages. */
  blockReason: string | null;
  /** Lease owner that claimed this entry; set only while 'syncing' through the fenced API (syncLease.ts). */
  claimedBy: string | null;
}

/**
 * Evidence that the cloud persisted the entity. Only a confirmed remote write
 * (e.g. the row returned by an upsert) may produce this — never an attempt.
 */
export interface CloudConfirmation {
  /** Server-side receipt time reported by the cloud database. */
  cloudReceivedAt: string;
}

export class OutboxStateError extends Error {
  override name = 'OutboxStateError';
}

function toEntry(row: Row): OutboxEntry {
  return {
    id: num(row, 'id'),
    entityType: str(row, 'entity_type') as OutboxEntityType,
    entityId: str(row, 'entity_id'),
    state: str(row, 'state') as SyncState,
    attemptCount: num(row, 'attempt_count'),
    enqueuedAt: str(row, 'enqueued_at'),
    lastAttemptAt: strOrNull(row, 'last_attempt_at'),
    nextAttemptAt: strOrNull(row, 'next_attempt_at'),
    lastError: strOrNull(row, 'last_error'),
    cloudConfirmedAt: strOrNull(row, 'cloud_confirmed_at'),
    blockedAt: strOrNull(row, 'blocked_at'),
    blockReason: strOrNull(row, 'block_reason'),
    claimedBy: strOrNull(row, 'claimed_by'),
  };
}

export { toEntry as toOutboxEntry };

/** Adds the entity to the outbox once. Call inside the transaction that stores it. */
export function enqueue(db: Database, entityType: OutboxEntityType, entityId: string, now: Date): void {
  db.prepare(
    `INSERT INTO sync_outbox (entity_type, entity_id, state, enqueued_at)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT (entity_type, entity_id) DO NOTHING`,
  ).run(entityType, entityId, toCanonicalUtc(now));
}

/** Re-queues an already-synced entity whose mirrored content legitimately changed. */
export function markChanged(db: Database, entityType: OutboxEntityType, entityId: string): void {
  db.prepare(
    `UPDATE sync_outbox SET state = 'pending', cloud_confirmed_at = NULL, next_attempt_at = NULL
     WHERE entity_type = ? AND entity_id = ? AND state = 'synced'`,
  ).run(entityType, entityId);
}

export function getEntry(db: Database, entityType: OutboxEntityType, entityId: string): OutboxEntry | null {
  const row = db
    .prepare('SELECT * FROM sync_outbox WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId);
  return row === undefined ? null : toEntry(row);
}

/**
 * Moves up to `limit` due entries (pending, or failed whose retry time has
 * come) to 'syncing', parents first. The returned entries are now owned by
 * the caller until marked synced/failed or recovered at startup.
 *
 * Single-process helper without a lease, parent gating or fairness. A cloud
 * sync worker must use `claimEligible` (syncLease.ts) instead. Blocked
 * entries are never selected (claiming one would also violate migration
 * 0002's CHECK and abort the whole batch).
 */
export function claimBatch(db: Database, limit: number, now: Date): OutboxEntry[] {
  const nowText = toCanonicalUtc(now);
  const orderCase = OUTBOX_SYNC_ORDER.map((type, index) => `WHEN '${type}' THEN ${index}`).join(' ');
  return withTransaction(db, () => {
    const rows = db
      .prepare(
        `SELECT * FROM sync_outbox
         WHERE blocked_at IS NULL
           AND (state = 'pending' OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))
         ORDER BY CASE entity_type ${orderCase} END, id
         LIMIT ?`,
      )
      .all(nowText, limit);
    const update = db.prepare(
      `UPDATE sync_outbox SET state = 'syncing', attempt_count = attempt_count + 1, last_attempt_at = ?
       WHERE id = ?`,
    );
    for (const row of rows) {
      update.run(nowText, num(row, 'id'));
    }
    return rows.map((row) => ({
      ...toEntry(row),
      state: 'syncing' as const,
      attemptCount: num(row, 'attempt_count') + 1,
      lastAttemptAt: nowText,
    }));
  });
}

/** Legacy (unleased) transitions only apply to entries claimed without an owner. */
function requireSyncing(db: Database, id: number): void {
  const row = db.prepare('SELECT state, claimed_by FROM sync_outbox WHERE id = ?').get(id);
  if (row === undefined) {
    throw new OutboxStateError(`Outbox entry ${id} does not exist`);
  }
  if (str(row, 'state') !== 'syncing') {
    throw new OutboxStateError(`Outbox entry ${id} is '${str(row, 'state')}', not 'syncing'`);
  }
  if (strOrNull(row, 'claimed_by') !== null) {
    throw new OutboxStateError(`Outbox entry ${id} is owned by a sync lease; use the fenced API`);
  }
}

/** Records a CONFIRMED cloud write. Only valid for an entry currently being synced. */
export function markSynced(db: Database, id: number, confirmation: CloudConfirmation): void {
  requireSyncing(db, id);
  db.prepare(
    `UPDATE sync_outbox SET state = 'synced', cloud_confirmed_at = ?, last_error = NULL, next_attempt_at = NULL
     WHERE id = ?`,
  ).run(toCanonicalUtc(confirmation.cloudReceivedAt), id);
}

/** Records a failed or unconfirmed attempt; the entry is retried at `nextAttemptAt`. */
export function markFailed(db: Database, id: number, error: string, nextAttemptAt: Date): void {
  requireSyncing(db, id);
  db.prepare(
    `UPDATE sync_outbox SET state = 'failed', last_error = ?, next_attempt_at = ? WHERE id = ?`,
  ).run(error.slice(0, 2000), toCanonicalUtc(nextAttemptAt), id);
}

/**
 * Startup recovery: entries left 'syncing' by a previous process have an
 * unknown outcome, so they return to 'pending'. Re-sending is safe because
 * cloud writes are idempotent on the shared stable IDs.
 *
 * Only unowned claims (claimed_by NULL) are recovered here. Entries claimed
 * under a sync lease are recovered exclusively by an expired-lease takeover
 * (`acquireLease`), so a live worker's claims can never be stolen.
 */
export function recoverInterrupted(db: Database): number {
  const result = db
    .prepare(`UPDATE sync_outbox SET state = 'pending' WHERE state = 'syncing' AND claimed_by IS NULL`)
    .run();
  return Number(result.changes);
}

export function countByState(db: Database): Record<SyncState, number> {
  const counts: Record<SyncState, number> = { pending: 0, syncing: 0, synced: 0, failed: 0 };
  for (const row of db.prepare('SELECT state, COUNT(*) AS n FROM sync_outbox GROUP BY state').all()) {
    counts[str(row, 'state') as SyncState] = num(row, 'n');
  }
  return counts;
}

/** Cloud confirmation time for an entity, or null if not (yet) confirmed. */
export function cloudConfirmedAt(db: Database, entityType: OutboxEntityType, entityId: string): string | null {
  const row = db
    .prepare('SELECT cloud_confirmed_at FROM sync_outbox WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId);
  return row === undefined ? null : strOrNull(row, 'cloud_confirmed_at');
}
