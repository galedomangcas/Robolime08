import type { CloudConfig } from '../config/cloudConfig';
import { CLOUD_SESSION_STORAGE_KEY, createCloudAuth, sessionFromTokenResponse } from './cloudAuth';
import { createCloudReader, type CloudSessionProvider } from './cloudReader';
import { cloudToGatewayFailure, createCloudDataSource } from './dataSource';
import type { FetchLike } from './gatewayClient';
import type { KeyValueStorage } from './sessionStore';

/** D52: anonymous sign-in, server-verified claim, and cloud reads mapped to the app contracts. */
const CONFIG: CloudConfig = { ok: true, url: 'https://abcdefghijklmnopqrst.supabase.co', projectRef: 'abcdefghijklmnopqrst', publicKey: 'sb_publishable_test_only' };
const ROBOT = '7f9c2ba4-e88f-4f3b-9c1d-111111111111';
const RUN = '14f6a315-e343-5ec6-9eec-4234a077079a';
const REC = '25a6b315-e343-5ec6-9eec-4234a077079b';
const signedIn: CloudSessionProvider = { accessToken: async () => 'user-access-token-test-only' };

type Reply = { status: number; body: unknown };
function routedFetch(route: (url: string, method: string, body?: string) => Reply | 'throw') {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const reply = route(url, init.method, init.body);
    if (reply === 'throw') throw new TypeError('fetch failed');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: { get: () => null }, text: async () => JSON.stringify(reply.body) };
  };
  return { fetch, calls };
}

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const TOKEN_RESPONSE = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, user: { id: 'u-1', is_anonymous: true } };

describe('cloudAuth (anonymous Supabase sign-in)', () => {
  it('signs in anonymously with the public key only, and stores the session', async () => {
    const storage = memoryStorage();
    const { fetch, calls } = routedFetch(() => ({ status: 200, body: TOKEN_RESPONSE }));
    const auth = createCloudAuth({ config: CONFIG, storage, fetch, nowSeconds: () => 1000 });
    const result = await auth.signInAnonymously();
    expect(result).toEqual({ ok: true, data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 4600, userId: 'u-1' } });
    expect(calls[0]?.url).toBe('https://abcdefghijklmnopqrst.supabase.co/auth/v1/signup');
    expect(calls[0]?.headers.apikey).toBe('sb_publishable_test_only');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.body).toBe('{"data":{}}'); // no email, phone or identity
    expect(JSON.parse(storage.data.get(CLOUD_SESSION_STORAGE_KEY) ?? '{}').userId).toBe('u-1');
    expect(await auth.accessToken()).toBe('at-1');
  });

  it('reports disabled anonymous sign-ins precisely', async () => {
    const { fetch } = routedFetch(() => ({ status: 422, body: { code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' } }));
    const auth = createCloudAuth({ config: CONFIG, storage: memoryStorage(), fetch });
    expect(await auth.signInAnonymously()).toEqual({ ok: false, failure: { kind: 'anonymous-disabled' } });
    expect(auth.current()).toBeNull();
  });

  it('refreshes an expiring token once, and forgets a rejected refresh token', async () => {
    const storage = memoryStorage();
    storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1010, userId: 'u-1' }));
    let reply: Reply = { status: 200, body: { ...TOKEN_RESPONSE, access_token: 'at-2' } };
    const { fetch, calls } = routedFetch(() => reply);
    const auth = createCloudAuth({ config: CONFIG, storage, fetch, nowSeconds: () => 1000 });
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect([a, b]).toEqual(['at-2', 'at-2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/auth/v1/token?grant_type=refresh_token');

    storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 'old', refreshToken: 'bad', expiresAt: 0, userId: 'u-1' }));
    reply = { status: 400, body: { error_code: 'refresh_token_not_found' } };
    const auth2 = createCloudAuth({ config: CONFIG, storage, fetch, nowSeconds: () => 1000 });
    expect(await auth2.accessToken()).toBeNull();
    expect(auth2.current()).toBeNull();
    expect(storage.data.has(CLOUD_SESSION_STORAGE_KEY)).toBe(false);
  });

  it('keeps the session but returns no token while offline', async () => {
    const storage = memoryStorage();
    storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 'old', refreshToken: 'rt', expiresAt: 0, userId: 'u-1' }));
    const { fetch } = routedFetch(() => 'throw');
    const auth = createCloudAuth({ config: CONFIG, storage, fetch, nowSeconds: () => 1000 });
    expect(await auth.accessToken()).toBeNull();
    expect(auth.current()).not.toBeNull();
  });

  it('never makes a request without a valid configuration', async () => {
    const { fetch, calls } = routedFetch(() => ({ status: 200, body: TOKEN_RESPONSE }));
    const auth = createCloudAuth({ config: { ok: false, problem: 'missing' }, storage: null, fetch });
    expect(await auth.signInAnonymously()).toEqual({ ok: false, failure: { kind: 'not-configured' } });
    expect(calls).toHaveLength(0);
  });

  it('rejects token responses that are not the documented shape', () => {
    expect(sessionFromTokenResponse({ access_token: 'a' }, 0)).toBeNull();
    expect(sessionFromTokenResponse({ ...TOKEN_RESPONSE, user: null }, 0)).toBeNull();
  });
});

