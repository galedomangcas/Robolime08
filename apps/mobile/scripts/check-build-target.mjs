// Build-time guard for the web export (D48, D49). Runs before `expo export`.
// - EXPO_PUBLIC_ROBOLIME_TARGET must be unset/"field" or "online"; anything
//   else fails the build (the app would only show a "misconfigured" notice).
// - On Vercel (VERCEL=1, set by Vercel's build environment) the target must be
//   "online": a field build there would show the laptop pairing flow and call
//   a gateway API that does not exist online.
// - No EXPO_PUBLIC_* variable may carry a privileged Supabase key: those
//   values are inlined into the public client bundle.
// Prints variable NAMES and decisions only, never values.
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
    if (/SERVICE_ROLE|SECRET/i.test(name) || (value ?? '').trim().startsWith('sb_secret_')) {
      return { ok: false, message: `${name} would expose a privileged key in the public client bundle. Remove it.` };
    }
  }
  return { ok: true, message: `web build target: ${target}` };
}

const result = check(process.env);
(result.ok ? process.stdout : process.stderr).write(`check-build-target: ${result.message}\n`);
process.exit(result.ok ? 0 : 1);
