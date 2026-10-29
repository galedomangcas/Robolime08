import {
  MANUAL_AUTO_STOP_MS,
  MANUAL_RELAY_STALE_SECONDS,
  ROBOT_COMPONENTS,
  ROBOT_STATE_BY_CODE,
  STALE_THRESHOLD_SECONDS,
  decodeErrorFlags,
  manualControlLine,
  parseManualControlLine,
  type CellReading,
  type CropScore,
  type FieldResponse,
  type ManualBridgeState,
  type ManualCommandOutcome,
  type ManualCommandResult,
  type ManualControlCommand,
  type ManualStatusResponse,
  type RobotState,
  type RobotStatus,
  type RobotStatusResponse,
  type RobotSummary,
  type RunReadingsResponse,
  type RunRecommendationResponse,
  type RunSummary,
} from '@robolime/shared';

import type { CloudConfig } from '../config/cloudConfig';
import { REQUEST_TIMEOUT_MS } from '../config/timing';
import type { FetchLike } from './gatewayClient';
import {
  isFieldResponse,
  isIsoDateTime,
  isReadingsForRun,
  isRecommendationForRun,
  isRobotStatus,
  isRunReadingsResponse,
  isRunRecommendationResponse,
  isRunSummary,
} from './responseValidation';

/**
 * Read client for the hosted cloud mirror (D49, D52), over Supabase's
 * PostgREST API with plain `fetch` (no new dependency). Used by the online
 * (Vercel) build through the cloud data source.
 *
 * Rules:
 * - Reads are GET only: the cloud mirror is written by the gateway's service
 *   role, never by the app. The POSTs are RPCs: `claim_robot(code)`, a
 *   server-side check of a claim code (D52; the client never names a robot to
 *   claim), and the manual-control RPCs (D58), which queue a command for the
 *   field gateway to relay to the robot. The app never writes a table directly.
 * - A signed-in user's access token is required. Without one, no request is
 *   made (`auth-required`); the public key alone is never used as a bearer.
 * - Row Level Security decides visibility: a robot that is not claimed simply
 *   returns no rows. That is reported as "no data", never as an error and
 *   never as a successful claim.
 * - Every row is validated before use; anything malformed is
 *   `invalid-response`. Never throws.
 */

export type CloudFailure =
  | { kind: 'not-configured' }
  | { kind: 'auth-required' }
  | { kind: 'forbidden' }
  | { kind: 'timeout' }
  | { kind: 'unreachable' }
  | { kind: 'http'; status: number }
  | { kind: 'invalid-response' };

export type CloudResult<T> = { ok: true; data: T } | { ok: false; failure: CloudFailure };

/** Supplies the signed-in user's access token, or null (cloudAuth.ts: anonymous Supabase sign-in, D52). */
export interface CloudSessionProvider {
  accessToken(): Promise<string | null>;
}

export type ClaimOutcome = { kind: 'claimed'; robot: RobotSummary } | { kind: 'invalid-code' } | { kind: 'rate-limited' };

export interface CloudReader {
  /** Robots this user currently holds a claim for (RLS: own, unrevoked claims only). */
  claimedRobotIds(): Promise<CloudResult<string[]>>;
  /** The claimed robots' summaries (RLS hides every other robot). */
  claimedRobots(): Promise<CloudResult<RobotSummary[]>>;
  /** Asks the server to verify a claim code and, if valid, grant this user a claim. */
  claimRobot(code: string): Promise<CloudResult<ClaimOutcome>>;
  /** Latest status report for one claimed robot; `status: null` if none is visible. */
  robotStatus(robotId: string): Promise<CloudResult<RobotStatusResponse>>;
  /** Dosing runs only (verification runs are research data), newest first. */
  runs(robotId: string): Promise<CloudResult<RunSummary[]>>;
  /** One dosing run's readings; `null` if the run is not visible or is not a dosing run. */
  runReadings(robotId: string, runId: string): Promise<CloudResult<RunReadingsResponse | null>>;
  /** The stored recommendation of one dosing run; `null` if none is stored. */
  runRecommendation(robotId: string, runId: string): Promise<CloudResult<RunRecommendationResponse | null>>;
  /** The robot's active field and its cells; `null` if none is synchronised (D54). */
  field(robotId: string): Promise<CloudResult<FieldResponse | null>>;
  /** Online manual control (D58): whether the field gateway relay is live, and recent commands. */
  manualStatus(robotId: string): Promise<CloudResult<ManualStatusResponse>>;
  /**
   * Online manual control (D58): queues one command and waits for the gateway's
   * verdict. `http` 429 when rate-limited; `timeout` if no verdict arrives.
   */
  manualCommand(robotId: string, command: ManualControlCommand): Promise<CloudResult<ManualCommandResult>>;
}

