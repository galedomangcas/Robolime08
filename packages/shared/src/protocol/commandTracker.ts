/**
 * Gateway-side lifecycle of manual commands: retries, timeouts, expiry, and
 * the honest reporting of outcomes. Pure and clock-injected (all times are
 * epoch milliseconds passed in by the caller) so it can be tested without
 * timers. DISABLED: `submit` throws unless manual commanding is approved (D21).
 *
 * Three different facts are tracked separately and never merged:
 *   TRANSMITTED — the bridge reports the radio sent it (not that the robot heard it)
 *   ACCEPTED / REJECTED — the robot's COMMAND_ACK (it received and decided)
 *   EXECUTING / COMPLETED / ABORTED / FAILED — the robot's COMMAND_STATUS
 *
 * "Unresolved" states mean the gateway does not know what the robot did:
 *   UNCONFIRMED — transmitted, never acknowledged (the robot may have acted)
 *   SUPERSEDED  — replaced by a STOP while unacknowledged
 *   NO_EXECUTION_REPORT — accepted, but no final status arrived in time
 * A late report from the robot may still resolve them. EXPIRED_UNSENT is
 * certain: the command never left the gateway.
 */
import type { LoRaCommandAckMessage, LoRaCommandStatusMessage } from './lora';
import {
  assertManualCommandingEnabled,
  checkManualCommand,
  type CommandAbortReason,
  type CommandIssue,
  type CommandRejectReason,
  type ManualCommand,
  type ManualCommandApproval,
  type ManualCommandLimits,
} from './manualCommands';

export interface CommandTimingConfig {
  /** Wait this long for a COMMAND_ACK before retransmitting. */
  readonly ackTimeoutMs: number;
  /** Transmissions per command, including the first. */
  readonly maxTransmissions: number;
  /** After acceptance, silence longer than this makes the outcome unknown. */
  readonly executionReportTimeoutMs: number;
}

/** NOT CONFIRMED: depends on airtime and the robot's receive windows (OPEN_ITEMS #20). */
export const COMMAND_TIMING: CommandTimingConfig | null = null;

export type CommandLifecycleState =
  | 'QUEUED'
  | 'TRANSMITTED'
  | 'ACCEPTED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'ABORTED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED_UNSENT'
  | 'UNCONFIRMED'
  | 'SUPERSEDED'
  | 'NO_EXECUTION_REPORT';

const ROBOT_REPORTED: CommandLifecycleState[] = ['ACCEPTED', 'REJECTED', 'EXECUTING', 'COMPLETED', 'ABORTED', 'FAILED'];
const FINAL_REPORTS: CommandLifecycleState[] = ['COMPLETED', 'ABORTED', 'FAILED'];

const ALLOWED: Readonly<Record<CommandLifecycleState, readonly CommandLifecycleState[]>> = {
  QUEUED: ['TRANSMITTED', 'EXPIRED_UNSENT', 'SUPERSEDED'],
  TRANSMITTED: ['TRANSMITTED', 'UNCONFIRMED', 'SUPERSEDED', ...ROBOT_REPORTED],
  UNCONFIRMED: ROBOT_REPORTED,
  SUPERSEDED: ROBOT_REPORTED,
  ACCEPTED: ['EXECUTING', 'NO_EXECUTION_REPORT', ...FINAL_REPORTS],
  EXECUTING: ['NO_EXECUTION_REPORT', ...FINAL_REPORTS],
  NO_EXECUTION_REPORT: ['EXECUTING', ...FINAL_REPORTS],
  COMPLETED: [],
  ABORTED: [],
  FAILED: [],
  REJECTED: [],
  EXPIRED_UNSENT: [],
};

export function isTerminalCommandState(state: CommandLifecycleState): boolean {
  return ALLOWED[state].length === 0;
}

export interface TrackedCommand {
  readonly commandSeq: number;
  readonly command: ManualCommand;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  state: CommandLifecycleState;
  transmissions: number;
  lastTransmittedAtMs: number | null;
  lastUpdateAtMs: number;
  rejectReason: CommandRejectReason | null;
  abortReason: CommandAbortReason | null;
  history: { state: CommandLifecycleState; atMs: number }[];
}

export interface DueCommandTransmission {
  commandSeq: number;
  command: ManualCommand;
  /** Recomputed for every (re)transmission; the robot never needs a synchronised clock. */
  ttlRemainingMs: number;
  attempt: number;
}

export class CommandRejectedLocallyError extends Error {
  constructor(readonly issues: CommandIssue[]) {
    super(`Command refused before sending: ${issues.map((i) => i.detail).join('; ')}`);
    this.name = 'CommandRejectedLocallyError';
  }
}

export class CommandBusyError extends Error {
  constructor(readonly pendingCommandSeq: number) {
    super(`Command ${pendingCommandSeq} is still awaiting acknowledgement; only STOP may supersede it`);
    this.name = 'CommandBusyError';
  }
}

export class CommandTimingUnconfirmedError extends Error {
  constructor() {
    super('Command retry/timeout timing is not confirmed (OPEN_ITEMS #20)');
    this.name = 'CommandTimingUnconfirmedError';
  }
}

export type ReportOutcome = 'applied' | 'duplicate' | 'unknown_command';

export interface CommandTrackerOptions {
  approval: ManualCommandApproval;
  limits: ManualCommandLimits;
  timing: CommandTimingConfig | null;
  /** Must continue from the last persisted value after a restart so sequences stay strictly increasing. */
  firstSeq: number;
}