describe('cloudReader.claimRobot (server-verified claim)', () => {
  it('posts only the code to claim_robot with the user token, and returns the claimed robot', async () => {
    const { fetch, calls } = routedFetch(() => ({ status: 200, body: [{ result: 'claimed', robot_id: ROBOT, display_name: 'Robot A', is_synthetic: false }] }));
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch });
    expect(await reader.claimRobot('ABCD-2345-EFGH')).toEqual({
      ok: true,
      data: { kind: 'claimed', robot: { id: ROBOT, displayName: 'Robot A', isSynthetic: false } },
    });
    expect(calls[0]).toMatchObject({ url: 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/claim_robot', method: 'POST', body: '{"p_code":"ABCD-2345-EFGH"}' });
    expect(calls[0]?.headers.Authorization).toBe('Bearer user-access-token-test-only');
  });

  it.each([
    ['invalid-code', { kind: 'invalid-code' }],
    ['rate-limited', { kind: 'rate-limited' }],
  ])('reports %s as a settled answer', async (result, expected) => {
    const { fetch } = routedFetch(() => ({ status: 200, body: [{ result, robot_id: null, display_name: null, is_synthetic: null }] }));
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch });
    expect(await reader.claimRobot('x')).toEqual({ ok: true, data: expected });
  });

  it('does not claim without a sign-in, and treats an unexpected answer as invalid', async () => {
    const out = routedFetch(() => ({ status: 200, body: [] }));
    const signedOutReader = createCloudReader({ config: CONFIG, session: { accessToken: async () => null }, fetch: out.fetch });
    expect(await signedOutReader.claimRobot('x')).toEqual({ ok: false, failure: { kind: 'auth-required' } });
    expect(out.calls).toHaveLength(0);
    const odd = routedFetch(() => ({ status: 200, body: [{ result: 'claimed', robot_id: 'not-a-uuid' }] }));
    const reader = createCloudReader({ config: CONFIG, session: signedIn, fetch: odd.fetch });
    expect(await reader.claimRobot('x')).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });
});

const READING_ROW = {
  run_id: RUN, cell_index: 0, seq: 0, attempt_count: 1, ph: 5.4, ec: 0.3, moisture_percent: 25, temperature_c: 27,
  dose_volume_ml: 50, expected_post_correction_ph: 6.0, gps_latitude: 13.88, gps_longitude: 120.63, raw_flags: 0,
  robot_recorded_at: '2026-01-15T00:03:00+00:00', gateway_received_at: '2026-01-15T00:03:01+00:00', cloud_received_at: '2026-01-15T01:00:00+00:00',
};

