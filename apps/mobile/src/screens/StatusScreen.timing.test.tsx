import { ROBOT_COMPONENTS, type RobotStatus } from '@robolime/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { AGE_REFRESH_MS, REQUEST_TIMEOUT_MS, STATUS_POLL_INTERVAL_MS } from '../config/timing';
import { createGatewayClient, type FetchLike } from '../data/gatewayClient';
import { createMemorySessionStore, type StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { AppRoot } from './AppRoot';

/**
 * Timing (decision D33) and malformed-answer handling, end to end through the
 * REAL gateway client with a scripted fetch. Poll scheduling uses injected
 * manual timers (so the requested delay can be asserted); the 1 s age refresh
 * and the 10 s request timeout use Jest's fake clock. No real waiting.
 */

const ROBOT = { id: 'r1', displayName: 'Demo robot', isSynthetic: true };
const SESSION: StoredSession = { token: 'stored-token', robot: ROBOT, expiresAt: '2026-06-01T00:00:00.000Z' };
const START = new Date('2026-03-01T12:00:00.000Z');

const STATUS: RobotStatus = {
  robotId: 'r1',
  state: 'IDLE',
  errorFlags: [],
  componentChecks: Object.fromEntries(ROBOT_COMPONENTS.map((c) => [c, 'unknown'])) as RobotStatus['componentChecks'],
  batteryVoltage: 12.4,
  totalLimeCommandedMl: 1250,
  cellsCompleted: 0,
  totalCells: 0,
  timestamps: { robotAt: '2026-03-01T11:59:30.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
};
const VALID = JSON.stringify({ status: STATUS, staleThresholdSeconds: 240 });

/** Scripted fetch: each call takes the next reply; a reply may be held open until released. */
function scriptedFetch() {
  const replies: (string | Promise<string>)[] = [];
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const reply = await (replies.shift() ?? VALID);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => reply };
  };
  return { fetch, replies, urls };
}

function manualTimers() {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    setTimeout: (cb, ms) => {
      const id = next++;
      pending.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  const firePoll = async () => {
    const [id, entry] = [...pending.entries()][0] ?? [];
    if (id === undefined || entry === undefined) throw new Error('no poll scheduled');
    pending.delete(id);
    await act(async () => entry.cb());
  };
  return { timers, pending, firePoll };
}

async function renderStatus(fetch: FetchLike, timers: Timers) {
  const store = createMemorySessionStore();
  store.save(SESSION);
  const client = createGatewayClient({ baseUrl: '', fetch });
  const view = await render(<AppRoot client={client} store={store} now={() => new Date()} timers={timers} />);
  await act(async () => {});
  return view;
}

afterEach(() => {
  jest.useRealTimers();
});

describe('approved timing values (D33)', () => {
  it('are 10 s request timeout, 10 s poll gap and 1 s age refresh', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(STATUS_POLL_INTERVAL_MS).toBe(10_000);
    expect(AGE_REFRESH_MS).toBe(1_000);
  });

  it('the client times out at 10 s by default (not earlier)', async () => {
    jest.useFakeTimers();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = createGatewayClient({ baseUrl: '', fetch: hanging }).robotStatus('t');
    let settled = false;
    void pending.then(() => (settled = true));
    jest.advanceTimersByTime(9_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await pending).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });
});

describe('status polling schedule', () => {
  it('schedules the next request 10 s after the previous one FINISHES, never while one is in flight', async () => {
    const { fetch, replies, urls } = scriptedFetch();
    let release!: (text: string) => void;
    replies.push(new Promise<string>((r) => (release = r)));
    const t = manualTimers();
    await renderStatus(fetch, t.timers);

    expect(urls).toHaveLength(1);
    expect(t.pending.size).toBe(0); // first request still in flight: nothing scheduled
    await act(async () => release(VALID));
    expect(t.pending.size).toBe(1);
    expect([...t.pending.values()][0]?.ms).toBe(10_000);

    await t.firePoll();
    expect(urls).toHaveLength(2);
    expect([...t.pending.values()][0]?.ms).toBe(10_000);
  });

  it('stops polling when the device is forgotten', async () => {
    const t = manualTimers();
    await renderStatus(scriptedFetch().fetch, t.timers);
    expect(t.pending.size).toBe(1);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forget this device…' })));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forget this device' })));
    expect(t.pending.size).toBe(0);
  });
});

