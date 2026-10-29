import {
  MANUAL_AUTO_STOP_MS,
  manualControlLine,
  type ManualBridgeState,
  type ManualCommandOutcome,
  type ManualCommandResult,
  type ManualControlCommand,
  type ManualStatusResponse,
} from '@robolime/shared';

import { systemClock, toCanonicalUtc, type Clock } from '../db/time';
import type { LineTransport } from './lineTransport';

/**
 * Manual control (D57): sends one text command at a time to the gateway LoRa
 * bridge and reports what the bridge saw. The bridge sketch relays the line
 * over LoRa, retries up to 3 times at 1 s intervals and prints
 * `[Gateway] Received --> ACK:<line>` when the robot answers, or
 * `[Gateway] Error: Command timed out...` when it gives up.
 *
 * One command is in flight at a time, as in the bridge: sending a new one
 * (STOP in particular) supersedes the pending one immediately.
 *
 * History and the bridge log are in memory only and clear on restart.
 */

export interface LinkTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LinkTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ManualControlLinkOptions {
  /** Null when no serial port is configured: every command is refused as unavailable. */
  transport: LineTransport | null;
  port: string | null;
  clock?: Clock;
  timers?: LinkTimers;
  /** Give up waiting for the bridge's verdict after this long (bridge worst case is about 4 s). */
  responseTimeoutMs?: number;
  /** Retry opening the port this long after it fails or closes. */
  reconnectMs?: number;
}

export type SendResult = { ok: true; result: ManualCommandResult } | { ok: false; reason: 'unavailable' };

const HISTORY_LIMIT = 20;
const LOG_LIMIT = 50;
const LOG_LINE_MAX = 200;

const RECEIVED = /Received\s*-->\s*(N?ACK):(.*)$/i;
const TIMED_OUT = /Command timed out/i;

interface Pending {
  command: ManualControlCommand;
  line: string;
  sentAt: string;
  timer: unknown;
  resolve: (result: SendResult) => void;
}

export class ManualControlLink {
  private readonly transport: LineTransport | null;
  private readonly port: string | null;
  private readonly clock: Clock;
  private readonly timers: LinkTimers;
  private readonly responseTimeoutMs: number;
  private readonly reconnectMs: number;
  private state: ManualBridgeState;
  private detail: string | null;
  private pending: Pending | null = null;
  private reconnectTimer: unknown = null;
  private stopped = false;
  private readonly history: ManualCommandResult[] = [];
  private readonly log: { at: string; line: string }[] = [];

  constructor(options: ManualControlLinkOptions) {
    this.transport = options.transport;
    this.port = options.port;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? realTimers;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 8_000;
    this.reconnectMs = options.reconnectMs ?? 5_000;
    this.state = options.transport === null ? 'not-configured' : 'disconnected';
    this.detail =
      options.transport === null
        ? 'No bridge serial port is configured. Start the gateway with --serial-port <port> (or GATEWAY_SERIAL_PORT).'
        : 'Not connected yet.';
  }

  /** Opens the port and keeps retrying in the background until `close()`. */
  start(): void {
    if (this.transport === null || this.stopped) return;
    void this.connect();
  }

  status(): ManualStatusResponse {
    return {
      bridge: { state: this.state, port: this.port, detail: this.state === 'connected' ? null : this.detail },
      autoStopMs: MANUAL_AUTO_STOP_MS,
      recentCommands: [...this.history],
      bridgeLog: [...this.log],
    };
  }

  async send(command: ManualControlCommand): Promise<SendResult> {
    if (this.transport === null || this.state !== 'connected') return { ok: false, reason: 'unavailable' };
    const line = manualControlLine(command);
    if (this.pending) this.finish(this.pending, 'superseded');

    const result = new Promise<SendResult>((resolve) => {
      const pending: Pending = {
        command,
        line,
        sentAt: toCanonicalUtc(this.clock()),
        timer: null,
        resolve,
      };
      pending.timer = this.timers.setTimeout(() => this.finish(pending, 'no-ack'), this.responseTimeoutMs);
      this.pending = pending;
    });

    try {
      await this.transport.writeLine(line);
    } catch {
      const pending = this.pending;
      if (pending && pending.line === line) {
        this.timers.clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve({ ok: false, reason: 'unavailable' });
      }
      this.markDisconnected('Writing to the bridge failed. Check the USB cable.');
    }
    return result;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pending) this.finish(this.pending, 'no-ack');
    await this.transport?.close();
  }

  private async connect(): Promise<void> {
    const transport = this.transport;
    if (transport === null || this.stopped) return;
    this.state = 'connecting';
    this.detail = `Opening ${this.port ?? 'the serial port'}…`;
    try {
      await transport.open(
        (line) => this.onLine(line),
        () => this.markDisconnected('The bridge disconnected (USB cable unplugged or the board reset).'),
      );
      if (this.stopped) {
        await transport.close();
        return;
      }
      this.state = 'connected';
      this.detail = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.markDisconnected(`Could not open ${this.port ?? 'the serial port'}: ${reason}`);
    }
  }

  private markDisconnected(detail: string): void {
    this.state = 'disconnected';
    this.detail = detail;
    if (this.pending) {
      const pending = this.pending;
      this.timers.clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve({ ok: false, reason: 'unavailable' });
    }
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectMs);
  }

  private onLine(raw: string): void {
    // Control characters are dropped so a noisy line cannot corrupt the app's log view.
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (line.length === 0) return;
    this.log.push({ at: toCanonicalUtc(this.clock()), line: line.slice(0, LOG_LINE_MAX) });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);

    const pending = this.pending;
    if (!pending) return;
    const received = RECEIVED.exec(line);
    if (received && (received[2] ?? '').trim().toUpperCase() === pending.line.toUpperCase()) {
      this.finish(pending, (received[1] ?? '').toUpperCase() === 'ACK' ? 'acknowledged' : 'rejected');
      return;
    }
    if (TIMED_OUT.test(line)) this.finish(pending, 'no-ack');
  }

  private finish(pending: Pending, outcome: ManualCommandOutcome): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    const result: ManualCommandResult = {
      command: pending.command,
      line: pending.line,
      outcome,
      sentAt: pending.sentAt,
      finishedAt: toCanonicalUtc(this.clock()),
    };
    this.history.unshift(result);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
    pending.resolve({ ok: true, result });
  }
}
