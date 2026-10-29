import {
  ERROR_FLAG_BITS,
  ROBOT_COMPONENTS,
  ROBOT_STATE_BY_CODE,
  parseManualControlCommand,
  type CellReading,
  type ComponentCheck,
  type CropRecommendation,
  type CropScore,
  type ExportCsvResponse,
  type ExportRunsResponse,
  type FieldResponse,
  type FieldSelectionResponse,
  type ManualBridgeState,
  type ManualCommandOutcome,
  type ManualCommandResult,
  type ManualStatusResponse,
  type PairingResponse,
  type RobotStatus,
  type RobotStatusResponse,
  type RobotSummary,
  type RunReadingsResponse,
  type RunRecommendationResponse,
  type RunsResponse,
  type RunSummary,
  type SessionResponse,
} from '@robolime/shared';

/**
 * Runtime checks for SUCCESSFUL gateway answers, following the shared API v1
 * contracts exactly (packages/shared/src/api/v1.ts and domain/*). A body that
 * fails is reported as `invalid-response` by the client and never reaches the
 * screens. Nothing is coerced or defaulted, and validation results carry no
 * payload, so malformed data is neither shown nor logged.
 *
 * Extra, unknown fields are ignored (forward compatibility); required fields
 * must be present with the contract's type. Where the contract only says
 * `number`, only finiteness is checked (JSON can still yield Infinity, e.g.
 * 1e400); no ranges are invented.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * `IsoDateTime` is documented as "ISO 8601 date-time string with an explicit
 * offset". Accepted: YYYY-MM-DDTHH:MM[:SS[.fff…]] followed by Z or ±HH:MM.
 *
 * `Date.parse` alone is not enough: it silently shifts impossible values
 * (2026-02-30 → 2026-03-02, T24:00 → next day). So the WRITTEN fields are
 * checked first, as the LoRa validator does (commit 395ceee): a real day of
 * that month (Gregorian leap years), hour 0–23, minute and second 0–59 (no
 * leap second), offset hours 0–23 and minutes 0–59. The local fields are
 * checked as written, never against the UTC date, so an offset that crosses
 * midnight stays valid.
 */
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isIsoDateTime(v: unknown): v is string {
  if (!isString(v)) return false;
  const m = ISO_WITH_OFFSET.exec(v);
  if (m === null) return false;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offsetHours = m[7] === undefined ? 0 : Number(m[7]);
  const offsetMinutes = m[8] === undefined ? 0 : Number(m[8]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHours <= 23 &&
    offsetMinutes <= 59 &&
    !Number.isNaN(Date.parse(v))
  );
}

const ROBOT_STATES: ReadonlySet<unknown> = new Set(Object.values(ROBOT_STATE_BY_CODE));
const ERROR_FLAGS: ReadonlySet<unknown> = new Set(Object.keys(ERROR_FLAG_BITS));
/**
 * ComponentCheck is a type-only union in the contract. A Record over it forces
 * this list to contain every member and nothing else (checked at compile time).
 */
const COMPONENT_CHECK_SET: ReadonlySet<unknown> = new Set(
  Object.keys({ ok: true, fault: true, unknown: true } satisfies Record<ComponentCheck, true>),
);

export function isRobotSummary(v: unknown): v is RobotSummary {
  return isObject(v) && isString(v.id) && isString(v.displayName) && typeof v.isSynthetic === 'boolean';
}

export function isRobotStatus(v: unknown): v is RobotStatus {
  if (!isObject(v)) return false;
  const { timestamps, componentChecks, errorFlags } = v;
  return (
    isString(v.robotId) &&
    ROBOT_STATES.has(v.state) &&
    Array.isArray(errorFlags) &&
    errorFlags.every((flag) => ERROR_FLAGS.has(flag)) &&
    isObject(componentChecks) &&
    ROBOT_COMPONENTS.every((component) => COMPONENT_CHECK_SET.has(componentChecks[component])) &&
    isFiniteNumber(v.batteryVoltage) &&
    isFiniteNumber(v.totalLimeCommandedMl) &&
    isFiniteNumber(v.cellsCompleted) &&
    isFiniteNumber(v.totalCells) &&
    isObject(timestamps) &&
    isIsoDateTime(timestamps.robotAt) &&
    (timestamps.gatewayReceivedAt === null || isIsoDateTime(timestamps.gatewayReceivedAt)) &&
    (timestamps.cloudSyncedAt === null || isIsoDateTime(timestamps.cloudSyncedAt))
  );
}

export function isRobotStatusResponse(v: unknown): v is RobotStatusResponse {
  return isObject(v) && (v.status === null || isRobotStatus(v.status)) && isFiniteNumber(v.staleThresholdSeconds);
}