function cloudMirror(url: string): Reply {
  const path = url.replace(`${CONFIG.ok ? CONFIG.url : ''}/rest/v1/`, '');
  if (path.startsWith('runs?') && path.includes(`id=eq.${RUN}`)) {
    return { status: 200, body: path.includes('run_type=eq.dosing') ? [{ id: RUN, source_run_id: 'R1', field_id: null, is_synthetic: true }] : [] };
  }
  if (path.startsWith('runs?')) return { status: 200, body: [{ id: RUN, source_run_id: 'R1', field_id: null, is_synthetic: true }] };
  if (path.startsWith('readings?select=run_id,robot_recorded_at')) {
    return { status: 200, body: [{ run_id: RUN, robot_recorded_at: '2026-01-15T00:57:00+00:00' }, { run_id: RUN, robot_recorded_at: '2026-01-15T00:03:00+00:00' }] };
  }
  if (path.startsWith('readings?')) return { status: 200, body: [READING_ROW] };
  if (path.startsWith('recommendations?')) {
    return {
      status: 200,
      body: [{
        id: REC, run_id: RUN, computed_at: '2026-01-15T02:00:00+00:00', rule_sets: { version: 'demo-1', status: 'draft', is_synthetic: true },
        inputs: { medianPh: 6, medianEc: 0.3, medianMoisturePercent: 25, medianTemperatureC: 27, season: 'dry', weatherSource: 'seasonal-defaults', weather: { rainfall_mm: 10 } },
      }],
    };
  }
  if (path.startsWith('recommendation_scores?')) {
    return {
      status: 200,
      body: [
        { crop_key: 'a', score: 0.9, shortlist_rank: 1, reasons: ['pH in range'], rule_crops: { display_name: 'Crop A', category: 'grain' } },
        { crop_key: 'b', score: 0.4, shortlist_rank: null, reasons: ['pH low'], rule_crops: { display_name: 'Crop B', category: 'grain' } },
      ],
    };
  }
  return { status: 404, body: {} };
}

describe('cloud data source (D52)', () => {
  it('lists dosing runs only, with counts and robot-side first/last times', async () => {
    const { fetch, calls } = routedFetch(cloudMirror);
    const source = createCloudDataSource(createCloudReader({ config: CONFIG, session: signedIn, fetch }), ROBOT);
    const runs = await source.runs('ignored');
    expect(runs).toEqual({
      ok: true,
      data: { runs: [{ id: RUN, sourceRunId: 'R1', runType: 'dosing', fieldId: null, readingCount: 2, firstRobotRecordedAt: '2026-01-15T00:03:00+00:00', lastRobotRecordedAt: '2026-01-15T00:57:00+00:00', isSynthetic: true }] },
    });
    expect(calls[0]?.url).toContain('run_type=eq.dosing');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('maps readings and the stored recommendation to the shared contracts', async () => {
    const { fetch } = routedFetch(cloudMirror);
    const source = createCloudDataSource(createCloudReader({ config: CONFIG, session: signedIn, fetch }), ROBOT);
    const readings = await source.runReadings('ignored', RUN);
    expect(readings.ok && readings.data.readings[0]).toMatchObject({ runId: RUN, cellIndex: 0, ph: 5.4, gps: { latitude: 13.88, longitude: 120.63 } });
    const rec = await source.runRecommendation('ignored', RUN);
    expect(rec.ok && rec.data.recommendation.shortlist.map((s) => s.cropName)).toEqual(['Crop A']);
    expect(rec.ok && rec.data.recommendation.allScores).toHaveLength(2);
    expect(rec.ok && rec.data.isSynthetic).toBe(true);
  });

  it('answers NOT_FOUND for a run that is not a visible dosing run (verification runs stay hidden)', async () => {
    const { fetch } = routedFetch((url) => (url.includes('/runs?') ? { status: 200, body: [] } : cloudMirror(url)));
    const source = createCloudDataSource(createCloudReader({ config: CONFIG, session: signedIn, fetch }), ROBOT);
    expect(await source.runReadings('ignored', RUN)).toEqual({ ok: false, failure: { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null } });
    expect(await source.runRecommendation('ignored', RUN)).toEqual({ ok: false, failure: { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null } });
  });

  it('maps a lost sign-in to INVALID_SESSION and an outage to unreachable', async () => {
    expect(cloudToGatewayFailure({ kind: 'auth-required' })).toEqual({ kind: 'api', status: 401, code: 'INVALID_SESSION', retryAfterSeconds: null });
    const { fetch } = routedFetch(() => 'throw');
    const source = createCloudDataSource(createCloudReader({ config: CONFIG, session: signedIn, fetch }), ROBOT);
    expect(await source.robotStatus('ignored')).toEqual({ ok: false, failure: { kind: 'unreachable' } });
  });

  it('rejects a malformed recommendation instead of showing it', async () => {
    const { fetch } = routedFetch((url) =>
      url.includes('/recommendation_scores?') ? { status: 200, body: [{ crop_key: 'a', score: 'high', shortlist_rank: 1, reasons: [], rule_crops: { display_name: 'A', category: 'g' } }] } : cloudMirror(url),
    );
    const source = createCloudDataSource(createCloudReader({ config: CONFIG, session: signedIn, fetch }), ROBOT);
    expect(await source.runRecommendation('ignored', RUN)).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });
});
