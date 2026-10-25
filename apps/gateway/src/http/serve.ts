import { createLocalApi } from '../api/localApi';
import type { Database } from '../db/connection';
import { openExistingDatabase } from '../db/init';
import { migrate } from '../db/migrate';
import type { Clock } from '../db/time';
import { resolveHttpConfig, type GatewayBindMode, type NetworkInterfacesProvider } from './config';
import { startGatewayHttpServer, type HttpErrorLog, type HttpRequestLog } from './server';
import { loadStaticSite } from './static';

export interface ServeOptions {
  dbPath: string;
  env: Readonly<Record<string, string | undefined>>;
  /** CLI flags; they take precedence over the environment. */
  host?: string;
  port?: string;
  /** Exported web app folder (--web-dir); overrides GATEWAY_WEB_DIR. */
  webDir?: string;
  /** `--lan`: true enables LAN mode (D36); absent defers to GATEWAY_LAN_MODE. */
  lan?: boolean;
  /** Tests only: interface list for the LAN-address assignment check. */
  networkInterfaces?: NetworkInterfacesProvider;
  /** Tests only: ephemeral port, bypassing the 1–65535 operator range. */
  portOverride?: number;
  clock?: Clock;
  onRequest?: (entry: HttpRequestLog) => void;
  onError?: (entry: HttpErrorLog) => void;
}

export interface RunningGateway {
  /** `loopback` (default) or `lan` (D36 opt-in). */
  readonly mode: GatewayBindMode;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** True when the exported web app is served at the root URL. */
  readonly servesWebApp: boolean;
  /** Closes the HTTP server first, then the database. Safe to call twice. */
  close(): Promise<void>;
  /** Drops in-flight connections; used only if a graceful close hangs. */
  forceCloseConnections(): void;
}

/**
 * Starts the local API over HTTP against an EXISTING gateway database.
 * Configuration is validated before the database is opened. The database is
 * never created, reset or seeded here; pending migrations are applied exactly
 * as the provisioning commands do (applied migrations are checksum-verified).
 * Pairing and field-selection requests write through the normal API.
 */
export async function startGateway(options: ServeOptions): Promise<RunningGateway> {
  const config = resolveHttpConfig(
    options.env,
    { host: options.host, port: options.port, webDir: options.webDir, lan: options.lan },
    { networkInterfaces: options.networkInterfaces },
  );
  // Loaded before the database is opened, so a bad export fails fast.
  const staticSite = config.webDir === null ? undefined : loadStaticSite(config.webDir);

  const db: Database = openExistingDatabase(options.dbPath);
  try {
    migrate(db);
    const api = createLocalApi({ db, clock: options.clock });
    const http = await startGatewayHttpServer({
      api,
      mode: config.mode,
      networkInterfaces: options.networkInterfaces,
      host: config.host,
      port: options.portOverride ?? config.port,
      onRequest: options.onRequest,
      onError: options.onError,
      staticSite,
    });

    let closing: Promise<void> | null = null;
    return {
      mode: http.mode,
      url: http.url,
      host: http.host,
      port: http.port,
      servesWebApp: staticSite !== undefined,
      close: () => {
        closing ??= http.close().finally(() => {
          if (db.isOpen) db.close();
        });
        return closing;
      },
      forceCloseConnections: () => http.server.closeAllConnections(),
    };
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}
