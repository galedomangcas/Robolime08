import { describe, expect, it, vi } from 'vitest';

import {
  CommandBusyError,
  CommandRejectedLocallyError,
  CommandTimingUnconfirmedError,
  CommandTracker,
  isTerminalCommandState,
  type CommandTimingConfig,
} from './commandTracker';
import { MANUAL_COMMAND_LIMITS, checkManualCommand, type ManualCommandLimits } from './manualCommands';

/**
 * TEST-ONLY: opens the manual-command gate for THIS FILE by replacing the gate
 * function through the test runner's module mock. Production code has no
 * equivalent: the gate reads only the committed constant and takes no
 * arguments. manualCommandGate.test.ts proves the real gate is closed.
 */
vi.mock('./manualCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manualCommands')>()),
  assertManualCommandingEnabled: () => undefined,
}));

/** TEST-ONLY values: they exercise the state machine and are NOT proposed real settings. */
const TEST_ONLY_LIMITS: ManualCommandLimits = { maxDriveDurationMs: 2_000, maxCommandTtlMs: 5_000 };
const TEST_ONLY_TIMING: CommandTimingConfig = { ackTimeoutMs: 1_000, maxTransmissions: 3, executionReportTimeoutMs: 4_000 };

const tracker = (firstSeq = 1) => new CommandTracker({ limits: TEST_ONLY_LIMITS, timing: TEST_ONLY_TIMING, firstSeq });

const drive = { type: 'DRIVE', direction: 'FORWARD', durationMs: 1_000 } as const;

describe('CommandTracker preconditions (gate mocked open)', () => {
  it('refuses to run without confirmed timing', () => {
    const t = new CommandTracker({ limits: TEST_ONLY_LIMITS, timing: null, firstSeq: 1 });
    expect(() => t.submit({ type: 'STOP' }, 1_000, 0)).toThrow(CommandTimingUnconfirmedError);
  });

  it('refuses every command with the production (unconfirmed) limits', () => {
    const t = new CommandTracker({ limits: MANUAL_COMMAND_LIMITS, timing: TEST_ONLY_TIMING, firstSeq: 1 });
    expect(() => t.submit({ type: 'STOP' }, 1_000, 0)).toThrow(CommandRejectedLocallyError);
  });
});

describe('checkManualCommand', () => {
  it('rejects anything that depends on an unconfirmed limit', () => {
    expect(checkManualCommand(drive, 1_000, MANUAL_COMMAND_LIMITS).map((i) => i.reason)).toEqual([
      'LIMIT_UNCONFIRMED',
      'LIMIT_UNCONFIRMED',
    ]);
  });

  it('enforces limits and parameter validity', () => {
    expect(checkManualCommand(drive, 1_000, TEST_ONLY_LIMITS)).toEqual([]);
    expect(checkManualCommand({ ...drive, durationMs: 2_001 }, 1_000, TEST_ONLY_LIMITS).map((i) => i.reason)).toEqual(['LIMIT_EXCEEDED']);
    expect(checkManualCommand({ ...drive, durationMs: 0 }, 1_000, TEST_ONLY_LIMITS).map((i) => i.reason)).toEqual(['INVALID_PARAMETERS']);
    expect(checkManualCommand({ type: 'STOP' }, 5_001, TEST_ONLY_LIMITS).map((i) => i.reason)).toEqual(['LIMIT_EXCEEDED']);
    expect(checkManualCommand({ type: 'STOP' }, 0, TEST_ONLY_LIMITS).map((i) => i.reason)).toEqual(['INVALID_PARAMETERS']);
  });
});

