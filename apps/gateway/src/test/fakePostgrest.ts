import { CLOUD_PRIMARY_KEYS } from '../sync/cloudContract';
import type { CloudTable } from '../sync/cloudRows';
import type { FetchLike } from '../sync/postgrest';

/**
 * TEST DOUBLE: an in-memory stand-in for Supabase's PostgREST, served through
 * a `fetch`-compatible function (no network, no ports). It is NOT a cloud
 * integration test; it reproduces only the behaviour the sync worker relies
 * on, taken from `supabase/migrations/20261023000000_cloud_mirror_initial.sql`:
 * - POST with `on_conflict=<primary key>` + `resolution=ignore-duplicates`:
 *   all-or-nothing per request; existing primary keys are skipped; another
 *   unique key → 409/23505; a missing parent → 409/23503; returns the newly
 *   inserted rows (201) with a cloud-assigned `cloud_received_at`;
 * - GET `?select=*&<column>=eq.<value>`;
 * - PostgreSQL output formats: timestamptz as `…+00:00`, jsonb with keys
 *   reordered (jsonb does not keep key order);
 * - error bodies `{ code, message }` whose message must never be surfaced.
 * Faults can be injected per request to simulate outages and lost responses.
 */

type Row = Record<string, unknown>;

const UNIQUE_KEYS: Partial<Record<CloudTable, string[][]>> = {
  robots: [['source_robot_id']],
  fields: [['robot_id', 'field_key']],
  runs: [['robot_id', 'source_run_id']],
  readings: [['run_id', 'cell_index', 'seq']],
  robot_status_reports: [['robot_id', 'robot_reported_at', 'state', 'cells_completed']],
  rule_sets: [['version']],
  recommendations: [['run_id']],
  recommendation_scores: [['recommendation_id', 'shortlist_rank']],
};

