import { createLocalApi } from '../api/localApi';
import type { Database } from '../db/connection';
import { openExistingDatabase } from '../db/init';
import { migrate } from '../db/migrate';
import type { Clock } from '../db/time';
import { DEFAULT_BRIDGE_BAUD, createSerialLineTransport, type LineTransport } from '../manual/lineTransport';
import { CloudRelay, createRelayRpc, type RelayRpc, type RelayState } from '../manual/cloudRelay';
import { ManualControlLink } from '../manual/manualControlLink';
import { parseCloudTarget } from '../sync/postgrest';
import { resolveDemoPairing, resolveHttpConfig, type GatewayBindMode, type NetworkInterfacesProvider } from './config';
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
  /** `--demo-pairing` (D47, demo only): true enables it; absent defers to GATEWAY_DEMO_PAIRING (default off). */
  demoPairing?: boolean;
  /** `--serial-port` (D57): the LoRa bridge's USB serial port; overrides GATEWAY_SERIAL_PORT. Absent: no manual control. */
  serialPort?: string;
  /** Tests only: replaces the real serial port for manual control. */
  manualTransport?: LineTransport;
  /** Tests only: replaces the Supabase calls of the online relay (D58). */
  relayRpc?: RelayRpc;
  /** Online relay (D58) reached the cloud ('online') or lost it ('offline'). */
  onRelayState?: (state: RelayState) => void;
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
  /** True only in the D47 demo pairing mode (loopback, demo database). */
  readonly demoPairing: boolean;
  /** Bridge serial port used for manual control (D57); null when manual control is off. */
  readonly serialPort: string | null;
  /** One line about online manual control (D58), or null when manual control is off. */
  readonly onlineManualControl: string | null;
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
/**
 * Online manual control (D58): on whenever the bridge is configured and the
 * gateway has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (owner decision:
 * always accept, no on-site opt-in). The relay sends no robot data to the
 * cloud, only command statuses and a heartbeat, so a demo database may use it
 * too (target parsed as for a field database). The robot is
 * GATEWAY_RELAY_ROBOT_ID, or the only robot in this database.
 */
function setUpCloudRelay(db: Database, options: ServeOptions, link: ManualControlLink): { relay: CloudRelay | null; notice: string } {
  const url = options.env.SUPABASE_URL?.trim();
  if (!url && options.relayRpc === undefined) {
    return { relay: null, notice: 'Online manual control off: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.' };
  }
  const configured = options.env.GATEWAY_RELAY_ROBOT_ID?.trim();
  const ids = db.prepare('SELECT source_robot_id FROM robots ORDER BY source_robot_id').all().map((row) => String(row.source_robot_id));
  const sourceRobotId = configured || (ids.length === 1 ? ids[0] : undefined);
  if (sourceRobotId === undefined) {
    return {
      relay: null,
      notice: `Online manual control off: this database has ${ids.length} robots; set GATEWAY_RELAY_ROBOT_ID to the one the bridge reaches.`,
    };
  }
  const rpc =
    options.relayRpc ?? createRelayRpc(parseCloudTarget({ url, serviceRoleKey: options.env.SUPABASE_SERVICE_ROLE_KEY }, 'field'));
  return {
    relay: new CloudRelay({ rpc, link, sourceRobotId, onStateChange: options.onRelayState }),
    notice: `Online manual control ON for robot ${sourceRobotId}: anyone who claimed it online can drive it while this laptop has internet.`,
  };
}

export async function startGateway(options: ServeOptions): Promise<RunningGateway> {
  const config = resolveHttpConfig(
    options.env,
    { host: options.host, port: options.port, webDir: options.webDir, lan: options.lan },
    { networkInterfaces: options.networkInterfaces },
  );
  const demoPairing = resolveDemoPairing(options.env, options.demoPairing, config.mode);
  // Loaded before the database is opened, so a bad export fails fast.
  const staticSite = config.webDir === null ? undefined : loadStaticSite(config.webDir);
  const serialPort = (options.serialPort ?? options.env.GATEWAY_SERIAL_PORT ?? '').trim() || null;
  if (serialPort !== null && config.mode !== 'loopback') {
    // D40/D57: robot commands may come only from a browser on this laptop.
    throw new Error('Manual control (--serial-port) runs only in loopback mode, never with --lan.');
  }
  const baud = Number(options.env.GATEWAY_SERIAL_BAUD ?? DEFAULT_BRIDGE_BAUD);
  if (!Number.isSafeInteger(baud) || baud <= 0) throw new Error('GATEWAY_SERIAL_BAUD must be a positive whole number.');
  const manualControl =
    serialPort === null
      ? null
      : new ManualControlLink({
          transport: options.manualTransport ?? createSerialLineTransport(serialPort, baud),
          port: serialPort,
          clock: options.clock,
        });

  const db: Database = openExistingDatabase(options.dbPath);
  try {
    migrate(db);
    const online = manualControl === null ? { relay: null, notice: null } : setUpCloudRelay(db, options, manualControl);
    const relay = online.relay;
    const api = createLocalApi({ db, clock: options.clock, demoPairing, manualControl });
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
    manualControl?.start();
    relay?.start();

    let closing: Promise<void> | null = null;
    return {
      mode: http.mode,
      url: http.url,
      host: http.host,
      port: http.port,
      servesWebApp: staticSite !== undefined,
      demoPairing,
      serialPort,
      onlineManualControl: online.notice,
      close: () => {
        closing ??= Promise.all([http.close(), relay?.stop().then(() => manualControl?.close()) ?? manualControl?.close()])
          .then(() => undefined)
          .finally(() => {
            if (db.isOpen) db.close();
          });
        return closing;
      },
      forceCloseConnections: () => http.server.closeAllConnections(),
    };
  } catch (error) {
    await manualControl?.close();
    if (db.isOpen) db.close();
    throw error;
  }
}
