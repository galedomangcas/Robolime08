import type { CellReading, RobotStatus, RunSummary } from '@robolime/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { GatewayClient, GatewayResult } from '../data/gatewayClient';
import { createMemorySessionStore, type StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { colors } from '../theme';
import { PH_TARGET, gaugeColorAt } from '../ui/primitives';
import { AppRoot } from './AppRoot';

// Window size is controlled through the hook the screens use (Dimensions.set is unreliable under jest-expo).
const mockWindow = { width: 750, height: 1334, scale: 1, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

/**
 * Canva-based layout (D50): sections, exports, reading sheet and the
 * laptop-width variant. Synthetic data only; no network beyond the fake client.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');
const ROBOT = { id: 'r1', displayName: 'Synthetic demo robot', isSynthetic: true };
const SESSION: StoredSession = { token: 'stored-token', robot: ROBOT, expiresAt: '2026-06-01T00:00:00.000Z' };
const STATUS: RobotStatus = {
  robotId: 'r1',
  state: 'WORKING',
  errorFlags: [],
  componentChecks: {
    SOIL_PROBE: 'unknown', GPS: 'unknown', PUMP: 'unknown', DRIVE_MOTORS: 'unknown',
    NANO_LINK: 'unknown', LORA_RADIO: 'unknown', FLASH_STORAGE: 'unknown', BATTERY_SENSOR: 'unknown',
  },
  batteryVoltage: 12.4,
  totalLimeCommandedMl: 575,
  cellsCompleted: 7,
  totalCells: 20,
  timestamps: { robotAt: '2026-03-01T11:59:30.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
};
const RUN: RunSummary = {
  id: 'run-1', sourceRunId: 'R-0001', runType: 'dosing', fieldId: null, readingCount: 1,
  firstRobotRecordedAt: '2026-03-01T08:00:00.000Z', lastRobotRecordedAt: '2026-03-01T08:00:00.000Z', isSynthetic: true,
};
const READING: CellReading = {
  runId: 'run-1', runType: 'dosing', cellIndex: 3, seq: 1, attemptCount: 0, ph: 5.2, ec: 0.45, moisturePercent: 34,
  temperatureC: 26.8, doseVolumeMl: 100, expectedPostCorrectionPh: 6, gps: null, rawFlags: 0,
  timestamps: { robotAt: '2026-03-01T08:06:00.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
};
const ok = <T,>(data: T): GatewayResult<T> => ({ ok: true, data });
const notFound = { ok: false as const, failure: { kind: 'api' as const, status: 404, code: 'NOT_FOUND' as const, retryAfterSeconds: null } };

function fakeClient() {
  const calls: string[] = [];
  const client: GatewayClient = {
    pair: async () => notFound,
    session: async () => ok({ robot: ROBOT, expiresAt: SESSION.expiresAt }),
    robotStatus: async () => {
      calls.push('status');
      return ok({ status: STATUS, staleThresholdSeconds: 240 });
    },
    runs: async () => {
      calls.push('runs');
      return ok({ runs: [RUN] });
    },
    runReadings: async () => {
      calls.push('readings');
      return ok({ run: RUN, readings: [READING] });
    },
    runRecommendation: async () => {
      calls.push('recommendation');
      return notFound;
    },
  };
  return { client, calls };
}

const noTimers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };
const allText = () => JSON.stringify(screen.toJSON());

async function renderPaired() {
  const store = createMemorySessionStore();
  store.save(SESSION);
  const fake = fakeClient();
  await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={noTimers} />);
  await screen.findByText('Latest report');
  return fake;
}

function setWindow(width: number, height: number) {
  mockWindow.width = width;
  mockWindow.height = height;
}

afterEach(() => setWindow(750, 1334));

describe('paired layout (D50)', () => {
  it('opens on the Field section with the strip, honest notes and no map, progress or field selection', async () => {
    await renderPaired();
    expect(screen.getByRole('tab', { name: 'Field' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByText('Synthetic demo robot')).toBeTruthy();
    expect(screen.getByText('SYNTHETIC')).toBeTruthy();
    expect(screen.getByText('Field gateway connected')).toBeTruthy();
    expect(screen.getByText('575 mL')).toBeTruthy();
    expect(screen.getByText('Battery voltage · health TBC')).toBeTruthy();
    expect(screen.getByText(/The field map, cell progress and field selection are not part of this version/)).toBeTruthy();
    // The mockup's "Working: 7 of 20 cells (35%)", "6 of 7 needed lime" and "8/8 OK" never appear.
    expect(allText()).not.toMatch(/\b7 of 20\b|35 ?%|needed lime|8\/8|Choose your field|LAPTOP-LAN-IP/);
  });

  it('shows research exports as unavailable downloads with the laptop command, and no values', async () => {
    const fake = await renderPaired();
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Exports' })));
    expect(screen.getByText('Research exports')).toBeTruthy();
    expect(screen.getByText('Downloads are not available in the app yet')).toBeTruthy();
    expect(screen.getByText(/npm run export:csv/)).toBeTruthy();
    for (const name of ['Readings per run', 'Dosing + verification pairs', 'Radio delivery']) {
      expect(screen.getByLabelText(`Download ${name}`).props.accessibilityState).toEqual({ disabled: true });
    }
    // No invented counts or delivery percentages; exports trigger no gateway request.
    expect(allText()).not.toMatch(/\d+ ?%|of 20|\d+ of \d+ records/);
    expect(fake.calls.every((c) => c === 'status')).toBe(true);
  });

  it('opens a reading in a detail sheet, compared only with the confirmed 6.00 target', async () => {
    await renderPaired();
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Cell 3 · record 1' })));
    expect(screen.getByText('Soil pH')).toBeTruthy();
    expect(screen.getByText('Below target 6.00')).toBeTruthy();
    // The gauge is decorative (hidden from screen readers; the pill above states the comparison).
    expect(screen.getByText('Target 6.00', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText('Target 6.00')).toBeNull();
    expect(screen.getByText('Soil temp.')).toBeTruthy();
    expect(screen.getByText(/Synthetic demo values\. Commanded volume is not a measurement of liquid delivered\./)).toBeTruthy();
    // The unconfirmed three-band labels from the mockup are not used (OPEN_ITEMS #4).
    expect(allText()).not.toMatch(/Too acidic|Near target/);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Close reading' })));
    expect(screen.queryByText('Below target 6.00')).toBeNull();
  });

  it('uses the side rail and a readings table at laptop width', async () => {
    setWindow(1280, 900);
    await renderPaired();
    expect(screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Field', 'Results', 'Exports']);
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByRole('button', { name: 'Cell 3 · record 1, pH 5.20' })).toBeTruthy();
    expect(screen.getByText('Reading')).toBeTruthy(); // table header
  });
});

describe('pH gauge colour', () => {
  it('is the target colour from 6.00 up and changes continuously below it (no hidden band edge)', () => {
    expect(gaugeColorAt(PH_TARGET)).toBe(colors.gaugeHigh);
    expect(gaugeColorAt(7)).toBe(colors.gaugeHigh);
    expect(gaugeColorAt(5.99)).not.toBe(colors.gaugeHigh);
    const channels = (rgb: string) => rgb.replace(/[^\d,]/g, '').split(',').map(Number);
    const [a, b] = [channels(gaugeColorAt(4.99)), channels(gaugeColorAt(5.01))];
    expect(Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))))).toBeLessThan(6);
  });
});
