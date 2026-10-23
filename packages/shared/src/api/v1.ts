/**
 * Local gateway HTTP API, version 1 — typed contract shared by the app and the
 * laptop gateway. This API is READ-ONLY with respect to the robot: it exposes
 * no start/stop, dosing, navigation, or settings downlink. The only writes are
 * pairing (creates a local session) and recording a field-selection intent.
 *
 * Every route except POST pairing requires `Authorization: Bearer <token>`
 * and only returns data for the robot claimed by that session.
 */
import type { Field, FieldCell, FieldSelection } from '../domain/field';
import type { CellReading } from '../domain/reading';
import type { CropRecommendation } from '../domain/recommendation';
import type { RobotStatus } from '../domain/robot';
import type { IsoDateTime } from '../domain/time';

export const API_V1_BASE_PATH = '/api/v1';

export const API_V1_ROUTES = {
  pairing: `${API_V1_BASE_PATH}/pairing`,
  session: `${API_V1_BASE_PATH}/session`,
  robotStatus: `${API_V1_BASE_PATH}/robot/status`,
  field: `${API_V1_BASE_PATH}/field`,
  fieldSelections: `${API_V1_BASE_PATH}/field-selections`,
  runs: `${API_V1_BASE_PATH}/runs`,
  runReadings: (runId: string) =>
    `${API_V1_BASE_PATH}/runs/${encodeURIComponent(runId)}/readings`,
  runRecommendation: (runId: string) =>
    `${API_V1_BASE_PATH}/runs/${encodeURIComponent(runId)}/recommendation`,
} as const;

export type ApiErrorCode =
  /** No session token was sent: the device has not paired. */
  | 'UNPAIRED'
  /** Token is malformed or unknown to this gateway. */
  | 'INVALID_SESSION'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  /** The gateway has no active pairing credential; the operator must provision one. */
  | 'NO_PAIRING_PROVISIONED'
  | 'INVALID_PAIRING_CODE'
  /** Too many failed pairing attempts from this client address; retry later (HTTP 429, `Retry-After`). */
  | 'PAIRING_RATE_LIMITED'
  /** The resource does not exist for the robot claimed by this session. */
  | 'NOT_FOUND'
  | 'NO_ACTIVE_FIELD'
  | 'BAD_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  /** Request body exceeds the gateway's JSON size limit (HTTP transport). */
  | 'PAYLOAD_TOO_LARGE'
  /** POST body is not declared as `application/json` (HTTP transport). */
  | 'UNSUPPORTED_MEDIA_TYPE'
  /** Unexpected gateway failure; details are logged on the gateway only, never returned. */
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export interface RobotSummary {
  id: string;
  displayName: string;
  isSynthetic: boolean;
}

export interface PairingRequest {
  pairingCode: string;
}

export interface PairingResponse {
  sessionToken: string;
  robot: RobotSummary;
  expiresAt: IsoDateTime;
}

export interface SessionResponse {
  robot: RobotSummary;
  expiresAt: IsoDateTime;
}

export interface RobotStatusResponse {
  /** Latest status by robot-side time; null if the robot has never reported. */
  status: RobotStatus | null;
  staleThresholdSeconds: number;
}

export interface FieldResponse {
  field: Field;
  cells: FieldCell[];
}

export interface FieldSelectionRequest {
  fieldId: string;
}

export interface FieldSelectionResponse {
  selection: FieldSelection;
}

/** Farmer-facing run summary. Verification runs are never listed here. */
export interface RunSummary {
  id: string;
  /** Run identifier as reported by the firmware (format pending packet spec). */
  sourceRunId: string;
  runType: 'dosing';
  fieldId: string | null;
  readingCount: number;
  firstRobotRecordedAt: IsoDateTime | null;
  lastRobotRecordedAt: IsoDateTime | null;
  isSynthetic: boolean;
}

export interface RunsResponse {
  runs: RunSummary[];
}

export interface RunReadingsResponse {
  run: RunSummary;
  readings: CellReading[];
}

export interface RunRecommendationResponse {
  recommendation: CropRecommendation;
  ruleSetStatus: 'draft' | 'approved' | 'retired';
  /** True when built from synthetic fixtures; must never be shown as a verified recommendation. */
  isSynthetic: boolean;
}
