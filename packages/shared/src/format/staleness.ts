import { STALE_THRESHOLD_SECONDS } from '../config';
import type { IsoDateTime } from '../domain/time';

export type Freshness =
  | { kind: 'no-data' }
  | { kind: 'invalid-timestamp' }
  /** Robot timestamp is ahead of this device's clock (clock skew). */
  | { kind: 'future'; ageSeconds: number; label: string }
  | { kind: 'fresh' | 'stale'; ageSeconds: number; label: string };

/** Whole seconds elapsed since `observedAt`; null if the timestamp cannot be parsed. */
export function ageSeconds(observedAt: IsoDateTime, now: Date): number | null {
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    return null;
  }
  return Math.floor((now.getTime() - observedMs) / 1000);
}

/** Compact age label, e.g. "45 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Classifies telemetry age. Data is stale only when strictly older than the
 * threshold. Status packets arrive once per cell with no heartbeat, so
 * "fresh" means "recently reported", not "live".
 */
export function describeFreshness(
  observedAt: IsoDateTime | null,
  now: Date,
  thresholdSeconds: number = STALE_THRESHOLD_SECONDS,
): Freshness {
  if (observedAt === null) {
    return { kind: 'no-data' };
  }
  const age = ageSeconds(observedAt, now);
  if (age === null) {
    return { kind: 'invalid-timestamp' };
  }
  if (age < 0) {
    return { kind: 'future', ageSeconds: age, label: "Timestamp ahead of this device's clock" };
  }
  return {
    kind: age > thresholdSeconds ? 'stale' : 'fresh',
    ageSeconds: age,
    label: formatAge(age),
  };
}
