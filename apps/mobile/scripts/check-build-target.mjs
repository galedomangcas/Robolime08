// Build-time guard for the web export (D48, D49). Runs before `expo export`.
// - EXPO_PUBLIC_ROBOLIME_TARGET must be unset/"field" or "online"; anything
//   else fails the build (the app would only show a "misconfigured" notice).
// - On Vercel (VERCEL=1, set by Vercel's build environment) the target must be
//   "online": a field build there would show the laptop pairing flow and call
//   a gateway API that does not exist online.
// - No EXPO_PUBLIC_* variable may carry a privileged Supabase key: those
//   values are inlined into the public client bundle.
// Prints variable NAMES and decisions only, never values.
import { Buffer } from 'node:buffer';
import process from 'node:process';

function check(env) {
  const raw = (env.EXPO_PUBLIC_ROBOLIME_TARGET ?? '').trim().toLowerCase();
  const target = raw === '' || raw === 'field' ? 'field' : raw === 'online' ? 'online' : 'invalid';
  if (target === 'invalid') return { ok: false, message: 'EXPO_PUBLIC_ROBOLIME_TARGET must be "field" or "online".' };
  if (env.VERCEL === '1' && target !== 'online') {
    return { ok: false, message: 'Refusing a field build on Vercel: set EXPO_PUBLIC_ROBOLIME_TARGET=online (see vercel.json).' };
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('EXPO_PUBLIC_')) continue;
    if (/SERVICE_ROLE|SECRET/i.test(name) || (value ?? '').trim().startsWith('sb_secret_') || jwtRoleIsPrivileged(value)) {
      return { ok: false, message: `${name} would expose a privileged key in the public client bundle. Remove it.` };
    }
  }
  // D52: the Vercel build needs the public project settings, or it would only show "not configured".
  if (env.VERCEL === '1') {
    for (const name of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']) {
      if ((env[name] ?? '').trim() === '') return { ok: false, message: `${name} is not set for this Vercel environment.` };
    }
  }
  return { ok: true, message: `web build target: ${target}` };
}

/** True for a JWT whose payload role is anything but "anon" (e.g. a legacy service_role key). */
function jwtRoleIsPrivileged(value) {
  const parts = (value ?? '').trim().split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload === 'object' && payload !== null && 'role' in payload && payload.role !== 'anon';
  } catch {
    return false;
  }
}

const result = check(process.env);
(result.ok ? process.stdout : process.stderr).write(`check-build-target: ${result.message}\n`);
process.exit(result.ok ? 0 : 1);
