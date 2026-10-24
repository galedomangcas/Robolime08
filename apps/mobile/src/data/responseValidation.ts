import {
  ERROR_FLAG_BITS,
  ROBOT_COMPONENTS,
  ROBOT_STATE_BY_CODE,
  type ComponentCheck,
  type PairingResponse,
  type RobotStatus,
  type RobotStatusResponse,
  type RobotSummary,
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
