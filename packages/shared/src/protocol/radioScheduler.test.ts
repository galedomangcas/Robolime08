import { describe, expect, it, vi } from 'vitest';

import { HalfDuplexScheduler, RADIO_SCHEDULE, type RadioScheduleConfig } from './radioScheduler';

/**
 * TEST-ONLY: the priority test needs command items, so the gate is opened for
 * this file via the test runner's module mock. The closed production gate is
 * covered by manualCommandGate.test.ts (no mocks).
 */
vi.mock('./manualCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manualCommands')>()),
  assertManualCommandingEnabled: () => undefined,
}));

/** TEST-ONLY timing; the real window timing is unconfirmed (OPEN_ITEMS #20). */
const TEST_ONLY_SCHEDULE: RadioScheduleConfig = {
  responseWindowDelayMs: 50,
  responseWindowMs: 500,
  maxTransmissionsPerWindow: 1,
  txResultTimeoutMs: 300,
};

const scheduler = (config: Partial<RadioScheduleConfig> = {}) => new HalfDuplexScheduler<string>({ ...TEST_ONLY_SCHEDULE, ...config });

describe('HalfDuplexScheduler', () => {
  it('has no confirmed production timing', () => {
    expect(RADIO_SCHEDULE).toBeNull();
  });

  it('stays silent until the robot opens a response window with an uplink', () => {
    const s = scheduler();
    s.enqueue('ack:1', 'storage_ack', 'A1');
    expect(s.next(0)).toBeNull();
    s.onUplinkReceived(1_000);
    expect(s.next(1_049)).toBeNull(); // window not open yet
    expect(s.next(1_050)).toEqual({ key: 'ack:1', item: 'A1' });
  });

  it('does not transmit after the window closes', () => {
    const s = scheduler();
    s.enqueue('ack:1', 'storage_ack', 'A1');
    s.onUplinkReceived(0);
    expect(s.next(550)).toBeNull();
    expect(s.pending).toBe(1);
  });

  it('transmits one frame at a time and only up to the per-window budget', () => {
    const s = scheduler({ maxTransmissionsPerWindow: 2 });
    s.enqueue('ack:1', 'storage_ack', 'A1');
    s.enqueue('ack:2', 'storage_ack', 'A2');
    s.enqueue('ack:3', 'storage_ack', 'A3');
    s.onUplinkReceived(0);
    expect(s.next(60)?.key).toBe('ack:1');
    expect(s.next(61)).toBeNull(); // in flight: half-duplex, no overlapping transmissions
    expect(s.onTransmissionResult('ack:1', 'SENT')).toBe('sent');
    expect(s.next(62)?.key).toBe('ack:2');
    s.onTransmissionResult('ack:2', 'SENT');
    expect(s.next(63)).toBeNull(); // budget used up; ack:3 waits for the next uplink
    expect(s.pending).toBe(1);
  });

  it('sends STOP before storage ACKs, and ACKs before other commands', () => {
    const s = scheduler({ maxTransmissionsPerWindow: 3 });
    s.enqueue('cmd:5', 'manual_command', 'DRIVE');
    s.enqueue('ack:1', 'storage_ack', 'A1');
    s.enqueue('cmd:6', 'stop_command', 'STOP');
    s.onUplinkReceived(0);
    const order: string[] = [];
    for (let t = 60; t < 63; t++) {
      const next = s.next(t);
      if (next) {
        order.push(next.key);
        s.onTransmissionResult(next.key, 'SENT');
      }
    }
    expect(order).toEqual(['cmd:6', 'ack:1', 'cmd:5']);
  });

  it('keeps an item queued when the radio was busy receiving, and replaces same-key items in place', () => {
    const s = scheduler();
    s.enqueue('ack:1', 'storage_ack', 'first copy');
    s.onUplinkReceived(0);
    s.next(60);
    expect(s.onTransmissionResult('ack:1', 'CHANNEL_BUSY_RX')).toBe('retry_later');
    s.enqueue('ack:1', 'storage_ack', 're-ACK');
    expect(s.pending).toBe(1);
    s.onUplinkReceived(1_000);
    expect(s.next(1_060)).toEqual({ key: 'ack:1', item: 're-ACK' });
  });

  it('recovers from a lost LORA_TX_RESULT and ignores results for other keys', () => {
    const s = scheduler({ maxTransmissionsPerWindow: 5 });
    s.enqueue('ack:1', 'storage_ack', 'A1');
    s.onUplinkReceived(0);
    s.next(60);
    expect(s.onTransmissionResult('ack:9', 'SENT')).toBe('unexpected');
    expect(s.next(359)).toBeNull();
    expect(s.next(360)?.key).toBe('ack:1');
    expect(s.lostTxResults).toBe(1);
  });

  it('drops items the bridge says can never fit, and forgets the window on link reset', () => {
    const s = scheduler();
    s.enqueue('ack:1', 'storage_ack', 'A1');
    s.enqueue('ack:2', 'storage_ack', 'A2');
    s.onUplinkReceived(0);
    s.next(60);
    expect(s.onTransmissionResult('ack:1', 'REJECTED_TOO_LARGE')).toBe('dropped');
    s.resetLink();
    expect(s.next(70)).toBeNull();
    expect(s.pending).toBe(1);
  });
});
