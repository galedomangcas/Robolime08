import type {
  CellReading,
  RobotStatus,
  RunReadingsResponse,
  RunRecommendationResponse,
  RunsResponse,
  RunSummary,
} from '@robolime/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { API_V1_ROUTES } from '@robolime/shared';

import { createGatewayClient, type FetchLike, type GatewayClient, type GatewayResult } from '../data/gatewayClient';
import { createMemorySessionStore, type StoredSession } from '../data/sessionStore';
import type { Timers } from '../data/statusPoller';
import { AppRoot } from './AppRoot';

/**
 * Phase 5 Results flow, end to end through AppRoot with a fake local gateway:
 * the monitoring strip stays pinned while the user opens runs, and the screen
 * shows readings, commanded lime, expected post-correction pH and the stored
 * recommendation, with honest empty, missing and unavailable states.
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
  totalLimeCommandedMl: 1250,
  // Cell counts are present in the status but must never be rendered (D29): a
  // regression would show "7 of 20" or "35%", which PROGRESS detects.
  cellsCompleted: 7,
  totalCells: 20,
  timestamps: { robotAt: '2026-03-01T11:59:30.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
};

const RUN: RunSummary = {
  id: 'run-1', sourceRunId: 'R-0001', runType: 'dosing', fieldId: null, readingCount: 2,
  firstRobotRecordedAt: '2026-03-01T08:00:00.000Z', lastRobotRecordedAt: '2026-03-01T08:05:00.000Z', isSynthetic: true,
};

const reading = (cellIndex: number, dose: number, ph: number, expected: number | null): CellReading => ({
  runId: 'run-1', runType: 'dosing', cellIndex, seq: 1, attemptCount: 0, ph, ec: 0.42, moisturePercent: 31.5,
  temperatureC: 28.4, doseVolumeMl: dose, expectedPostCorrectionPh: expected, gps: null, rawFlags: 0,
  timestamps: { robotAt: '2026-03-01T08:00:00.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
});

const RECOMMENDATION: RunRecommendationResponse = {
  recommendation: {
    id: 'rec-1', runId: 'run-1', ruleSetVersion: 'demo-1',
    inputs: { medianPh: 5.9, medianEc: 0.42, medianMoisturePercent: 31.5, medianTemperatureC: 28.4, season: 'dry', weatherSource: 'seasonal-defaults', weather: {} },
    allScores: [],
    shortlist: [{ cropId: 'c1', cropName: 'Fixture crop A', category: 'Fixture category', score: 0.8, reasons: ['SYNTHETIC FIXTURE — not a scientific recommendation.'] }],
    computedAt: '2026-03-01T09:00:00.000Z',
  },
  ruleSetStatus: 'draft',
  isSynthetic: true,
};

const PROGRESS = /\b7 of 20\b|\b35 ?%|Working: \d/;

const RUN2: RunSummary = { ...RUN, id: 'run-2', sourceRunId: 'R-0002', readingCount: 1 };
const reading2: CellReading = { ...reading(5, 30, 4.75, 5.5), runId: 'run-2' };

const ok = <T,>(data: T): GatewayResult<T> => ({ ok: true, data });
const unreachable = { ok: false as const, failure: { kind: 'unreachable' as const } };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const notFound = { ok: false as const, failure: { kind: 'api' as const, status: 404, code: 'NOT_FOUND' as const, retryAfterSeconds: null } };

function fakeClient() {
  const calls: string[] = [];
  const state = {
    runs: ok<RunsResponse>({ runs: [RUN] }) as GatewayResult<RunsResponse>,
    readings: ok<RunReadingsResponse>({ run: RUN, readings: [reading(1, 0, 6.05, null), reading(0, 120, 5.21, 5.95)] }) as GatewayResult<RunReadingsResponse>,
    recommendation: ok(RECOMMENDATION) as GatewayResult<RunRecommendationResponse>,
    /** When set, answers come from these instead (lets a test hold an answer and release it late). */
    runsFor: null as null | (() => Promise<GatewayResult<RunsResponse>>),
    readingsFor: null as null | ((runId: string) => Promise<GatewayResult<RunReadingsResponse>>),
    recommendationFor: null as null | ((runId: string) => Promise<GatewayResult<RunRecommendationResponse>>),
  };
  const client: GatewayClient = {
    pair: async () => notFound,
    session: async () => ok({ robot: ROBOT, expiresAt: SESSION.expiresAt }),
    robotStatus: async () => {
      calls.push('status');
      return ok({ status: STATUS, staleThresholdSeconds: 240 });
    },
    runs: async (token) => {
      calls.push(`runs:${token}`);
      return state.runsFor ? state.runsFor() : state.runs;
    },
    runReadings: async (token, runId) => {
      calls.push(`readings:${token}:${runId}`);
      return state.readingsFor ? state.readingsFor(runId) : state.readings;
    },
    runRecommendation: async (token, runId) => {
      calls.push(`recommendation:${token}:${runId}`);
      return state.recommendationFor ? state.recommendationFor(runId) : state.recommendation;
    },
  };
  return { client, calls, state };
}

