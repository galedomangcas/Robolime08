import type { CellReading, RunRecommendationResponse, RunSummary } from '@robolime/shared';

import {
  isReadingsForRun,
  isRecommendationForRun,
  isRunReadingsResponse,
  isRunRecommendationResponse,
  isRunsResponse,
} from './responseValidation';

const RUN: RunSummary = {
  id: 'run-1',
  sourceRunId: 'R-0001',
  runType: 'dosing',
  fieldId: null,
  readingCount: 1,
  firstRobotRecordedAt: '2026-03-01T08:00:00.000Z',
  lastRobotRecordedAt: '2026-03-01T08:00:00.000Z',
  isSynthetic: true,
};

const READING: CellReading = {
  runId: 'run-1',
  runType: 'dosing',
  cellIndex: 0,
  seq: 1,
  attemptCount: 0,
  ph: 5.21,
  ec: 0.42,
  moisturePercent: 31.5,
  temperatureC: 28.4,
  doseVolumeMl: 120,
  expectedPostCorrectionPh: 5.9,
  gps: { latitude: 13.9, longitude: 120.6 },
  rawFlags: 0,
  timestamps: { robotAt: '2026-03-01T08:00:00.000Z', gatewayReceivedAt: '2026-03-01T08:00:01.000Z', cloudSyncedAt: null },
};

const RECOMMENDATION: RunRecommendationResponse = {
  recommendation: {
    id: 'rec-1',
    runId: 'run-1',
    ruleSetVersion: 'demo-1',
    inputs: {
      medianPh: 5.9,
      medianEc: 0.42,
      medianMoisturePercent: 31.5,
      medianTemperatureC: 28.4,
      season: 'dry',
      weatherSource: 'seasonal-defaults',
      weather: { rainfallMm: 10 },
    },
    allScores: [{ cropId: 'c1', cropName: 'Crop', category: 'cat', score: 1, reasons: ['r'] }],
    shortlist: [{ cropId: 'c1', cropName: 'Crop', category: 'cat', score: 1, reasons: ['r'] }],
    computedAt: '2026-03-01T09:00:00.000Z',
  },
  ruleSetStatus: 'draft',
  isSynthetic: true,
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('run response validation', () => {
  it('accepts the documented shapes', () => {
    expect(isRunsResponse({ runs: [RUN] })).toBe(true);
    expect(isRunsResponse({ runs: [] })).toBe(true);
    expect(isRunReadingsResponse({ run: RUN, readings: [READING] })).toBe(true);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, gps: null, expectedPostCorrectionPh: null }] })).toBe(true);
    expect(isRunRecommendationResponse(RECOMMENDATION)).toBe(true);
  });

  it('rejects verification runs and verification readings, so they never reach farmer-facing screens', () => {
    expect(isRunsResponse({ runs: [{ ...RUN, runType: 'verification' }] })).toBe(false);
    expect(isRunReadingsResponse({ run: { ...RUN, runType: 'verification' }, readings: [] })).toBe(false);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, runType: 'verification' }] })).toBe(false);
  });

  it('rejects missing, mistyped and non-finite values without coercion', () => {
    expect(isRunsResponse({})).toBe(false);
    expect(isRunsResponse({ runs: [{ ...RUN, readingCount: '1' }] })).toBe(false);
    expect(isRunsResponse({ runs: [{ ...RUN, firstRobotRecordedAt: '2026-02-30T00:00:00Z' }] })).toBe(false);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, ph: null }] })).toBe(false);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, gps: { latitude: 1 } }] })).toBe(false);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, timestamps: { robotAt: '2026-03-01T08:00:00' } }] })).toBe(false);
    expect(isRunReadingsResponse({ run: RUN, readings: [{ ...READING, ec: Infinity }] })).toBe(false);
  });

  it('rejects malformed recommendations', () => {
    const badWeather = clone(RECOMMENDATION);
    (badWeather.recommendation.inputs as { weatherSource: string }).weatherSource = 'guess';
    expect(isRunRecommendationResponse(badWeather)).toBe(false);
    const badStatus = { ...clone(RECOMMENDATION), ruleSetStatus: 'final' };
    expect(isRunRecommendationResponse(badStatus)).toBe(false);
    const badReasons = clone(RECOMMENDATION);
    (badReasons.recommendation.shortlist as unknown[])[0] = { cropId: 'c1', cropName: 'Crop', category: 'cat', score: 1, reasons: [1] };
    expect(isRunRecommendationResponse(badReasons)).toBe(false);
    const { isSynthetic: _omitted, ...noFlag } = clone(RECOMMENDATION);
    expect(isRunRecommendationResponse(noFlag)).toBe(false);
  });
});

describe('nested malformed data is rejected', () => {
  const withReading = (patch: Record<string, unknown>) => ({ run: RUN, readings: [{ ...READING, ...patch }] });
  it('in readings', () => {
    expect(isRunReadingsResponse(withReading({ timestamps: { ...READING.timestamps, gatewayReceivedAt: '2026-13-01T00:00:00Z' } }))).toBe(false);
    expect(isRunReadingsResponse(withReading({ timestamps: { ...READING.timestamps, cloudSyncedAt: undefined } }))).toBe(false);
    expect(isRunReadingsResponse(withReading({ gps: { latitude: 13.9, longitude: '120.6' } }))).toBe(false);
    expect(isRunReadingsResponse(withReading({ runId: 7 }))).toBe(false);
    expect(isRunReadingsResponse({ run: { ...RUN, id: 1 }, readings: [] })).toBe(false);
  });

  it('in recommendations', () => {
    const variants: ((r: RunRecommendationResponse) => void)[] = [
      (r) => ((r.recommendation as { computedAt: string }).computedAt = '2026-02-29T09:00:00Z'),
      (r) => delete (r.recommendation.inputs as Partial<RunRecommendationResponse['recommendation']['inputs']>).medianPh,
      (r) => ((r.recommendation.inputs.weather as Record<string, unknown>).rainfallMm = 'wet'),
      (r) => ((r.recommendation.allScores as unknown[])[0] = { cropId: 'c1', cropName: 'Crop', category: 'cat', score: Infinity, reasons: [] }),
      (r) => ((r.recommendation as { runId: unknown }).runId = 5),
    ];
    for (const mutate of variants) {
      const bad = clone(RECOMMENDATION);
      mutate(bad);
      expect(isRunRecommendationResponse(bad)).toBe(false);
    }
  });
});

describe('run identity', () => {
  it('accepts readings and a recommendation for the requested run', () => {
    expect(isReadingsForRun({ run: RUN, readings: [READING] }, 'run-1')).toBe(true);
    expect(isReadingsForRun({ run: RUN, readings: [] }, 'run-1')).toBe(true);
    expect(isRecommendationForRun(RECOMMENDATION, 'run-1')).toBe(true);
  });

  it('rejects an answer that describes, or contains records of, another run', () => {
    expect(isReadingsForRun({ run: RUN, readings: [READING] }, 'run-2')).toBe(false);
    expect(isReadingsForRun({ run: RUN, readings: [READING, { ...READING, runId: 'run-2', seq: 2 }] }, 'run-1')).toBe(false);
    expect(isReadingsForRun({ run: { ...RUN, id: '' }, readings: [] }, 'run-1')).toBe(false);
    expect(isRecommendationForRun(RECOMMENDATION, 'run-2')).toBe(false);
  });
});
