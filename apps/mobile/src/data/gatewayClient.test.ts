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
});
