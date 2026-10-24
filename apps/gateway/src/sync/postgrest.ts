import { isIP } from 'node:net';
import { inspect } from 'node:util';

import type { DatabasePurpose } from '../db/init';
import { CLOUD_PRIMARY_KEYS } from './cloudContract';
import type { CloudRow, CloudTable, CloudValue } from './cloudRows';
import type { TransportFailure } from './confirmation';

/**
 * Cloud transport for the one-way mirror (M6c): Supabase's PostgREST API over
 * the built-in `fetch` (no dependency). It only moves bytes and reports what
 * it observed; deciding what an observation MEANS is `confirmation.ts`.
 *
 * - Inserts conflict-target the primary key only and ignore duplicates
 *   (`Prefer: resolution=ignore-duplicates,return=representation`), so a
 *   replay is idempotent and the response lists only newly inserted rows.
 * - Every request has a hard timeout covering the whole response body, and
 *   bodies are size-capped and shape-checked.
 * - The service-role key is held by `CloudCredential`, which never prints,
 *   serialises or appears in an error. Server error messages are dropped;
 *   only the status and the machine error code are kept.
 */

export const SYNC_REQUEST_TIMEOUT_MS = 30_000;
/** Approved request budget (M6 design): an aggregate larger than this is blocked, never split. */
export const SYNC_MAX_REQUEST_BYTES = 512 * 1024;
export const SYNC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class CloudTargetError extends Error {
  override name = 'CloudTargetError';
}

/** Holds the gateway's privileged key. It cannot be printed, logged or serialised by accident. */
export class CloudCredential {
  readonly #key: string;

  constructor(key: string) {
    if (key.length < 20 || key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) {
      throw new CloudTargetError('The service-role key is missing or malformed (value not shown).');
    }
    this.#key = key;
  }

  /** Request headers carrying the key. Only the transport calls this. */
  headers(): Record<string, string> {
    return { apikey: this.#key, authorization: `Bearer ${this.#key}` };
  }

  toString(): string {
    return '[redacted credential]';
  }

  toJSON(): string {
    return '[redacted credential]';
  }

  [inspect.custom](): string {
    return '[redacted credential]';
  }
}

export interface CloudTarget {
  /** Origin of the Supabase project (or a local stand-in), e.g. https://xyz.supabase.co */
  origin: string;
  credential: CloudCredential;
  isLoopback: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  return version === 6 && (host === '::1' || host === '0:0:0:0:0:0:0:1');
}

/**
 * Validates the sync target. HTTPS is required except on loopback (a local
 * test target). A demo/simulation database may only sync to loopback, so
 * synthetic data can never reach a hosted project. Errors never echo the key.
 */
export function parseCloudTarget(
  input: { url: string | undefined; serviceRoleKey: string | undefined },
  purpose: DatabasePurpose,
): CloudTarget {
  const raw = input.url?.trim();
  if (!raw) throw new CloudTargetError('Set SUPABASE_URL to the cloud project URL.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudTargetError('SUPABASE_URL is not a valid URL.');
  }
  if (url.username || url.password) throw new CloudTargetError('SUPABASE_URL must not contain credentials.');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CloudTargetError('SUPABASE_URL must be the bare project origin (no path, query or fragment).');
  }
  const isLoopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new CloudTargetError('SUPABASE_URL must use https (plain http is allowed only for a loopback test target).');
  }
  if (purpose !== 'field' && !isLoopback) {
    throw new CloudTargetError(
      `This is a ${purpose} database; it may only sync to a loopback test target, never to a hosted project.`,
    );
  }
  if (input.serviceRoleKey === undefined || input.serviceRoleKey === '') {
    throw new CloudTargetError('Set SUPABASE_SERVICE_ROLE_KEY (gateway environment only).');
  }
  return { origin: url.origin, credential: new CloudCredential(input.serviceRoleKey), isLoopback };
}

// ---------------------------------------------------------------- transport

export type TransportResult<T> = { ok: true; value: T } | { ok: false; failure: TransportFailure };

