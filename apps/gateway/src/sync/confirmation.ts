import { toCanonicalUtc } from '../db/time';
import type { OutboxEntityType } from '../store/outbox';
import type { BlockReason } from '../store/syncLease';
import { CLOUD_PRIMARY_KEYS, ROOT_TABLE } from './cloudContract';
import type { CloudRow, CloudTable, CloudTableRows, CloudValue } from './cloudRows';

/**
 * Cloud-sync confirmation and outcome contract (M6b). Pure: no I/O.
 *
 * An outbox entry may become 'synced' ONLY through a `VerifiedConfirmation`,
 * which only `verifyReadBack` issues, after reading the aggregate back from
 * the cloud and finding every local row there with identical content (and no
 * extra rows). A sent request, a 2xx status, or a timeout is never proof.
 *
 * Outcome kinds:
 * - confirmed  — read-back matched; `duplicate` when the cloud already held
 *                every row (nothing new was inserted).
 * - retryable  — known not to have succeeded, or not verifiable yet; retried
 *                with backoff.
 * - ambiguous  — a write may or may not have been applied (timeout, lost
 *                response). Never treated as failure OR success: the entry is
 *                retried, and the idempotent re-insert plus read-back decides.
 * - permanent  — the cloud holds conflicting data or rejects the row; the
 *                entry is blocked for operator review (fixed reason code).
 */

export type RetryCode =
  | 'network_unavailable'
  | 'auth_rejected'
  | 'schema_mismatch'
  | 'rate_limited'
  | 'server_unavailable'
  | 'server_error'
  | 'request_rejected'
  | 'invalid_response'
  | 'verification_unavailable'
  | 'verification_incomplete'
  | 'read_truncated';

declare const verifiedBrand: unique symbol;

/** Proof that the cloud persisted exactly the local aggregate. Only `verifyReadBack` creates one. */
export interface VerifiedConfirmation {
  readonly entityType: OutboxEntityType;
  readonly entityId: string;
  /** Canonical UTC copy of the cloud-assigned `cloud_received_at` of the root row. */
  readonly cloudReceivedAt: string;
  readonly [verifiedBrand]: true;
}

export type SyncOutcome =
  | { kind: 'confirmed'; confirmation: VerifiedConfirmation; duplicate: boolean }
  /** `stopCycle`: the problem is target-wide (network, credentials, server), not specific to this row. */
  | { kind: 'retryable'; code: RetryCode; stopCycle: boolean }
  | { kind: 'ambiguous'; code: 'outcome_unknown'; stopCycle: true }
  | { kind: 'permanent'; reason: BlockReason };

const issued = new WeakSet<object>();

/** Runtime check that a confirmation was issued by `verifyReadBack` (a type cast cannot forge one). */
export function isVerifiedConfirmation(value: unknown): value is VerifiedConfirmation {
  return typeof value === 'object' && value !== null && issued.has(value);
}

function issue(entityType: OutboxEntityType, entityId: string, cloudReceivedAt: string): VerifiedConfirmation {
  const confirmation = Object.freeze({ entityType, entityId, cloudReceivedAt }) as unknown as VerifiedConfirmation;
  issued.add(confirmation);
  return confirmation;
}

// --------------------------------------------------------- failure classes

/** What the transport observed, without any server message text. */
export type TransportFailure =
  /** The connection was never established: the request was certainly not applied. */
  | { kind: 'not_sent' }
  /** Sent (or possibly sent) but no complete response: timeout, reset, abort. */
  | { kind: 'no_response' }
  /** A read returned fewer rows than the server's exact count (a server row cap). */
  | { kind: 'truncated' }
  /** A response arrived but its body was not the expected shape. */
  | { kind: 'invalid_response'; status: number }
  /** An HTTP error status, with the PostgreSQL/PostgREST error code when the body carried one. */
  | { kind: 'http'; status: number; pgCode: string | null };

export type RequestPhase = 'write' | 'read';

const retry = (code: RetryCode, stopCycle = true): SyncOutcome => ({ kind: 'retryable', code, stopCycle });
const AMBIGUOUS: SyncOutcome = { kind: 'ambiguous', code: 'outcome_unknown', stopCycle: true };

/**
 * Maps a failed request to an outcome. A write that may have reached the
 * database without a usable answer is ambiguous; a read can never change
 * cloud state, so its failures are simply retryable.
 */
export function classifyFailure(phase: RequestPhase, failure: TransportFailure): SyncOutcome {
  switch (failure.kind) {
    case 'not_sent':
      return retry('network_unavailable');
    case 'no_response':
      return phase === 'write' ? AMBIGUOUS : retry('verification_unavailable');
    case 'truncated':
      return retry('read_truncated', false); // specific to this (large) aggregate, not the whole target
    case 'invalid_response':
      return phase === 'write' && failure.status >= 200 && failure.status < 300 ? AMBIGUOUS : retry('invalid_response');
    case 'http':
      return classifyHttp(phase, failure.status, failure.pgCode);
  }
}

