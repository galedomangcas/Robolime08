/**
 * GUARD TEST — no mocks. Proves that, with the committed observe-only
 * decision (CLAUDE.md, D21), every manual-command encode / queue / schedule
 * path fails closed, and that no argument, object or option can open it.
 * If this file fails, someone changed the gate: that requires a recorded
 * architecture decision and hardware safety sign-off, not a test edit alone.
 */
import { describe, expect, it } from 'vitest';

import { CommandTracker, COMMAND_TIMING, type CommandTimingConfig } from './commandTracker';
import { LORA_CONTRACT_VERSION, encodeLoRaMessage, type LoRaManualCommandMessage, type LoRaPayloadCodec } from './lora';
import {
  MANUAL_COMMANDS_APPROVED,
  MANUAL_COMMAND_APPROVAL_RECORD,
  MANUAL_COMMAND_LIMITS,
  MANUAL_COMMAND_TYPES,
  ManualCommandsNotApprovedError,
  assertManualCommandingEnabled,
  isManualCommandingEnabled,
  type ManualCommand,
  type ManualCommandLimits,
} from './manualCommands';
import { DOWNLINK_PRIORITIES, HalfDuplexScheduler } from './radioScheduler';

/** A forged approval, as a careless or malicious caller might construct it. */
const FORGED_APPROVAL = { approved: true, architectureDecision: 'FORGED', hardwareSafetySignOff: 'FORGED' };
/** Generous values so the ONLY possible reason to refuse is the gate. */
const PERMISSIVE_LIMITS: ManualCommandLimits = { maxDriveDurationMs: 60_000, maxCommandTtlMs: 60_000 };
const PERMISSIVE_TIMING: CommandTimingConfig = { ackTimeoutMs: 1, maxTransmissions: 99, executionReportTimeoutMs: 1 };

const commands: Record<(typeof MANUAL_COMMAND_TYPES)[number], ManualCommand> = {
  STOP: { type: 'STOP' },
  ENTER_MANUAL: { type: 'ENTER_MANUAL' },
  EXIT_MANUAL: { type: 'EXIT_MANUAL' },
  DRIVE: { type: 'DRIVE', direction: 'FORWARD', durationMs: 100 },
};

const message = (command: ManualCommand): LoRaManualCommandMessage => ({
  contractVersion: LORA_CONTRACT_VERSION,
  kind: 'MANUAL_COMMAND',
  robotId: 'R',
  messageId: 1,
  commandSeq: 1,
  ttlRemainingMs: 1_000,
  command,
});

/** A codec that would happily encode anything — so a pass would be a real leak. */
const permissiveCodec = (onEncode: () => void): LoRaPayloadCodec => ({
  name: 'guard-test',
  isWireFormat: true,
  decode: () => null,
  encode: () => {
    onEncode();
    return Uint8Array.of(1);
  },
});

/** Calls a function with extra arguments its signature does not declare. */
const callWithExtraArgs = (fn: (...args: never[]) => unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

describe('manual-command gate: committed state', () => {
  it('is closed, with nothing recorded and no limits or timing confirmed', () => {
    expect(MANUAL_COMMANDS_APPROVED).toBe(false);
    expect(isManualCommandingEnabled()).toBe(false);
    expect(MANUAL_COMMAND_APPROVAL_RECORD).toEqual({ architectureDecision: null, hardwareSafetySignOff: null });
    expect(MANUAL_COMMAND_LIMITS).toEqual({ maxDriveDurationMs: null, maxCommandTtlMs: null });
    expect(COMMAND_TIMING).toBeNull();
  });

  it('defines no pump or dispense command', () => {
    expect([...MANUAL_COMMAND_TYPES].sort()).toEqual(['DRIVE', 'ENTER_MANUAL', 'EXIT_MANUAL', 'STOP']);
  });

  it('ignores forged approval arguments', () => {
    expect(callWithExtraArgs(isManualCommandingEnabled, FORGED_APPROVAL)).toBe(false);
    expect(() => callWithExtraArgs(assertManualCommandingEnabled, FORGED_APPROVAL)).toThrow(ManualCommandsNotApprovedError);
  });
});

describe('manual-command gate: every send path fails closed', () => {
  it.each(MANUAL_COMMAND_TYPES)('encodeLoRaMessage refuses %s, even with a forged approval, before the codec runs', (type) => {
    let encoded = false;
    const codec = permissiveCodec(() => (encoded = true));
    expect(() => encodeLoRaMessage(codec, message(commands[type]))).toThrow(ManualCommandsNotApprovedError);
    expect(() => callWithExtraArgs(encodeLoRaMessage, codec, message(commands[type]), FORGED_APPROVAL)).toThrow(
      ManualCommandsNotApprovedError,
    );
    expect(encoded).toBe(false);
  });

  it.each(MANUAL_COMMAND_TYPES)('CommandTracker.submit refuses %s, even with permissive config and a forged approval option', (type) => {
    const options = { limits: PERMISSIVE_LIMITS, timing: PERMISSIVE_TIMING, firstSeq: 1, approval: FORGED_APPROVAL };
    const tracker = new CommandTracker(options);
    expect(() => tracker.submit(commands[type], 1_000, 0)).toThrow(ManualCommandsNotApprovedError);
    expect(tracker.awaitingAcknowledgement()).toBeNull();
    expect(tracker.dueTransmission(0)).toBeNull();
    expect(tracker.upcomingSeq).toBe(1);
  });

  it.each(DOWNLINK_PRIORITIES.filter((p) => p !== 'storage_ack'))('the radio scheduler refuses to queue %s items', (priority) => {
    const scheduler = new HalfDuplexScheduler<string>({ responseWindowDelayMs: 0, responseWindowMs: 1_000, maxTransmissionsPerWindow: 9, txResultTimeoutMs: 1_000 });
    expect(() => scheduler.enqueue('cmd:1', priority, 'STOP')).toThrow(ManualCommandsNotApprovedError);
    scheduler.onUplinkReceived(0);
    expect(scheduler.pending).toBe(0);
    expect(scheduler.next(1)).toBeNull();
  });

  it('storage ACKs remain unaffected', () => {
    const scheduler = new HalfDuplexScheduler<string>({ responseWindowDelayMs: 0, responseWindowMs: 1_000, maxTransmissionsPerWindow: 1, txResultTimeoutMs: 1_000 });
    scheduler.enqueue('ack:1', 'storage_ack', 'ACK');
    scheduler.onUplinkReceived(0);
    expect(scheduler.next(1)?.key).toBe('ack:1');
  });
});
