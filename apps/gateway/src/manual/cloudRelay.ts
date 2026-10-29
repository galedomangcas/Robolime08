import {
  MANUAL_CLOUD_MAX_AGE_SECONDS,
  parseManualControlLine,
  type ManualBridgeState,
  type ManualCommandOutcome,
} from '@robolime/shared';

import type { CloudTarget, FetchLike } from '../sync/postgrest';
import type { LinkTimers, ManualControlLink } from './manualControlLink';

/**
 * Online manual control relay (decision D58). While the gateway has internet,
 * it polls hosted Supabase (`take_manual_commands`) for commands queued by the
 * Vercel site or the Android app, sends each through the same LoRa bridge as
 * the laptop tab, and reports the bridge's verdict (`finish_manual_command`).
 *
 * - Every poll also records a heartbeat with the bridge state, so online users
 *   can see whether the robot is reachable.
 * - The database expires a command older than MANUAL_CLOUD_MAX_AGE_SECONDS
 *   before handing it over, so a delayed command never runs late.
 * - A send is not awaited before the next poll: a STOP queued online
 *   supersedes a pending drive at once, as on the laptop.
 * - Writes no robot data to the cloud; only command statuses and heartbeats.
 *   Without internet it keeps retrying quietly; the laptop tab is unaffected.
 */

export interface RelayRpc {
  /** Null when the cloud could not be reached or answered with an error. */
  take(sourceRobotId: string, bridgeState: ManualBridgeState): Promise<{ id: string; line: string }[] | null>;
  finish(id: string, status: Exclude<ManualCommandOutcome, 'expired'>): Promise<boolean>;
}

export type RelayState = 'starting' | 'online' | 'offline';

const REQUEST_TIMEOUT_MS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRelayRpc(target: CloudTarget, fetchImpl: FetchLike = (url, init) => fetch(url, init)): RelayRpc {
  async function rpc(name: string, body: unknown): Promise<unknown> {
    const response = await fetchImpl(`${target.origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...target.credential.headers(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Never follow a redirect: the key would be sent to the new location.
      redirect: 'manual',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  }

  return {
    async take(sourceRobotId, bridgeState) {
      try {
        const rows = await rpc('take_manual_commands', {
          p_source_robot_id: sourceRobotId,
          p_bridge_state: bridgeState,
          p_max_age_seconds: MANUAL_CLOUD_MAX_AGE_SECONDS,
        });
        if (!Array.isArray(rows)) return null;
        const out: { id: string; line: string }[] = [];
        for (const row of rows) {
          const r = row as { id?: unknown; line?: unknown };
          if (typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.line !== 'string') return null;
          out.push({ id: r.id, line: r.line });
        }
        return out;
      } catch {
        return null;
      }
    },
    async finish(id, status) {
      try {
        return (await rpc('finish_manual_command', { p_id: id, p_status: status })) === true;
      } catch {
        return false;
      }
    },
  };
}

export interface CloudRelayOptions {
  rpc: RelayRpc;
  link: ManualControlLink;
  /** `robots.source_robot_id` of the robot this bridge reaches. */
  sourceRobotId: string;
  pollMs?: number;
  timers?: LinkTimers;
  onStateChange?: (state: RelayState) => void;
}

export class CloudRelay {
  private readonly options: CloudRelayOptions;
  private readonly timers: LinkTimers;
  private timer: unknown = null;
  private stopped = false;
  private state: RelayState = 'starting';
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: CloudRelayOptions) {
    this.options = options;
    this.timers =
      options.timers ?? {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      };
  }

  get relayState(): RelayState {
    return this.state;
  }

  start(): void {
    if (this.stopped) return;
    void this.poll();
  }

  /** Stops polling and waits for commands already being sent to be reported. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([...this.inFlight]);
  }

  /** One poll; exposed for tests. */
  async poll(): Promise<void> {
    this.timer = null;
    const bridgeState = this.options.link.status().bridge.state;
    const taken = await this.options.rpc.take(this.options.sourceRobotId, bridgeState);
    this.setState(taken === null ? 'offline' : 'online');
    for (const command of taken ?? []) this.track(this.relay(command));
    if (!this.stopped) this.timer = this.timers.setTimeout(() => void this.poll(), this.options.pollMs ?? 1_000);
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async relay(command: { id: string; line: string }): Promise<void> {
    const parsed = parseManualControlLine(command.line);
    if (parsed === null) {
      // The database CHECK makes this unreachable; never send an unrecognised line.
      await this.options.rpc.finish(command.id, 'rejected');
      return;
    }
    const sent = await this.options.link.send(parsed);
    const outcome = sent.ok ? sent.result.outcome : 'unavailable';
    await this.options.rpc.finish(command.id, outcome === 'expired' ? 'unavailable' : outcome);
  }

  private setState(next: RelayState): void {
    if (next === this.state) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
