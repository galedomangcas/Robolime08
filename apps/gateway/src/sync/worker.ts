import type { Database } from '../db/connection';
import { getDatabasePurpose } from '../db/init';
import { systemClock, type Clock } from '../db/time';
import type { OutboxEntry } from '../store/outbox';
import {
  acquireLease,
  claimEligible,
  LeaseLostError,
  releaseLease,
  renewLease,
  returnClaimsFenced,
  SYNC_LEASE_RENEW_INTERVAL_MS,
  type WorkerLease,
} from '../store/syncLease';
import { applyOutcome } from './applyOutcome';
import { cloudRowsFor, CloudMappingError } from './cloudRows';
import { retryDelayMs, SYNC_RETRY_BASE_MS, type SyncOutcome } from './confirmation';
import { CloudTargetError, createPostgrestTransport, type CloudTarget, type CloudTransport, type FetchLike } from './postgrest';
import { uploadEntity } from './uploadEntity';

/**
 * Durable one-way cloud sync worker (M6d): local SQLite outbox → cloud.
 *
 * - Holds the single worker lease; every outbox change goes through the
 *   fenced API, so a worker that lost its lease changes nothing.
 * - Claims only eligible entries (parents confirmed, not blocked, retry due),
 *   uploads each aggregate, and records its outcome. `synced` requires a
 *   verified read-back (confirmation.ts); retry state lives in SQLite, so it
 *   survives restarts. Interrupted claims are recovered by lease takeover.
 * - A target-wide failure (network, credentials, server) stops the cycle:
 *   the failed entry gets a backoff retry time and the unattempted claims go
 *   back to 'pending' untouched.
 * - The lease is renewed before every cloud request once 30 s have passed,
 *   so a slow aggregate cannot outlive it unnoticed.
 */

export const SYNC_BATCH_LIMIT = 100;
export const SYNC_IDLE_DELAY_MS = 15_000;

export interface CycleCounts {
  claimed: number;
  confirmed: number;
  duplicates: number;
  retried: number;
  ambiguous: number;
  blocked: number;
  returned: number;
  /** Fixed code of the target-wide failure that stopped the cycle, if any. */
  stoppedBy: string | null;
}

export interface CycleOptions {
  db: Database;
  transport: CloudTransport;
  lease: WorkerLease;
  clock: Clock;
  random: () => number;
  limit?: number;
  maxRequestBytes?: number;
}

/** Renews the lease before a request when the renew interval has passed. */
function renewingTransport(inner: CloudTransport, renewIfDue: () => void): CloudTransport {
  return {
    insert: (table, rows) => {
      renewIfDue();
      return inner.insert(table, rows);
    },
    select: (table, column, value) => {
      renewIfDue();
      return inner.select(table, column, value);
    },
  };
}

/**
 * One claim-upload-record pass. Throws `LeaseLostError` if the lease is lost;
 * whatever was not recorded stays claimed and is recovered by the takeover.
 */
export async function runSyncCycle(options: CycleOptions): Promise<CycleCounts> {
  const { db, lease, clock, random } = options;
  const counts: CycleCounts = {
    claimed: 0, confirmed: 0, duplicates: 0, retried: 0, ambiguous: 0, blocked: 0, returned: 0, stoppedBy: null,
  };
  // Renew first: proves the lease is still held before claiming, and makes the renew timer truthful
  // however long the caller waited since its last cycle.
  renewLease(db, lease, clock);
  let renewedAt = clock().getTime();
  const renewIfDue = () => {
    if (clock().getTime() - renewedAt >= SYNC_LEASE_RENEW_INTERVAL_MS) {
      renewLease(db, lease, clock);
      renewedAt = clock().getTime();
    }
  };
  const transport = renewingTransport(options.transport, renewIfDue);

  const claims = claimEligible(db, lease, { limit: options.limit ?? SYNC_BATCH_LIMIT, clock });
  counts.claimed = claims.length;
  const unattempted: number[] = [];
  for (const entry of claims) {
    if (counts.stoppedBy !== null) {
      unattempted.push(entry.id);
      continue;
    }
    const outcome = await syncOne(db, transport, entry, options.maxRequestBytes);
    applyOutcome(db, lease, entry, outcome, { clock, random });
    tally(counts, outcome);
  }
  if (unattempted.length > 0) counts.returned = returnClaimsFenced(db, lease, unattempted, clock);
  return counts;
}

async function syncOne(db: Database, transport: CloudTransport, entry: OutboxEntry, maxRequestBytes?: number): Promise<SyncOutcome> {
  let local;
  try {
    local = cloudRowsFor(db, entry.entityType, entry.entityId);
  } catch (error) {
    if (error instanceof CloudMappingError) return { kind: 'permanent', reason: 'row_rejected' };
    throw error;
  }
  try {
    return await uploadEntity(transport, entry.entityType, entry.entityId, local, maxRequestBytes);
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    // An unexpected transport exception: the write may have happened.
    return { kind: 'ambiguous', code: 'outcome_unknown', stopCycle: true };
  }
}

