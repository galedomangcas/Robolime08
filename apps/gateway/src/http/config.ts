import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Local HTTP server configuration (Phase 4, milestone 1; LAN mode: D36).
 *
 * LOOPBACK BY DEFAULT. Without an explicit opt-in the server binds to
 * 127.0.0.1 and accepts only loopback addresses. LAN mode (D36) needs BOTH
 * `GATEWAY_LAN_MODE=on` (or `--lan`) AND an IPv4 literal inside RFC 1918
 * that is assigned to a local network interface. Anything else — wildcard,
 * loopback, public, link-local, CGNAT, multicast, IPv6, a host name or an
 * unassigned address — is refused with an error and never silently replaced
 * by another address (fail closed).
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

/** `loopback`: the default. `lan`: D36 opt-in, one validated private IPv4 address. */
export type GatewayBindMode = 'loopback' | 'lan';

export interface HttpServerConfig {
  mode: GatewayBindMode;
  host: string;
  /** 1–65535, or 0 (ephemeral) when requested programmatically by tests. */
  port: number;
  /** Exported web app folder to serve (D33); null = static serving disabled. */
  webDir: string | null;
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

/** Validates a loopback-mode host. Errors name the problem but never echo unrelated settings. */
export function parseHost(raw: string): string {
  const host = raw.trim();
  if (WILDCARD_HOSTS.has(host)) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" would listen on every network interface, which is never allowed. ` +
        'Use 127.0.0.1 (default), or LAN mode with one private address (decision D36).',
    );
  }
  if (isIP(host) === 0) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" is not an IP address. Use a literal loopback address such as 127.0.0.1.`,
    );
  }
  if (!isLoopbackAddress(host)) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" is not a loopback address and LAN mode is off. ` +
        'To bind a private LAN address, set GATEWAY_LAN_MODE=on or pass --lan (decision D36).',
    );
  }
  return host;
}

/** IPv4 octets of a literal, or null if it is not a plain dotted-quad IPv4 literal. */
function ipv4Octets(host: string): number[] | null {
  if (isIP(host) !== 4) return null; // also rejects leading zeros and surrounding spaces
  return host.split('.').map(Number);
}

/** True only for RFC 1918 IPv4 literals: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. */
export function isRfc1918Ipv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (o === null) return false;
  const [a = -1, b = -1] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Why an address is not acceptable for LAN mode (null = acceptable as RFC 1918). */
function lanAddressProblem(host: string): string | null {
  if (WILDCARD_HOSTS.has(host)) return 'would listen on every network interface';
  const version = isIP(host);
  if (version === 0) return 'is not an IP address literal';
  if (version === 6) return 'is an IPv6 address; LAN mode supports one private IPv4 address only';
  const [a = -1, b = -1] = ipv4Octets(host) ?? [];
  if (a === 127) return 'is a loopback address; LAN mode needs a private (RFC 1918) address';
  if (a === 169 && b === 254) return 'is a link-local address';
  if (a === 100 && b >= 64 && b <= 127) return 'is a carrier-grade NAT (100.64/10) address';
  if (a >= 224) return 'is a multicast or reserved address';
  if (a === 0) return 'is not a usable unicast address';
  if (!isRfc1918Ipv4(host)) return 'is a public address; LAN mode never binds outside RFC 1918';
  return null;
}

/** Shape of `os.networkInterfaces()` the gateway relies on (injectable for tests). */
export type NetworkInterfacesProvider = () => Readonly<
  Record<string, ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined>
>;

/** True if `address` is currently assigned to a non-internal IPv4 interface of this machine. */
export function isAssignedLocalIpv4(address: string, provider: NetworkInterfacesProvider = networkInterfaces): boolean {
  return Object.values(provider()).some((entries) =>
    (entries ?? []).some((e) => !e.internal && (e.family === 'IPv4' || e.family === 4) && e.address === address),
  );
}

/**
 * Validates a LAN-mode bind address (D36): an RFC 1918 IPv4 literal assigned
 * to a local interface. Throws `GatewayConfigError`; never substitutes another
 * address. Used by config resolution and again by the HTTP server.
 */
export function parseLanAddress(raw: string, provider: NetworkInterfacesProvider = networkInterfaces): string {
  const host = raw.trim();
  const problem = lanAddressProblem(host);
  if (problem !== null) {
    throw new GatewayConfigError(`GATEWAY_HOST "${host}" ${problem}. LAN mode was not started.`);
  }
  if (!isAssignedLocalIpv4(host, provider)) {
    throw new GatewayConfigError(
      `GATEWAY_HOST "${host}" is not assigned to any network interface of this computer ` +
        '(check the Wi-Fi or hotspot address). LAN mode was not started.',
    );
  }
  return host;
}

/** `GATEWAY_LAN_MODE`: `on` or `off`, case-insensitive. Anything else fails closed. */
export function parseLanMode(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new GatewayConfigError('GATEWAY_LAN_MODE must be "on" or "off".');
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
 * blank entries in .env.example. `--lan` (overrides.lan === true) enables LAN
 * mode; when the flag is absent, `GATEWAY_LAN_MODE` decides (default off).
 */
export function resolveHttpConfig(
  env: Readonly<Record<string, string | undefined>>,
  overrides: { host?: string; port?: string; webDir?: string; lan?: boolean } = {},
  deps: { networkInterfaces?: NetworkInterfacesProvider } = {},
): HttpServerConfig {
  const host = overrides.host ?? env.GATEWAY_HOST;
  const port = overrides.port ?? env.GATEWAY_PORT;
  const webDir = overrides.webDir ?? env.GATEWAY_WEB_DIR;
  const lanMode = env.GATEWAY_LAN_MODE;
  // Always validated when present, so an invalid value fails closed even when --lan is given.
  const envLan = present(lanMode) ? parseLanMode(lanMode) : false;
  const lan = overrides.lan === true || envLan;
  const common = {
    port: present(port) ? parsePort(port) : DEFAULT_GATEWAY_PORT,
    webDir: present(webDir) ? webDir.trim() : null,
  };
  if (!lan) {
    return { mode: 'loopback', host: present(host) ? parseHost(host) : DEFAULT_GATEWAY_HOST, ...common };
  }
  if (!present(host)) {
    throw new GatewayConfigError(
      'LAN mode is on but no address is set. Set GATEWAY_HOST (or --host) to this computer\'s private ' +
        'Wi-Fi/hotspot IPv4 address. LAN mode was not started.',
    );
  }
  return { mode: 'lan', host: parseLanAddress(host, deps.networkInterfaces), ...common };
}
