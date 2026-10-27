import type { CloudConfig } from '../config/cloudConfig';
import { createCloudReader, statusFromCloudRow, type CloudSessionProvider } from './cloudReader';
import type { FetchLike } from './gatewayClient';

const CONFIG: CloudConfig = { ok: true, url: 'https://abcdefghijklmnopqrst.supabase.co', projectRef: 'abcdefghijklmnopqrst', publicKey: 'sb_publishable_test_only' };
const ROBOT = '7f9c2ba4-e88f-4f3b-9c1d-111111111111';
const ROW = {
  robot_id: ROBOT,
  state: 'WORKING',
  error_flags: 0b0000_0101, // LIME_EMPTY + PROBE_FAULT
  battery_voltage: 12.4,
  total_lime_commanded_ml: 1250,
  cells_completed: 7,
  total_cells: 20,
  robot_reported_at: '2026-03-01T08:00:00+00:00',
  gateway_received_at: '2026-03-01T08:00:01.5+00:00',
  cloud_received_at: '2026-03-01T09:00:00.123456+00:00',
};

const signedIn: CloudSessionProvider = { accessToken: async () => 'user-access-token-test-only' };
const signedOut: CloudSessionProvider = { accessToken: async () => null };

function fakeFetch(reply: { status: number; body?: unknown; text?: string } | 'throw') {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (reply === 'throw') throw new TypeError('fetch failed');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: () => null },
      text: async () => reply.text ?? JSON.stringify(reply.body),
    };
  };
  return { fetch, calls };
}

describe('cloud row mapping', () => {
  it('maps a status row to the app contract without guessing component checks', () => {
    const status = statusFromCloudRow(ROW);
    expect(status).toMatchObject({
      robotId: ROBOT,
      state: 'WORKING',
      errorFlags: ['LIME_EMPTY', 'PROBE_FAULT'],
      batteryVoltage: 12.4,
      totalLimeCommandedMl: 1250,
      timestamps: { robotAt: ROW.robot_reported_at, gatewayReceivedAt: ROW.gateway_received_at, cloudSyncedAt: ROW.cloud_received_at },
    });
    expect(Object.values(status?.componentChecks ?? {}).every((c) => c === 'unknown')).toBe(true);
  });

  it('rejects malformed rows', () => {
    for (const patch of [{ state: 'RUNNING' }, { error_flags: 256 }, { error_flags: 1.5 }, { battery_voltage: null }, { robot_reported_at: '2026-02-30T00:00:00Z' }, { robot_id: 5 }]) {
      expect(statusFromCloudRow({ ...ROW, ...patch })).toBeNull();
    }
    expect(statusFromCloudRow(null)).toBeNull();
  });
});

describe('cloud reader (read-only, session required)', () => {
  it('makes no request when the configuration is invalid or nobody is signed in', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: [] });
    const notConfigured = createCloudReader({ config: { ok: false, problem: 'missing' }, session: signedIn, fetch });
    expect(await notConfigured.robotStatus(ROBOT)).toEqual({ ok: false, failure: { kind: 'not-configured' } });
    const anonymous = createCloudReader({ config: CONFIG, session: signedOut, fetch });
    expect(await anonymous.robotStatus(ROBOT)).toEqual({ ok: false, failure: { kind: 'auth-required' } });
    expect(await anonymous.claimedRobotIds()).toEqual({ ok: false, failure: { kind: 'auth-required' } });
    const throwing = createCloudReader({ config: CONFIG, session: { accessToken: async () => { throw new Error('x'); } }, fetch });
    expect(await throwing.claimedRobotIds()).toEqual({ ok: false, failure: { kind: 'auth-required' } });
    expect(calls).toHaveLength(0);
  });

  it('sends a bodiless GET with the public key and the user token to the PostgREST table, scoped by robot', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: [ROW] });
    const result = await createCloudReader({ config: CONFIG, session: signedIn, fetch }).robotStatus(ROBOT);
    expect(result.ok && result.data.status?.state).toBe('WORKING');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.body).toBeUndefined();
    expect(call?.url.startsWith('https://abcdefghijklmnopqrst.supabase.co/rest/v1/robot_status_reports?')).toBe(true);
    expect(call?.url).toContain(`robot_id=eq.${ROBOT}`);
    expect(call?.url).toContain('order=robot_reported_at.desc&limit=1');
    expect(call?.headers).toEqual({ apikey: 'sb_publishable_test_only', Authorization: 'Bearer user-access-token-test-only', Accept: 'application/json' });
  });

  it('treats rows hidden by RLS as "no data", never as an error or a claim', async () => {
    const { fetch } = fakeFetch({ status: 200, body: [] });
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch });
    expect(await reader.robotStatus(ROBOT)).toEqual({ ok: true, data: { status: null, staleThresholdSeconds: 240 } });
    expect(await reader.claimedRobotIds()).toEqual({ ok: true, data: [] });
  });

  it('maps authentication, permission, server and transport failures', async () => {
    const cases: [Parameters<typeof fakeFetch>[0], unknown][] = [
      [{ status: 401, body: { message: 'JWT expired' } }, { kind: 'auth-required' }],
      [{ status: 403, body: { message: 'permission denied' } }, { kind: 'forbidden' }],
      [{ status: 500, body: {} }, { kind: 'http', status: 500 }],
      [{ status: 200, text: 'not json' }, { kind: 'invalid-response' }],
      [{ status: 200, body: { not: 'an array' } }, { kind: 'invalid-response' }],
      ['throw', { kind: 'unreachable' }],
    ];
    for (const [reply, failure] of cases) {
      const { fetch } = fakeFetch(reply);
      expect(await createCloudReader({ config: CONFIG, session: signedIn, fetch }).robotStatus(ROBOT)).toEqual({ ok: false, failure });
    }
  });

  it('times out instead of hanging', async () => {
    const never: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const result = await createCloudReader({ config: CONFIG, session: signedIn, fetch: never, timeoutMs: 10 }).robotStatus(ROBOT);
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('never queries with a non-UUID robot id, and rejects rows for another robot', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: [ROW] });
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch });
    for (const bad of ['', 'abc', `${ROBOT}&select=*`, 'eq.1,or=(id.gt.0)']) {
      expect(await reader.robotStatus(bad)).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
    }
    expect(calls).toHaveLength(0);
    const other = '7f9c2ba4-e88f-4f3b-9c1d-222222222222';
    expect(await reader.robotStatus(other)).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });

  it('returns claimed robot ids only when every row is well formed', async () => {
    const good = fakeFetch({ status: 200, body: [{ robot_id: ROBOT }, { robot_id: ROBOT }] });
    expect(await createCloudReader({ config: CONFIG, session: signedIn, fetch: good.fetch }).claimedRobotIds()).toEqual({ ok: true, data: [ROBOT] });
    expect(good.calls[0]?.url).toContain('robot_claims?select=robot_id&revoked_at=is.null');
    const bad = fakeFetch({ status: 200, body: [{ robot_id: 'not-a-uuid' }] });
    expect(await createCloudReader({ config: CONFIG, session: signedIn, fetch: bad.fetch }).claimedRobotIds()).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });

  it('exposes read methods only: no write, claim, command, RPC or dosing path', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: [] });
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch });
    expect(Object.keys(reader).sort()).toEqual(['claimedRobotIds', 'robotStatus']);
    await reader.claimedRobotIds();
    await reader.robotStatus(ROBOT);
    expect(calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
    // Only these two tables are ever read; never an RPC endpoint or any other path.
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths).toEqual(['/rest/v1/robot_claims', '/rest/v1/robot_status_reports']);
  });
});
