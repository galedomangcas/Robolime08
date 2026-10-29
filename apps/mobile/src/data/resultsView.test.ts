import type { CellReading, RunRecommendationResponse, RunSummary } from '@robolime/shared';

import {
  OPEN_METEO_CREDIT,
  RUN_STATUS_NOT_REPORTED,
  buildReadingRows,
  buildRecommendationView,
  buildRunListItem,
  formatEcUnconfirmed,
  isRecommendationMissing,
  recommendationFailureMessage,
  runLoadFailureMessage,
  totalCommandedMl,
} from './resultsView';

const reading = (cellIndex: number, seq: number, dose: number, expected: number | null): CellReading => ({
  runId: 'run-1',
  runType: 'dosing',
  cellIndex,
  seq,
  attemptCount: 0,
  ph: 5.2,
  ec: 0.4234,
  moisturePercent: 31.25,
  temperatureC: 28.44,
  doseVolumeMl: dose,
  expectedPostCorrectionPh: expected,
  gps: null,
  rawFlags: 0,
  timestamps: { robotAt: '2026-03-01T08:00:00.000Z', gatewayReceivedAt: null, cloudSyncedAt: null },
});

const stored = (over: Partial<RunRecommendationResponse> = {}, weatherSource: 'forecast' | 'seasonal-defaults' = 'seasonal-defaults'): RunRecommendationResponse => ({
  recommendation: {
    id: 'rec',
    runId: 'run-1',
    ruleSetVersion: 'v1',
    inputs: { medianPh: 5.9, medianEc: 0.4, medianMoisturePercent: 30, medianTemperatureC: 28, season: 'dry', weatherSource, weather: {} },
    allScores: [],
    shortlist: [1, 2, 3, 4, 5, 6].map((n) => ({ cropId: `c${n}`, cropName: `Crop ${n}`, category: `cat${n}`, score: 10 - n + 0.456, reasons: [`reason ${n}`] })),
    computedAt: '2026-03-01T09:00:00.000Z',
  },
  ruleSetStatus: 'approved',
  isSynthetic: false,
  ...over,
});