const FOREIGN_KEYS: Partial<Record<CloudTable, { columns: string[]; table: CloudTable; refs: string[] }[]>> = {
  fields: [{ columns: ['robot_id'], table: 'robots', refs: ['id'] }],
  field_cells: [{ columns: ['field_id', 'robot_id'], table: 'fields', refs: ['id', 'robot_id'] }],
  runs: [{ columns: ['robot_id'], table: 'robots', refs: ['id'] }],
  readings: [{ columns: ['run_id', 'robot_id'], table: 'runs', refs: ['id', 'robot_id'] }],
  robot_status_reports: [{ columns: ['robot_id'], table: 'robots', refs: ['id'] }],
  rule_crops: [{ columns: ['rule_set_id'], table: 'rule_sets', refs: ['id'] }],
  rule_suitability_ranges: [{ columns: ['rule_set_id', 'crop_key'], table: 'rule_crops', refs: ['rule_set_id', 'crop_key'] }],
  rule_seasons: [{ columns: ['rule_set_id'], table: 'rule_sets', refs: ['id'] }],
  rule_seasonal_weather_defaults: [{ columns: ['rule_set_id', 'season_key'], table: 'rule_seasons', refs: ['rule_set_id', 'season_key'] }],
  recommendations: [
    { columns: ['run_id', 'robot_id'], table: 'runs', refs: ['id', 'robot_id'] },
    { columns: ['rule_set_id'], table: 'rule_sets', refs: ['id'] },
  ],
  recommendation_scores: [
    { columns: ['recommendation_id', 'robot_id'], table: 'recommendations', refs: ['id', 'robot_id'] },
    { columns: ['rule_set_id', 'crop_key'], table: 'rule_crops', refs: ['rule_set_id', 'crop_key'] },
  ],
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** What a fault does to one request. */
export type Fault =
  | 'refuse' // connection refused: nothing sent
  | 'timeout' // no response; the request did NOT reach the database
  | 'commit_then_timeout' // the database committed, but the response was lost
  | { status: number; code?: string; message?: string };

export interface RecordedRequest {
  method: string;
  table: string;
  query: string;
  headers: Record<string, string>;
}

export class FakePostgrest {
  readonly tables = new Map<CloudTable, Row[]>();
  readonly requests: RecordedRequest[] = [];
  /** Called for each request; return a fault to inject it. */
  fault: (request: RecordedRequest) => Fault | undefined = () => undefined;
  private tick = 0;
  /** Emulates PostgREST's db-max-rows cap on reads (Supabase default 1000). */
  maxRows = Number.POSITIVE_INFINITY;

  constructor(private readonly expectedKey: string) {}

  rows(table: CloudTable): Row[] {
    return this.tables.get(table) ?? [];
  }

  count(table: CloudTable): number {
    return this.rows(table).length;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace(/^\/rest\/v1\//, '') as CloudTable;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request: RecordedRequest = { method: init.method ?? 'GET', table, query: parsed.search, headers };
    this.requests.push(request);
    const fault = this.fault(request);
    if (fault === 'refuse') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (fault === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (fault !== undefined && fault !== 'commit_then_timeout') {
      return json(fault.status, { code: fault.code, message: fault.message ?? 'server says: secret detail' });
    }
    if (headers.apikey !== this.expectedKey || headers.authorization !== `Bearer ${this.expectedKey}`) {
      return json(401, { code: 'PGRST301', message: 'JWT invalid' });
    }
    if (!(table in CLOUD_PRIMARY_KEYS)) return json(404, { code: 'PGRST205', message: 'no such table' });

    let response: Response;
    if (request.method === 'POST') response = this.insert(table, parsed, headers, String(init.body));
    else if (request.method === 'GET') response = this.select(table, parsed, headers.prefer === 'count=exact');
    else response = json(405, { code: 'PGRST117', message: 'method' });
    if (fault === 'commit_then_timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    return response;
  };

  private insert(table: CloudTable, url: URL, headers: Record<string, string>, body: string): Response {
    const pk = CLOUD_PRIMARY_KEYS[table] as readonly string[];
    if (url.searchParams.get('on_conflict') !== pk.join(',') || !headers.prefer?.includes('resolution=ignore-duplicates')) {
      return json(400, { code: 'PGRST100', message: 'unsupported request for this fake' });
    }
    const incoming = JSON.parse(body) as Row[];
    const existing = this.rows(table);
    const staged = [...existing];
    const inserted: Row[] = [];
    for (const raw of incoming) {
      if (staged.some((r) => sameKey(r, raw, pk))) continue; // ignore-duplicates on the primary key only
      for (const unique of UNIQUE_KEYS[table] ?? []) {
        if (staged.some((r) => sameKey(r, raw, unique))) return json(409, { code: '23505', message: `duplicate key ${JSON.stringify(raw)}` });
      }
      for (const fk of FOREIGN_KEYS[table] ?? []) {
        if (fk.columns.some((c) => raw[c] === null || raw[c] === undefined)) continue;
        const parent = this.rows(fk.table).some((p) => fk.refs.every((ref, i) => same(p[ref], raw[fk.columns[i] ?? ''])));
        if (!parent) return json(409, { code: '23503', message: 'violates foreign key' });
      }
      const row = this.toStored(raw);
      staged.push(row);
      inserted.push(row);
    }
    this.tables.set(table, staged); // all-or-nothing: only reached when every row was accepted
    return json(201, inserted);
  }

  private select(table: CloudTable, url: URL, exactCount: boolean): Response {
    const filters = [...url.searchParams.entries()].filter(([k]) => k !== 'select');
    const rows = this.rows(table).filter((row) =>
      filters.every(([column, condition]) => condition.startsWith('eq.') && same(row[column], condition.slice(3))),
    );
    const page = rows.slice(0, this.maxRows);
    const range = page.length === 0 ? '*' : `0-${page.length - 1}`;
    // Like PostgREST: 206 Partial Content when an exact count shows the cap cut the result short.
    const status = exactCount && page.length < rows.length ? 206 : 200;
    return json(status, page, { 'content-range': `${range}/${exactCount ? rows.length : '*'}` });
  }

  private toStored(raw: Row): Row {
    const out: Row = {};
    for (const [column, value] of Object.entries(raw)) {
      if (typeof value === 'string' && TIMESTAMP.test(value)) out[column] = value.replace('Z', '+00:00');
      else if (typeof value === 'object' && value !== null) out[column] = reorder(value);
      else out[column] = value;
    }
    this.tick += 1;
    out.cloud_received_at = new Date(Date.UTC(2026, 2, 2, 0, 0, this.tick)).toISOString().replace('Z', '+00:00');
    return out;
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    if (ISO_INSTANT.test(a) && ISO_INSTANT.test(b)) return Date.parse(a) === Date.parse(b); // timestamptz equality
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  return a === b;
}

function sameKey(a: Row, b: Row, columns: readonly string[]): boolean {
  return columns.every((c) => a[c] !== null && a[c] !== undefined && same(a[c], b[c]));
}

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)]));
  }
  return value;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
}

/** Clearly fake key for tests; never a real credential. */
export const TEST_ONLY_SERVICE_KEY = 'TEST-ONLY-NOT-A-REAL-SERVICE-ROLE-KEY';
