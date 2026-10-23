import {
  API_V1_BASE_PATH,
  API_V1_ROUTES,
  STALE_THRESHOLD_SECONDS,
  type ApiErrorBody,
  type ApiErrorCode,
  type FieldResponse,
  type FieldSelectionResponse,
  type PairingResponse,
  type RobotStatusResponse,
  type RobotSummary,
  type RunReadingsResponse,
  type RunRecommendationResponse,
  type RunsResponse,
  type RunSummary,
  type SessionResponse,
} from '@robolime/shared';
import { randomUUID } from 'node:crypto';

import { bool, num, str, strOrNull, type Database, type Row } from '../db/connection';
import { systemClock, toCanonicalUtc, type Clock } from '../db/time';
import { DEFAULT_SESSION_TTL_DAYS, pairDevice, validateSession } from '../pairing/sessions';
import { getRun, listRunReadings } from '../store/readings';
import { getRecommendationForRun } from '../store/recommendations';
import { getActiveField, getRobot } from '../store/robots';
import { getLatestStatus } from '../store/status';

/**
 * Transport-independent handler for the local read-only API (contract:
 * packages/shared/src/api/v1.ts). Phase 4 wraps this in a LAN-bound HTTP
 * server; the authorization boundary lives here so it is tested directly.
 *
 * There are deliberately no routes that command the robot.
 */
export interface ApiRequest {
  method: string;
  path: string;
  /** Raw `Authorization` header value, if any. */
  authorization?: string | null;
  body?: unknown;
}

export type ApiResponseBody =
  | PairingResponse
  | SessionResponse
  | RobotStatusResponse
  | FieldResponse
  | FieldSelectionResponse
  | RunsResponse
  | RunReadingsResponse
  | RunRecommendationResponse
  | ApiErrorBody;

export interface ApiResponse {
  status: number;
  body: ApiResponseBody;
}

export interface LocalApiOptions {
  db: Database;
  clock?: Clock;
  sessionTtlDays?: number;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNPAIRED: 401,
  INVALID_SESSION: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  NO_PAIRING_PROVISIONED: 503,
  INVALID_PAIRING_CODE: 401,
  NOT_FOUND: 404,
  NO_ACTIVE_FIELD: 404,
  BAD_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
};

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  UNPAIRED: 'This device is not paired. Open Pairing and enter the code from the gateway laptop.',
  INVALID_SESSION: 'This pairing is not recognised by the gateway. Pair this device again.',
  SESSION_EXPIRED: 'This pairing has expired. Pair this device again with the current code.',
  SESSION_REVOKED: 'This pairing was revoked on the gateway. Pair again with the new code.',
  NO_PAIRING_PROVISIONED:
    'No pairing code is set up on this gateway. On the laptop, run "npm run pairing:provision".',
  INVALID_PAIRING_CODE: 'That pairing code is not correct. Check the code on the gateway laptop.',
  NOT_FOUND: 'Not found for the robot paired with this device.',
  NO_ACTIVE_FIELD: 'No field has been set up for this robot on the gateway yet.',
  BAD_REQUEST: 'The request was not valid.',
  METHOD_NOT_ALLOWED: 'This operation is not available.',
  PAYLOAD_TOO_LARGE: 'The request is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'Send the request body as JSON with Content-Type: application/json.',
  INTERNAL_ERROR: 'The gateway could not complete this request. Try again; if it keeps failing, check the gateway laptop.',
};

/** Builds a contract-shaped error response; also used by the HTTP transport. */
export function apiErrorResponse(code: ApiErrorCode, message: string = ERROR_MESSAGES[code]): ApiResponse {
  return { status: ERROR_STATUS[code], body: { error: { code, message } } };
}

const fail = apiErrorResponse;

function ok(body: ApiResponseBody, status = 200): ApiResponse {
  return { status, body };
}

