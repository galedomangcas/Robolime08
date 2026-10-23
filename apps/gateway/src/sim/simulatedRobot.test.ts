import {
  CommandTracker,
  LORA_CONTRACT_VERSION,
  type CommandTimingConfig,
  type LoRaManualCommandMessage,
  type ManualCommand,
  type ManualCommandApproval,
  type ManualCommandLimits,
} from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import { SimulatedRobot, type RobotReport } from './simulatedRobot';

/**
 * Everything here is SIMULATION with TEST-ONLY values. It specifies the
 * robot's required safe behaviour; it does not approve manual commands or
 * physical actuation (docs/decisions.md D21).
 */
const TEST_ONLY_APPROVAL: ManualCommandApproval = { approved: true, architectureDecision: 'TEST-ONLY', hardwareSafetySignOff: 'TEST-ONLY' };
const TEST_ONLY_LIMITS: ManualCommandLimits = { maxDriveDurationMs: 2_000, maxCommandTtlMs: 5_000 };
const TEST_ONLY_TIMING: CommandTimingConfig = { ackTimeoutMs: 500, maxTransmissions: 3, executionReportTimeoutMs: 3_000 };

const robot = (limits: ManualCommandLimits = TEST_ONLY_LIMITS) => new SimulatedRobot({ limits, linkLossTimeoutMs: 1_000 });

let messageId = 0;
const cmd = (commandSeq: number, command: ManualCommand, ttlRemainingMs = 2_000): LoRaManualCommandMessage => ({
  contractVersion: LORA_CONTRACT_VERSION,
  kind: 'MANUAL_COMMAND',
  robotId: 'TEST-ROBOT-1',
  messageId: messageId++,
  commandSeq,
  ttlRemainingMs,
  command,
});

const drive = (durationMs = 1_500): ManualCommand => ({ type: 'DRIVE', direction: 'FORWARD', durationMs });
const acks = (reports: RobotReport[]) => reports.flatMap((r) => (r.kind === 'COMMAND_ACK' ? [r.rejectReason ?? r.disposition] : []));
const statuses = (reports: RobotReport[]) =>
  reports.flatMap((r) => (r.kind === 'COMMAND_STATUS' ? [`${r.commandSeq}:${r.execution}${r.abortReason ? `:${r.abortReason}` : ''}`] : []));

describe('required robot behaviour (reference model)', () => {
  it('refuses motion outside manual mode and refuses to enter manual mode during an autonomous run', () => {
    const r = robot();
    expect(acks(r.receive(cmd(1, drive()), 0))).toEqual(['NOT_IN_MANUAL_MODE']);
    r.startAutonomousRun();
    expect(acks(r.receive(cmd(2, { type: 'ENTER_MANUAL' }), 10))).toEqual(['MODE_CONFLICT']);
    expect(acks(r.receive(cmd(3, { type: 'STOP' }), 20))).toEqual(['NOT_IN_MANUAL_MODE']);
    expect(r.state).toBe('WORKING');
    expect(r.motionStarts).toBe(0);
  });

  it('executes a bounded drive and stops by itself when the duration ends', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    expect(statuses(r.receive(cmd(2, drive(800)), 100))).toEqual(['2:EXECUTING']);
    expect(r.tick(899)).toEqual([]);
    expect(statuses(r.tick(900))).toEqual(['2:COMPLETED']);
    expect(r.motion).toBeNull();
  });

  it('never runs past the command TTL even if the requested duration is longer', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive(1_500), 300), 0);
    expect(r.motion?.endsAtMs).toBe(300);
  });

  it('rejects expired, stale and duplicate commands without re-executing anything', () => {
    const r = robot();
    r.receive(cmd(5, { type: 'ENTER_MANUAL' }), 0);
    expect(acks(r.receive(cmd(6, drive(), 0), 10))).toEqual(['EXPIRED']);
    expect(acks(r.receive(cmd(7, drive()), 20))).toEqual(['ACCEPTED']);
    expect(acks(r.receive(cmd(7, drive()), 30))).toEqual(['DUPLICATE']);
    expect(acks(r.receive(cmd(4, drive()), 40))).toEqual(['STALE_SEQUENCE']);
    expect(r.motionStarts).toBe(1);
    // A rejected command stays rejected on retransmission.
    expect(acks(r.receive(cmd(8, drive(), 0), 50))).toEqual(['EXPIRED']);
    expect(acks(r.receive(cmd(8, drive(), 0), 60))).toEqual(['EXPIRED']);
  });

  it('enforces its own limits and rejects anything that depends on an unconfirmed limit', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    expect(acks(r.receive(cmd(2, drive(2_001)), 10))).toEqual(['LIMIT_EXCEEDED']);
    const unconfigured = robot({ maxDriveDurationMs: null, maxCommandTtlMs: null });
    expect(acks(unconfigured.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0))).toEqual(['LIMIT_UNCONFIRMED']);
  });

  it('stops on link loss (dead-man) and does not resume when the link returns', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive(1_900)), 0);
    expect(statuses(r.tick(1_000))).toEqual(['2:ABORTED:LINK_LOST']);
    // Reconnection: the gateway retransmits the old command — it is a duplicate and does nothing.
    expect(acks(r.receive(cmd(2, drive(1_900)), 1_200))).toEqual(['DUPLICATE']);
    expect(r.motion).toBeNull();
    expect(r.state).toBe('MANUAL');
    // Only a fresh command moves the robot again.
    expect(acks(r.receive(cmd(3, drive(500)), 1_300))).toEqual(['ACCEPTED']);
    expect(r.motionStarts).toBe(2);
  });

  it('STOP and EXIT_MANUAL abort motion; a new DRIVE replaces the old one', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive()), 0);
    expect(statuses(r.receive(cmd(3, drive()), 100))).toEqual(['2:ABORTED:REPLACED', '3:EXECUTING']);
    expect(statuses(r.receive(cmd(4, { type: 'STOP' }), 200))).toEqual(['3:ABORTED:STOP_COMMAND', '4:COMPLETED']);
    r.receive(cmd(5, drive()), 300);
    expect(statuses(r.receive(cmd(6, { type: 'EXIT_MANUAL' }), 400))).toEqual(['5:ABORTED:MODE_EXIT', '6:COMPLETED']);
    expect(r.state).toBe('IDLE');
  });

  it('stops on a fault and refuses motion while the fault is active; STOP is still accepted', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive()), 0);
    expect(statuses(r.raiseFault('DRIVE_FAULT'))).toEqual(['2:ABORTED:FAULT']);
    expect(acks(r.receive(cmd(3, drive()), 10))).toEqual(['FAULT_ACTIVE']);
    expect(acks(r.receive(cmd(4, { type: 'STOP' }), 20))).toEqual(['ACCEPTED']);
  });

  it('an on-robot stop works with no radio involvement', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive()), 0);
    expect(statuses(r.localStop())).toEqual(['2:ABORTED:LOCAL_STOP']);
  });

  it('after a reboot it is out of manual mode, so a late retransmission cannot move it', () => {
    const r = robot();
    r.receive(cmd(1, { type: 'ENTER_MANUAL' }), 0);
    r.receive(cmd(2, drive()), 0);
    r.reboot();
    expect(r.motion).toBeNull();
    expect(acks(r.receive(cmd(2, drive()), 100))).toEqual(['NOT_IN_MANUAL_MODE']);
  });
});

