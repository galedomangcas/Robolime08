import {
  RADIO_SCHEDULE,
  UNSIGNED_LORA_CODEC,
  type LoRaPayloadCodec,
  type RadioScheduleConfig,
} from '@robolime/shared';

import type { Database } from '../db/connection';
import { getDatabasePurpose } from '../db/init';
import { systemClock, type Clock } from '../db/time';
import { BridgeProtocolSession, type SessionEvent, type SessionOutput } from '../protocol/bridgeSession';
import type { ByteTransport } from './byteTransport';

/**
 * Gateway bridge runtime (Phase 4, milestone 3; decision D31).
 *
 * Connects the existing `BridgeProtocolSession` (serial bytes in/out,
 * write-before-ACK, half-duplex ACK scheduling) to a `ByteTransport`, and
 * adds what the session deliberately leaves out: connecting, a poll timer,
 * strictly ordered writes, reconnecting, and shutdown. It adds no protocol
 * rules: framing, storage, deduplication and ACK decisions stay in the
 * session and the store, unchanged.
 *
 * Opt-in and SIMULATION-ONLY in this build. A hardware runtime refuses to
 * start while the radio schedule is unconfirmed (OPEN_ITEMS #20) or the codec
 * is not a signed-off wire format (OPEN_ITEMS #1); there is no serial-port
 * adapter (OPEN_ITEMS #19). A simulation runtime refuses any database that is
 * not marked 'demo' (D17), so simulated readings never reach field records.
 *
 * Timing has NO defaults: poll interval, reconnect delays and limits must be
 * supplied. Tests and the simulator use values marked TEST_ONLY /
 * SIMULATION_ONLY; production values need a confirmed radio schedule.
 */

export interface BridgeRuntimeTiming {
  /** How often queued downlinks are offered to the session (`poll`). */
  readonly pollIntervalMs: number;
  /** Delay before reconnect attempt n uses `reconnectDelaysMs[min(n - 1, length - 1)]`. */
  readonly reconnectDelaysMs: readonly number[];
  /**
   * Failed opens plus disconnects in a row before the runtime gives up
   * (state 'failed'). The count resets when the bridge sends a valid frame.
   */
  readonly maxConsecutiveFailures: number;
  /**
   * Most outgoing writes held for the current connection at once: the write
   * in progress (if it belongs to this connection) plus the queued ones.
   * Further writes are dropped and reported. At least
   * `MIN_PENDING_WRITES`, so the opening handshake always fits.
   */
  readonly maxPendingWrites: number;
}

/** `session.open()` emits two writes on every connection: a lone resync delimiter byte and HELLO. */
export const MIN_PENDING_WRITES = 2;

export interface RuntimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: RuntimeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type BridgeRuntimeState = 'idle' | 'connecting' | 'connected' | 'waiting_to_reconnect' | 'failed' | 'stopped';

/** Structured, payload-free events. Never contains packet bytes, reading values, codes or tokens. */
export type BridgeRuntimeEvent =
  | { type: 'state'; state: BridgeRuntimeState }
  | { type: 'connected'; opens: number }
  | { type: 'connect_failed'; consecutiveFailures: number; errorName: string }
  | { type: 'disconnected'; consecutiveFailures: number; errorName: string | null; droppedWrites: number }
  | { type: 'reconnect_scheduled'; delayMs: number; attempt: number }
  | { type: 'gave_up'; consecutiveFailures: number }
  | { type: 'write_failed'; errorName: string }
  | { type: 'writes_dropped'; count: number; reason: 'queue_full' | 'disconnected' | 'stopped' }
  | { type: 'session'; sessionEvent: SessionEvent['type']; outcome: string | null };

export interface BridgeRuntimeOptions {
  link: 'simulation' | 'hardware';
  db: Database;
  transport: ByteTransport;
  codec: LoRaPayloadCodec;
  /** Simulation only (TEST_ONLY / SIMULATION_ONLY values). A hardware runtime uses only the committed RADIO_SCHEDULE. */
  schedule?: RadioScheduleConfig;
  timing: BridgeRuntimeTiming;
  hostBuildId: string;
  clock?: Clock;
  timers?: RuntimeTimers;
  onEvent?: (event: BridgeRuntimeEvent) => void;
}

