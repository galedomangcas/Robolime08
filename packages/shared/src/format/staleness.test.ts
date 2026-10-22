import { describe, expect, it } from 'vitest';
import { STALE_THRESHOLD_SECONDS } from '../config';
import { ageSeconds, describeFreshness, formatAge } from './staleness';

const now = new Date('2026-10-23T08:00:00Z');
const secondsBefore = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

describe('ageSeconds', () => {
  it('computes whole seconds elapsed', () => {
    expect(ageSeconds(secondsBefore(90), now)).toBe(90);
    expect(ageSeconds('2026-10-23T07:59:59.400Z', now)).toBe(0);
  });

  it('returns null for unparseable timestamps', () => {
    expect(ageSeconds('not a date', now)).toBeNull();
  });
});

describe('formatAge', () => {
  it('chooses a readable unit', () => {
    expect(formatAge(0)).toBe('0 s ago');
    expect(formatAge(59)).toBe('59 s ago');
    expect(formatAge(60)).toBe('1 min ago');
    expect(formatAge(3599)).toBe('59 min ago');
    expect(formatAge(3600)).toBe('1 h ago');
    expect(formatAge(86399)).toBe('23 h ago');
    expect(formatAge(86400 * 3)).toBe('3 d ago');
  });
});

describe('describeFreshness', () => {
  it('uses the configured 240 s default threshold', () => {
    expect(STALE_THRESHOLD_SECONDS).toBe(240);
  });

  it('reports no data when nothing has been received', () => {
    expect(describeFreshness(null, now)).toEqual({ kind: 'no-data' });
  });

  it('reports an invalid timestamp rather than guessing', () => {
    expect(describeFreshness('garbage', now)).toEqual({ kind: 'invalid-timestamp' });
  });

  it('is fresh up to and including the threshold, stale after it', () => {
    expect(describeFreshness(secondsBefore(240), now)).toEqual({
      kind: 'fresh',
      ageSeconds: 240,
      label: '4 min ago',
    });
    expect(describeFreshness(secondsBefore(241), now)).toMatchObject({
      kind: 'stale',
      ageSeconds: 241,
    });
  });

  it('honours a custom threshold', () => {
    expect(describeFreshness(secondsBefore(30), now, 20).kind).toBe('stale');
  });

  it('flags robot timestamps ahead of the viewer clock', () => {
    expect(describeFreshness(secondsBefore(-30), now)).toMatchObject({
      kind: 'future',
      ageSeconds: -30,
    });
  });
});