function tally(counts: CycleCounts, outcome: SyncOutcome): void {
  switch (outcome.kind) {
    case 'confirmed':
      counts.confirmed += 1;
      if (outcome.duplicate) counts.duplicates += 1;
      return;
    case 'retryable':
      counts.retried += 1;
      if (outcome.stopCycle) counts.stoppedBy = outcome.code;
      return;
    case 'ambiguous':
      counts.ambiguous += 1;
      counts.stoppedBy = outcome.code;
      return;
    case 'permanent':
      counts.blocked += 1;
      return;
  }
}

// ------------------------------------------------------------ long-running

export type SyncEvent =
  | { event: 'lease_waiting'; heldUntil: string }
  | { event: 'lease_acquired'; tookOver: boolean; recovered: number }
  | { event: 'lease_lost' }
  | { event: 'cycle'; counts: CycleCounts }
  | { event: 'stopped'; returnedClaims: number };

export interface SyncWorkerOptions {
  db: Database;
  target: CloudTarget;
  fetch?: FetchLike;
  timeoutMs?: number;
  clock?: Clock;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limit?: number;
  idleDelayMs?: number;
  /** Receives counts and codes only — never record content, URLs or credentials. */
  onEvent?: (event: SyncEvent) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export class SyncWorker {
  private readonly transport: CloudTransport;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private lease: WorkerLease | null = null;

  constructor(private readonly options: SyncWorkerOptions) {
    const purpose = getDatabasePurpose(options.db);
    if (purpose !== 'field' && !options.target.isLoopback) {
      throw new CloudTargetError(`A ${purpose ?? 'unrecognised'} database may only sync to a loopback test target.`);
    }
    this.transport = createPostgrestTransport(options.target, { fetch: options.fetch, timeoutMs: options.timeoutMs });
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Runs cycles until `signal` aborts, then returns its claims and releases the lease. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    try {
      while (!signal.aborted) {
        const lease = this.ensureLease();
        if (typeof lease === 'string') {
          // Another worker holds a live lease: wait until it could expire (bounded), then try again.
          const untilExpiry = Date.parse(lease) - this.clock().getTime();
          await this.sleep(Math.min(Math.max(untilExpiry, SYNC_RETRY_BASE_MS), this.options.idleDelayMs ?? SYNC_IDLE_DELAY_MS), signal);
          continue;
        }
        let delay: number;
        try {
          const counts = await runSyncCycle({
            db: this.options.db, transport: this.transport, lease, clock: this.clock, random: this.random,
            limit: this.options.limit,
          });
          this.emit({ event: 'cycle', counts });
          failures = counts.stoppedBy === null ? 0 : failures + 1;
          const limit = this.options.limit ?? SYNC_BATCH_LIMIT;
          if (counts.stoppedBy !== null) delay = Math.max(SYNC_RETRY_BASE_MS, retryDelayMs(failures, this.random));
          else delay = counts.claimed >= limit ? 0 : (this.options.idleDelayMs ?? SYNC_IDLE_DELAY_MS);
        } catch (error) {
          if (!(error instanceof LeaseLostError)) throw error;
          this.lease = null;
          this.emit({ event: 'lease_lost' });
          delay = SYNC_RETRY_BASE_MS;
        }
        if (delay > 0) await this.idle(delay, signal);
      }
    } finally {
      this.stop();
    }
  }

  /**
   * Waits between cycles while keeping the lease alive: sleeps in steps of at
   * most the renew interval and renews after each. Backoff can last up to
   * 15 min, far longer than the 120 s lease.
   */
  private async idle(ms: number, signal: AbortSignal): Promise<void> {
    let remaining = ms;
    while (remaining > 0 && !signal.aborted) {
      const step = Math.min(remaining, SYNC_LEASE_RENEW_INTERVAL_MS);
      await this.sleep(step, signal);
      remaining -= step;
      if (this.lease === null || signal.aborted) continue;
      try {
        renewLease(this.options.db, this.lease, this.clock);
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
        this.lease = null;
        this.emit({ event: 'lease_lost' });
        return;
      }
    }
  }

  /** The held lease, or the expiry time of another worker's live lease. */
  private ensureLease(): WorkerLease | string {
    if (this.lease !== null) return this.lease;
    const result = acquireLease(this.options.db, this.clock);
    if (!result.acquired) {
      this.emit({ event: 'lease_waiting', heldUntil: result.heldUntil });
      return result.heldUntil;
    }
    this.lease = result.lease;
    this.emit({ event: 'lease_acquired', tookOver: result.tookOver, recovered: result.recovered });
    return this.lease;
  }

  private stop(): void {
    const lease = this.lease;
    this.lease = null;
    if (lease === null) return;
    try {
      this.emit({ event: 'stopped', returnedClaims: releaseLease(this.options.db, lease, this.clock) });
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error; // already expired: the next takeover recovers its claims
    }
  }

  private emit(event: SyncEvent): void {
    this.options.onEvent?.(event);
  }
}
