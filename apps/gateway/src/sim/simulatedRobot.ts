import {
  checkManualCommand,
  type CommandAbortReason,
  type CommandDisposition,
  type CommandExecutionState,
  type CommandRejectReason,
  type DriveDirection,
  type ErrorFlag,
  type LoRaManualCommandMessage,
  type ManualCommandLimits,
  type RobotState,
} from '@robolime/shared';

/**
 * REFERENCE MODEL of the robot-side manual-command safety rules in
 * docs/protocol.md ("Required robot behaviour"). It is an executable
 * specification for the firmware owner and a test double for the gateway.
 * It is NOT firmware, drives no hardware, and passing its tests does not
 * make physical actuation safe or approved.
 */

export interface CommandAckReport {
  kind: 'COMMAND_ACK';
  commandSeq: number;
  disposition: CommandDisposition;
  rejectReason: CommandRejectReason | null;
}

export interface CommandStatusReport {
  kind: 'COMMAND_STATUS';
  commandSeq: number;
  execution: CommandExecutionState;
  abortReason: CommandAbortReason | null;
}

export type RobotReport = CommandAckReport | CommandStatusReport;

export interface SimulatedRobotConfig {
  /** The robot's OWN copy of the limits; it never trusts the gateway to have checked. */
  limits: ManualCommandLimits;
  /** Motion stops if no valid downlink arrives for this long (dead-man). Value unconfirmed. */
  linkLossTimeoutMs: number;
}

/** PROPOSED faults that forbid motion (the Nano is the low-level drive layer); firmware owner to confirm. */
const MOTION_BLOCKING_FAULTS: readonly ErrorFlag[] = ['DRIVE_FAULT', 'BATTERY_CRITICAL', 'NANO_LINK_LOST'];

export class SimulatedRobot {
  state: RobotState = 'IDLE';
  private faults = new Set<ErrorFlag>();
  private lastSeq: number | null = null;
  private lastAck: CommandAckReport | null = null;
  private lastDownlinkAtMs: number | null = null;
  motion: { commandSeq: number; direction: DriveDirection; endsAtMs: number } | null = null;
  /** How many times motion actually started (to prove duplicates never re-execute). */
  motionStarts = 0;

  constructor(private readonly config: SimulatedRobotConfig) {}

  private ack(commandSeq: number, disposition: CommandDisposition, rejectReason: CommandRejectReason | null = null): CommandAckReport {
    return { kind: 'COMMAND_ACK', commandSeq, disposition, rejectReason };
  }

  private stopMotion(reason: CommandAbortReason): CommandStatusReport[] {
    if (!this.motion) return [];
    const { commandSeq } = this.motion;
    this.motion = null;
    return [{ kind: 'COMMAND_STATUS', commandSeq, execution: 'ABORTED', abortReason: reason }];
  }

  private done(commandSeq: number): CommandStatusReport {
    return { kind: 'COMMAND_STATUS', commandSeq, execution: 'COMPLETED', abortReason: null };
  }

  receive(message: LoRaManualCommandMessage, nowMs: number): RobotReport[] {
    const seq = message.commandSeq;
    this.lastDownlinkAtMs = nowMs;

    // Duplicate suppression: a retransmission is answered, never re-executed.
    if (this.lastSeq !== null && seq === this.lastSeq && this.lastAck) {
      return [this.lastAck.disposition === 'REJECTED' ? this.lastAck : this.ack(seq, 'DUPLICATE')];
    }
    if (this.lastSeq !== null && seq < this.lastSeq) return [this.ack(seq, 'REJECTED', 'STALE_SEQUENCE')];
    this.lastSeq = seq;

    const reports = this.decide(message, nowMs);
    const ack = reports.find((r): r is CommandAckReport => r.kind === 'COMMAND_ACK');
    this.lastAck = ack ?? null;
    return reports;
  }

  private decide(message: LoRaManualCommandMessage, nowMs: number): RobotReport[] {
    const seq = message.commandSeq;
    const command = message.command;
    const reject = (reason: CommandRejectReason) => [this.ack(seq, 'REJECTED', reason)];

    if (message.ttlRemainingMs <= 0) return reject('EXPIRED');
    const issue = checkManualCommand(command, message.ttlRemainingMs, this.config.limits)[0];
    if (issue) return reject(issue.reason);

    switch (command.type) {
      case 'STOP':
        // Radio STOP is honoured only in manual mode; it is not an emergency stop (see protocol.md).
        if (this.state !== 'MANUAL') return reject('NOT_IN_MANUAL_MODE');
        return [this.ack(seq, 'ACCEPTED'), ...this.stopMotion('STOP_COMMAND'), this.done(seq)];
      case 'ENTER_MANUAL':
        if (this.state === 'ERROR') return reject('FAULT_ACTIVE');
        if (this.state !== 'IDLE' && this.state !== 'COMPLETED' && this.state !== 'MANUAL') return reject('MODE_CONFLICT');
        this.state = 'MANUAL';
        return [this.ack(seq, 'ACCEPTED'), this.done(seq)];
      case 'EXIT_MANUAL': {
        if (this.state !== 'MANUAL') return reject('NOT_IN_MANUAL_MODE');
        const aborted = this.stopMotion('MODE_EXIT');
        this.state = 'IDLE';
        return [this.ack(seq, 'ACCEPTED'), ...aborted, this.done(seq)];
      }
      case 'DRIVE': {
        if (this.state !== 'MANUAL') return reject('NOT_IN_MANUAL_MODE');
        if (MOTION_BLOCKING_FAULTS.some((f) => this.faults.has(f))) return reject('FAULT_ACTIVE');
        const replaced = this.stopMotion('REPLACED');
        // Never run past the command's own expiry, whatever the requested duration.
        const runMs = Math.min(command.durationMs, message.ttlRemainingMs);
        this.motion = { commandSeq: seq, direction: command.direction, endsAtMs: nowMs + runMs };
        this.motionStarts += 1;
        return [...replaced, this.ack(seq, 'ACCEPTED'), { kind: 'COMMAND_STATUS', commandSeq: seq, execution: 'EXECUTING', abortReason: null }];
      }
    }
  }

  /** Advances time: bounded motion ends by itself; silence beyond the dead-man timeout stops it. */
  tick(nowMs: number): CommandStatusReport[] {
    if (!this.motion) return [];
    if (this.lastDownlinkAtMs !== null && nowMs - this.lastDownlinkAtMs >= this.config.linkLossTimeoutMs) {
      return this.stopMotion('LINK_LOST');
    }
    if (nowMs >= this.motion.endsAtMs) {
      const { commandSeq } = this.motion;
      this.motion = null;
      return [this.done(commandSeq)];
    }
    return [];
  }

  /** On-robot stop (physical button / onboard logic). Works with no radio at all. */
  localStop(): CommandStatusReport[] {
    return this.stopMotion('LOCAL_STOP');
  }

  raiseFault(flag: ErrorFlag): CommandStatusReport[] {
    this.faults.add(flag);
    return MOTION_BLOCKING_FAULTS.includes(flag) ? this.stopMotion('FAULT') : [];
  }

  clearFault(flag: ErrorFlag): void {
    this.faults.delete(flag);
  }

  /** Autonomous run started from the robot itself (never from the app). */
  startAutonomousRun(): void {
    this.state = 'WORKING';
  }

  /** Power cycle: motion stops, sequence memory is lost, the robot boots out of manual mode. */
  reboot(): void {
    this.motion = null;
    this.lastSeq = null;
    this.lastAck = null;
    this.lastDownlinkAtMs = null;
    this.state = 'IDLE';
  }
}
