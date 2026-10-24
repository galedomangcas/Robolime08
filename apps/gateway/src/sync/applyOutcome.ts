import type { Database } from '../db/connection';
import type { Clock } from '../db/time';
import type { OutboxEntry } from '../store/outbox';
import { markBlockedFenced, markFailedFenced, markSyncedFenced, type WorkerLease } from '../store/syncLease';
import { retryDelayMs, type SyncOutcome } from './confirmation';

export interface OutcomeContext {
  clock: Clock;
  /** Uniform [0, 1) source for retry jitter (injectable for tests). */
  random: () => number;
}

/**
 * Records one claimed entry's outcome through the fenced outbox API, in one
 * transaction. Throws `LeaseLostError` (and changes nothing) if this worker
 * no longer holds the lease when the transaction runs.
 * - confirmed            → 'synced' with the verified cloud receipt time;
 * - retryable / ambiguous → 'failed' with a fixed code and a backoff retry time;
 * - permanent            → blocked for operator review.
 */
export function applyOutcome(
  db: Database,
  lease: WorkerLease,
  entry: OutboxEntry,
  outcome: SyncOutcome,
  context: OutcomeContext,
): void {
  switch (outcome.kind) {
    case 'confirmed':
      markSyncedFenced(db, lease, entry.id, outcome.confirmation, context.clock);
      return;
    case 'retryable':
    case 'ambiguous': {
      const retryAt = new Date(context.clock().getTime() + retryDelayMs(entry.attemptCount, context.random));
      markFailedFenced(db, lease, entry.id, outcome.code, retryAt, context.clock);
      return;
    }
    case 'permanent':
      markBlockedFenced(db, lease, entry.id, outcome.reason, context.clock);
      return;
  }
}
