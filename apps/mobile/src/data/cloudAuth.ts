import type { CloudConfig } from '../config/cloudConfig';
import { REQUEST_TIMEOUT_MS } from '../config/timing';
import type { FetchLike } from './gatewayClient';
import type { CloudSessionProvider } from './cloudReader';
import type { KeyValueStorage } from './sessionStore';

/**
 * Online sign-in for the Vercel build (D52): Supabase Auth ANONYMOUS sign-in
 * over plain `fetch`. No email, phone or third-party identity is requested
 * (CLAUDE.md §4). An anonymous session alone grants nothing: RLS shows rows
 * only after the server-side `claim_robot()` accepted a claim code.
 *
 * The session (access + refresh token) is kept in this browser's storage, like
 * the local pairing session (same XSS/extension caveats, D33). Clearing it
 * loses the anonymous identity; the user then claims again with a code.
 * Only the project's PUBLIC key is ever sent as `apikey`.
 */
export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  userId: string;
}

export type CloudAuthFailure =
  | { kind: 'not-configured' }
  /** Anonymous sign-ins are switched off in the project's Auth settings. */
  | { kind: 'anonymous-disabled' }
  | { kind: 'rate-limited' }
  | { kind: 'timeout' }
  | { kind: 'unreachable' }
  | { kind: 'http'; status: number }
  | { kind: 'invalid-response' };

export type CloudAuthResult<T> = { ok: true; data: T } | { ok: false; failure: CloudAuthFailure };

export interface CloudAuth extends CloudSessionProvider {
  /** The stored session, if any (not refreshed). */
  current(): CloudSession | null;
  signInAnonymously(): Promise<CloudAuthResult<CloudSession>>;
  /** Forgets the session in this browser and asks the server to end it (best effort). */
  signOut(): Promise<void>;
}

export const CLOUD_SESSION_STORAGE_KEY = 'robolime.cloudSession.v1';
/** Refresh this many seconds before expiry. */
const REFRESH_MARGIN_SECONDS = 60;

function isCloudSession(v: unknown): v is CloudSession {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.accessToken === 'string' && s.accessToken !== '' &&
    typeof s.refreshToken === 'string' && s.refreshToken !== '' &&
    typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt) &&
    typeof s.userId === 'string' && s.userId !== ''
  );
}

/** Maps a GoTrue token response to a session, or null if it is not the documented shape. */
export function sessionFromTokenResponse(json: unknown, nowSeconds: number): CloudSession | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  const user = r.user as Record<string, unknown> | null | undefined;
  if (typeof r.access_token !== 'string' || r.access_token === '' || typeof r.refresh_token !== 'string' || r.refresh_token === '') {
    return null;
  }
  if (typeof user !== 'object' || user === null || typeof user.id !== 'string') return null;
  const expiresAt =
    typeof r.expires_at === 'number' ? r.expires_at : typeof r.expires_in === 'number' ? nowSeconds + r.expires_in : null;
  if (expiresAt === null || !Number.isFinite(expiresAt)) return null;
  return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt, userId: user.id };
}

export function createCloudAuth(options: {
  config: CloudConfig;
  storage: KeyValueStorage | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  nowSeconds?: () => number;
}): CloudAuth {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let refreshing: Promise<string | null> | null = null;

  function load(): CloudSession | null {
    try {
      const raw = options.storage?.getItem(CLOUD_SESSION_STORAGE_KEY) ?? null;
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return isCloudSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  function save(session: CloudSession | null): void {
    try {
      if (session === null) options.storage?.removeItem(CLOUD_SESSION_STORAGE_KEY);
      else options.storage?.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage blocked: the session lasts for this page only.
    }
  }
  let memory: CloudSession | null = load();

  async function post(path: string, body: unknown, bearer?: string): Promise<CloudAuthResult<{ status: number; json: unknown }>> {
    const { config } = options;
    if (!config.ok) return { ok: false, failure: { kind: 'not-configured' } };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const headers: Record<string, string> = { apikey: config.publicKey, 'Content-Type': 'application/json', Accept: 'application/json' };
      if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
      const res = await doFetch(`${config.url}/auth/v1/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { ok: true, data: { status: res.status, json } };
    } catch {
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  function failureFor(status: number, json: unknown): CloudAuthFailure {
    const code = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).error_code ?? (json as Record<string, unknown>).code : null;
    if (code === 'anonymous_provider_disabled' || (status === 422 && JSON.stringify(json).includes('nonymous'))) {
      return { kind: 'anonymous-disabled' };
    }
    if (status === 429) return { kind: 'rate-limited' };
    return { kind: 'http', status };
  }

  async function refresh(session: CloudSession): Promise<string | null> {
    const result = await post('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    if (!result.ok) return null; // offline: keep the session for later, but no usable token now
    const next = result.data.status === 200 ? sessionFromTokenResponse(result.data.json, nowSeconds()) : null;
    if (next === null) {
      if (result.data.status === 400 || result.data.status === 401) {
        // The refresh token was rejected: this identity cannot be recovered.
        memory = null;
        save(null);
      }
      return null;
    }
    memory = next;
    save(next);
    return next.accessToken;
  }

  return {
    current: () => memory,

    async accessToken() {
      const session = memory;
      if (session === null) return null;
      if (session.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds()) return session.accessToken;
      refreshing ??= refresh(session).finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    async signInAnonymously() {
      const result = await post('signup', { data: {} });
      if (!result.ok) return result;
      if (result.data.status !== 200) return { ok: false, failure: failureFor(result.data.status, result.data.json) };
      const session = sessionFromTokenResponse(result.data.json, nowSeconds());
      if (session === null) return { ok: false, failure: { kind: 'invalid-response' } };
      memory = session;
      save(session);
      return { ok: true, data: session };
    },

    async signOut() {
      const session = memory;
      memory = null;
      save(null);
      if (session !== null) await post('logout', {}, session.accessToken);
    },
  };
}