const noTimers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };

async function openResults(fake: ReturnType<typeof fakeClient>) {
  const store = createMemorySessionStore();
  store.save(SESSION);
  await render(<AppRoot client={fake.client} store={store} now={() => NOW} timers={noTimers} />);
  await screen.findByText('Latest report');
  await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
  return store;
}

const allText = () => JSON.stringify(screen.toJSON());

describe('Results (Phase 5, local field mode)', () => {
  it('lists dosing runs under the pinned monitoring strip, then shows one run in full', async () => {
    const fake = fakeClient();
    await openResults(fake);

    // Monitoring strip still pinned on the results section.
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Component self-check: Unknown')).toBeTruthy();
    expect(screen.queryByText('Forget this device…')).toBeNull();

    expect(await screen.findByText('Dosing run R-0001 (synthetic demo data)')).toBeTruthy();
    expect(screen.getByText(/Source: Field gateway on this laptop \(works without internet\)/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));

    expect(await screen.findByText('Cell 0 · record 1')).toBeTruthy();
    expect(fake.calls).toEqual(expect.arrayContaining(['runs:stored-token', 'readings:stored-token:run-1', 'recommendation:stored-token:run-1']));
    expect(screen.getByText('5.21')).toBeTruthy();
    expect(screen.getByText('5.95')).toBeTruthy();
    expect(screen.getAllByText('Expected post-correction pH').length).toBe(2);
    // One reading row (120 mL) plus the run total (120 + 0 mL).
    expect(screen.getAllByText('120.0 mL')).toHaveLength(2);
    expect(screen.getByText('Total lime commanded in these records')).toBeTruthy();
    expect(screen.getByText(/not measurements of liquid actually delivered/)).toBeTruthy();
    expect(screen.getAllByText('0.42 (unit unconfirmed)').length).toBeGreaterThan(0);

    expect(screen.getByText('Synthetic demo fixture: not a verified crop recommendation.')).toBeTruthy();
    // Crop card (mockup page 5): rank badge, name, category, score and its traceable reason.
    expect(screen.getByText('Top 5 crops for this field')).toBeTruthy();
    expect(screen.getByText('Fixture crop A')).toBeTruthy();
    expect(screen.getByText('Fixture category')).toBeTruthy();
    expect(screen.getByLabelText('Score 0.8')).toBeTruthy();
    expect(screen.getByText('SYNTHETIC FIXTURE — not a scientific recommendation.')).toBeTruthy();
    expect(screen.getByText('Weather: local seasonal defaults from the rule set (no forecast was used).')).toBeTruthy();

    const text = allText();
    expect(text).not.toMatch(/predicted/i);
    expect(text).not.toMatch(/verification|observed post-treatment/i);
    // The progress pattern really detects the excluded format, and the screen does not show it.
    expect('Working: 7 of 20 cells (35%)').toMatch(PROGRESS);
    expect(text).not.toMatch(PROGRESS);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Back to dosing runs' })));
    expect(await screen.findByText('Dosing run R-0001 (synthetic demo data)')).toBeTruthy();
  });

  it('shows empty and "not stored yet" states without inventing values', async () => {
    const fake = fakeClient();
    fake.state.recommendation = notFound;
    fake.state.readings = ok({ run: RUN, readings: [] });
    await openResults(fake);
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByText('No reading records have been stored for this run.')).toBeTruthy();
    expect(screen.getByText('No crop recommendation has been stored for this run yet.')).toBeTruthy();
  });

  it('shows "no runs" when the gateway has none', async () => {
    const fake = fakeClient();
    fake.state.runs = ok({ runs: [] });
    await openResults(fake);
    expect(await screen.findByText('No dosing runs have been recorded on this gateway yet.')).toBeTruthy();
  });

  it('reports an unavailable gateway and retries on request', async () => {
    const fake = fakeClient();
    fake.state.runs = { ok: false, failure: { kind: 'unreachable' } };
    await openResults(fake);
    expect(await screen.findByText('Field gateway unavailable: cannot reach it.')).toBeTruthy();
    fake.state.runs = ok({ runs: [RUN] });
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText('Dosing run R-0001 (synthetic demo data)')).toBeTruthy();
  });

  it('returns to pairing when the gateway rejects the session while loading results', async () => {
    const fake = fakeClient();
    fake.state.runs = { ok: false, failure: { kind: 'api', status: 401, code: 'SESSION_EXPIRED', retryAfterSeconds: null } };
    const store = await openResults(fake);
    expect(await screen.findByText(/no longer accepts this device/)).toBeTruthy();
    expect(store.load()).toBeNull();
  });

  it('shows a failed recommendation with a retry that reloads only the recommendation', async () => {
    const fake = fakeClient();
    fake.state.recommendation = unreachable;
    await openResults(fake);
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByText('Crop recommendation unavailable. Field gateway unavailable: cannot reach it.')).toBeTruthy();
    expect(screen.getByText('Cell 0 · record 1')).toBeTruthy();
    const count = (prefix: string) => fake.calls.filter((c) => c.startsWith(prefix)).length;
    expect([count('readings:'), count('recommendation:')]).toEqual([1, 1]);

    // Still failing: each press sends exactly one more read-only request.
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText(/Crop recommendation unavailable/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
    expect([count('readings:'), count('recommendation:')]).toEqual([1, 3]);

    fake.state.recommendation = ok(RECOMMENDATION);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText('Fixture crop A')).toBeTruthy();
    expect(screen.queryByText(/Crop recommendation unavailable/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect([count('readings:'), count('recommendation:')]).toEqual([1, 4]);
    expect(fake.calls.every((c) => /^(status|runs:|readings:|recommendation:)/.test(c))).toBe(true);
  });

  it('says a missing run is no longer available, not that the gateway is down', async () => {
    const fake = fakeClient();
    fake.state.readings = notFound;
    await openResults(fake);
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByText('This run is no longer available on the field gateway.')).toBeTruthy();
    expect(screen.queryByText(/Field gateway unavailable/)).toBeNull();
  });

  it('ignores answers that arrive after the user has left the Results section', async () => {
    const fake = fakeClient();
    const held = deferred<GatewayResult<RunReadingsResponse>>();
    fake.state.readingsFor = () => held.promise;
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await openResults(fake);
      await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
      expect(screen.getByText('Loading readings…')).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Field' })));
      await act(async () => held.resolve(ok({ run: RUN, readings: [reading(0, 120, 5.21, 5.95)] })));
      expect(screen.queryByText('Cell 0 · record 1')).toBeNull();
      expect(screen.getByText('Forget this device…')).toBeTruthy();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('never lets a late answer for a previously opened run replace the run now shown', async () => {
    const fake = fakeClient();
    fake.state.runs = ok({ runs: [RUN, RUN2] });
    const heldRun1 = deferred<GatewayResult<RunReadingsResponse>>();
    fake.state.readingsFor = (runId) =>
      runId === 'run-1' ? heldRun1.promise : Promise.resolve(ok({ run: RUN2, readings: [reading2] }));
    fake.state.recommendationFor = async () => notFound;
    await openResults(fake);

    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Back to dosing runs' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0002 (synthetic demo data)' })));
    expect(await screen.findByText('Cell 5 · record 1')).toBeTruthy();

    await act(async () => heldRun1.resolve(ok({ run: RUN, readings: [reading(0, 120, 5.21, 5.95)] })));
    expect(screen.getByText('Dosing run R-0002 (synthetic demo data)')).toBeTruthy();
    expect(screen.getByText('Cell 5 · record 1')).toBeTruthy();
    expect(screen.queryByText('Cell 0 · record 1')).toBeNull();
    expect(screen.queryByText('Dosing run R-0001 (synthetic demo data)')).toBeNull();
  });

  it('returns to pairing and shows no run data when the session is rejected while readings are loading', async () => {
    const fake = fakeClient();
    const held = deferred<GatewayResult<RunReadingsResponse>>();
    fake.state.readingsFor = () => held.promise;
    const store = await openResults(fake);
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    // The recommendation already arrived and is visible while readings are still loading.
    expect(await screen.findByText('Fixture crop A')).toBeTruthy();
    expect(screen.getByText('Loading readings…')).toBeTruthy();

    await act(async () =>
      held.resolve({ ok: false, failure: { kind: 'api', status: 401, code: 'SESSION_EXPIRED', retryAfterSeconds: null } }),
    );
    expect(await screen.findByText(/no longer accepts this device/)).toBeTruthy();
    expect(store.load()).toBeNull();
    expect(screen.queryByText(/Fixture crop A/)).toBeNull();
    expect(screen.queryByText(/Dosing run/)).toBeNull();
    expect(screen.getByLabelText('Pairing code')).toBeTruthy();
  });

  it('lists every dosing run, including one with no readings yet, with an honest status label and no completion claim', async () => {
    const fake = fakeClient();
    const inProgress: RunSummary = { ...RUN2, readingCount: 0, firstRobotRecordedAt: null, lastRobotRecordedAt: null };
    fake.state.runs = ok({ runs: [RUN, inProgress] });
    await openResults(fake);
    expect(await screen.findByText('Dosing run R-0001 (synthetic demo data)')).toBeTruthy();
    expect(screen.getByText('Dosing run R-0002 (synthetic demo data)')).toBeTruthy();
    expect(screen.getByText('No readings recorded yet · 0 reading records')).toBeTruthy();
    expect(screen.getAllByText('Run status: not reported by the gateway')).toHaveLength(2);
    expect(screen.getByText(/including runs that may still be in progress or were interrupted/)).toBeTruthy();
    const listText = allText();
    expect(listText).not.toMatch(/\b(Completed|Complete run|Incomplete|Finished|Failed run)\b/);
    expect(listText).not.toMatch(/verification/i);
  });

  it('keeps the newest run list when an older list request answers last', async () => {
    const fake = fakeClient();
    const first = deferred<GatewayResult<RunsResponse>>();
    let call = 0;
    fake.state.runsFor = () => (++call === 1 ? first.promise : Promise.resolve(ok({ runs: [RUN2] })));
    await openResults(fake);
    expect(screen.getByText('Loading runs…')).toBeTruthy();

    // Leave and come back: a second, newer request answers first.
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Field' })));
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    expect(await screen.findByText('Dosing run R-0002 (synthetic demo data)')).toBeTruthy();

    // The older request now answers with different data: it must be ignored.
    await act(async () => first.resolve(ok({ runs: [RUN] })));
    expect(screen.getByText('Dosing run R-0002 (synthetic demo data)')).toBeTruthy();
    expect(screen.queryByText('Dosing run R-0001 (synthetic demo data)')).toBeNull();
    expect(screen.queryByText('Loading runs…')).toBeNull();
    expect(call).toBe(2);
  });

  it('clears the loading and error states when a failed run list is retried successfully', async () => {
    const fake = fakeClient();
    const retry = deferred<GatewayResult<RunsResponse>>();
    let call = 0;
    fake.state.runsFor = () => (++call === 1 ? Promise.resolve(unreachable) : retry.promise);
    await openResults(fake);
    expect(await screen.findByText('Field gateway unavailable: cannot reach it.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
    expect(screen.getByText('Loading runs…')).toBeTruthy();
    expect(screen.queryByText('Field gateway unavailable: cannot reach it.')).toBeNull();
    await act(async () => retry.resolve(ok({ runs: [RUN] })));
    expect(screen.getByText('Dosing run R-0001 (synthetic demo data)')).toBeTruthy();
    expect(screen.queryByText('Loading runs…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('Results through the real gateway client', () => {
  it('reports readings for a different run as unreadable instead of showing them', async () => {
    const byPath: Record<string, unknown> = {
      [API_V1_ROUTES.robotStatus]: { status: STATUS, staleThresholdSeconds: 240 },
      [API_V1_ROUTES.runs]: { runs: [RUN] },
      // The gateway answers the run-1 request with run-2's records.
      [API_V1_ROUTES.runReadings('run-1')]: { run: RUN2, readings: [reading2] },
      [API_V1_ROUTES.runRecommendation('run-1')]: RECOMMENDATION,
    };
    const fetch: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(byPath[url] ?? {}),
    });
    const store = createMemorySessionStore();
    store.save(SESSION);
    await render(<AppRoot client={createGatewayClient({ baseUrl: '', fetch })} store={store} now={() => NOW} timers={noTimers} />);
    await screen.findByText('Latest report');
    await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Results' })));
    await act(async () => fireEvent.press(await screen.findByRole('button', { name: 'Dosing run R-0001 (synthetic demo data)' })));
    expect(await screen.findByText('Field gateway unavailable: unreadable answer.')).toBeTruthy();
    expect(screen.queryByText('Cell 5 · record 1')).toBeNull();
    expect(screen.queryByText(/R-0002/)).toBeNull();
  });
});