export class BridgeRuntimeConfigError extends Error {
  override name = 'BridgeRuntimeConfigError';
}

/** Hardware use is blocked until the wire format and radio timing are confirmed. */
export class HardwareNotConfiguredError extends Error {
  override name = 'HardwareNotConfiguredError';
}

/** A simulation may only write into a database marked 'demo'. */
export class SimulationDatabaseError extends Error {
  override name = 'SimulationDatabaseError';
}

export class BridgeRuntimeStoppedError extends Error {
  override name = 'BridgeRuntimeStoppedError';
}

function validateTiming(t: BridgeRuntimeTiming): void {
  const positiveInt = (v: number) => Number.isSafeInteger(v) && v > 0;
  const problems: string[] = [];
  if (!positiveInt(t.pollIntervalMs)) problems.push('pollIntervalMs must be a positive integer');
  if (t.reconnectDelaysMs.length === 0 || !t.reconnectDelaysMs.every((d) => Number.isSafeInteger(d) && d >= 0)) {
    problems.push('reconnectDelaysMs must be a non-empty list of non-negative integers');
  }
  if (!positiveInt(t.maxConsecutiveFailures)) problems.push('maxConsecutiveFailures must be a positive integer');
  if (!Number.isSafeInteger(t.maxPendingWrites) || t.maxPendingWrites < MIN_PENDING_WRITES) {
    problems.push(`maxPendingWrites must be an integer of at least ${MIN_PENDING_WRITES} (the opening resync byte and HELLO)`);
  }
  if (problems.length > 0) throw new BridgeRuntimeConfigError(problems.join('; '));
}

/** Resolves the schedule after the hardware/simulation guards; throws if the combination is not allowed. */
function guardedSchedule(o: BridgeRuntimeOptions): RadioScheduleConfig {
  if (o.transport.kind !== o.link) {
    throw new BridgeRuntimeConfigError(`A ${o.link} runtime cannot use a ${o.transport.kind} transport.`);
  }
  if (o.link === 'hardware') {
    const reasons: string[] = [];
    if (o.schedule !== undefined) reasons.push('a hardware runtime uses only the committed RADIO_SCHEDULE, not a supplied schedule');
    if (RADIO_SCHEDULE === null) reasons.push('the radio response-window timing is not confirmed (OPEN_ITEMS #20)');
    if (o.codec === UNSIGNED_LORA_CODEC || !o.codec.isWireFormat) {
      reasons.push('no signed-off LoRa wire codec exists (OPEN_ITEMS #1)');
    }
    if (reasons.length > 0 || RADIO_SCHEDULE === null) {
      throw new HardwareNotConfiguredError(`Hardware bridge runtime refused: ${reasons.join('; ')}.`);
    }
    return RADIO_SCHEDULE;
  }
  if (o.schedule === undefined) {
    throw new BridgeRuntimeConfigError('A simulation runtime needs an explicit (SIMULATION_ONLY / TEST_ONLY) schedule.');
  }
  if (o.codec.isWireFormat) {
    throw new BridgeRuntimeConfigError('A simulation runtime must use a simulation codec, never a wire codec.');
  }
  let purpose: string | null;
  try {
    purpose = getDatabasePurpose(o.db);
  } catch {
    purpose = null;
  }
  if (purpose !== 'demo') {
    throw new SimulationDatabaseError(
      `Simulation refused: the database is ${purpose === null ? 'not a verifiable gateway database' : `marked '${purpose}'`}; simulated readings may only be written to a 'demo' database.`,
    );
  }
  return o.schedule;
}

/** One payload-free summary per session event. */
function summarise(e: SessionEvent): BridgeRuntimeEvent {
  let outcome: string | null = null;
  switch (e.type) {
    case 'serial_error':
    case 'lora_rejected':
      outcome = e.code;
      break;
    case 'bridge_rejected_frame':
      outcome = e.reason;
      break;
    case 'bridge_fault':
      outcome = e.fault;
      break;
    case 'tx_result':
      outcome = e.outcome;
      break;
    case 'unexpected_frame':
      outcome = e.frameType;
      break;
    case 'uplink':
      outcome =
        e.result.kind === 'reading_stored' || e.result.kind === 'status_stored'
          ? `${e.result.kind}:${e.result.outcome}`
          : e.result.kind === 'reading_rejected' || e.result.kind === 'status_rejected'
            ? `${e.result.kind}:${e.result.reason}`
            : e.result.kind;
      break;
    case 'bridge_hello':
    case 'pong':
    case 'storage_failed':
    case 'downlink_blocked':
      // Details (build id, error text, keys) are not needed to operate and may carry data.
      outcome = null;
      break;
  }
  return { type: 'session', sessionEvent: e.type, outcome };
}

