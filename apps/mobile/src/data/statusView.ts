import {
  ERROR_FLAG_LABELS,
  STALE_THRESHOLD_SECONDS,
  describeFreshness,
  formatVoltage,
  formatVolumeMl,
  robotStateLabelWithoutProgress,
  type RobotStatus,
} from '@robolime/shared';

import { REQUEST_TIMEOUT_MS } from '../config/timing';
import type { GatewayFailure } from './gatewayClient';

const TIMEOUT_SECONDS = Math.round(REQUEST_TIMEOUT_MS / 1000);

/**
 * Turns the latest poll outcome into display text (pure, no React). Rules:
 * - Never "live": status packets arrive once per cell with no heartbeat.
 * - Stale only when strictly older than the threshold (describeFreshness).
 * - Gateway unavailable: say so, and label any kept status "Last received".
 * - Cell counts (cellsCompleted/totalCells) are never read here (D33).
 */

export type Connection =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'unavailable'; failure: GatewayFailure };

export interface StatusSnapshot {
  status: RobotStatus | null;
  staleThresholdSeconds: number;
}

export interface StatusViewInput {
  connection: Connection;
  /** Latest successful answer, kept when later polls fail; null if none yet. */
  snapshot: StatusSnapshot | null;
  now: Date;
  /** Where the data comes from, for messages (default "Field gateway"). */
  sourceName?: string;
}

export interface StatusView {
  connectionLabel: string;
  connectionOk: boolean;
  /** "Latest report", "Last received", or null while there is no status. */
  heading: string | null;
  /** Shown instead of the values when there is no status. */
  emptyMessage: string | null;
  freshnessLabel: string | null;
  isStale: boolean;
  stateLabel: string | null;
  faults: string[];
  batteryVoltage: string | null;
  limeCommanded: string | null;
  /** Robot-side time of the status, as an ISO string (formatted by the screen). */
  robotAt: string | null;
}

export function connectionLabel(connection: Connection, source = 'Field gateway'): string {
  switch (connection.kind) {
    case 'connecting':
      return `Connecting to the ${source === 'Field gateway' ? 'field gateway' : source}…`;
    case 'connected':
      return `${source} connected`;
    case 'unavailable':
      switch (connection.failure.kind) {
        case 'timeout':
          return `${source} unavailable: no answer within ${TIMEOUT_SECONDS} seconds`;
        case 'unreachable':
          return `${source} unavailable: cannot reach it`;
        case 'api':
          return `${source} unavailable: error ${connection.failure.status}`;
        case 'invalid-response':
          return `${source} unavailable: unreadable answer`;
      }
  }
}

export function buildStatusView({ connection, snapshot, now, sourceName }: StatusViewInput): StatusView {
  const unavailable = connection.kind === 'unavailable';
  const status = snapshot?.status ?? null;
  const base = {
    connectionLabel: connectionLabel(connection, sourceName),
    connectionOk: connection.kind === 'connected',
  };

  if (status === null) {
    const waiting = connection.kind === 'connecting' && snapshot === null;
    return {
      ...base,
      heading: null,
      emptyMessage: waiting ? 'Waiting for the gateway…' : 'No status data',
      freshnessLabel: null,
      isStale: false,
      stateLabel: null,
      faults: [],
      batteryVoltage: null,
      limeCommanded: null,
      robotAt: null,
    };
  }

  const threshold = snapshot?.staleThresholdSeconds ?? STALE_THRESHOLD_SECONDS;
  const freshness = describeFreshness(status.timestamps.robotAt, now, threshold);
  let freshnessLabel: string;
  let isStale = false;
  switch (freshness.kind) {
    case 'no-data':
      freshnessLabel = 'No timestamp';
      break;
    case 'invalid-timestamp':
      freshnessLabel = 'Timestamp invalid';
      isStale = true;
      break;
    case 'future':
      freshnessLabel = freshness.label;
      break;
    case 'stale':
      freshnessLabel = `Stale: reported ${freshness.label}`;
      isStale = true;
      break;
    case 'fresh':
      freshnessLabel = `Reported ${freshness.label}`;
      break;
  }

  return {
    ...base,
    heading: unavailable ? 'Last received' : 'Latest report',
    emptyMessage: null,
    freshnessLabel,
    // Old data is never shown as current while the gateway cannot be reached.
    isStale: isStale || unavailable,
    stateLabel: robotStateLabelWithoutProgress({ state: status.state, errorFlags: status.errorFlags }),
    faults: status.errorFlags.map((flag) => ERROR_FLAG_LABELS[flag]),
    batteryVoltage: formatVoltage(status.batteryVoltage),
    limeCommanded: formatVolumeMl(status.totalLimeCommandedMl),
    robotAt: status.timestamps.robotAt,
  };
}

/** Fixed, locale-independent local time, e.g. "2026-03-01 20:00:05 (UTC+08:00)". */
export function formatLocalTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid timestamp';
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `(UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
  );
}

/** Pairing feedback. The code itself is never echoed. */
export function pairingFailureMessage(failure: GatewayFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `The field gateway did not answer within ${TIMEOUT_SECONDS} seconds. Check that it is running, then try again.`;
    case 'unreachable':
      return 'Cannot reach the field gateway. Check that it is running on this computer, then try again.';
    case 'invalid-response':
      return 'The field gateway sent an unreadable answer. Try again.';
    case 'api':
      switch (failure.code) {
        case 'INVALID_PAIRING_CODE':
          return 'That pairing code was not accepted. Check it and try again.';
        case 'NO_PAIRING_PROVISIONED':
          return 'This gateway has no pairing code yet. The operator must create one on the laptop with "npm run pairing:provision".';
        case 'PAIRING_RATE_LIMITED': {
          if (failure.retryAfterSeconds === null) return 'Too many incorrect codes. Wait, then try again.';
          const minutes = Math.max(1, Math.ceil(failure.retryAfterSeconds / 60));
          return `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
        }
        case 'BAD_REQUEST':
          return 'Enter the pairing code.';
        default:
          return `Pairing failed (gateway error ${failure.status}). Try again.`;
      }
  }
}
