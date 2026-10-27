import type {
  RobotStatusResponse,
  RunReadingsResponse,
  RunRecommendationResponse,
  RunsResponse,
} from '@robolime/shared';

import type { CloudFailure, CloudReader, CloudResult } from './cloudReader';
import type { GatewayClient, GatewayFailure, GatewayResult } from './gatewayClient';

/**
 * Explicit data-source adapter (CLAUDE.md §3: "screens do not directly assume
 * Supabase is reachable"). Screens read robot status, runs, readings and
 * recommendations only through this interface, never through a concrete
 * transport.
 *
 * - `local-gateway`: the field build. The laptop gateway's loopback API and
 *   its SQLite store; works with no internet and never contacts the cloud.
 * - `cloud`: the online (Vercel) build (D52). The hosted Supabase mirror,
 *   read with the signed-in user's own token; RLS limits it to claimed robots.
 */
export type DataSourceKind = 'local-gateway' | 'cloud';

export interface FieldDataSource {
  kind: DataSourceKind;
  /** Shown in diagnostics so the user knows where the data comes from. */
  description: string;
  /** Short name used in connection messages ("Field gateway", "RoboLime cloud"). */
  sourceName: string;
  robotStatus(token: string): Promise<GatewayResult<RobotStatusResponse>>;
  runs(token: string): Promise<GatewayResult<RunsResponse>>;
  runReadings(token: string, runId: string): Promise<GatewayResult<RunReadingsResponse>>;
  runRecommendation(token: string, runId: string): Promise<GatewayResult<RunRecommendationResponse>>;
}

/** Field mode: the laptop gateway's loopback API and its SQLite store. Works with no internet. */
export function createLocalGatewayDataSource(client: GatewayClient): FieldDataSource {
  return {
    kind: 'local-gateway',
    description: 'Field gateway on this laptop (works without internet)',
    sourceName: 'Field gateway',
    robotStatus: (token) => client.robotStatus(token),
    runs: (token) => client.runs(token),
    runReadings: (token, runId) => client.runReadings(token, runId),
    runRecommendation: (token, runId) => client.runRecommendation(token, runId),
  };
}

/**
 * Cloud failures in the screens' vocabulary. A missing/rejected sign-in maps
 * to INVALID_SESSION, so the screens return to the claim step exactly as a
 * rejected local pairing returns to pairing.
 */
export function cloudToGatewayFailure(failure: CloudFailure): GatewayFailure {
  switch (failure.kind) {
    case 'auth-required':
      return { kind: 'api', status: 401, code: 'INVALID_SESSION', retryAfterSeconds: null };
    case 'forbidden':
      return { kind: 'api', status: 403, code: null, retryAfterSeconds: null };
    case 'http':
      return { kind: 'api', status: failure.status, code: null, retryAfterSeconds: null };
    case 'timeout':
    case 'unreachable':
    case 'invalid-response':
      return { kind: failure.kind };
    case 'not-configured':
      return { kind: 'invalid-response' };
  }
}

const NOT_FOUND: GatewayFailure = { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null };

function mapResult<T, U>(result: CloudResult<T>, map: (data: T) => GatewayResult<U>): GatewayResult<U> {
  return result.ok ? map(result.data) : { ok: false, failure: cloudToGatewayFailure(result.failure) };
}

/** Online mode: one claimed robot's synchronised records. The `token` argument is unused (the reader holds the session). */
export function createCloudDataSource(reader: CloudReader, robotId: string): FieldDataSource {
  return {
    kind: 'cloud',
    description: 'RoboLime cloud (records synchronised from the field gateway when it had internet)',
    sourceName: 'RoboLime cloud',
    robotStatus: async () => mapResult(await reader.robotStatus(robotId), (data) => ({ ok: true, data })),
    runs: async () => mapResult(await reader.runs(robotId), (runs) => ({ ok: true, data: { runs } })),
    runReadings: async (_token, runId) =>
      mapResult(await reader.runReadings(robotId, runId), (data) => (data === null ? { ok: false, failure: NOT_FOUND } : { ok: true, data })),
    runRecommendation: async (_token, runId) =>
      mapResult(await reader.runRecommendation(robotId, runId), (data) =>
        data === null ? { ok: false, failure: NOT_FOUND } : { ok: true, data },
      ),
  };
}
