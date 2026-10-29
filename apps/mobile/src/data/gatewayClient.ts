import {
  API_V1_ROUTES,
  type ApiErrorCode,
  type ExportCsvRequest,
  type ExportCsvResponse,
  type ExportRunsResponse,
  type FieldResponse,
  type FieldSelectionResponse,
  type ManualCommandResponse,
  type ManualControlCommand,
  type ManualStatusResponse,
  type PairingResponse,
  type RobotStatusResponse,
  type RunReadingsResponse,
  type RunRecommendationResponse,
  type RunsResponse,
  type SessionResponse,
} from '@robolime/shared';

import { REQUEST_TIMEOUT_MS } from '../config/timing';
import {
  isExportCsvResponse,
  isExportRunsResponse,
  isFieldResponse,
  isFieldSelectionResponse,
  isManualCommandResult,
  isManualStatusResponse,
  isPairingResponse,
  isReadingsForRun,
  isRecommendationForRun,
  isRobotStatusResponse,
  isRunReadingsResponse,
  isRunRecommendationResponse,
  isRunsResponse,
  isSessionResponse,
} from './responseValidation';

/**
 * Typed client for the laptop gateway's local API (pairing, session, robot
 * status, and the read-only run/readings/recommendation routes). Every call
 * resolves — it never throws — so screens can always show an honest state
 * instead of hanging.
 */

export type GatewayFailure =
  /** Our own timeout fired before the gateway answered. */
  | { kind: 'timeout' }
  /** The request never got an HTTP answer (gateway stopped, wrong address, no network). */
  | { kind: 'unreachable' }
  /** The gateway answered with an error. `code` is null if the body was not the documented shape. */
  | { kind: 'api'; status: number; code: ApiErrorCode | null; retryAfterSeconds: number | null }
  /** A 2xx answer that was not JSON or did not match the API contract (runtime-validated). */
  | { kind: 'invalid-response' };

export type GatewayResult<T> = { ok: true; data: T } | { ok: false; failure: GatewayFailure };

/** Errors meaning the stored session can no longer be used; the device must pair again. */
export const SESSION_INVALID_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'UNPAIRED',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
]);

export function isSessionInvalid(failure: GatewayFailure): boolean {
  return failure.kind === 'api' && failure.code !== null && SESSION_INVALID_CODES.has(failure.code);
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface GatewayClientOptions {
  /** '' = same origin (the web app served by the gateway itself). */
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface GatewayClient {
  pair(pairingCode: string): Promise<GatewayResult<PairingResponse>>;
  session(token: string): Promise<GatewayResult<SessionResponse>>;
  robotStatus(token: string): Promise<GatewayResult<RobotStatusResponse>>;
  /** Dosing runs only; the gateway never lists verification runs. */
  runs(token: string): Promise<GatewayResult<RunsResponse>>;
  runReadings(token: string, runId: string): Promise<GatewayResult<RunReadingsResponse>>;
  /** NOT_FOUND (HTTP 404) when no recommendation has been stored for the run. */
  runRecommendation(token: string, runId: string): Promise<GatewayResult<RunRecommendationResponse>>;
  /** NO_ACTIVE_FIELD (HTTP 404) when no field is provisioned (D54). */
  field(token: string): Promise<GatewayResult<FieldResponse>>;
  /** Records the user's field choice as intent only; the robot never reads it. */
  selectField(token: string, fieldId: string): Promise<GatewayResult<FieldSelectionResponse>>;
  /** Research export area (D54): all runs, including verification runs. */
  exportRuns(token: string): Promise<GatewayResult<ExportRunsResponse>>;
  exportCsv(token: string, request: ExportCsvRequest): Promise<GatewayResult<ExportCsvResponse>>;
  /** Manual control (D57): LoRa bridge connection and recent commands. */
  manualStatus(token: string): Promise<GatewayResult<ManualStatusResponse>>;
  /** Manual control (D57): answers once the robot ACKs or the bridge gives up. MANUAL_BRIDGE_UNAVAILABLE (503) when not connected. */
  manualCommand(token: string, command: ManualControlCommand): Promise<GatewayResult<ManualCommandResponse>>;
}

function errorCodeOf(body: unknown): ApiErrorCode | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? (code as ApiErrorCode) : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    isValid: (json: unknown) => json is T,
    body?: unknown,
  ): Promise<GatewayResult<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const json = parseJson(await res.text());
      if (!res.ok) {
        return {
          ok: false,
          failure: { kind: 'api', status: res.status, code: errorCodeOf(json), retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) },
        };
      }
      // The body is checked against the contract and then dropped if invalid: never logged or kept.
      if (!isValid(json)) return { ok: false, failure: { kind: 'invalid-response' } };
      return { ok: true, data: json };
    } catch {
      // Error details are deliberately not kept: they can contain the URL.
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    pair: (pairingCode) => call<PairingResponse>('POST', API_V1_ROUTES.pairing, null, isPairingResponse, { pairingCode }),
    session: (token) => call<SessionResponse>('GET', API_V1_ROUTES.session, token, isSessionResponse),
    robotStatus: (token) => call<RobotStatusResponse>('GET', API_V1_ROUTES.robotStatus, token, isRobotStatusResponse),
    runs: (token) => call<RunsResponse>('GET', API_V1_ROUTES.runs, token, isRunsResponse),
    // A valid answer for a different run is reported as invalid-response, never shown.
    runReadings: (token, runId) =>
      call<RunReadingsResponse>(
        'GET',
        API_V1_ROUTES.runReadings(runId),
        token,
        (json): json is RunReadingsResponse => isRunReadingsResponse(json) && isReadingsForRun(json, runId),
      ),
    runRecommendation: (token, runId) =>
      call<RunRecommendationResponse>(
        'GET',
        API_V1_ROUTES.runRecommendation(runId),
        token,
        (json): json is RunRecommendationResponse => isRunRecommendationResponse(json) && isRecommendationForRun(json, runId),
      ),
    field: (token) => call<FieldResponse>('GET', API_V1_ROUTES.field, token, isFieldResponse),
    selectField: (token, fieldId) => call<FieldSelectionResponse>('POST', API_V1_ROUTES.fieldSelections, token, isFieldSelectionResponse, { fieldId }),
    exportRuns: (token) => call<ExportRunsResponse>('GET', API_V1_ROUTES.exportRuns, token, isExportRunsResponse),
    exportCsv: (token, request) => call<ExportCsvResponse>('POST', API_V1_ROUTES.exportCsv, token, isExportCsvResponse, request),
    manualStatus: (token) => call<ManualStatusResponse>('GET', API_V1_ROUTES.manualStatus, token, isManualStatusResponse),
    manualCommand: (token, command) =>
      call<ManualCommandResponse>('POST', API_V1_ROUTES.manualCommands, token, isManualCommandResult, { command }),
  };
}
