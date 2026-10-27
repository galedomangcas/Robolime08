import type {
  RobotStatusResponse,
  RunReadingsResponse,
  RunRecommendationResponse,
  RunsResponse,
} from '@robolime/shared';

import type { GatewayClient, GatewayResult } from './gatewayClient';

/**
 * Explicit data-source adapter (CLAUDE.md §3: "screens do not directly assume
 * Supabase is reachable"). Screens read robot status, runs, readings and
 * recommendations only through this interface, never through a concrete
 * transport.
 *
 * Only the local field adapter exists. A cloud adapter (hosted Supabase, for
 * the Vercel build) is NOT implemented: it needs the online claim flow
 * (OPEN_ITEMS #14), the cloud schema applied to the hosted project (#17, D42)
 * and an approved Supabase client dependency. Until then the online build has
 * no data source, and nothing here contacts the internet.
 */
export type DataSourceKind = 'local-gateway';

export interface FieldDataSource {
  kind: DataSourceKind;
  /** Shown in diagnostics so the user knows where the data comes from. */
  description: string;
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
    robotStatus: (token) => client.robotStatus(token),
    runs: (token) => client.runs(token),
    runReadings: (token, runId) => client.runReadings(token, runId),
    runRecommendation: (token, runId) => client.runRecommendation(token, runId),
  };
}
