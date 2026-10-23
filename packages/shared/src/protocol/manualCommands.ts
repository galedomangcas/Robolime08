/**
 * Manual-command contract — SPECIFIED BUT NOT APPROVED.
 *
 * CLAUDE.md (locked) makes the apps observe-only and forbids app-to-robot
 * downlink and app-initiated run control. The Phase 3 brief asked for a
 * manual-command flow; the team chose to have it specified and tested while
 * remaining DISABLED (docs/decisions.md D21). Every path that would encode or
 * queue a manual command calls `assertManualCommandingEnabled`, which fails
 * unless an architecture decision AND a hardware safety sign-off are recorded
 * below. Flipping `approved` alone is not enough.
 *
 * Nothing here selects GPIOs, motor speeds, actuator limits or pump volumes.
 * Pump/dispense commands are deliberately absent: a manual dose would be a
 * dosing instruction from the app, which CLAUDE.md forbids outright.
 */

export interface ManualCommandApproval {
  readonly approved: boolean;
  /** Reference to the decision-log entry that lifts the observe-only rule. */
  readonly architectureDecision: string | null;
  /** Reference to the hardware owner's safety sign-off (E-stop, limits, bench test). */
  readonly hardwareSafetySignOff: string | null;
}

/** Production approval state. Do not change without D21's conditions being met. */
export const MANUAL_COMMAND_APPROVAL: ManualCommandApproval = Object.freeze({
  approved: false,
  architectureDecision: null,
  hardwareSafetySignOff: null,
});

export class ManualCommandsNotApprovedError extends Error {
  constructor() {
    super(
      'Manual commands are specified but NOT approved (docs/decisions.md D21). ' +
        'They need an architecture decision and a hardware safety sign-off before any command can be sent.',
    );
    this.name = 'ManualCommandsNotApprovedError';
  }
}

export function isManualCommandingEnabled(approval: ManualCommandApproval): boolean {
  return approval.approved && Boolean(approval.architectureDecision) && Boolean(approval.hardwareSafetySignOff);
}

export function assertManualCommandingEnabled(approval: ManualCommandApproval): void {
  if (!isManualCommandingEnabled(approval)) throw new ManualCommandsNotApprovedError();
}

export const MANUAL_COMMAND_TYPES = ['STOP', 'ENTER_MANUAL', 'EXIT_MANUAL', 'DRIVE'] as const;
export type ManualCommandType = (typeof MANUAL_COMMAND_TYPES)[number];

/** Logical directions only; how the drive motors realise them is firmware-owned. */
export const DRIVE_DIRECTIONS = ['FORWARD', 'REVERSE', 'TURN_LEFT', 'TURN_RIGHT'] as const;
export type DriveDirection = (typeof DRIVE_DIRECTIONS)[number];

export type ManualCommand =
  | { type: 'STOP' }
  | { type: 'ENTER_MANUAL' }
  | { type: 'EXIT_MANUAL' }
  /** Bounded motion: the robot stops by itself after `durationMs` (a dead-man bound, not a speed). */
  | { type: 'DRIVE'; direction: DriveDirection; durationMs: number };

/**
 * Limits the gateway (and, independently, the robot) enforce. NONE ARE
 * CONFIRMED: null means "not signed off", and a command that depends on a
 * null limit is rejected with LIMIT_UNCONFIRMED. Values come from the hardware
 * owner (OPEN_ITEMS #22), never from software defaults.
 */
export interface ManualCommandLimits {
  readonly maxDriveDurationMs: number | null;
  readonly maxCommandTtlMs: number | null;
}

export const MANUAL_COMMAND_LIMITS: ManualCommandLimits = Object.freeze({
  maxDriveDurationMs: null,
  maxCommandTtlMs: null,
});

/** Why a robot (or the gateway, before sending) refuses a command. */
export const COMMAND_REJECT_REASONS = [
  'EXPIRED',
  'STALE_SEQUENCE',
  'NOT_IN_MANUAL_MODE',
  'MODE_CONFLICT',
  'INVALID_PARAMETERS',
  'LIMIT_UNCONFIRMED',
  'LIMIT_EXCEEDED',
  'FAULT_ACTIVE',
  'UNSUPPORTED_COMMAND',
] as const;
export type CommandRejectReason = (typeof COMMAND_REJECT_REASONS)[number];

/** Why an accepted command stopped before completing. */
export const COMMAND_ABORT_REASONS = ['STOP_COMMAND', 'REPLACED', 'LINK_LOST', 'FAULT', 'MODE_EXIT', 'LOCAL_STOP'] as const;
export type CommandAbortReason = (typeof COMMAND_ABORT_REASONS)[number];

export interface CommandIssue {
  reason: CommandRejectReason;
  detail: string;
}

const isPositiveInt = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Checks a command and its time-to-live against the configured limits. Empty array = acceptable. */
export function checkManualCommand(command: ManualCommand, ttlMs: number, limits: ManualCommandLimits): CommandIssue[] {
  const issues: CommandIssue[] = [];
  if (!isPositiveInt(ttlMs)) {
    issues.push({ reason: 'INVALID_PARAMETERS', detail: 'ttlMs must be a positive integer' });
  } else if (limits.maxCommandTtlMs === null) {
    issues.push({ reason: 'LIMIT_UNCONFIRMED', detail: 'maximum command TTL is not signed off' });
  } else if (ttlMs > limits.maxCommandTtlMs) {
    issues.push({ reason: 'LIMIT_EXCEEDED', detail: `ttlMs ${ttlMs} exceeds ${limits.maxCommandTtlMs}` });
  }

  switch (command.type) {
    case 'STOP':
    case 'ENTER_MANUAL':
    case 'EXIT_MANUAL':
      break;
    case 'DRIVE':
      if (!(DRIVE_DIRECTIONS as readonly string[]).includes(command.direction)) {
        issues.push({ reason: 'INVALID_PARAMETERS', detail: `unknown drive direction ${String(command.direction)}` });
      }
      if (!isPositiveInt(command.durationMs)) {
        issues.push({ reason: 'INVALID_PARAMETERS', detail: 'durationMs must be a positive integer' });
      } else if (limits.maxDriveDurationMs === null) {
        issues.push({ reason: 'LIMIT_UNCONFIRMED', detail: 'maximum drive duration is not signed off' });
      } else if (command.durationMs > limits.maxDriveDurationMs) {
        issues.push({
          reason: 'LIMIT_EXCEEDED',
          detail: `durationMs ${command.durationMs} exceeds ${limits.maxDriveDurationMs}`,
        });
      }
      break;
    default:
      issues.push({ reason: 'UNSUPPORTED_COMMAND', detail: 'unknown command type' });
  }
  return issues;
}
