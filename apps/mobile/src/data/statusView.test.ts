import type { RobotStatus } from '@robolime/shared';

import { buildStatusView, connectionLabel, formatLocalTimestamp, pairingFailureMessage, type StatusSnapshot } from './statusView';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const secondsBefore = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function status(overrides: Partial<RobotStatus> = {}): RobotStatus {
  return {
    robotId: 'r1',
    state: 'WORKING',
    errorFlags: [],
    componentChecks: {
      SOIL_PROBE: 'unknown', GPS: 'unknown', PUMP: 'unknown', DRIVE_MOTORS: 'unknown',
      NANO_LINK: 'unknown', LORA_RADIO: 'unknown', FLASH_STORAGE: 'unknown', BATTERY_SENSOR: 'unknown',
    },
    batteryVoltage: 12.4,
    totalLimeCommandedMl: 1250,
    cellsCompleted: 7,
    totalCells: 20,
    timestamps: { robotAt: secondsBefore(30), gatewayReceivedAt: secondsBefore(29), cloudSyncedAt: null },
    ...overrides,
  };
}

const snap = (s: RobotStatus | null, staleThresholdSeconds = 240): StatusSnapshot => ({ status: s, staleThresholdSeconds });

describe('buildStatusView', () => {
  it('shows a recent report as "Latest report", never as live, with commanded lime and voltage', () => {
    const view = buildStatusView({ connection: { kind: 'connected' }, snapshot: snap(status()), now: NOW });
    expect(view).toMatchObject({
      heading: 'Latest report',
      freshnessLabel: 'Reported 30 s ago',
      isStale: false,
      stateLabel: 'Working',
      batteryVoltage: '12.40 V',
      limeCommanded: '1,250 mL',
      connectionOk: true,
    });
    expect(JSON.stringify(view)).not.toMatch(/live/i);
  });

  it('is fresh at exactly the threshold and stale one second later', () => {
    const at = (s: number) =>
      buildStatusView({ connection: { kind: 'connected' }, snapshot: snap(status({ timestamps: { robotAt: secondsBefore(s), gatewayReceivedAt: null, cloudSyncedAt: null } })), now: NOW });
    expect(at(240)).toMatchObject({ isStale: false, freshnessLabel: 'Reported 4 min ago' });
    expect(at(241)).toMatchObject({ isStale: true, freshnessLabel: 'Stale: reported 4 min ago' });
  });

  it('uses the threshold the gateway reports', () => {
    const view = buildStatusView({ connection: { kind: 'connected' }, snapshot: snap(status(), 20), now: NOW });
    expect(view.isStale).toBe(true);
  });

  it('when the gateway is unavailable, keeps old data only as "Last received", with time and age, and marks it stale', () => {
    const view = buildStatusView({ connection: { kind: 'unavailable', failure: { kind: 'unreachable' } }, snapshot: snap(status()), now: NOW });
    expect(view).toMatchObject({
      heading: 'Last received',
      freshnessLabel: 'Reported 30 s ago',
      isStale: true,
      connectionOk: false,
      connectionLabel: 'Field gateway unavailable: cannot reach it',
    });
    expect(view.robotAt).toBe(secondsBefore(30));
  });

  it('shows "No status data" rather than any value when nothing has been received', () => {
    for (const input of [
      { connection: { kind: 'unavailable', failure: { kind: 'timeout' } }, snapshot: null },
      { connection: { kind: 'connected' }, snapshot: snap(null) },
      { connection: { kind: 'unavailable', failure: { kind: 'unreachable' } }, snapshot: snap(null) },
    ] as const) {
      const view = buildStatusView({ ...input, now: NOW });
      expect(view).toMatchObject({ emptyMessage: 'No status data', heading: null, stateLabel: null, batteryVoltage: null, limeCommanded: null });
    }
    expect(buildStatusView({ connection: { kind: 'connecting' }, snapshot: null, now: NOW }).emptyMessage).toBe('Waiting for the gateway…');
  });

  it('never exposes cell counts or progress percentages, for any state', () => {
    for (const state of ['INITIALIZING', 'IDLE', 'WORKING', 'PAUSED', 'COMPLETED', 'ERROR', 'MANUAL'] as const) {
      const view = buildStatusView({ connection: { kind: 'connected' }, snapshot: snap(status({ state, cellsCompleted: 7, totalCells: 20 })), now: NOW });
      expect(view.stateLabel).not.toMatch(/cell|of 20|%|\b7\b/i);
      expect(JSON.stringify(view)).not.toMatch(/of 20|35%|cells/i);
    }
  });

  it('lists reported faults by name and flags an invalid robot timestamp as stale', () => {
    const view = buildStatusView({
      connection: { kind: 'connected' },
      snapshot: snap(status({ state: 'ERROR', errorFlags: ['LIME_EMPTY', 'GPS_NO_FIX'], timestamps: { robotAt: 'garbage', gatewayReceivedAt: null, cloudSyncedAt: null } })),
      now: NOW,
    });
    expect(view.faults).toEqual(['Lime tank empty', 'No GPS fix']);
    expect(view).toMatchObject({ freshnessLabel: 'Timestamp invalid', isStale: true });
  });
});

describe('labels and messages', () => {
  it('names each connection failure, including the 10 s timeout', () => {
    expect(connectionLabel({ kind: 'unavailable', failure: { kind: 'timeout' } })).toBe('Field gateway unavailable: no answer within 10 seconds');
    expect(connectionLabel({ kind: 'unavailable', failure: { kind: 'api', status: 500, code: 'INTERNAL_ERROR', retryAfterSeconds: null } })).toBe(
      'Field gateway unavailable: error 500',
    );
    expect(connectionLabel({ kind: 'unavailable', failure: { kind: 'invalid-response' } })).toBe('Field gateway unavailable: unreadable answer');
  });

  it('explains pairing failures without echoing the code', () => {
    expect(pairingFailureMessage({ kind: 'api', status: 401, code: 'INVALID_PAIRING_CODE', retryAfterSeconds: null })).toMatch(/not accepted/);
    expect(pairingFailureMessage({ kind: 'api', status: 429, code: 'PAIRING_RATE_LIMITED', retryAfterSeconds: 421 })).toBe(
      'Too many incorrect codes. Try again in 8 minutes.',
    );
    expect(pairingFailureMessage({ kind: 'api', status: 503, code: 'NO_PAIRING_PROVISIONED', retryAfterSeconds: null })).toMatch(/pairing:provision/);
    expect(pairingFailureMessage({ kind: 'timeout' })).toMatch(/10 seconds/);
  });

  it('formats robot time as a fixed local timestamp with its UTC offset', () => {
    expect(formatLocalTimestamp('2026-03-01T12:00:05.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:05 \(UTC[+-]\d{2}:\d{2}\)$/);
    expect(formatLocalTimestamp('nope')).toBe('Invalid timestamp');
  });
});
