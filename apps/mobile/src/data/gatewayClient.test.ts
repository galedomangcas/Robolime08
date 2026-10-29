import { API_V1_ROUTES } from '@robolime/shared';

import { createGatewayClient, isSessionInvalid, type FetchLike } from './gatewayClient';

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

function fakeFetch(reply: Reply | ((url: string) => Promise<Reply>)) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = typeof reply === 'function' ? await reply(url) : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => r.headers?.[name] ?? null },
      text: async () => r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  return { fetch, calls };
}

describe('gateway client', () => {
  it('pairs with a JSON POST to the same-origin pairing route', async () => {
    const { fetch, calls } = fakeFetch({
      status: 201,
      body: { sessionToken: 't', robot: { id: 'r', displayName: 'R', isSynthetic: true }, expiresAt: '2026-06-01T00:00:00.000Z' },
    });
    const result = await createGatewayClient({ baseUrl: '', fetch }).pair('ABCD-1234');
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: API_V1_ROUTES.pairing, method: 'POST', body: '{"pairingCode":"ABCD-1234"}' });
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('sends the bearer token for session and status, joined to a configured base URL', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { status: null, staleThresholdSeconds: 240 } });
    const client = createGatewayClient({ baseUrl: 'http://192.168.137.1:8780/', fetch });
    await client.robotStatus('tok');
    await client.session('tok');
    expect(calls.map((c) => c.url)).toEqual([`http://192.168.137.1:8780${API_V1_ROUTES.robotStatus}`, `http://192.168.137.1:8780${API_V1_ROUTES.session}`]);
    expect(calls.every((c) => c.headers.Authorization === 'Bearer tok' && c.method === 'GET')).toBe(true);
  });

  it('reports API errors with their code and Retry-After', async () => {
    const { fetch } = fakeFetch({ status: 429, body: { error: { code: 'PAIRING_RATE_LIMITED', message: 'm' } }, headers: { 'Retry-After': '421' } });
    const result = await createGatewayClient({ baseUrl: '', fetch }).pair('x');
    expect(result).toEqual({ ok: false, failure: { kind: 'api', status: 429, code: 'PAIRING_RATE_LIMITED', retryAfterSeconds: 421 } });
  });

  it('tolerates an error body that is not the documented shape', async () => {
    const { fetch } = fakeFetch({ status: 502, text: '<html>bad gateway</html>' });
    const result = await createGatewayClient({ baseUrl: '', fetch }).robotStatus('t');
    expect(result).toEqual({ ok: false, failure: { kind: 'api', status: 502, code: null, retryAfterSeconds: null } });
  });

  it('reports an unusable success body as invalid-response', async () => {
    const { fetch } = fakeFetch({ status: 200, text: 'not json' });
    expect(await createGatewayClient({ baseUrl: '', fetch }).robotStatus('t')).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });

  it('distinguishes a network failure from a timeout', async () => {
    const unreachable: FetchLike = async () => {
      throw new TypeError('Failed to fetch http://secret-host');
    };
    expect(await createGatewayClient({ baseUrl: '', fetch: unreachable }).robotStatus('t')).toEqual({ ok: false, failure: { kind: 'unreachable' } });

    jest.useFakeTimers();
    try {
      const hanging: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      const pending = createGatewayClient({ baseUrl: '', fetch: hanging, timeoutMs: 10_000 }).robotStatus('t');
      jest.advanceTimersByTime(9_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await pending).toEqual({ ok: false, failure: { kind: 'timeout' } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats exactly the four session error codes as invalidating the session', () => {
    for (const code of ['UNPAIRED', 'INVALID_SESSION', 'SESSION_EXPIRED', 'SESSION_REVOKED'] as const) {
      expect(isSessionInvalid({ kind: 'api', status: 401, code, retryAfterSeconds: null })).toBe(true);
    }
    expect(isSessionInvalid({ kind: 'api', status: 500, code: 'INTERNAL_ERROR', retryAfterSeconds: null })).toBe(false);
    expect(isSessionInvalid({ kind: 'api', status: 401, code: null, retryAfterSeconds: null })).toBe(false);
    expect(isSessionInvalid({ kind: 'timeout' })).toBe(false);
    expect(isSessionInvalid({ kind: 'unreachable' })).toBe(false);
  });

  it('reads runs, readings and recommendations with the bearer token and an encoded run id', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { runs: [] } });
    const client = createGatewayClient({ baseUrl: '', fetch });
    expect((await client.runs('tok')).ok).toBe(true);
    await client.runReadings('tok', 'run/1 x');
    await client.runRecommendation('tok', 'run/1 x');
    expect(calls.map((c) => c.url)).toEqual([
      API_V1_ROUTES.runs,
      '/api/v1/runs/run%2F1%20x/readings',
      '/api/v1/runs/run%2F1%20x/recommendation',
    ]);
    expect(calls.every((c) => c.method === 'GET' && c.headers.Authorization === 'Bearer tok')).toBe(true);
  });

  it('reports a verification run in a runs answer as an invalid response', async () => {
    const run = {
      id: 'v', sourceRunId: 'V', runType: 'verification', fieldId: null, readingCount: 0,
      firstRobotRecordedAt: null, lastRobotRecordedAt: null, isSynthetic: true,
    };
    const { fetch } = fakeFetch({ status: 200, body: { runs: [run] } });
    expect(await createGatewayClient({ baseUrl: '', fetch }).runs('tok')).toEqual({ ok: false, failure: { kind: 'invalid-response' } });
  });

  it('reports a missing recommendation as NOT_FOUND', async () => {
    const { fetch } = fakeFetch({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'none' } } });
    expect(await createGatewayClient({ baseUrl: '', fetch }).runRecommendation('tok', 'r')).toEqual({
      ok: false,
      failure: { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null },
    });
  });

  it('only pairing, the field intent, the export READ and manual control (D57) are POSTs; manual control is the only robot command route', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: {} });
    const client = createGatewayClient({ baseUrl: '', fetch });
    expect(Object.keys(client).sort()).toEqual(['exportCsv', 'exportRuns', 'field', 'manualCommand', 'manualStatus', 'pair', 'robotStatus', 'runReadings', 'runRecommendation', 'runs', 'selectField', 'session']);
    await client.pair('ABCD-1234');
    await client.session('t');
    await client.robotStatus('t');
    await client.runs('t');
    await client.runReadings('t', 'r');
    await client.runRecommendation('t', 'r');
    await client.field('t');
    await client.exportRuns('t');
    await client.selectField('t', 'f1');
    await client.exportCsv('t', { kind: 'readings', runId: 'r' });
    const [pairCall, ...rest] = calls;
    expect(pairCall).toMatchObject({ method: 'POST', url: API_V1_ROUTES.pairing });
    const reads = rest.slice(0, 7);
    expect(reads.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
    // D54: recording the field choice (intent only) and building an export (read-only) are the only other POSTs.
    expect(rest.slice(7).map((c) => [c.method, c.url])).toEqual([['POST', API_V1_ROUTES.fieldSelections], ['POST', API_V1_ROUTES.exportCsv]]);
    expect(calls.map((c) => c.url).join(' ')).not.toMatch(/command|control|dose|dosing|motor|pump|actuator|navigate|start|stop/i);
    await client.manualStatus('t');
    await client.manualCommand('t', { type: 'STOP_ALL' });
    expect(calls.slice(-2).map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', API_V1_ROUTES.manualStatus, undefined],
      ['POST', API_V1_ROUTES.manualCommands, JSON.stringify({ command: { type: 'STOP_ALL' } })],
    ]);
  });

  it('reports a readings or recommendation answer for a different run as invalid-response', async () => {
    const run = {
      id: 'run-1', sourceRunId: 'R1', runType: 'dosing', fieldId: null, readingCount: 0,
      firstRobotRecordedAt: null, lastRobotRecordedAt: null, isSynthetic: true,
    };
    const recommendation = {
      recommendation: {
        id: 'rec', runId: 'run-1', ruleSetVersion: 'v1',
        inputs: { medianPh: 6, medianEc: 1, medianMoisturePercent: 30, medianTemperatureC: 28, season: 'dry', weatherSource: 'seasonal-defaults', weather: {} },
        allScores: [], shortlist: [], computedAt: '2026-03-01T09:00:00.000Z',
      },
      ruleSetStatus: 'draft',
      isSynthetic: true,
    };
    const client = (body: unknown) => createGatewayClient({ baseUrl: '', fetch: fakeFetch({ status: 200, body }).fetch });
    const invalid = { ok: false, failure: { kind: 'invalid-response' } };

    expect((await client({ run, readings: [] }).runReadings('t', 'run-1')).ok).toBe(true);
    expect(await client({ run, readings: [] }).runReadings('t', 'run-2')).toEqual(invalid);
    expect(await client({ run: { ...run, id: 7 }, readings: [] }).runReadings('t', 'run-1')).toEqual(invalid);
    expect((await client(recommendation).runRecommendation('t', 'run-1')).ok).toBe(true);
    expect(await client(recommendation).runRecommendation('t', 'run-2')).toEqual(invalid);
  });
});