export interface CloudTransport {
  /** Inserts rows, ignoring primary-key duplicates. Value: number of rows newly inserted. */
  insert(table: CloudTable, rows: readonly CloudRow[]): Promise<TransportResult<number>>;
  /** All rows of `table` whose `column` equals `value`. */
  select(table: CloudTable, column: string, value: string): Promise<TransportResult<unknown[]>>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Error codes that prove the TCP connection was never made (nothing was sent). */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
]);
/** `Content-Range: 0-24/25` or `*` + `/0` (PostgREST, with `Prefer: count=exact`). */
const CONTENT_RANGE = /^(?:\d+-\d+|\*)\/(\d+|\*)$/;
const PG_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/;

function errorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function toWire(row: CloudRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row) as [string, CloudValue][]) {
    out[column] = value !== null && typeof value === 'object' ? (JSON.parse(value.jsonb) as unknown) : value;
  }
  return out;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArrayOfObjects(text: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))
    ? parsed
    : null;
}

function pgCodeOf(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' && PG_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function createPostgrestTransport(target: CloudTarget, options: TransportOptions = {}): CloudTransport {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? SYNC_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? SYNC_MAX_RESPONSE_BYTES;

  async function request(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; prefer?: string },
    expectStatus: number,
  ): Promise<TransportResult<unknown[]>> {
    const headers: Record<string, string> = { ...target.credential.headers(), accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.prefer) headers.prefer = init.prefer;
    let response: Response;
    let text: string | null;
    try {
      response = await doFetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow a redirect: the key would be sent to the new location. A 3xx is reported as an HTTP failure.
        redirect: 'manual',
      });
      text = await readCapped(response, maxResponseBytes);
    } catch (error) {
      const code = errorCode(error);
      return { ok: false, failure: code !== undefined && NOT_SENT_CODES.has(code) ? { kind: 'not_sent' } : { kind: 'no_response' } };
    }
    // PostgREST answers a read cut short by its row cap with 206 Partial Content. Only reads may get
    // it, and it is never taken as complete unless the exact count proves it (below).
    const partialRead = init.method === 'GET' && response.status === 206;
    if (response.status !== expectStatus && !partialRead) {
      if (response.status >= 200 && response.status < 300) {
        return { ok: false, failure: { kind: 'invalid_response', status: response.status } };
      }
      return { ok: false, failure: { kind: 'http', status: response.status, pgCode: text === null ? null : pgCodeOf(text) } };
    }
    const contentType = response.headers.get('content-type') ?? '';
    const rows = text === null || !contentType.startsWith('application/json') ? null : parseArrayOfObjects(text);
    if (rows === null) return { ok: false, failure: { kind: 'invalid_response', status: response.status } };
    // A server row cap (Supabase db-max-rows, 1000 by default) truncates a read. With an exact count
    // requested, a total that differs from the rows received means the read is incomplete; a 206
    // without an exact total is incomplete by definition.
    if (init.method === 'GET') {
      const total = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')?.[1];
      const exactTotal = total === undefined || total === '*' ? null : Number(total);
      if (exactTotal === null ? partialRead : exactTotal !== rows.length) {
        return { ok: false, failure: { kind: 'truncated' } };
      }
    }
    return { ok: true, value: rows };
  }

  const endpoint = (table: CloudTable) => `${target.origin}/rest/v1/${table}`;

  return {
    async insert(table, rows) {
      if (rows.length === 0) return { ok: true, value: 0 };
      const conflict = (CLOUD_PRIMARY_KEYS[table] as readonly string[]).join(',');
      const result = await request(
        `${endpoint(table)}?on_conflict=${encodeURIComponent(conflict)}`,
        { method: 'POST', body: JSON.stringify(rows.map(toWire)), prefer: 'resolution=ignore-duplicates,return=representation' },
        201,
      );
      if (!result.ok) return result;
      if (result.value.length > rows.length) return { ok: false, failure: { kind: 'invalid_response', status: 201 } };
      return { ok: true, value: result.value.length };
    },
    async select(table, column, value) {
      const query = `select=*&${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`;
      return request(`${endpoint(table)}?${query}`, { method: 'GET', prefer: 'count=exact' }, 200);
    },
  };
}

/** Serialised size of an aggregate's insert bodies (what the size budget applies to). */
export function aggregateRequestBytes(tables: readonly { rows: readonly CloudRow[] }[]): number {
  return tables.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t.rows.map(toWire)), 'utf8'), 0);
}
