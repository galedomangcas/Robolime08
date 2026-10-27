import type { PairingResponse, RobotStatus, RobotStatusResponse, SessionResponse } from '@robolime/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { GatewayClient, GatewayResult } from '../data/gatewayClient';
import { createMemorySessionStore, type StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { AppRoot } from './AppRoot';

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
  totalLimeCommandedMl: 1250,
  cellsCompleted: 7,
  totalCells: 20,
  timestamps: { robotAt: '2026-03-01T11:59:30.000Z', gatewayReceivedAt: '2026-03-01T11:59:31.000Z', cloudSyncedAt: null },
};

const ok = <T,>(data: T): GatewayResult<T> => ({ ok: true, data });

/** Fake gateway: queue status results; records every call. */
function fakeClient() {
  const statusResults: GatewayResult<RobotStatusResponse>[] = [];
  const calls = { pair: [] as string[], status: [] as string[] };
  let pairResult: GatewayResult<PairingResponse> = ok({ sessionToken: 'new-token', robot: ROBOT, expiresAt: '2026-06-01T00:00:00.000Z' });
  const client: GatewayClient = {
    pair: async (code) => {
      calls.pair.push(code);
      return pairResult;
    },
    session: async () => ok<SessionResponse>({ robot: ROBOT, expiresAt: SESSION.expiresAt }),
    robotStatus: async (token) => {
      calls.status.push(token);
      return statusResults.shift() ?? ok({ status: STATUS, staleThresholdSeconds: 240 });
    },
    runs: async () => ok({ runs: [] }),
    runReadings: async () => ({ ok: false, failure: { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null } }),
    runRecommendation: async () => ({ ok: false, failure: { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null } }),
  };
  return {
    client,
    calls,
    statusResults,
    setPairResult: (r: GatewayResult<PairingResponse>) => (pairResult = r),
  };
}

/** Poll timers fired by the test, so polling cadence is deterministic. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    setTimeout: (cb) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  const firePoll = async () => {
    const [id, cb] = [...pending.entries()][0] ?? [];
    if (id === undefined || cb === undefined) throw new Error('no poll scheduled');
    pending.delete(id);
    await act(async () => cb());
  };
  return { timers, pending, firePoll };
}

async function renderApp(stored: StoredSession | null) {
  const store = createMemorySessionStore();
  if (stored) store.save(stored);
  const fake = fakeClient();
  const timers = manualTimers();
  const view = await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={timers.timers} />);
  return { store, fake, timers, view };
}

const allText = () => JSON.stringify(screen.toJSON());

describe('AppRoot (local field mode)', () => {
  it('pairs, stores only the session, and opens the status screen', async () => {
    const { store, fake } = await renderApp(null);
    expect(screen.getByText('Pair with your robot')).toBeTruthy();

    await act(async () => fireEvent.changeText(screen.getByLabelText('Pairing code'), ' ABCD-EFGH-JKMN '));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Pair this device' })));

    expect(fake.calls.pair).toEqual(['ABCD-EFGH-JKMN']);
    expect(store.load()).toEqual({ token: 'new-token', robot: ROBOT, expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(await screen.findByText('Field gateway connected')).toBeTruthy();
    expect(allText()).not.toContain('ABCD-EFGH-JKMN');
  });

  it('shows the gateway error and stays on pairing when the code is rejected', async () => {
    const { store, fake } = await renderApp(null);
    fake.setPairResult({ ok: false, failure: { kind: 'api', status: 401, code: 'INVALID_PAIRING_CODE', retryAfterSeconds: null } });
    await act(async () => fireEvent.changeText(screen.getByLabelText('Pairing code'), 'WRONG-CODE-1234'));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Pair this device' })));
    expect(screen.getByText('That pairing code was not accepted. Check it and try again.')).toBeTruthy();
    expect(store.load()).toBeNull();
    expect(allText()).not.toContain('WRONG-CODE-1234');
  });

  it('opens straight to status with a stored session and shows the report without cell progress', async () => {
    const { fake } = await renderApp(SESSION);
    expect(await screen.findByText('Latest report')).toBeTruthy();
    expect(fake.calls.status).toEqual(['stored-token']);
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Reported 30 s ago')).toBeTruthy();
    expect(screen.getByText('12.40 V')).toBeTruthy();
    expect(screen.getByText('1,250 mL')).toBeTruthy();
    expect(screen.getByText('Component self-check: Unknown')).toBeTruthy();
    expect(allText()).not.toMatch(/of 20|35%|\bcells? \d|Working: /);
  });

  it('keeps the last report only as "Last received" when the gateway becomes unavailable, and never overlaps polls', async () => {
    const { fake, timers } = await renderApp(SESSION);
    await screen.findByText('Latest report');
    expect(timers.pending.size).toBe(1); // next poll scheduled only after the first finished

    fake.statusResults.push({ ok: false, failure: { kind: 'unreachable' } });
    await timers.firePoll();
    expect(screen.getByText('Field gateway unavailable: cannot reach it')).toBeTruthy();
    expect(screen.getByText('Last received')).toBeTruthy();
    expect(screen.queryByText('Latest report')).toBeNull();
    expect(screen.getByText('Reported 30 s ago')).toBeTruthy();
    expect(timers.pending.size).toBe(1);

    await timers.firePoll();
    expect(await screen.findByText('Latest report')).toBeTruthy();
    expect(fake.calls.status).toHaveLength(3);
  });

  it('shows "No status data" when the gateway is unavailable and nothing was received', async () => {
    const store = createMemorySessionStore();
    store.save(SESSION);
    const fake = fakeClient();
    fake.statusResults.push({ ok: false, failure: { kind: 'timeout' } });
    await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={manualTimers().timers} />);
    expect(await screen.findByText('No status data')).toBeTruthy();
    expect(screen.getByText('Field gateway unavailable: no answer within 10 seconds')).toBeTruthy();
    expect(screen.queryByText('Last received')).toBeNull();
  });

  it('returns to pairing, clears the token and stops polling when the gateway rejects the session', async () => {
    const store = createMemorySessionStore();
    store.save(SESSION);
    const fake = fakeClient();
    const timers = manualTimers();
    fake.statusResults.push({ ok: false, failure: { kind: 'api', status: 401, code: 'SESSION_REVOKED', retryAfterSeconds: null } });
    await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={timers.timers} />);
    expect(await screen.findByText(/no longer accepts this device/)).toBeTruthy();
    expect(screen.getByLabelText('Pairing code')).toBeTruthy();
    expect(store.load()).toBeNull();
    expect(timers.pending.size).toBe(0);
    expect(fake.calls.status).toHaveLength(1);
  });

  it('"Forget this device" explains it is local only, clears the token and stops polling', async () => {
    const { store, timers } = await renderApp(SESSION);
    await screen.findByText('Latest report');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forget this device…' })));
    expect(screen.getByText(/does not end the session on the gateway/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forget this device' })));
    expect(store.load()).toBeNull();
    expect(screen.getByText(/gateway session itself was not revoked/)).toBeTruthy();
    expect(timers.pending.size).toBe(0);
  });

  it('stops polling when the status screen is unmounted', async () => {
    const { timers, view } = await renderApp(SESSION);
    await screen.findByText('Latest report');
    expect(timers.pending.size).toBe(1);
    await act(async () => view.unmount());
    expect(timers.pending.size).toBe(0);
  });
});
