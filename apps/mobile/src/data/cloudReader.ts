import {
  ROBOT_COMPONENTS,
  ROBOT_STATE_BY_CODE,
  STALE_THRESHOLD_SECONDS,
  decodeErrorFlags,
  type RobotState,
  type RobotStatus,
  type RobotStatusResponse,
} from '@robolime/shared';

import type { CloudConfig } from '../config/cloudConfig';
import { REQUEST_TIMEOUT_MS } from '../config/timing';
import type { FetchLike } from './gatewayClient';
import { isIsoDateTime, isRobotStatus } from './responseValidation';

/**
 * Read-only client for the hosted cloud mirror (D49), over Supabase's
 * PostgREST API with plain `fetch` (no new dependency). It is NOT wired into
 * any screen: the online build keeps showing "not available yet" until the
 * online claim flow (OPEN_ITEMS #14) is decided and the hosted schema is
 * applied (D42).
 *
 * Rules:
 * - GET only: the cloud mirror is written by the gateway's service role, never
 *   by the app; there is no command, claim or write path here.
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

/**
 * Supplies the signed-in user's access token, or null. The implementation
 * (how an online user signs in and receives a robot claim) is the open
 * decision in OPEN_ITEMS #14; none is provided here.
 */
export interface CloudSessionProvider {
  accessToken(): Promise<string | null>;
}

export interface CloudReader {
  /** Robots this user currently holds a claim for (RLS: own, unrevoked claims only). */
  claimedRobotIds(): Promise<CloudResult<string[]>>;
  /** Latest status report for one claimed robot; `status: null` if none is visible. */
  robotStatus(robotId: string): Promise<CloudResult<RobotStatusResponse>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ROBOT_STATES: ReadonlySet<unknown> = new Set(Object.values(ROBOT_STATE_BY_CODE));

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

const STATUS_COLUMNS =
  'robot_id,state,error_flags,battery_voltage,total_lime_commanded_ml,cells_completed,total_cells,robot_reported_at,gateway_received_at,cloud_received_at';

export function createCloudReader(options: {
  config: CloudConfig;
  session: CloudSessionProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
}): CloudReader {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function get(pathAndQuery: string): Promise<CloudResult<unknown[]>> {
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
      const res = await doFetch(`${config.url}/rest/v1/${pathAndQuery}`, {
        method: 'GET',
        headers: { apikey: config.publicKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
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
        return { ok: false, failure: { kind: 'invalid-response' } };
      }
      return Array.isArray(json) ? { ok: true, data: json } : { ok: false, failure: { kind: 'invalid-response' } };
    } catch {
      // Error details are not kept: they can contain the URL.
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async claimedRobotIds() {
      const result = await get('robot_claims?select=robot_id&revoked_at=is.null');
      if (!result.ok) return result;
      const ids = result.data.map((row) => (isObject(row) && typeof row.robot_id === 'string' && UUID.test(row.robot_id) ? row.robot_id : null));
      if (ids.some((id) => id === null)) return { ok: false, failure: { kind: 'invalid-response' } };
      return { ok: true, data: [...new Set(ids as string[])] };
    },

    async robotStatus(robotId) {
      // Only a well-formed UUID is ever placed into the query string.
      if (!UUID.test(robotId)) return { ok: false, failure: { kind: 'invalid-response' } };
      const result = await get(
        `robot_status_reports?select=${STATUS_COLUMNS}&robot_id=eq.${robotId}&order=robot_reported_at.desc&limit=1`,
      );
      if (!result.ok) return result;
      if (result.data.length === 0) return { ok: true, data: { status: null, staleThresholdSeconds: STALE_THRESHOLD_SECONDS } };
      const status = statusFromCloudRow(result.data[0]);
      if (status === null || status.robotId !== robotId) return { ok: false, failure: { kind: 'invalid-response' } };
      return { ok: true, data: { status, staleThresholdSeconds: STALE_THRESHOLD_SECONDS } };
    },
  };
}