export class BridgeRuntime {
  private readonly session: BridgeProtocolSession;
  private readonly clock: Clock;
  private readonly timers: RuntimeTimers;
  private readonly timing: BridgeRuntimeTiming;
  private currentState: BridgeRuntimeState = 'idle';
  /** Bumped on every (re)connection and on stop; async work from an older generation is ignored. */
  private generation = 0;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private pollTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private consecutiveFailures = 0;
  private opens = 0;
  private readonly writeQueue: Uint8Array[] = [];
  private writing = false;
  /** Connection generation of the write in progress, or null. */
  private writingGeneration: number | null = null;

  constructor(private readonly options: BridgeRuntimeOptions) {
    validateTiming(options.timing);
    const schedule = guardedSchedule(options);
    this.timing = options.timing;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? globalTimers;
    this.session = new BridgeProtocolSession({
      link: options.link,
      db: options.db,
      codec: options.codec,
      schedule,
      hostBuildId: options.hostBuildId,
    });
  }

  get state(): BridgeRuntimeState {
    return this.currentState;
  }

  /**
   * Writes the runtime still holds: queued writes plus the write in progress,
   * including one still pending from a lost connection. Because of that stale
   * write it can briefly exceed `maxPendingWrites`, which only counts the
   * current connection's writes.
   */
  get pendingWrites(): number {
    return this.writeQueue.length + (this.writing ? 1 : 0);
  }

  /** Storage ACKs the session still owes the robot. */
  get pendingDownlinks(): number {
    return this.session.pendingDownlinks;
  }

  /** Starts connecting. A second call while running is a no-op; a stopped runtime cannot be restarted. */
  start(): void {
    if (this.stopped) throw new BridgeRuntimeStoppedError('This bridge runtime was stopped; create a new one.');
    if (this.currentState !== 'idle') return;
    void this.connect();
  }