/**
 * The session token must be a non-empty string: an empty bearer token could
 * never authenticate, and the session store already refuses to keep one.
 */
export function isPairingResponse(v: unknown): v is PairingResponse {
  return (
    isObject(v) && isString(v.sessionToken) && v.sessionToken !== '' && isRobotSummary(v.robot) && isIsoDateTime(v.expiresAt)
  );
}

export function isSessionResponse(v: unknown): v is SessionResponse {
  return isObject(v) && isRobotSummary(v.robot) && isIsoDateTime(v.expiresAt);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isNullableIso = (v: unknown) => v === null || isIsoDateTime(v);

function isTimestamps(v: unknown): boolean {
  return (
    isObject(v) && isIsoDateTime(v.robotAt) && isNullableIso(v.gatewayReceivedAt) && isNullableIso(v.cloudSyncedAt)
  );
}

/**
 * Farmer-facing run summary. Only dosing runs are accepted: a verification run
 * is research data and must never reach these screens (CLAUDE.md §4 Screen 4).
 */
export function isRunSummary(v: unknown): v is RunSummary {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.sourceRunId) &&
    v.runType === 'dosing' &&
    (v.fieldId === null || isString(v.fieldId)) &&
    isFiniteNumber(v.readingCount) &&
    isNullableIso(v.firstRobotRecordedAt) &&
    isNullableIso(v.lastRobotRecordedAt) &&
    typeof v.isSynthetic === 'boolean'
  );
}

export function isRunsResponse(v: unknown): v is RunsResponse {
  return isObject(v) && Array.isArray(v.runs) && v.runs.every(isRunSummary);
}

/** A reading from a verification run is rejected outright (the whole answer becomes invalid). */
export function isCellReading(v: unknown): v is CellReading {
  if (!isObject(v)) return false;
  const { gps } = v;
  return (
    isString(v.runId) &&
    v.runType === 'dosing' &&
    isFiniteNumber(v.cellIndex) &&
    isFiniteNumber(v.seq) &&
    isFiniteNumber(v.attemptCount) &&
    isFiniteNumber(v.ph) &&
    isFiniteNumber(v.ec) &&
    isFiniteNumber(v.moisturePercent) &&
    isFiniteNumber(v.temperatureC) &&
    isFiniteNumber(v.doseVolumeMl) &&
    (v.expectedPostCorrectionPh === null || isFiniteNumber(v.expectedPostCorrectionPh)) &&
    (gps === null || (isObject(gps) && isFiniteNumber(gps.latitude) && isFiniteNumber(gps.longitude))) &&
    isFiniteNumber(v.rawFlags) &&
    isTimestamps(v.timestamps)
  );
}

export function isRunReadingsResponse(v: unknown): v is RunReadingsResponse {
  return isObject(v) && isRunSummary(v.run) && Array.isArray(v.readings) && v.readings.every(isCellReading);
}

function isCropScore(v: unknown): v is CropScore {
  return (
    isObject(v) &&
    isString(v.cropId) &&
    isString(v.cropName) &&
    isString(v.category) &&
    isFiniteNumber(v.score) &&
    isStringArray(v.reasons)
  );
}

const WEATHER_SOURCES: ReadonlySet<unknown> = new Set(['forecast', 'seasonal-defaults']);
const RULE_SET_STATUSES: ReadonlySet<unknown> = new Set(['draft', 'approved', 'retired']);

function isCropRecommendation(v: unknown): v is CropRecommendation {
  if (!isObject(v)) return false;
  const { inputs } = v;
  return (
    isString(v.id) &&
    isString(v.runId) &&
    isString(v.ruleSetVersion) &&
    isObject(inputs) &&
    isFiniteNumber(inputs.medianPh) &&
    isFiniteNumber(inputs.medianEc) &&
    isFiniteNumber(inputs.medianMoisturePercent) &&
    isFiniteNumber(inputs.medianTemperatureC) &&
    isString(inputs.season) &&
    WEATHER_SOURCES.has(inputs.weatherSource) &&
    isObject(inputs.weather) &&
    Object.values(inputs.weather).every(isFiniteNumber) &&
    Array.isArray(v.allScores) &&
    v.allScores.every(isCropScore) &&
    Array.isArray(v.shortlist) &&
    v.shortlist.every(isCropScore) &&
    isIsoDateTime(v.computedAt)
  );
}

export function isRunRecommendationResponse(v: unknown): v is RunRecommendationResponse {
  return (
    isObject(v) &&
    isCropRecommendation(v.recommendation) &&
    RULE_SET_STATUSES.has(v.ruleSetStatus) &&
    typeof v.isSynthetic === 'boolean'
  );
}