function classifyHttp(phase: RequestPhase, status: number, pgCode: string | null): SyncOutcome {
  if (pgCode !== null) {
    // Data the cloud will never accept as sent: block for review.
    if (pgCode === '23505') return { kind: 'permanent', reason: 'identity_conflict' }; // other unique (natural) key
    if (pgCode === '23514' || pgCode === '23502' || pgCode.startsWith('22')) {
      return { kind: 'permanent', reason: 'row_rejected' }; // CHECK (incl. immutability/dosing-only triggers), NOT NULL, bad data
    }
    if (pgCode.startsWith('23')) return { kind: 'permanent', reason: 'constraint_conflict' }; // e.g. 23503 parent missing in the cloud
    if (pgCode === '42501') return retry('auth_rejected');
    if (pgCode === '42P01' || pgCode === '42703' || /^PGRST2\d\d$/.test(pgCode)) return retry('schema_mismatch');
    if (/^PGRST3\d\d$/.test(pgCode)) return retry('auth_rejected'); // JWT errors
  }
  if (status === 401 || status === 403) return retry('auth_rejected');
  if (status === 404) return retry('schema_mismatch');
  if (status === 429) return retry('rate_limited');
  if (status === 408) return phase === 'write' ? AMBIGUOUS : retry('verification_unavailable');
  if (status >= 500) {
    // With a database error code the statement failed and rolled back; without one
    // (a proxy or gateway error) a write may still have been applied.
    if (pgCode !== null) return retry('server_error');
    return phase === 'write' ? AMBIGUOUS : retry('server_unavailable');
  }
  return retry('request_rejected');
}

// ------------------------------------------------------------ verification

/** The gateway's stored timestamp form (see db/time.ts). */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Order-insensitive equality for JSON values (jsonb does not preserve key order). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return a === b;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return Symbol('invalid'); // never equal to anything
  }
}

/** Compares a local value with what PostgREST returned for the same column. */
export function sameCloudValue(local: CloudValue, remote: unknown): boolean {
  if (local === null || typeof local === 'boolean' || typeof local === 'number') return remote === local;
  if (typeof local === 'object') return jsonEqual(parseJson(local.jsonb), remote);
  if (typeof remote !== 'string') return false;
  if (CANONICAL_UTC.test(local)) {
    const remoteMs = Date.parse(remote); // timestamptz comes back as e.g. 2026-03-01T00:00:00+00:00
    return !Number.isNaN(remoteMs) && remoteMs === Date.parse(local);
  }
  if (UUID.test(local)) return remote.toLowerCase() === local.toLowerCase();
  return remote === local;
}

function keyOf(table: CloudTable, row: Readonly<Record<string, unknown>>): string | null {
  const parts: string[] = [];
  for (const column of CLOUD_PRIMARY_KEYS[table] as readonly string[]) {
    const value = row[column];
    if (typeof value === 'string') parts.push(UUID.test(value) ? value.toLowerCase() : value);
    else if (typeof value === 'number') parts.push(String(value));
    else return null;
  }
  return JSON.stringify(parts);
}

function rowMatches(local: CloudRow, remote: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(local).every(([column, value]) => column in remote && sameCloudValue(value, remote[column]));
}

export interface ReadBack {
  /** Every row the cloud returned for each aggregate table (selected by READ_BACK_COLUMN = entity id). */
  rows: ReadonlyMap<CloudTable, readonly unknown[]>;
  /** Rows the insert requests reported as newly inserted (0 = all already existed). */
  insertedRows: number;
}

/**
 * Decides whether the cloud holds exactly the local aggregate.
 * - any differing or extra cloud row → permanent `content_conflict`;
 * - a local row absent from the cloud → retryable `verification_incomplete`;
 * - otherwise → confirmed, with the root row's `cloud_received_at`.
 */
export function verifyReadBack(
  entityType: OutboxEntityType,
  entityId: string,
  local: readonly CloudTableRows[],
  readBack: ReadBack,
): SyncOutcome {
  let missing = false;
  for (const { table, rows } of local) {
    const remoteRows = readBack.rows.get(table);
    if (remoteRows === undefined || !remoteRows.every(isPlainObject)) return retry('invalid_response');
    const byKey = new Map<string, Readonly<Record<string, unknown>>>();
    for (const remote of remoteRows as readonly Record<string, unknown>[]) {
      const key = keyOf(table, remote);
      if (key === null) return retry('invalid_response');
      if (byKey.has(key)) return { kind: 'permanent', reason: 'content_conflict' };
      byKey.set(key, remote);
    }
    for (const row of rows) {
      const key = keyOf(table, row);
      const remote = key === null ? undefined : byKey.get(key);
      if (key !== null) byKey.delete(key);
      if (remote === undefined) missing = true;
      else if (!rowMatches(row, remote)) return { kind: 'permanent', reason: 'content_conflict' };
    }
    if (byKey.size > 0) return { kind: 'permanent', reason: 'content_conflict' }; // cloud rows the gateway never sent
  }
  if (missing) return retry('verification_incomplete', false);

  const root = readBack.rows.get(ROOT_TABLE[entityType])?.[0];
  const received = isPlainObject(root) ? root.cloud_received_at : undefined;
  const receivedMs = typeof received === 'string' ? Date.parse(received) : Number.NaN;
  if (Number.isNaN(receivedMs)) return retry('invalid_response');
  return {
    kind: 'confirmed',
    confirmation: issue(entityType, entityId, toCanonicalUtc(new Date(receivedMs))),
    duplicate: readBack.insertedRows === 0,
  };
}

// ------------------------------------------------------------------ backoff

/** Approved retry policy (M6 design): exponential from 5 s, capped at 15 min, full jitter. */
export const SYNC_RETRY_BASE_MS = 5_000;
export const SYNC_RETRY_CAP_MS = 15 * 60 * 1000;

/** Delay before the next attempt after `attemptCount` attempts; `random` returns [0, 1). */
export function retryDelayMs(attemptCount: number, random: () => number): number {
  const ceiling = Math.min(SYNC_RETRY_CAP_MS, SYNC_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1));
  const r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return Math.floor(ceiling * r);
}