describe('CommandTracker lifecycle (simulation, TEST-ONLY approval)', () => {
  it('refuses invalid parameters before queuing', () => {
    expect(() => tracker().submit({ ...drive, durationMs: 10_000 }, 1_000, 0)).toThrow(CommandRejectedLocallyError);
  });

  it('assigns strictly increasing sequence numbers continuing from the persisted value', () => {
    const t = tracker(41);
    const first = t.submit({ type: 'ENTER_MANUAL' }, 1_000, 0);
    t.markTransmitted(first.commandSeq, 0);
    t.onCommandAck({ commandSeq: first.commandSeq, disposition: 'ACCEPTED', rejectReason: null }, 10);
    expect(first.commandSeq).toBe(41);
    expect(t.submit({ type: 'STOP' }, 1_000, 20).commandSeq).toBe(42);
    expect(t.upcomingSeq).toBe(43);
  });

  it('retransmits after the ACK timeout with a shrinking TTL, then gives up as UNCONFIRMED', () => {
    const t = tracker();
    const c = t.submit(drive, 5_000, 0);
    expect(t.dueTransmission(0)).toEqual({ commandSeq: 1, command: drive, ttlRemainingMs: 5_000, attempt: 1 });
    t.markTransmitted(1, 0);
    expect(t.dueTransmission(999)).toBeNull();
    expect(t.dueTransmission(1_000)).toMatchObject({ attempt: 2, ttlRemainingMs: 4_000 });
    t.markTransmitted(1, 1_000);
    expect(t.dueTransmission(2_000)).toMatchObject({ attempt: 3, ttlRemainingMs: 3_000 });
    t.markTransmitted(1, 2_000);
    expect(t.dueTransmission(2_500)).toBeNull(); // max transmissions reached
    t.tick(3_000);
    expect(c.state).toBe('UNCONFIRMED');
    expect(isTerminalCommandState(c.state)).toBe(false); // the robot may still have acted
  });

  it('a bridge that never confirms transmission leaves the command QUEUED, then EXPIRED_UNSENT', () => {
    const t = tracker();
    const c = t.submit({ type: 'ENTER_MANUAL' }, 1_500, 0);
    expect(t.dueTransmission(0)).not.toBeNull(); // offered, but LORA_TX_RESULT never says SENT
    expect(t.dueTransmission(1_499)).not.toBeNull();
    expect(t.dueTransmission(1_500)).toBeNull();
    expect(c.state).toBe('EXPIRED_UNSENT');
    expect(isTerminalCommandState(c.state)).toBe(true);
  });

  it('never offers an expired command, even with retries remaining', () => {
    const t = tracker();
    const c = t.submit(drive, 1_500, 0);
    t.markTransmitted(1, 0);
    expect(t.dueTransmission(1_000)).toMatchObject({ ttlRemainingMs: 500 });
    t.markTransmitted(1, 1_000);
    expect(t.dueTransmission(2_000)).toBeNull();
    expect(c.state).toBe('UNCONFIRMED');
  });

  it('separates acceptance from completion and times out silent executions honestly', () => {
    const t = tracker();
    const c = t.submit(drive, 2_000, 0);
    t.markTransmitted(1, 0);
    expect(t.onCommandAck({ commandSeq: 1, disposition: 'ACCEPTED', rejectReason: null }, 100)).toBe('applied');
    expect(c.state).toBe('ACCEPTED');
    expect(t.dueTransmission(5_000)).toBeNull(); // accepted commands are never retransmitted
    t.tick(4_100);
    expect(c.state).toBe('NO_EXECUTION_REPORT');
    // A late report still resolves it.
    expect(t.onCommandStatus({ commandSeq: 1, execution: 'COMPLETED', abortReason: null }, 4_200)).toBe('applied');
    expect(c.state).toBe('COMPLETED');
    expect(c.history.map((h) => h.state)).toEqual(['QUEUED', 'TRANSMITTED', 'ACCEPTED', 'NO_EXECUTION_REPORT', 'COMPLETED']);
  });

  it('suppresses duplicate and late reports instead of regressing state', () => {
    const t = tracker();
    const c = t.submit(drive, 2_000, 0);
    t.markTransmitted(1, 0);
    t.onCommandAck({ commandSeq: 1, disposition: 'ACCEPTED', rejectReason: null }, 10);
    expect(t.onCommandAck({ commandSeq: 1, disposition: 'DUPLICATE', rejectReason: null }, 20)).toBe('duplicate');
    t.onCommandStatus({ commandSeq: 1, execution: 'EXECUTING', abortReason: null }, 30);
    expect(t.onCommandStatus({ commandSeq: 1, execution: 'EXECUTING', abortReason: null }, 40)).toBe('duplicate');
    t.onCommandStatus({ commandSeq: 1, execution: 'COMPLETED', abortReason: null }, 50);
    expect(t.onCommandStatus({ commandSeq: 1, execution: 'EXECUTING', abortReason: null }, 60)).toBe('duplicate');
    expect(t.onCommandAck({ commandSeq: 1, disposition: 'REJECTED', rejectReason: 'EXPIRED' }, 70)).toBe('duplicate');
    expect(c.state).toBe('COMPLETED');
    expect(t.onCommandAck({ commandSeq: 99, disposition: 'ACCEPTED', rejectReason: null }, 80)).toBe('unknown_command');
  });

  it('treats an execution report as implied acceptance when the ACK was lost', () => {
    const t = tracker();
    const c = t.submit(drive, 2_000, 0);
    t.markTransmitted(1, 0);
    t.onCommandStatus({ commandSeq: 1, execution: 'EXECUTING', abortReason: null }, 200);
    expect(c.state).toBe('EXECUTING');
    expect(t.dueTransmission(1_500)).toBeNull();
  });

  it('records robot rejections with their reason', () => {
    const t = tracker();
    const c = t.submit(drive, 2_000, 0);
    t.markTransmitted(1, 0);
    t.onCommandAck({ commandSeq: 1, disposition: 'REJECTED', rejectReason: 'NOT_IN_MANUAL_MODE' }, 100);
    expect(c).toMatchObject({ state: 'REJECTED', rejectReason: 'NOT_IN_MANUAL_MODE' });
  });

  it('allows only one unacknowledged command; STOP supersedes it and is sent next', () => {
    const t = tracker();
    const first = t.submit(drive, 5_000, 0);
    t.markTransmitted(1, 0);
    expect(() => t.submit({ type: 'EXIT_MANUAL' }, 1_000, 10)).toThrow(CommandBusyError);
    const stop = t.submit({ type: 'STOP' }, 1_000, 20);
    expect(first.state).toBe('SUPERSEDED');
    expect(t.dueTransmission(20)).toMatchObject({ commandSeq: stop.commandSeq, command: { type: 'STOP' } });
    // The robot did receive the superseded command: its report is still recorded.
    t.onCommandStatus({ commandSeq: 1, execution: 'ABORTED', abortReason: 'STOP_COMMAND' }, 300);
    expect(first).toMatchObject({ state: 'ABORTED', abortReason: 'STOP_COMMAND' });
  });
});