/**
 * Identity checks for the run-scoped routes. A structurally valid answer is
 * still rejected if it describes a different run from the one requested, so
 * one run's records can never be shown under another run's title. Run ids are
 * the gateway's opaque ids (`RunSummary.id`, also used as `CellReading.runId`
 * and `CropRecommendation.runId`).
 */
export function isReadingsForRun(v: RunReadingsResponse, requestedRunId: string): boolean {
  return v.run.id === requestedRunId && v.readings.every((reading) => reading.runId === requestedRunId);
}

export function isRecommendationForRun(v: RunRecommendationResponse, requestedRunId: string): boolean {
  return v.recommendation.runId === requestedRunId;
}

const isNullableNumber = (v: unknown) => v === null || isFiniteNumber(v);

/** Field + cells (D54). Cell grid positions and centres may be absent until surveyed. */
export function isFieldResponse(v: unknown): v is FieldResponse {
  if (!isObject(v) || !isObject(v.field) || !Array.isArray(v.cells)) return false;
  const f = v.field;
  return (
    isString(f.id) && isString(f.name) && isString(f.locationLabel) && isNullableNumber(f.areaSquareMeters) &&
    isFiniteNumber(f.cellSizeMeters) && isNullableNumber(f.totalCells) && typeof f.isSynthetic === 'boolean' &&
    v.cells.every(
      (c) =>
        isObject(c) && isFiniteNumber(c.cellIndex) && isNullableNumber(c.gridRow) && isNullableNumber(c.gridColumn) &&
        (c.center === null || (isObject(c.center) && isFiniteNumber(c.center.latitude) && isFiniteNumber(c.center.longitude))),
    )
  );
}

export function isFieldSelectionResponse(v: unknown): v is FieldSelectionResponse {
  return isObject(v) && isObject(v.selection) && isString(v.selection.fieldId) && isIsoDateTime(v.selection.confirmedAt);
}

const RUN_TYPES: ReadonlySet<unknown> = new Set(['dosing', 'verification']);
export function isExportRunsResponse(v: unknown): v is ExportRunsResponse {
  return (
    isObject(v) && Array.isArray(v.runs) &&
    v.runs.every(
      (r) => isObject(r) && isString(r.id) && isString(r.sourceRunId) && RUN_TYPES.has(r.runType) &&
        isFiniteNumber(r.readingCount) && isNullableIso(r.firstRobotRecordedAt) && typeof r.isSynthetic === 'boolean',
    )
  );
}

const EXPORT_KINDS: ReadonlySet<unknown> = new Set(['readings', 'paired', 'delivery']);
export function isExportCsvResponse(v: unknown): v is ExportCsvResponse {
  if (!isObject(v) || !EXPORT_KINDS.has(v.kind) || !isString(v.filename) || !isString(v.csv) || !isFiniteNumber(v.rows)) return false;
  const pc = v.pairCounts;
  const d = v.delivery;
  return (
    (pc === null || (isObject(pc) && ['paired', 'missing_verification', 'missing_dosing', 'ambiguous_multiple_readings'].every((k) => isFiniteNumber(pc[k])))) &&
    (d === null || (isObject(d) && isNullableNumber(d.completenessNumerator) && isNullableNumber(d.completenessDenominator) && isString(d.completenessNote) && isString(d.firstAttemptNote)))
  );
}

const MANUAL_OUTCOMES: ReadonlySet<unknown> = new Set(['acknowledged', 'rejected', 'no-ack', 'superseded', 'expired', 'unavailable'] satisfies ManualCommandOutcome[]);
const BRIDGE_STATES: ReadonlySet<unknown> = new Set(['not-configured', 'connecting', 'connected', 'disconnected'] satisfies ManualBridgeState[]);

export function isManualCommandResult(v: unknown): v is ManualCommandResult {
  return (
    isObject(v) && parseManualControlCommand(v.command) !== null && isString(v.line) && MANUAL_OUTCOMES.has(v.outcome) &&
    isIsoDateTime(v.sentAt) && isIsoDateTime(v.finishedAt)
  );
}

export function isManualStatusResponse(v: unknown): v is ManualStatusResponse {
  if (!isObject(v) || !isObject(v.bridge) || !isFiniteNumber(v.autoStopMs)) return false;
  const b = v.bridge;
  return (
    BRIDGE_STATES.has(b.state) && (b.port === null || isString(b.port)) && (b.detail === null || isString(b.detail)) &&
    Array.isArray(v.recentCommands) && v.recentCommands.every(isManualCommandResult) &&
    Array.isArray(v.bridgeLog) && v.bridgeLog.every((e) => isObject(e) && isIsoDateTime(e.at) && isString(e.line))
  );
}