/** How often, and for how long, `manualCommand` re-reads the queued command (10 s pick-up + bridge retries). */
const MANUAL_RESULT_POLL_MS = 500;
const MANUAL_RESULT_WAIT_MS = 20_000;
const FINAL_MANUAL_STATUSES: ReadonlySet<unknown> = new Set(['acknowledged', 'rejected', 'no-ack', 'superseded', 'expired', 'unavailable']);
const BRIDGE_STATES: ReadonlySet<unknown> = new Set(['not-configured', 'connecting', 'connected', 'disconnected']);

function ago(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** Relay heartbeat row (or none) → the bridge part of the status, judged by the server-computed age. */
export function relayBridge(row: unknown): ManualStatusResponse['bridge'] | null {
  if (row === undefined) {
    return {
      state: 'not-configured',
      port: null,
      detail: 'The field gateway has not connected to the cloud yet. It needs internet, the LoRa bridge and its Supabase settings.',
    };
  }
  if (!isObject(row) || !BRIDGE_STATES.has(row.bridge_state) || !isFiniteNumber(row.seen_seconds_ago)) return null;
  if (row.seen_seconds_ago > MANUAL_RELAY_STALE_SECONDS) {
    return {
      state: 'disconnected',
      port: null,
      detail: `The field gateway was last online ${ago(row.seen_seconds_ago)} ago. It needs internet to relay commands to the robot.`,
    };
  }
  const state = row.bridge_state as ManualBridgeState;
  return {
    state,
    port: null,
    detail: state === 'connected' ? null : 'The field gateway is online, but its LoRa bridge is not connected over USB.',
  };
}

/** One finished `manual_commands` row → a command result; null while pending/sent or if malformed. */
export function manualResultFromRow(row: unknown): ManualCommandResult | null {
  if (!isObject(row) || typeof row.line !== 'string' || !FINAL_MANUAL_STATUSES.has(row.status)) return null;
  const command = parseManualControlLine(row.line);
  if (command === null || !isIsoDateTime(row.requested_at) || !isIsoDateTime(row.finished_at)) return null;
  return { command, line: row.line, outcome: row.status as ManualCommandOutcome, sentAt: row.requested_at, finishedAt: row.finished_at };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ROBOT_STATES: ReadonlySet<unknown> = new Set(Object.values(ROBOT_STATE_BY_CODE));
const INVALID = { ok: false, failure: { kind: 'invalid-response' } } as const;

/** Maps one `robot_status_reports` row (cloud schema 20261023000000) to the app contract, or null if malformed. */
export function statusFromCloudRow(row: unknown): RobotStatus | null {
  if (!isObject(row)) return null;
  if (
    typeof row.robot_id !== 'string' ||
    !ROBOT_STATES.has(row.state) ||
    !Number.isInteger(row.error_flags) ||
    (row.error_flags as number) < 0 ||
    (row.error_flags as number) > 255 ||
    !isFiniteNumber(row.battery_voltage) ||
    !isFiniteNumber(row.total_lime_commanded_ml) ||
    !isFiniteNumber(row.cells_completed) ||
    !isFiniteNumber(row.total_cells) ||
    !isIsoDateTime(row.robot_reported_at) ||
    !isIsoDateTime(row.gateway_received_at) ||
    !isIsoDateTime(row.cloud_received_at)
  ) {
    return null;
  }
  const status: RobotStatus = {
    robotId: row.robot_id,
    state: row.state as RobotState,
    errorFlags: decodeErrorFlags(row.error_flags as number),
    // Component bit positions are not specified (OPEN_ITEMS #9): never guessed.
    componentChecks: Object.fromEntries(ROBOT_COMPONENTS.map((c) => [c, 'unknown'])) as RobotStatus['componentChecks'],
    batteryVoltage: row.battery_voltage,
    totalLimeCommandedMl: row.total_lime_commanded_ml,
    cellsCompleted: row.cells_completed,
    totalCells: row.total_cells,
    timestamps: {
      robotAt: row.robot_reported_at,
      gatewayReceivedAt: row.gateway_received_at,
      cloudSyncedAt: row.cloud_received_at,
    },
  };
  return isRobotStatus(status) ? status : null;
}

interface RunRow {
  id: string;
  source_run_id: string;
  field_id: string | null;
  is_synthetic: boolean;
}
const isRunRow = (v: unknown): v is RunRow =>
  isObject(v) &&
  typeof v.id === 'string' &&
  UUID.test(v.id) &&
  typeof v.source_run_id === 'string' &&
  (v.field_id === null || typeof v.field_id === 'string') &&
  typeof v.is_synthetic === 'boolean';

/** A dosing-run summary from the run row and its readings' robot-side times. */
function runSummary(run: RunRow, recordedAt: readonly string[]): RunSummary {
  const sorted = [...recordedAt].sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    id: run.id,
    sourceRunId: run.source_run_id,
    runType: 'dosing',
    fieldId: run.field_id,
    readingCount: recordedAt.length,
    firstRobotRecordedAt: sorted[0] ?? null,
    lastRobotRecordedAt: sorted[sorted.length - 1] ?? null,
    isSynthetic: run.is_synthetic,
  };
}

/** Maps one `readings` row to the app contract; the result is checked by isRunReadingsResponse. */
function readingFromCloudRow(row: Json): CellReading {
  const { gps_latitude: lat, gps_longitude: lon } = row;
  return {
    runId: row.run_id as string,
    runType: 'dosing',
    cellIndex: row.cell_index as number,
    seq: row.seq as number,
    attemptCount: row.attempt_count as number,
    ph: row.ph as number,
    ec: row.ec as number,
    moisturePercent: row.moisture_percent as number,
    temperatureC: row.temperature_c as number,
    doseVolumeMl: row.dose_volume_ml as number,
    expectedPostCorrectionPh: (row.expected_post_correction_ph ?? null) as number | null,
    gps: isFiniteNumber(lat) && isFiniteNumber(lon) ? { latitude: lat, longitude: lon } : null,
    rawFlags: row.raw_flags as number,
    timestamps: {
      robotAt: row.robot_recorded_at as string,
      gatewayReceivedAt: row.gateway_received_at as string,
      cloudSyncedAt: row.cloud_received_at as string,
    },
  };
}

const STATUS_COLUMNS =
  'robot_id,state,error_flags,battery_voltage,total_lime_commanded_ml,cells_completed,total_cells,robot_reported_at,gateway_received_at,cloud_received_at';
const RUN_COLUMNS = 'id,source_run_id,field_id,is_synthetic';
const READING_COLUMNS =
  'run_id,cell_index,seq,attempt_count,ph,ec,moisture_percent,temperature_c,dose_volume_ml,expected_post_correction_ph,gps_latitude,gps_longitude,raw_flags,robot_recorded_at,gateway_received_at,cloud_received_at';
/** Supabase's default PostgREST row cap per request; larger sets are paged. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

export function createCloudReader(options: {
  config: CloudConfig;
  session: CloudSessionProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Tests only: replaces the wait between manual-command result checks. */
  sleep?: (ms: number) => Promise<void>;
}): CloudReader {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** GET, or POST with a JSON body (the claim and manual-control RPCs). */
  async function request(pathAndQuery: string, body?: unknown): Promise<CloudResult<unknown[]>> {
    const { config } = options;
    if (!config.ok) return { ok: false, failure: { kind: 'not-configured' } };
    let token: string | null;
    try {
      token = await options.session.accessToken();
    } catch {
      token = null;
    }
    if (token === null || token === '') return { ok: false, failure: { kind: 'auth-required' } };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const headers: Record<string, string> = { apikey: config.publicKey, Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await doFetch(`${config.url}/rest/v1/${pathAndQuery}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 401) return { ok: false, failure: { kind: 'auth-required' } };
      if (res.status === 403) return { ok: false, failure: { kind: 'forbidden' } };
      if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status } };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return INVALID;
      }
      return Array.isArray(json) ? { ok: true, data: json } : INVALID;
    } catch {
      // Error details are not kept: they can contain the URL.
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }
  const get = (pathAndQuery: string) => request(pathAndQuery);

  /** Every page of an ORDERED query, up to MAX_PAGES * PAGE_SIZE rows. */
  async function getAll(pathAndQuery: string): Promise<CloudResult<unknown[]>> {
    const rows: unknown[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await get(`${pathAndQuery}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
      if (!result.ok) return result;
      rows.push(...result.data);
      if (result.data.length < PAGE_SIZE) return { ok: true, data: rows };
    }
    return INVALID;
  }

  /** The run row if it is a visible DOSING run of this robot, else null. */
  async function dosingRun(robotId: string, runId: string): Promise<CloudResult<RunRow | null>> {
    const result = await get(`runs?select=${RUN_COLUMNS}&id=eq.${runId}&robot_id=eq.${robotId}&run_type=eq.dosing`);
    if (!result.ok) return result;
    if (result.data.length === 0) return { ok: true, data: null };
    const row = result.data[0];
    return isRunRow(row) ? { ok: true, data: row } : INVALID;
  }

  return {
    async claimedRobotIds() {
      const result = await get('robot_claims?select=robot_id&revoked_at=is.null');
      if (!result.ok) return result;
      const ids = result.data.map((row) => (isObject(row) && typeof row.robot_id === 'string' && UUID.test(row.robot_id) ? row.robot_id : null));
      if (ids.some((id) => id === null)) return INVALID;
      return { ok: true, data: [...new Set(ids as string[])] };
    },

    async claimedRobots() {
      const result = await get('robots?select=id,display_name,is_synthetic&order=display_name.asc,id.asc');
      if (!result.ok) return result;
      const robots: RobotSummary[] = [];
      for (const row of result.data) {
        if (!isObject(row) || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.display_name !== 'string' || typeof row.is_synthetic !== 'boolean') {
          return INVALID;
        }
        robots.push({ id: row.id, displayName: row.display_name, isSynthetic: row.is_synthetic });
      }
      return { ok: true, data: robots };
    },

    async claimRobot(code) {
      const result = await request('rpc/claim_robot', { p_code: code });
      if (!result.ok) return result;
      const row = result.data[0];
      if (result.data.length !== 1 || !isObject(row)) return INVALID;
      if (row.result === 'invalid-code') return { ok: true, data: { kind: 'invalid-code' } };
      if (row.result === 'rate-limited') return { ok: true, data: { kind: 'rate-limited' } };
      if (
        row.result === 'claimed' &&
        typeof row.robot_id === 'string' &&
        UUID.test(row.robot_id) &&
        typeof row.display_name === 'string' &&
        typeof row.is_synthetic === 'boolean'
      ) {
        return { ok: true, data: { kind: 'claimed', robot: { id: row.robot_id, displayName: row.display_name, isSynthetic: row.is_synthetic } } };
      }
      return INVALID;
    },

    async robotStatus(robotId) {
      // Only a well-formed UUID is ever placed into the query string.
      if (!UUID.test(robotId)) return INVALID;
      const result = await get(
        `robot_status_reports?select=${STATUS_COLUMNS}&robot_id=eq.${robotId}&order=robot_reported_at.desc&limit=1`,
      );
      if (!result.ok) return result;
      if (result.data.length === 0) return { ok: true, data: { status: null, staleThresholdSeconds: STALE_THRESHOLD_SECONDS } };
      const status = statusFromCloudRow(result.data[0]);
      if (status === null || status.robotId !== robotId) return INVALID;
      return { ok: true, data: { status, staleThresholdSeconds: STALE_THRESHOLD_SECONDS } };
    },

    async runs(robotId) {
      if (!UUID.test(robotId)) return INVALID;
      const runs = await getAll(`runs?select=${RUN_COLUMNS}&robot_id=eq.${robotId}&run_type=eq.dosing&order=id.asc`);
      if (!runs.ok) return runs;
      const runRows: RunRow[] = [];
      for (const row of runs.data) {
        if (!isRunRow(row)) return INVALID;
        runRows.push(row);
      }
      if (runRows.length === 0) return { ok: true, data: [] };
      const times = await getAll(
        `readings?select=run_id,robot_recorded_at&robot_id=eq.${robotId}&run_id=in.(${runRows.map((r) => r.id).join(',')})&order=id.asc`,
      );
      if (!times.ok) return times;
      const byRun = new Map<string, string[]>(runRows.map((r) => [r.id, []]));
      for (const row of times.data) {
        if (!isObject(row) || typeof row.run_id !== 'string' || !isIsoDateTime(row.robot_recorded_at)) return INVALID;
        byRun.get(row.run_id)?.push(row.robot_recorded_at);
      }
      const summaries = runRows.map((r) => runSummary(r, byRun.get(r.id) ?? []));
      if (!summaries.every(isRunSummary)) return INVALID;
      // Newest first by robot-side time, like the gateway's run list.
      summaries.sort(
        (a, b) => Date.parse(b.firstRobotRecordedAt ?? '1970-01-01T00:00:00Z') - Date.parse(a.firstRobotRecordedAt ?? '1970-01-01T00:00:00Z') || a.id.localeCompare(b.id),
      );
      return { ok: true, data: summaries };
    },

    async runReadings(robotId, runId) {
      if (!UUID.test(robotId) || !UUID.test(runId)) return INVALID;
      const run = await dosingRun(robotId, runId);
      if (!run.ok) return run;
      if (run.data === null) return { ok: true, data: null };
      const rows = await getAll(`readings?select=${READING_COLUMNS}&run_id=eq.${runId}&robot_id=eq.${robotId}&order=cell_index.asc,seq.asc`);
      if (!rows.ok) return rows;
      const readings: CellReading[] = [];
      for (const row of rows.data) {
        if (!isObject(row)) return INVALID;
        readings.push(readingFromCloudRow(row));
      }
      const response: RunReadingsResponse = { run: runSummary(run.data, readings.map((r) => r.timestamps.robotAt)), readings };
      return isRunReadingsResponse(response) && isReadingsForRun(response, runId) ? { ok: true, data: response } : INVALID;
    },

    async runRecommendation(robotId, runId) {
      if (!UUID.test(robotId) || !UUID.test(runId)) return INVALID;
      const run = await dosingRun(robotId, runId);
      if (!run.ok) return run;
      if (run.data === null) return { ok: true, data: null };
      const recs = await get(
        `recommendations?select=id,run_id,inputs,computed_at,rule_sets(version,status,is_synthetic)&run_id=eq.${runId}&robot_id=eq.${robotId}`,
      );
      if (!recs.ok) return recs;
      if (recs.data.length === 0) return { ok: true, data: null };
      const rec = recs.data[0];
      if (!isObject(rec) || typeof rec.id !== 'string' || !UUID.test(rec.id) || !isObject(rec.rule_sets)) return INVALID;
      const scores = await getAll(
        `recommendation_scores?select=crop_key,score,shortlist_rank,reasons,rule_crops(display_name,category)&recommendation_id=eq.${rec.id}&order=score.desc,crop_key.asc`,
      );
      if (!scores.ok) return scores;
      const ranked: { rank: number | null; score: CropScore }[] = [];
      for (const row of scores.data) {
        if (!isObject(row) || !isObject(row.rule_crops)) return INVALID;
        ranked.push({
          rank: typeof row.shortlist_rank === 'number' ? row.shortlist_rank : null,
          score: {
            cropId: row.crop_key as string,
            cropName: row.rule_crops.display_name as string,
            category: row.rule_crops.category as string,
            score: row.score as number,
            reasons: row.reasons as string[],
          },
        });
      }
      const ruleSet = rec.rule_sets;
      const response: unknown = {
        recommendation: {
          id: rec.id,
          runId: rec.run_id,
          ruleSetVersion: ruleSet.version,
          inputs: rec.inputs,
          allScores: ranked.map((s) => s.score),
          shortlist: ranked
            .filter((s) => s.rank !== null)
            .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
            .map((s) => s.score),
          computedAt: rec.computed_at,
        },
        ruleSetStatus: ruleSet.status,
        isSynthetic: ruleSet.is_synthetic,
      };
      return isRunRecommendationResponse(response) && isRecommendationForRun(response, runId) ? { ok: true, data: response } : INVALID;
    },

    async field(robotId) {
      if (!UUID.test(robotId)) return INVALID;
      const fields = await get(`fields?select=id,name,location_label,area_m2,cell_size_m,total_cells,is_synthetic&robot_id=eq.${robotId}&is_active=is.true&limit=1`);
      if (!fields.ok) return fields;
      const f = fields.data[0];
      if (f === undefined) return { ok: true, data: null };
      if (!isObject(f) || typeof f.id !== 'string' || !UUID.test(f.id)) return INVALID;
      const cells = await getAll(`field_cells?select=cell_index,grid_row,grid_column,center_latitude,center_longitude&field_id=eq.${f.id}&order=cell_index.asc`);
      if (!cells.ok) return cells;
      const response: unknown = {
        field: {
          id: f.id, name: f.name, locationLabel: f.location_label, areaSquareMeters: f.area_m2 ?? null,
          cellSizeMeters: f.cell_size_m, totalCells: f.total_cells ?? null, isSynthetic: f.is_synthetic,
        },
        cells: cells.data.map((c) => {
          const row = isObject(c) ? c : {};
          const lat = row.center_latitude;
          const lon = row.center_longitude;
          return {
            cellIndex: row.cell_index, gridRow: row.grid_row ?? null, gridColumn: row.grid_column ?? null,
            center: isFiniteNumber(lat) && isFiniteNumber(lon) ? { latitude: lat, longitude: lon } : null,
          };
        }),
      };
      return isFieldResponse(response) ? { ok: true, data: response } : INVALID;
    },

    async manualStatus(robotId) {
      if (!UUID.test(robotId)) return INVALID;
      const relay = await request('rpc/manual_relay_status', { p_robot_id: robotId });
      if (!relay.ok) return relay;
      const bridge = relayBridge(relay.data[0]);
      if (bridge === null) return INVALID;
      const recent = await get(`manual_commands?select=line,status,requested_at,finished_at&robot_id=eq.${robotId}&order=seq.desc&limit=20`);
      if (!recent.ok) return recent;
      const recentCommands: ManualCommandResult[] = [];
      for (const row of recent.data) {
        if (!isObject(row)) return INVALID;
        const result = manualResultFromRow(row);
        if (result !== null) recentCommands.push(result);
      }
      return { ok: true, data: { bridge, autoStopMs: MANUAL_AUTO_STOP_MS, recentCommands, bridgeLog: [] } };
    },

    async manualCommand(robotId, command) {
      if (!UUID.test(robotId)) return INVALID;
      const queued = await request('rpc/request_manual_command', { p_robot_id: robotId, p_line: manualControlLine(command) });
      if (!queued.ok) return queued;
      const row = queued.data[0];
      if (!isObject(row)) return INVALID;
      if (row.result === 'rate-limited') return { ok: false, failure: { kind: 'http', status: 429 } };
      if (row.result !== 'queued' || typeof row.id !== 'string' || !UUID.test(row.id)) return INVALID;
      const deadline = Date.now() + MANUAL_RESULT_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(MANUAL_RESULT_POLL_MS);
        const current = await get(`manual_commands?select=line,status,requested_at,finished_at&id=eq.${row.id}`);
        if (!current.ok) continue;
        const result = manualResultFromRow(current.data[0]);
        if (result !== null) return { ok: true, data: result };
      }
      return { ok: false, failure: { kind: 'timeout' } };
    },
  };
}
