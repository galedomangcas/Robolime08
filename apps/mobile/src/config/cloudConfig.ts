/**
 * Public hosted-Supabase configuration for the ONLINE build (D49). Only the
 * project URL and a PUBLIC key may reach the client bundle: EXPO_PUBLIC_*
 * values are inlined at build time and visible to anyone. A privileged key
 * (`sb_secret_…` or a JWT whose role is not `anon`) is refused, never used,
 * and never echoed. Any problem fails closed: no cloud request is ever made
 * with an unvalidated configuration. Field builds do not use this at all.
 */
export type CloudConfigProblem = 'missing' | 'invalid-url' | 'invalid-key' | 'privileged-key' | 'key-project-mismatch';

export type CloudConfig =
  | { ok: true; url: string; projectRef: string; publicKey: string }
  | { ok: false; problem: CloudConfigProblem };

/** Hosted project URLs only: https://<20-character ref>.supabase.co (no path). */
const PROJECT_URL = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{10,}$/;
const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

function decodeJwtPayload(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(globalThis.atob(base64));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseCloudConfig(rawUrl: string | undefined, rawKey: string | undefined): CloudConfig {
  const url = rawUrl?.trim() ?? '';
  const key = rawKey?.trim() ?? '';
  if (url === '' || key === '') return { ok: false, problem: 'missing' };
  // Checked before the URL so a leaked secret is always reported as such.
  if (key.startsWith('sb_secret_')) return { ok: false, problem: 'privileged-key' };
  const urlMatch = PROJECT_URL.exec(url);
  if (urlMatch === null) return { ok: false, problem: 'invalid-url' };
  const projectRef = urlMatch[1] ?? '';
  if (PUBLISHABLE_KEY.test(key)) {
    return { ok: true, url: `https://${projectRef}.supabase.co`, projectRef, publicKey: key };
  }
  const jwtMatch = JWT.exec(key);
  if (jwtMatch === null) return { ok: false, problem: 'invalid-key' };
  const payload = decodeJwtPayload(jwtMatch[1] ?? '');
  if (payload === null) return { ok: false, problem: 'invalid-key' };
  if (payload.role !== 'anon') {
    return { ok: false, problem: payload.role === undefined ? 'invalid-key' : 'privileged-key' };
  }
  if (payload.ref !== undefined && payload.ref !== projectRef) return { ok: false, problem: 'key-project-mismatch' };
  return { ok: true, url: `https://${projectRef}.supabase.co`, projectRef, publicKey: key };
}

/** Not used by any screen yet: the online build stays "not available" until D49's prerequisites are met. */
export const cloudConfig: CloudConfig = parseCloudConfig(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);
