/**
 * Which deployment this build is for (decision D41, D48):
 * - `field`: the laptop-local build served by the gateway (default).
 * - `online`: the Vercel build. The cloud data adapter and online claim flow
 *   do not exist yet (OPEN_ITEMS #14, D42), so this build must not pretend a
 *   field gateway is reachable; it shows an honest "not available yet" notice
 *   and makes no requests.
 * Set at build time with EXPO_PUBLIC_ROBOLIME_TARGET (inlined into the bundle;
 * never a secret). Any other value is a configuration error and fails closed.
 */
export type DeploymentTarget = 'field' | 'online' | 'invalid';

export function parseDeploymentTarget(raw: string | undefined): DeploymentTarget {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'field') return 'field';
  if (value === 'online') return 'online';
  return 'invalid';
}

export const deploymentTarget: DeploymentTarget = parseDeploymentTarget(process.env.EXPO_PUBLIC_ROBOLIME_TARGET);
