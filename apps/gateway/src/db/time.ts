/**
 * Canonical stored timestamp: UTC ISO-8601 with milliseconds, e.g.
 * "2026-10-23T08:00:00.000Z" — the exact form the SQLite CHECK constraints
 * accept. How the firmware encodes robot time is pending the packet spec;
 * the decoder (Phase 3) must convert it to a Date/ISO string before storage.
 */
export function toCanonicalUtc(input: Date | string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${String(input)}`);
  }
  return date.toISOString();
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
