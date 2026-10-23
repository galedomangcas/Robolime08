import { isIP } from 'node:net';

/**
 * Local HTTP server configuration (Phase 4, milestone 1).
 *
 * LOOPBACK ONLY. The server binds to 127.0.0.1 by default and accepts only
 * loopback addresses. Wildcard (0.0.0.0, ::) and LAN addresses are refused
 * with an error — never silently replaced — because pairing-attempt rate
 * limiting (OPEN_ITEMS #16) must exist before the API is reachable from the
 * field Wi-Fi. LAN binding is a later milestone (decision D28).
 */
export const DEFAULT_GATEWAY_HOST = '127.0.0.1';

/** Unprivileged port, clear of Expo/Metro (8081) and the Expo web dev server. */
export const DEFAULT_GATEWAY_PORT = 8780;

/** Largest accepted request body. API bodies are tiny ({pairingCode}, {fieldId}). */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Whole request (headers + body) must arrive within this time. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Request headers must arrive within this time (slow-header protection). */
export const HEADERS_TIMEOUT_MS = 10_000;
/** Idle keep-alive connections are closed after this time. */
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/**
 * How often Node sweeps open connections for the header/request timeouts
 * above. Node's default is 30 s, which let a stalled request live ~30–45 s
 * instead of 10/15 s; at 1 s each timeout is enforced within about 1 s.
 */
export const CONNECTIONS_CHECK_INTERVAL_MS = 1_000;

export interface HttpServerConfig {
  host: string;
  /** 1–65535, or 0 (ephemeral) when requested programmatically by tests. */
  port: number;
}

export class GatewayConfigError extends Error {
  override name = 'GatewayConfigError';
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']);

/** True for 127.0.0.0/8 and ::1 written as IP literals. */
export function isLoopbackAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  if (version === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

/** Validates a host. Errors name the problem but never echo unrelated settings. */
export function parseHost(raw: string): string {
  const host = raw.trim();
  if (WILDCARD_HOSTS.has(host)) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" would listen on every network interface. ` +
        'This build serves loopback only (127.0.0.1 or ::1); LAN access is not enabled yet.',
    );
  }
  if (isIP(host) === 0) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" is not an IP address. Use a literal loopback address such as 127.0.0.1.`,
    );
  }
  if (!isLoopbackAddress(host)) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" is not a loopback address. This build serves loopback only; ` +
        'LAN binding needs pairing rate limiting first (OPEN_ITEMS #16).',
    );
  }
  return host;
}

/** Validates a port given as text (environment or CLI): an integer 1–65535. */
export function parsePort(raw: string): number {
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new GatewayConfigError(`GATEWAY_PORT "${text}" is not a whole number between 1 and 65535.`);
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new GatewayConfigError(`GATEWAY_PORT ${port} is outside 1–65535.`);
  }
  return port;
}

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/**
 * Resolves the HTTP configuration. Precedence: explicit argument (CLI flag)
 * > environment variable > default. Empty values count as unset, matching the
 * blank entries in .env.example.
 */
export function resolveHttpConfig(
  env: Readonly<Record<string, string | undefined>>,
  overrides: { host?: string; port?: string } = {},
): HttpServerConfig {
  const host = overrides.host ?? env.GATEWAY_HOST;
  const port = overrides.port ?? env.GATEWAY_PORT;
  return {
    host: present(host) ? parseHost(host) : DEFAULT_GATEWAY_HOST,
    port: present(port) ? parsePort(port) : DEFAULT_GATEWAY_PORT,
  };
}
