import { ROBOT_COMPONENTS, type RobotStatus } from '@robolime/shared';

import { createGatewayClient, type FetchLike } from './gatewayClient';
import { isIsoDateTime, isPairingResponse, isRobotStatus, isRobotStatusResponse, isSessionResponse } from './responseValidation';

const STATUS: RobotStatus = {
  robotId: 'r1',
  state: 'WORKING',
  errorFlags: ['LIME_EMPTY'],
  componentChecks: Object.fromEntries(ROBOT_COMPONENTS.map((c) => [c, 'unknown'])) as RobotStatus['componentChecks'],
  batteryVoltage: 12.4,
  totalLimeCommandedMl: 1250,
  cellsCompleted: 7,
  totalCells: 20,
  timestamps: { robotAt: '2026-03-01T11:59:30.000Z', gatewayReceivedAt: '2026-03-01T11:59:31.000Z', cloudSyncedAt: null },
};
const ROBOT = { id: 'r1', displayName: 'Demo', isSynthetic: true };

/** Deep clone with one path replaced (undefined = delete the key). */
function withField(path: string[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(STATUS)) as Record<string, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

describe('robot status validation (shared contract)', () => {
  it('accepts a contract-valid status, including nullable timestamps and extra unknown fields', () => {
    expect(isRobotStatus(STATUS)).toBe(true);
    expect(isRobotStatus({ ...STATUS, timestamps: { ...STATUS.timestamps, gatewayReceivedAt: null } })).toBe(true);
    expect(isRobotStatus({ ...STATUS, futureField: 1 })).toBe(true);
    expect(isRobotStatusResponse({ status: STATUS, staleThresholdSeconds: 240 })).toBe(true);
    expect(isRobotStatusResponse({ status: null, staleThresholdSeconds: 240 })).toBe(true);
  });

  it.each([
    ['unknown state', ['state'], 'FLYING'],
    ['numeric state code instead of name', ['state'], 2],
    ['missing state', ['state'], undefined],
    ['unknown error flag', ['errorFlags'], ['LIME_EMPTY', 'ON_FIRE']],
    ['error flags not an array', ['errorFlags'], 'LIME_EMPTY'],
    ['component check outside ok/fault/unknown', ['componentChecks', 'GPS'], 'passed'],
    ['missing component', ['componentChecks', 'PUMP'], undefined],
    ['component checks not an object', ['componentChecks'], null],
    ['battery voltage as text', ['batteryVoltage'], '12.4'],
    ['battery voltage null', ['batteryVoltage'], null],
    ['commanded lime missing', ['totalLimeCommandedMl'], undefined],
    ['cells completed as text', ['cellsCompleted'], '7'],
    ['total cells missing', ['totalCells'], undefined],
    ['robot id missing', ['robotId'], undefined],
    ['robot time not ISO', ['timestamps', 'robotAt'], 'yesterday'],
    ['robot time without offset', ['timestamps', 'robotAt'], '2026-03-01T11:59:30'],
    ['robot time impossible date', ['timestamps', 'robotAt'], '2026-13-45T99:00:00Z'],
    ['robot time null (not nullable)', ['timestamps', 'robotAt'], null],
    ['gateway time wrong type', ['timestamps', 'gatewayReceivedAt'], 5],
    ['cloud time missing (must be null or ISO)', ['timestamps', 'cloudSyncedAt'], undefined],
    ['timestamps missing', ['timestamps'], undefined],
  ])('rejects %s', (_label, path, value) => {
    expect(isRobotStatus(withField(path, value))).toBe(false);
    expect(isRobotStatusResponse({ status: withField(path, value), staleThresholdSeconds: 240 })).toBe(false);
  });

  it('rejects a non-finite or missing stale threshold and a non-object status', () => {
    expect(isRobotStatusResponse({ status: STATUS, staleThresholdSeconds: Infinity })).toBe(false);
    expect(isRobotStatusResponse({ status: STATUS })).toBe(false);
    expect(isRobotStatusResponse({ status: [], staleThresholdSeconds: 240 })).toBe(false);
    expect(isRobotStatusResponse({ staleThresholdSeconds: 240 })).toBe(false); // status must be present (null allowed)
    expect(isRobotStatusResponse([])).toBe(false);
  });

  it.each([
    ['February 30', '2026-02-30T00:00:00Z'],
    ['February 31', '2026-02-31T00:00:00Z'],
    ['April 31', '2026-04-31T00:00:00Z'],
    ['February 29 in a non-leap year', '2025-02-29T12:00:00Z'],
    ['February 29 in a century non-leap year', '1900-02-29T12:00:00Z'],
    ['day 0', '2026-03-00T00:00:00Z'],
    ['month 0', '2026-00-10T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T23:60:00Z'],
    ['second 60 (no leap second, as in the LoRa validator)', '2026-12-31T23:59:60Z'],
    ['offset hour 24', '2026-01-01T00:00:00+24:00'],
    ['offset minute 60', '2026-01-01T00:00:00+05:60'],
  ])('rejects an impossible timestamp instead of shifting it: %s', (_label, value) => {
    expect(isIsoDateTime(value)).toBe(false);
    expect(isRobotStatus(withField(['timestamps', 'robotAt'], value))).toBe(false);
  });

  it.each([
    ['February 29 in a leap year', '2024-02-29T12:00:00Z'],
    ['February 29 in a 400-year leap year', '2000-02-29T00:00:00Z'],
    ['last second of a 30-day month', '2026-04-30T23:59:59Z'],
    ['an offset that crosses the UTC date (local Jan 1, UTC Dec 31)', '2026-01-01T07:30:00+08:00'],
    ['a negative offset that crosses the UTC date (local Dec 31, UTC Jan 1)', '2026-12-31T20:00:00-05:00'],
    ['the largest offset hour and minute', '2026-06-15T12:00:00+23:59'],
  ])('accepts a real timestamp: %s', (_label, value) => {
    expect(isIsoDateTime(value)).toBe(true);
  });

  it('accepts ISO 8601 with Z or a numeric offset, and nothing else', () => {
    for (const ok of ['2026-03-01T11:59:30Z', '2026-03-01T11:59:30.123Z', '2026-03-01T19:59:30+08:00', '2026-03-01T11:59Z']) {
      expect(isIsoDateTime(ok)).toBe(true);
    }
    for (const bad of ['2026-03-01', '2026-03-01 11:59:30Z', '1709294370', '', 'Z']) {
      expect(isIsoDateTime(bad)).toBe(false);
    }
  });
});

describe('pairing and session validation', () => {
  const pairing = { sessionToken: 'rlg1.x.y', robot: ROBOT, expiresAt: '2026-06-01T00:00:00.000Z' };

  it('accepts contract-valid answers', () => {
    expect(isPairingResponse(pairing)).toBe(true);
    expect(isSessionResponse({ robot: ROBOT, expiresAt: pairing.expiresAt })).toBe(true);
  });

  it('rejects missing or mistyped fields', () => {
    expect(isPairingResponse({ ...pairing, sessionToken: '' })).toBe(false);
    expect(isPairingResponse({ ...pairing, sessionToken: 42 })).toBe(false);
    expect(isPairingResponse({ ...pairing, expiresAt: 'soon' })).toBe(false);
    expect(isPairingResponse({ ...pairing, robot: { ...ROBOT, isSynthetic: 'yes' } })).toBe(false);
    expect(isPairingResponse({ ...pairing, robot: { id: 'r1' } })).toBe(false);
    expect(isSessionResponse({ robot: ROBOT })).toBe(false);
  });
});

describe('client: malformed success answers become invalid-response', () => {
  const fetchReturning = (status: number, text: string): FetchLike => async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  });
  const client = (text: string, status = 200) => createGatewayClient({ baseUrl: '', fetch: fetchReturning(status, text) });
  const invalid = { ok: false, failure: { kind: 'invalid-response' } };

  it('for malformed JSON', async () => {
    expect(await client('{"status": ').robotStatus('t')).toEqual(invalid);
    expect(await client('<html>').session('t')).toEqual(invalid);
    expect(await client('', 201).pair('ABCD-EFGH-JKMN')).toEqual(invalid);
  });

  it('for structurally invalid JSON, including invalid robot status fields', async () => {
    expect(await client('null').robotStatus('t')).toEqual(invalid);
    expect(await client('[]').robotStatus('t')).toEqual(invalid);
    expect(await client(JSON.stringify({ status: { ...STATUS, state: 'FLYING' }, staleThresholdSeconds: 240 })).robotStatus('t')).toEqual(invalid);
    expect(await client(JSON.stringify({ status: { ...STATUS, batteryVoltage: '12' }, staleThresholdSeconds: 240 })).robotStatus('t')).toEqual(invalid);
    expect(await client('{"status":null,"staleThresholdSeconds":1e400}').robotStatus('t')).toEqual(invalid);
    expect(await client(JSON.stringify({ sessionToken: 't', robot: ROBOT }), 201).pair('ABCD-EFGH-JKMN')).toEqual(invalid);
  });

  it('keeps valid answers fully compatible', async () => {
    const res = await client(JSON.stringify({ status: STATUS, staleThresholdSeconds: 240 })).robotStatus('t');
    expect(res).toEqual({ ok: true, data: { status: STATUS, staleThresholdSeconds: 240 } });
  });

  it('never puts the malformed payload into the result', async () => {
    const res = await client(JSON.stringify({ status: { ...STATUS, state: 'SECRET-PAYLOAD' }, staleThresholdSeconds: 240 })).robotStatus('t');
    expect(JSON.stringify(res)).not.toContain('SECRET-PAYLOAD');
  });
});