function bearerToken(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  // A non-Bearer header is passed through so it is rejected as INVALID_SESSION, not UNPAIRED.
  return match?.[1] ?? header.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function robotSummary(db: Database, robotId: string): RobotSummary | null {
  const robot = getRobot(db, robotId);
  return robot ? { id: robot.id, displayName: robot.displayName, isSynthetic: robot.isSynthetic } : null;
}

function toRunSummary(row: Row): RunSummary {
  return {
    id: str(row, 'id'),
    sourceRunId: str(row, 'source_run_id'),
    runType: 'dosing',
    fieldId: strOrNull(row, 'field_id'),
    readingCount: num(row, 'reading_count'),
    firstRobotRecordedAt: strOrNull(row, 'first_recorded'),
    lastRobotRecordedAt: strOrNull(row, 'last_recorded'),
    isSynthetic: bool(row, 'is_synthetic'),
  };
}

const RUN_SUMMARY_SQL = `
  SELECT r.id, r.source_run_id, r.field_id, r.is_synthetic,
         COUNT(x.id) AS reading_count,
         MIN(x.robot_recorded_at) AS first_recorded,
         MAX(x.robot_recorded_at) AS last_recorded
  FROM runs AS r LEFT JOIN readings AS x ON x.run_id = r.id
  WHERE r.robot_id = ? AND r.run_type = 'dosing'`;

const RUN_SUB_ROUTE = new RegExp(`^${API_V1_BASE_PATH}/runs/([^/]+)/(readings|recommendation)$`);

export function createLocalApi(options: LocalApiOptions) {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  const ttlDays = options.sessionTtlDays ?? DEFAULT_SESSION_TTL_DAYS;

  function handlePairing(req: ApiRequest): ApiResponse {
    if (req.method !== 'POST') {
      return fail('METHOD_NOT_ALLOWED');
    }
    if (!isRecord(req.body) || typeof req.body.pairingCode !== 'string' || req.body.pairingCode.length > 64) {
      return fail('BAD_REQUEST', 'Send {"pairingCode": "<code>"}.');
    }
    const result = pairDevice(db, req.body.pairingCode, clock(), ttlDays);
    if (!result.ok) {
      return fail(result.error);
    }
    const robot = robotSummary(db, result.robotId);
    if (!robot) {
      return fail('NOT_FOUND');
    }
    return ok({ sessionToken: result.token, robot, expiresAt: result.expiresAt }, 201);
  }

  function handleAuthorized(req: ApiRequest, robotId: string, expiresAt: string, sessionId: string): ApiResponse {
    const path = req.path.split('?')[0] ?? '';

    if (path === API_V1_ROUTES.session) {
      if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
      const robot = robotSummary(db, robotId);
      return robot ? ok({ robot, expiresAt }) : fail('NOT_FOUND');
    }

    if (path === API_V1_ROUTES.robotStatus) {
      if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
      return ok({ status: getLatestStatus(db, robotId), staleThresholdSeconds: STALE_THRESHOLD_SECONDS });
    }

    if (path === API_V1_ROUTES.field) {
      if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
      const active = getActiveField(db, robotId);
      return active ? ok({ field: active.field, cells: active.cells }) : fail('NO_ACTIVE_FIELD');
    }

    if (path === API_V1_ROUTES.fieldSelections) {
      if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
      if (!isRecord(req.body) || typeof req.body.fieldId !== 'string') {
        return fail('BAD_REQUEST', 'Send {"fieldId": "<id>"}.');
      }
      const field = db.prepare('SELECT id FROM fields WHERE id = ? AND robot_id = ?').get(req.body.fieldId, robotId);
      if (!field) return fail('NOT_FOUND');
      const confirmedAt = toCanonicalUtc(clock());
      db.prepare('INSERT INTO field_selections (id, field_id, session_id, confirmed_at) VALUES (?, ?, ?, ?)').run(
        randomUUID(),
        str(field, 'id'),
        sessionId,
        confirmedAt,
      );
      return ok({ selection: { fieldId: str(field, 'id'), confirmedAt } }, 201);
    }

    if (path === API_V1_ROUTES.runs) {
      if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
      const rows = db
        .prepare(`${RUN_SUMMARY_SQL} GROUP BY r.id ORDER BY first_recorded DESC, r.id`)
        .all(robotId);
      return ok({ runs: rows.map(toRunSummary) });
    }

    const sub = RUN_SUB_ROUTE.exec(path);
    if (sub) {
      if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
      let runId: string;
      try {
        runId = decodeURIComponent(sub[1] ?? '');
      } catch {
        return fail('BAD_REQUEST', 'The run identifier in the path is not valid.');
      }
      const run = getRun(db, runId);
      // Other robots' runs and verification runs are indistinguishable from missing runs.
      if (!run || run.robotId !== robotId || run.runType !== 'dosing') {
        return fail('NOT_FOUND');
      }
      if (sub[2] === 'readings') {
        const summaryRow = db.prepare(`${RUN_SUMMARY_SQL} AND r.id = ? GROUP BY r.id`).get(robotId, run.id);
        if (!summaryRow) return fail('NOT_FOUND');
        return ok({ run: toRunSummary(summaryRow), readings: listRunReadings(db, run) });
      }
      const stored = getRecommendationForRun(db, run.id);
      return stored ? ok(stored) : fail('NOT_FOUND', 'No recommendation has been stored for this run yet.');
    }

    return fail('NOT_FOUND', 'Unknown API route.');
  }

  return {
    handle(req: ApiRequest): ApiResponse {
      const path = req.path.split('?')[0] ?? '';
      if (path === API_V1_ROUTES.pairing) {
        return handlePairing(req);
      }
      const session = validateSession(db, bearerToken(req.authorization), clock());
      if (!session.ok) {
        return fail(session.error);
      }
      return handleAuthorized(req, session.robotId, session.expiresAt, session.sessionId);
    },
  };
}

export type LocalApi = ReturnType<typeof createLocalApi>;