describe('results view', () => {
  it('describes a run without cell-progress counts and marks synthetic data', () => {
    const run: RunSummary = {
      id: 'run-1', sourceRunId: 'R-7', runType: 'dosing', fieldId: null, readingCount: 1,
      firstRobotRecordedAt: null, lastRobotRecordedAt: null, isSynthetic: true,
    };
    const item = buildRunListItem(run);
    expect(item.title).toBe('Dosing run R-7 (synthetic demo data)');
    expect(item.detail).toBe('No readings recorded yet · 1 reading record');
    expect(`${item.title} ${item.detail}`).not.toMatch(/ of \d|%|cells? \d/);
    // No completion state exists in the contract (D46): never claimed, never inferred.
    expect(item.statusLabel).toBe(RUN_STATUS_NOT_REPORTED);
    expect(buildRunListItem({ ...run, readingCount: 20, firstRobotRecordedAt: '2026-03-01T08:00:00.000Z', lastRobotRecordedAt: '2026-03-01T09:00:00.000Z' }).statusLabel).toBe(
      RUN_STATUS_NOT_REPORTED,
    );
  });

  it('orders readings by cell and sequence, with pH to two decimals and the exact wording', () => {
    const rows = buildReadingRows([reading(2, 1, 0, null), reading(0, 2, 50, 6.1), reading(0, 1, 120.25, 5.95)]);
    expect(rows.map((r) => r.key)).toEqual(['0:1', '0:2', '2:1']);
    expect(rows[0]).toMatchObject({
      title: 'Cell 1 · record 1',
      ph: '5.20',
      expectedPostCorrectionPh: '5.95',
      doseCommanded: '120.3 mL',
      moisture: '31.3%',
      temperature: '28.4 °C',
      ec: '0.4234 (unit unconfirmed)',
    });
    expect(rows[2]?.expectedPostCorrectionPh).toBe('—');
    expect(JSON.stringify(rows)).not.toMatch(/predicted/i);
  });

  it('never guesses an EC unit and keeps small values visible', () => {
    expect(formatEcUnconfirmed(1200)).toBe('1200 (unit unconfirmed)');
    expect(formatEcUnconfirmed(0.004)).toBe('0.004 (unit unconfirmed)');
    expect(formatEcUnconfirmed(0.1 + 0.2)).toBe('0.3 (unit unconfirmed)');
    expect(formatEcUnconfirmed(Number.NaN)).toBe('—');
    expect(formatEcUnconfirmed(0.004)).not.toMatch(/S\/cm|dS\/m/);
  });

  it('sums commanded volumes for display only', () => {
    expect(totalCommandedMl([reading(0, 1, 120.25, null), reading(1, 1, 50, null)])).toBe('170.3 mL');
    expect(totalCommandedMl([])).toBe('0.0 mL');
  });

  it('shows at most five shortlisted crops in stored order, each with its reasons', () => {
    const view = buildRecommendationView(stored());
    if (view.kind !== 'available') throw new Error('expected available');
    expect(view.warning).toBeNull();
    expect(view.shortlist.map((s) => `${s.rank}:${s.cropName}:${s.score}`)).toEqual(['1:Crop 1:9.46', '2:Crop 2:8.46', '3:Crop 3:7.46', '4:Crop 4:6.46', '5:Crop 5:5.46']);
    expect(view.shortlist[0]?.reasons).toEqual(['reason 1']);
    expect(view.weatherNote).toBe('Weather: local seasonal defaults from the rule set (no forecast was used).');
    expect(view.showOpenMeteoCredit).toBe(false);
  });

  it('marks synthetic, draft and retired rule sets', () => {
    const synthetic = buildRecommendationView(stored({ isSynthetic: true, ruleSetStatus: 'draft' }));
    const draft = buildRecommendationView(stored({ ruleSetStatus: 'draft' }));
    const retired = buildRecommendationView(stored({ ruleSetStatus: 'retired' }));
    expect(synthetic.kind === 'available' && synthetic.warning).toMatch(/Synthetic demo fixture: not a verified/);
    expect(draft.kind === 'available' && draft.warning).toMatch(/Draft rule set/);
    expect(retired.kind === 'available' && retired.warning).toMatch(/retired/);
  });

  it('credits Open-Meteo only when a forecast was used', () => {
    const view = buildRecommendationView(stored({}, 'forecast'));
    expect(view.kind === 'available' && view.showOpenMeteoCredit).toBe(true);
    expect(view.kind === 'available' && view.weatherNote).toBe('Weather: forecast values recorded with this recommendation.');
    expect(OPEN_METEO_CREDIT).toMatch(/Open-Meteo/);
  });

  it('distinguishes "not stored yet" from an unavailable gateway', () => {
    expect(recommendationFailureMessage({ kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null })).toBe(
      'No crop recommendation has been stored for this run yet.',
    );
    expect(recommendationFailureMessage({ kind: 'unreachable' })).toBe(
      'Crop recommendation unavailable. Field gateway unavailable: cannot reach it.',
    );
  });

  it('tells a missing run apart from an unavailable gateway', () => {
    const notFound = { kind: 'api', status: 404, code: 'NOT_FOUND', retryAfterSeconds: null } as const;
    expect(runLoadFailureMessage(notFound)).toBe('This run is no longer available on the field gateway.');
    expect(runLoadFailureMessage({ kind: 'timeout' })).toBe('Field gateway unavailable: no answer within 10 seconds.');
    expect(isRecommendationMissing(notFound)).toBe(true);
    expect(isRecommendationMissing({ kind: 'unreachable' })).toBe(false);
    expect(isRecommendationMissing({ kind: 'api', status: 500, code: 'INTERNAL_ERROR', retryAfterSeconds: null })).toBe(false);
  });
});
