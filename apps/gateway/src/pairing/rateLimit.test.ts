import { describe, expect, it } from 'vitest';

import {
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PairingAttemptLimiter,
  UNKNOWN_CLIENT,
  clientKey,
} from './rateLimit';

const T = new Date('2026-03-01T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const MINUTE = 60_000;

function failTimes(limiter: PairingAttemptLimiter, address: string, offsetsMs: number[]) {
  for (const ms of offsetsMs) {
    expect(limiter.check(address, at(ms)).allowed).toBe(true);
    limiter.recordFailure(address, at(ms));
  }
}

describe('pairing rate limit policy', () => {
  it('is the approved policy: 5 failures per client in 15 minutes', () => {
    expect(PAIRING_MAX_FAILED_ATTEMPTS).toBe(5);
    expect(PAIRING_FAILURE_WINDOW_MS).toBe(15 * MINUTE);
  });

  it('allows attempts until the fifth failure, then refuses until the oldest failure is 15 minutes old', () => {
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '192.0.2.1', [0, 0, 0, 0]);
    expect(limiter.check('192.0.2.1', at(0))).toEqual({ allowed: true });
    limiter.recordFailure('192.0.2.1', at(0));

    expect(limiter.check('192.0.2.1', at(0))).toEqual({ allowed: false, retryAfterMs: 15 * MINUTE });
    expect(limiter.check('192.0.2.1', at(15 * MINUTE - 1))).toEqual({ allowed: false, retryAfterMs: 1 });
    // Boundary: a failure stops counting exactly 15 minutes after it happened.
    expect(limiter.check('192.0.2.1', at(15 * MINUTE))).toEqual({ allowed: true });
  });

  it('uses a sliding window: each failure expires on its own', () => {
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '192.0.2.1', [0, 1, 2, 3, 4].map((m) => m * MINUTE));
    expect(limiter.check('192.0.2.1', at(14 * MINUTE)).allowed).toBe(false);

    // At 15 min the first failure expires: exactly one more attempt is possible.
    expect(limiter.check('192.0.2.1', at(15 * MINUTE)).allowed).toBe(true);
    limiter.recordFailure('192.0.2.1', at(15 * MINUTE));
    expect(limiter.check('192.0.2.1', at(15 * MINUTE))).toEqual({ allowed: false, retryAfterMs: MINUTE });
    expect(limiter.check('192.0.2.1', at(16 * MINUTE)).allowed).toBe(true);
  });

  it('keeps separate counters per client address', () => {
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '192.0.2.1', [0, 0, 0, 0, 0]);
    expect(limiter.check('192.0.2.1', at(0)).allowed).toBe(false);
    expect(limiter.check('192.0.2.2', at(0)).allowed).toBe(true);
    expect(limiter.check('::1', at(0)).allowed).toBe(true);
  });

  it('refused checks are not failures: hammering a locked client does not extend its lockout', () => {
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '192.0.2.1', [0, 0, 0, 0, 0]);
    for (let i = 0; i < 50; i += 1) expect(limiter.check('192.0.2.1', at(MINUTE)).allowed).toBe(false);
    expect(limiter.check('192.0.2.1', at(15 * MINUTE)).allowed).toBe(true);
  });

  it('never stores more than the threshold per client, even if recordFailure is misused', () => {
    const limiter = new PairingAttemptLimiter();
    for (let i = 0; i < 20; i += 1) limiter.recordFailure('192.0.2.1', at(i));
    // Only the 5 most recent failures (at 15..19 ms) remain, so the lockout ends 15 min after the 15th.
    expect(limiter.check('192.0.2.1', at(19))).toEqual({ allowed: false, retryAfterMs: 15 * MINUTE - 4 });
  });

  it('drops expired clients on the next check, whoever makes it', () => {
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '192.0.2.1', [0]);
    failTimes(limiter, '192.0.2.2', [10 * MINUTE]);
    expect(limiter.trackedClients).toBe(2);

    limiter.check('192.0.2.99', at(15 * MINUTE));
    expect(limiter.trackedClients).toBe(1);
    limiter.check('192.0.2.99', at(25 * MINUTE));
    expect(limiter.trackedClients).toBe(0);
  });
});

describe('client keys', () => {
  it('treats IPv4-mapped IPv6 and plain IPv4 as one client, and is case-insensitive', () => {
    expect(clientKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientKey('::FFFF:192.0.2.1')).toBe('192.0.2.1');
    expect(clientKey('FE80::1')).toBe('fe80::1');
    expect(clientKey('::1')).toBe('::1');
  });

  it('fails closed: an unknown address shares one limited counter', () => {
    expect(clientKey(undefined)).toBe(UNKNOWN_CLIENT);
    expect(clientKey(null)).toBe(UNKNOWN_CLIENT);
    expect(clientKey('')).toBe(UNKNOWN_CLIENT);
    const limiter = new PairingAttemptLimiter();
    failTimes(limiter, '', [0, 0, 0]);
    limiter.recordFailure(null, at(0));
    limiter.recordFailure(undefined, at(0));
    expect(limiter.check(null, at(0)).allowed).toBe(false);
  });
});