describe('local age refresh', () => {
  it('re-renders the age every 1 s without any network request, and stops on unmount', async () => {
    jest.useFakeTimers({ now: START });
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    const { fetch, urls } = scriptedFetch();
    const t = manualTimers();
    const view = await renderStatus(fetch, t.timers);
    const ageCalls = setIntervalSpy.mock.calls.flatMap((call, i) => (call[1] === AGE_REFRESH_MS ? [setIntervalSpy.mock.results[i]?.value] : []));
    expect(ageCalls).toHaveLength(1); // exactly one 1 s interval, created by the status screen
    expect(screen.getByText('Reported 30 s ago')).toBeTruthy();

    await act(async () => jest.advanceTimersByTime(999));
    expect(screen.getByText('Reported 30 s ago')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(1));
    expect(screen.getByText('Reported 31 s ago')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(4_000));
    expect(screen.getByText('Reported 35 s ago')).toBeTruthy();

    expect(urls).toHaveLength(1); // ages are local: no extra request
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(ageCalls[0]);
    await act(async () => view.unmount());
    expect(clearIntervalSpy).toHaveBeenCalledWith(ageCalls[0]); // the 1 s interval is cleared
    expect(t.pending.size).toBe(0); // and the poll is cancelled
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(urls).toHaveLength(1); // nothing runs after unmount
  });

  it('crosses from fresh to stale at 240 s → 241 s on the local clock alone', async () => {
    jest.useFakeTimers({ now: new Date('2026-03-01T12:03:29.000Z') }); // robot time + 239 s
    await renderStatus(scriptedFetch().fetch, manualTimers().timers);
    expect(screen.getByText('Reported 3 min ago')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(1_000)); // 240 s: still fresh
    expect(screen.getByText('Reported 4 min ago')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(1_000)); // 241 s: stale
    expect(screen.getByText('Stale: reported 4 min ago')).toBeTruthy();
  });
});

describe('malformed gateway answers in the UI', () => {
  it('a malformed first answer shows "No status data", never values', async () => {
    const { fetch, replies } = scriptedFetch();
    replies.push(JSON.stringify({ status: { ...STATUS, state: 'FLYING', batteryVoltage: 99.9 }, staleThresholdSeconds: 240 }));
    await renderStatus(fetch, manualTimers().timers);
    expect(screen.getByText('Field gateway unavailable: unreadable answer')).toBeTruthy();
    expect(screen.getByText('No status data')).toBeTruthy();
    expect(screen.queryByText('99.90 V')).toBeNull();
    expect(screen.queryByText('Latest report')).toBeNull();
  });

  it('a malformed later answer keeps the earlier report only as "Last received" (stale), and does not crash', async () => {
    const { fetch, replies } = scriptedFetch();
    replies.push(VALID, '{"status": {"state": "IDLE"}', JSON.stringify({ status: { ...STATUS, batteryVoltage: 'high' }, staleThresholdSeconds: 240 }));
    const t = manualTimers();
    await renderStatus(fetch, t.timers);
    expect(screen.getByText('Latest report')).toBeTruthy();

    for (let i = 0; i < 2; i++) {
      await t.firePoll();
      expect(screen.getByText('Field gateway unavailable: unreadable answer')).toBeTruthy();
      expect(screen.getByText('Last received')).toBeTruthy();
      expect(screen.queryByText('Latest report')).toBeNull();
      expect(screen.getByText('12.40 V')).toBeTruthy(); // the earlier valid value, not the malformed one
    }
    expect(t.pending.size).toBe(1); // still polling: a malformed answer does not end the session
  });
});
