/**
 * Pairing-attempt rate limiting (Phase 4, milestone 2; decision D30).
 *
 * Policy (approved): at most 5 FAILED pairing attempts per client IP address
 * within any 15-minute window. A failure counts while it is younger than the
 * window (`now - failedAt < window`); once 5 failures count, every pairing
 * attempt from that address is refused until the oldest of them expires.
 *
 * Counters live in memory only: they reset when the gateway restarts, and
 * nothing is persisted. Only wrong-code results are recorded — never the
 * code itself — so this module holds no secrets.
 */
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;
export const PAIRING_FAILURE_WINDOW_MS = 15 * 60_000;

/** Key used when the transport cannot report a client address (fails closed: such clients share one counter). */
export const UNKNOWN_CLIENT = 'unknown';

export type PairingLimitCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

/** IPv4-mapped IPv6 (`::ffff:192.0.2.1`) and plain IPv4 count as the same client. */
export function clientKey(address: string | null | undefined): string {
  if (!address) return UNKNOWN_CLIENT;
  const lower = address.trim().toLowerCase();
  return lower.startsWith('::ffff:') && lower.includes('.') ? lower.slice(7) : lower || UNKNOWN_CLIENT;
}

export class PairingAttemptLimiter {
  /** Failure times (ms) per client key, oldest first; never more than `maxFailures` entries. */
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number = PAIRING_MAX_FAILED_ATTEMPTS,
    private readonly windowMs: number = PAIRING_FAILURE_WINDOW_MS,
  ) {}

  /** Whether `address` may make a pairing attempt now. Also drops expired entries for every client. */
  check(address: string | null | undefined, now: Date): PairingLimitCheck {
    this.sweep(now);
    const recent = this.failures.get(clientKey(address)) ?? [];
    const oldest = recent[0];
    if (recent.length < this.maxFailures || oldest === undefined) return { allowed: true };
    return { allowed: false, retryAfterMs: oldest + this.windowMs - now.getTime() };
  }

  /** Records one failed attempt. Call only after `check` allowed the attempt. */
  recordFailure(address: string | null | undefined, now: Date): void {
    const key = clientKey(address);
    const recent = [...this.live(this.failures.get(key) ?? [], now), now.getTime()];
    this.failures.set(key, recent.slice(-this.maxFailures));
  }

  /** Number of client addresses currently holding unexpired failures. */
  get trackedClients(): number {
    return this.failures.size;
  }

  private live(times: number[], now: Date): number[] {
    return times.filter((t) => now.getTime() - t < this.windowMs);
  }

  private sweep(now: Date): void {
    for (const [key, times] of this.failures) {
      const live = this.live(times, now);
      if (live.length === 0) this.failures.delete(key);
      else if (live.length !== times.length) this.failures.set(key, live);
    }
  }
}