  /**
   * Stops timers, drops queued writes and closes the transport. Idempotent:
   * every call, including one made from an event listener while this stop is
   * still running, returns the same promise, and the transport is closed once.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    // Recorded before anything below can emit an event (and so re-enter stop()).
    let settle: () => void = () => undefined;
    this.stopping = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      this.stopped = true;
      this.generation += 1;
      this.clearTimers();
      this.dropQueuedWrites('stopped');
      this.setState('stopped');
    } finally {
      void this.closeTransport().then(settle);
    }
    return this.stopping;
  }

  /**
   * Closes the transport, ignoring its errors. Resolves when `close()` settles;
   * a transport whose `close()` never settles keeps this pending (the
   * transport contract requires `close()` to settle).
   */
  private closeTransport(): Promise<void> {
    try {
      return this.options.transport.close().catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  /** Best effort: a failing sink must never interrupt connecting, writing, state changes or shutdown. */
  private emit(event: BridgeRuntimeEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Deliberately ignored; the event is not re-logged anywhere.
    }
  }

  private setState(state: BridgeRuntimeState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit({ type: 'state', state });
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private clearTimers(): void {
    if (this.pollTimer !== null) this.timers.clearTimeout(this.pollTimer);
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.setState('connecting');
    try {
      await this.options.transport.open({
        onData: (chunk) => this.onData(generation, chunk),
        onClose: (error) => this.onLinkLost(generation, error),
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.consecutiveFailures += 1;
      this.emit({ type: 'connect_failed', consecutiveFailures: this.consecutiveFailures, errorName: errorName(error) });
      this.scheduleReconnect();
      return;
    }
    if (!this.isCurrent(generation)) {
      // Stopped while the open was in progress: do not keep the connection.
      void this.closeTransport();
      return;
    }
    this.opens += 1;
    this.setState('connected');
    this.emit({ type: 'connected', opens: this.opens });
    this.enqueue(this.session.open(), generation);
    this.schedulePoll(generation);
  }

  private onData(generation: number, chunk: Uint8Array): void {
    if (!this.isCurrent(generation) || this.currentState !== 'connected') return;
    this.handle(this.session.receive(chunk, this.clock()), generation, true);
  }

  private schedulePoll(generation: number): void {
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      if (!this.isCurrent(generation)) return;
      this.handle(this.session.poll(this.clock()), generation, false);
      if (this.isCurrent(generation)) this.schedulePoll(generation);
    }, this.timing.pollIntervalMs);
  }

  private handle(output: SessionOutput, generation: number, fromLink: boolean): void {
    for (const event of output.events) {
      // A frame from the bridge that parsed is evidence the link works; poll output is not.
      if (fromLink && event.type !== 'serial_error') this.consecutiveFailures = 0;
      this.emit(summarise(event));
    }
    this.enqueue(output.outgoing, generation);
  }

  /** Writes held for the current connection: its write in progress plus queued writes. */
  private heldForCurrentConnection(): number {
    return this.writeQueue.length + (this.writingGeneration === this.generation ? 1 : 0);
  }

  private enqueue(frames: Uint8Array[], generation: number): void {
    let dropped = 0;
    for (const frame of frames) {
      if (this.heldForCurrentConnection() >= this.timing.maxPendingWrites) dropped += 1;
      else this.writeQueue.push(frame);
    }
    // Dropping is safe: the reading is already committed and its ACK stays queued in the
    // session. A dropped LORA_TX never gets a TX result, so the session clears it after its
    // TX-result timeout and sends the ACK in a later response window — in practice after the
    // robot's retry, which is stored as a DUPLICATE.
    if (dropped > 0) this.emit({ type: 'writes_dropped', count: dropped, reason: 'queue_full' });
    void this.pump(generation);
  }

  /** Writes queued frames one at a time: the next write starts only after the previous one settled. */
  private async pump(generation: number): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.isCurrent(generation) && this.writeQueue.length > 0) {
        const frame = this.writeQueue.shift() as Uint8Array;
        this.writingGeneration = generation;
        try {
          await this.options.transport.write(frame);
        } catch (error) {
          if (!this.isCurrent(generation)) return;
          this.emit({ type: 'write_failed', errorName: errorName(error) });
          this.onLinkLost(generation, error instanceof Error ? error : null);
          return;
        } finally {
          this.writingGeneration = null;
        }
      }
    } finally {
      this.writing = false;
      // A write from a lost connection may settle after the next connection queued frames.
      if (!this.stopped && this.currentState === 'connected' && this.writeQueue.length > 0) {
        void this.pump(this.generation);
      }
    }
  }

  private onLinkLost(generation: number, error: Error | null): void {
    if (!this.isCurrent(generation)) return;
    this.generation += 1; // everything from the lost connection is now stale
    this.clearTimers();
    const dropped = this.dropQueuedWrites(null);
    this.consecutiveFailures += 1;
    this.emit({
      type: 'disconnected',
      consecutiveFailures: this.consecutiveFailures,
      errorName: error ? errorName(error) : null,
      droppedWrites: dropped,
    });
    void this.closeTransport();
    this.scheduleReconnect();
  }

  /** Frames for a lost connection are never replayed on the next one: `session.open()` resets the link. */
  private dropQueuedWrites(reason: 'stopped' | null): number {
    const dropped = this.writeQueue.length;
    this.writeQueue.length = 0;
    if (dropped > 0) this.emit({ type: 'writes_dropped', count: dropped, reason: reason ?? 'disconnected' });
    return dropped;
  }

  private scheduleReconnect(): void {
    if (this.consecutiveFailures >= this.timing.maxConsecutiveFailures) {
      this.setState('failed');
      this.emit({ type: 'gave_up', consecutiveFailures: this.consecutiveFailures });
      return;
    }
    const delays = this.timing.reconnectDelaysMs;
    const delayMs = delays[Math.min(this.consecutiveFailures - 1, delays.length - 1)] ?? 0;
    this.setState('waiting_to_reconnect');
    this.emit({ type: 'reconnect_scheduled', delayMs, attempt: this.consecutiveFailures });
    const generation = this.generation;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrent(generation)) return;
      void this.connect();
    }, delayMs);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
