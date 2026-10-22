/**
 * Client-side configuration. Only EXPO_PUBLIC_* variables are available here,
 * and they are inlined into the app bundle at build time — never put secrets
 * in them. The app must launch with all of these unset.
 */

function readOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Default laptop gateway base URL for field (offline) mode, e.g.
 * "http://192.168.137.1:8080". A later phase adds an in-app setting so the
 * operator can change it without rebuilding.
 */
export const defaultGatewayUrl = readOptional(process.env.EXPO_PUBLIC_GATEWAY_URL);
