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
    field: async () => ({ ok: false, failure: { kind: 'api', status: 404, code: 'NO_ACTIVE_FIELD', retryAfterSeconds: null } }),
    selectField: async (_t: string, fieldId: string) => ({ ok: true, data: { selection: { fieldId, confirmedAt: '2026-03-01T12:00:00.000Z' } } }),
    exportRuns: async () => ({ ok: true, data: { runs: [] } }),
    exportCsv: async () => ({ ok: false, failure: { kind: 'invalid-response' } }),
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

describe('paired layout (D50, D54)', () => {
  it('opens on the Field section with progress, the needed-lime summary and a placeholder map', async () => {
    await renderPaired();
    expect(screen.getByRole('tab', { name: 'Field' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByText('Synthetic demo robot')).toBeTruthy();
    expect(screen.getByText('Field gateway connected')).toBeTruthy();
    expect(screen.getByText('Working: 7 of 20 cells (35%)')).toBeTruthy();
    expect(screen.getByLabelText('7 of 20 cells')).toBeTruthy();
    expect(screen.getByText('575 mL')).toBeTruthy();
    expect(screen.getByText('Battery · health TBC')).toBeTruthy();
    // Self-check stays a labelled placeholder: never "8/8 OK" (#9).
    expect(screen.getByText('Self-check: not reported yet (placeholder)')).toBeTruthy();
    expect(allText()).not.toMatch(/8\/8/);
    expect(await screen.findByText('1 of 1 measured cell needed lime')).toBeTruthy();
    expect(screen.getByText('19 cells left · cells fill in as the robot reports')).toBeTruthy();
    expect(screen.getByText('Field not provisioned')).toBeTruthy();
    // Cell index 3 is C4, too acidic, with a text label; C8 (index 7) is the assumed next cell.
    expect(screen.getByRole('button', { name: 'C4, pH 5.20, Too acidic, limed. Open readings' })).toBeTruthy();
    expect(screen.getByLabelText('C8, next cell (assumed order)')).toBeTruthy();
    expect(screen.getByText(/near-target cut-off 5\.50 is a placeholder/)).toBeTruthy();
    expect(screen.getByText(/Placeholder layout: no surveyed field grid/)).toBeTruthy();
  });

  it('opens a map cell in the detail sheet with its band label and the placeholder note', async () => {
    await renderPaired();
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'C4, pH 5.20, Too acidic, limed. Open readings' })));
    expect(screen.getByText('Cell 4 · record 1')).toBeTruthy();
    expect(screen.getByText('Soil pH')).toBeTruthy();
    expect(screen.getAllByText('Too acidic').length).toBeGreaterThan(0);
    expect(screen.getByText('Soil temp.')).toBeTruthy();
    expect(screen.getByText(/Synthetic demo values\. Commanded volume is not a measurement of liquid delivered\./)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Close reading' })));
    expect(screen.queryByText('Cell 4 · record 1')).toBeNull();
  });

  it('shows run tiles and a measured / expected-after-lime map in Results', async () => {
    await renderPaired();
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByText('Cells limed')).toBeTruthy();
    expect(screen.getByText('Median expected pH')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'C4, pH 5.20, Too acidic, limed. Open readings' })).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Expected after lime' })));
    // Limed cell C4: expected post-correction pH 6.00 → at target.
    expect(screen.getByRole('button', { name: 'C4, pH 6.00, At target, limed. Open readings' })).toBeTruthy();
  });

  it('builds research exports on the gateway and reports what it built', async () => {
    const fake = fakeClient();
    fake.client.exportRuns = async () => ok({ runs: [{ id: 'run-1', sourceRunId: 'R-0001', runType: 'dosing', readingCount: 1, firstRobotRecordedAt: '2026-03-01T08:00:00.000Z', isSynthetic: true }] });
    fake.client.exportCsv = async (_t, req) => ok({ kind: req.kind, filename: `readings_R-0001.csv`, csv: 'a,b\n1,2\n', rows: 1, pairCounts: null, delivery: null });
    const store = createMemorySessionStore();
    store.save(SESSION);
    await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={noTimers} />);
    await act(async () => fireEvent.press(await screen.findByRole('tab', { name: 'Exports' })));
    expect(await screen.findByText(/R-0001/)).toBeTruthy();
    const download = screen.getByLabelText('Download Readings per run');
    expect(download.props.accessibilityState).toMatchObject({ disabled: false });
    // Paired needs a verification run; none is stored.
    expect(screen.getByLabelText('Download Dosing + verification pairs').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => fireEvent.press(download));
    // No browser in tests, so the screen says it could not save rather than pretending it did.
    expect(await screen.findByText('Built readings_R-0001.csv; this device cannot save files · 1 row')).toBeTruthy();
  });

  it('uses the side rail, a cell readings table and the map at laptop width', async () => {
    setWindow(1280, 900);
    await renderPaired();
    expect(screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Field', 'Results', 'Exports']);
    expect(await screen.findByText('Cell readings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'C4 details' })).toBeTruthy();
    expect(screen.getByText('1 of 1 needed lime')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByRole('button', { name: 'Cell 4 · record 1, pH 5.20' })).toBeTruthy();
    setWindow(750, 1334);
  });

  it('asks for the field once after pairing (record of intent) when the device can keep the choice', async () => {
    const fake = fakeClient();
    const selected: string[] = [];
    fake.client.field = async () => ok({ field: { id: 'f1', name: 'Calatagan demo field', locationLabel: 'Calatagan, Batangas', areaSquareMeters: 80, cellSizeMeters: 2, totalCells: 20, isSynthetic: true }, cells: [] });
    fake.client.selectField = async (_t, fieldId) => {
      selected.push(fieldId);
      return ok({ selection: { fieldId, confirmedAt: '2026-03-01T12:00:00.000Z' } });
    };
    const kv = new Map<string, string>();
    const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
    const store = createMemorySessionStore();
    store.save(SESSION);
    await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={noTimers} selectionStorage={storage} />);
    expect(await screen.findByText('Choose your field')).toBeTruthy();
    expect(screen.getAllByText('Other fields not yet available.')).toHaveLength(2);
    expect(screen.getByText(/does not change any robot setting/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm field' })));
    expect(selected).toEqual(['f1']);
    expect(await screen.findByText('Latest report')).toBeTruthy();
    expect(kv.get('robolime.fieldSelection.v1:r1')).toBe('f1');
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