describe('gateway tracker ⇄ robot over a lossy simulated link', () => {
  function link(lost: (attempt: number, kind: 'downlink' | 'uplink') => boolean) {
    const tracker = new CommandTracker({ approval: TEST_ONLY_APPROVAL, limits: TEST_ONLY_LIMITS, timing: TEST_ONLY_TIMING, firstSeq: 1 });
    const r = robot();
    const step = (nowMs: number) => {
      const due = tracker.dueTransmission(nowMs);
      if (!due) return;
      tracker.markTransmitted(due.commandSeq, nowMs); // bridge reported SENT
      if (lost(due.attempt, 'downlink')) return;
      const reports = r.receive(cmd(due.commandSeq, due.command, due.ttlRemainingMs), nowMs);
      if (lost(due.attempt, 'uplink')) return;
      for (const report of reports) {
        if (report.kind === 'COMMAND_ACK') tracker.onCommandAck(report, nowMs);
        else tracker.onCommandStatus(report, nowMs);
      }
    };
    return { tracker, r, step };
  }

  it('a lost downlink is retried and executed once', () => {
    const { tracker, r, step } = link((attempt, kind) => attempt === 1 && kind === 'downlink');
    const c = tracker.submit({ type: 'ENTER_MANUAL' }, 3_000, 0);
    for (let t = 0; t <= 1_000; t += 100) step(t);
    expect(c.state).toBe('COMPLETED');
    expect(c.transmissions).toBe(2);
    expect(r.state).toBe('MANUAL');
  });

  it('a lost ACK causes a retransmission that the robot answers as DUPLICATE without re-executing', () => {
    const { tracker, r, step } = link((attempt, kind) => attempt === 1 && kind === 'uplink');
    tracker.submit({ type: 'ENTER_MANUAL' }, 3_000, 0);
    for (let t = 0; t <= 600; t += 100) step(t);
    const c = tracker.submit(drive(800), 3_000, 700);
    for (let t = 700; t <= 1_400; t += 100) step(t);
    expect(c.state).toBe('ACCEPTED');
    expect(c.transmissions).toBe(2);
    expect(r.motionStarts).toBe(1);
  });

  it('a dead link ends as UNCONFIRMED at the gateway, never as completed', () => {
    const { tracker, r, step } = link(() => true);
    const c = tracker.submit({ type: 'ENTER_MANUAL' }, 3_000, 0);
    for (let t = 0; t <= 3_000; t += 100) step(t);
    tracker.tick(3_000);
    expect(c.state).toBe('UNCONFIRMED');
    expect(c.transmissions).toBe(3);
    expect(r.state).toBe('IDLE');
  });
});