export class CommandTracker {
  private readonly commands = new Map<number, TrackedCommand>();
  private nextSeq: number;

  constructor(private readonly options: CommandTrackerOptions) {
    this.nextSeq = options.firstSeq;
  }

  private timing(): CommandTimingConfig {
    if (!this.options.timing) throw new CommandTimingUnconfirmedError();
    return this.options.timing;
  }

  private transition(c: TrackedCommand, to: CommandLifecycleState, atMs: number): boolean {
    if (!ALLOWED[c.state].includes(to)) return false;
    c.state = to;
    c.lastUpdateAtMs = atMs;
    c.history.push({ state: to, atMs });
    return true;
  }

  /** The one command (if any) still waiting for the robot's acknowledgement. */
  awaitingAcknowledgement(): TrackedCommand | null {
    for (const c of this.commands.values()) if (c.state === 'QUEUED' || c.state === 'TRANSMITTED') return c;
    return null;
  }

  get(commandSeq: number): TrackedCommand | null {
    return this.commands.get(commandSeq) ?? null;
  }

  /** The sequence number the next submitted command will use (persist it). */
  get upcomingSeq(): number {
    return this.nextSeq;
  }

  submit(command: ManualCommand, ttlMs: number, nowMs: number): TrackedCommand {
    assertManualCommandingEnabled(this.options.approval);
    this.timing();
    const issues = checkManualCommand(command, ttlMs, this.options.limits);
    if (issues.length > 0) throw new CommandRejectedLocallyError(issues);

    this.tick(nowMs);
    const pending = this.awaitingAcknowledgement();
    if (pending) {
      if (command.type !== 'STOP') throw new CommandBusyError(pending.commandSeq);
      this.transition(pending, 'SUPERSEDED', nowMs);
    }
    const tracked: TrackedCommand = {
      commandSeq: this.nextSeq++,
      command,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      state: 'QUEUED',
      transmissions: 0,
      lastTransmittedAtMs: null,
      lastUpdateAtMs: nowMs,
      rejectReason: null,
      abortReason: null,
      history: [{ state: 'QUEUED', atMs: nowMs }],
    };
    this.commands.set(tracked.commandSeq, tracked);
    return tracked;
  }

  /** Applies expiry and timeouts. Safe to call often. */
  tick(nowMs: number): void {
    const timing = this.options.timing;
    if (!timing) return;
    for (const c of this.commands.values()) {
      if (c.state === 'QUEUED' && nowMs >= c.expiresAtMs) {
        this.transition(c, 'EXPIRED_UNSENT', nowMs);
      } else if (c.state === 'TRANSMITTED') {
        const exhausted = c.transmissions >= timing.maxTransmissions && nowMs - (c.lastTransmittedAtMs ?? nowMs) >= timing.ackTimeoutMs;
        if (nowMs >= c.expiresAtMs || exhausted) this.transition(c, 'UNCONFIRMED', nowMs);
      } else if ((c.state === 'ACCEPTED' || c.state === 'EXECUTING') && nowMs - c.lastUpdateAtMs >= timing.executionReportTimeoutMs) {
        this.transition(c, 'NO_EXECUTION_REPORT', nowMs);
      }
    }
  }

  /** The command that should go on air now, if any. Never offers an expired command. */
  dueTransmission(nowMs: number): DueCommandTransmission | null {
    this.tick(nowMs);
    const c = this.awaitingAcknowledgement();
    if (!c) return null;
    const timing = this.timing();
    const ttlRemainingMs = c.expiresAtMs - nowMs;
    if (ttlRemainingMs <= 0 || c.transmissions >= timing.maxTransmissions) return null;
    if (c.lastTransmittedAtMs !== null && nowMs - c.lastTransmittedAtMs < timing.ackTimeoutMs) return null;
    return { commandSeq: c.commandSeq, command: c.command, ttlRemainingMs, attempt: c.transmissions + 1 };
  }

  /** Call only when the bridge reports LORA_TX_RESULT = SENT for this command. */
  markTransmitted(commandSeq: number, nowMs: number): boolean {
    const c = this.commands.get(commandSeq);
    if (!c || !this.transition(c, 'TRANSMITTED', nowMs)) return false;
    c.transmissions += 1;
    c.lastTransmittedAtMs = nowMs;
    return true;
  }

  onCommandAck(ack: Pick<LoRaCommandAckMessage, 'commandSeq' | 'disposition' | 'rejectReason'>, nowMs: number): ReportOutcome {
    const c = this.commands.get(ack.commandSeq);
    if (!c) return 'unknown_command';
    if (ack.disposition === 'REJECTED') {
      if (!this.transition(c, 'REJECTED', nowMs)) return 'duplicate';
      c.rejectReason = ack.rejectReason;
      return 'applied';
    }
    // ACCEPTED, or DUPLICATE (the robot accepted an earlier copy).
    return this.transition(c, 'ACCEPTED', nowMs) ? 'applied' : 'duplicate';
  }

  onCommandStatus(status: Pick<LoRaCommandStatusMessage, 'commandSeq' | 'execution' | 'abortReason'>, nowMs: number): ReportOutcome {
    const c = this.commands.get(status.commandSeq);
    if (!c) return 'unknown_command';
    if (c.state === status.execution) {
      // Repeated EXECUTING report: the robot is still alive and working on it.
      c.lastUpdateAtMs = nowMs;
      return 'duplicate';
    }
    if (!this.transition(c, status.execution, nowMs)) return 'duplicate';
    if (status.execution === 'ABORTED') c.abortReason = status.abortReason;
    return 'applied';
  }
}
