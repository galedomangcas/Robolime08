import {
  MISSING_VALUE,
  formatMoisturePercent,
  formatPh,
  formatTemperatureC,
  formatVolumeMl,
  type CellReading,
  type RunRecommendationResponse,
  type RunSummary,
} from '@robolime/shared';

import type { GatewayFailure } from './gatewayClient';
import { connectionLabel, formatLocalTimestamp } from './statusView';

/**
 * Display text for the Results screen (pure, no React). Rules (CLAUDE.md §4
 * Screen 4, D29):
 * - dosing runs only; verification data never reaches this screen (the
 *   validators reject it before it gets here);
 * - "expected post-correction pH", never "predicted pH";
 * - commanded lime volume is labelled as commanded, not measured;
 * - no cell map, cell-progress counts or percentages this semester;
 * - the EC unit is unconfirmed (OPEN_ITEMS #7), so EC is shown as the stored
 *   value with that caveat, never with a guessed unit;
 * - a synthetic or non-approved recommendation is always marked as such.
 */

export const OPEN_METEO_CREDIT = 'Weather data by Open-Meteo.com (CC BY 4.0)';

export interface RunListItem {
  id: string;
  title: string;
  detail: string;
  /**
   * Every run gets the same honest label: neither `RunSummary` nor the gateway's
   * `runs` table records completion, failure or an end time, and status
   * reports are not linked to runs. Completion is never inferred from reading
   * counts or the robot's current state (decision D46).
   */
  statusLabel: string;
  isSynthetic: boolean;
}

export const RUN_STATUS_NOT_REPORTED = 'Run status: not reported by the gateway';
export const RUN_LIST_NOTE =
  'All dosing runs are listed, including runs that may still be in progress or were interrupted. ' +
  'The gateway does not record whether a run finished, so no run is marked complete.';

export function buildRunListItem(run: RunSummary): RunListItem {
  const recorded =
    run.firstRobotRecordedAt === null
      ? 'No readings recorded yet'
      : `Recorded ${formatLocalTimestamp(run.firstRobotRecordedAt)}` +
        (run.lastRobotRecordedAt !== null && run.lastRobotRecordedAt !== run.firstRobotRecordedAt
          ? ` to ${formatLocalTimestamp(run.lastRobotRecordedAt)}`
          : '');
  return {
    id: run.id,
    title: `Dosing run ${run.sourceRunId}${run.isSynthetic ? ' (synthetic demo data)' : ''}`,
    detail: `${recorded} · ${run.readingCount} reading record${run.readingCount === 1 ? '' : 's'}`,
    statusLabel: RUN_STATUS_NOT_REPORTED,
    isSynthetic: run.isSynthetic,
  };
}

export interface ReadingRow {
  key: string;
  title: string;
  /** Raw measured pH, for the gauge only (display text is `ph`). */
  phValue: number;
  ph: string;
  ec: string;
  moisture: string;
  temperature: string;
  doseCommanded: string;
  expectedPostCorrectionPh: string;
  robotTime: string;
}

/**
 * EC as stored, without a unit (OPEN_ITEMS #7). Six significant digits keep
 * small values visible (0.004 stays 0.004) while trimming floating-point noise;
 * no unit, scaling or decimal convention is implied.
 */
export function formatEcUnconfirmed(value: number): string {
  return Number.isFinite(value) ? `${Number(value.toPrecision(6))} (unit unconfirmed)` : MISSING_VALUE;
}

export function buildReadingRows(readings: readonly CellReading[]): ReadingRow[] {
  return [...readings]
    .sort((a, b) => a.cellIndex - b.cellIndex || a.seq - b.seq)
    .map((r) => ({
      key: `${r.cellIndex}:${r.seq}`,
      title: `Cell ${r.cellIndex} · record ${r.seq}`,
      phValue: r.ph,
      ph: formatPh(r.ph),
      ec: formatEcUnconfirmed(r.ec),
      moisture: formatMoisturePercent(r.moisturePercent),
      temperature: formatTemperatureC(r.temperatureC),
      doseCommanded: formatVolumeMl(r.doseVolumeMl, 1),
      expectedPostCorrectionPh: formatPh(r.expectedPostCorrectionPh),
      robotTime: formatLocalTimestamp(r.timestamps.robotAt),
    }));
}

/** Sum of the commanded volumes in the stored records (display only; not a measured volume). */
export function totalCommandedMl(readings: readonly CellReading[]): string {
  return formatVolumeMl(
    readings.reduce((sum, r) => sum + r.doseVolumeMl, 0),
    1,
  );
}

export interface ShortlistEntry {
  rank: number;
  cropName: string;
  category: string;
  score: string;
  /** Raw score, for a bar drawn relative to the top shortlisted score (the score scale is not defined). */
  scoreValue: number;
  reasons: readonly string[];
}

export type RecommendationView =
  | { kind: 'none'; message: string }
  | {
      kind: 'available';
      /** Non-null when the result must not be read as a verified recommendation. */
      warning: string | null;
      ruleSetLabel: string;
      computedAt: string;
      inputs: { label: string; value: string }[];
      weatherNote: string;
      showOpenMeteoCredit: boolean;
      shortlist: ShortlistEntry[];
    };

const isNotFound = (failure: GatewayFailure) => failure.kind === 'api' && failure.code === 'NOT_FOUND';

/** A missing run (404) is not a gateway outage: say which it is. */
export function runLoadFailureMessage(failure: GatewayFailure): string {
  if (isNotFound(failure)) return 'This run is no longer available on the field gateway.';
  return `${connectionLabel({ kind: 'unavailable', failure })}.`;
}

/**
 * NOT_FOUND means nothing is stored for the run: a settled answer, not an
 * error, so it is not retried. Any other failure can be retried.
 */
export function isRecommendationMissing(failure: GatewayFailure): boolean {
  return isNotFound(failure);
}

export function recommendationFailureMessage(failure: GatewayFailure): string {
  if (isNotFound(failure)) {
    return 'No crop recommendation has been stored for this run yet.';
  }
  return `Crop recommendation unavailable. ${connectionLabel({ kind: 'unavailable', failure })}.`;
}

export function buildRecommendationView(stored: RunRecommendationResponse): RecommendationView {
  const { recommendation, ruleSetStatus, isSynthetic } = stored;
  const { inputs } = recommendation;
  let warning: string | null = null;
  if (isSynthetic) {
    warning = 'Synthetic demo fixture: not a verified crop recommendation.';
  } else if (ruleSetStatus === 'draft') {
    warning = 'Draft rule set: not an approved crop recommendation.';
  } else if (ruleSetStatus === 'retired') {
    warning = 'Computed with a rule set that has since been retired.';
  }
  return {
    kind: 'available',
    warning,
    ruleSetLabel: `Rule set ${recommendation.ruleSetVersion} (${ruleSetStatus})`,
    computedAt: formatLocalTimestamp(recommendation.computedAt),
    inputs: [
      { label: 'Field median pH used (expected post-correction pH for limed cells, measured pH otherwise)', value: formatPh(inputs.medianPh) },
      { label: 'Field median EC', value: formatEcUnconfirmed(inputs.medianEc) },
      { label: 'Field median moisture', value: formatMoisturePercent(inputs.medianMoisturePercent) },
      { label: 'Field median temperature', value: formatTemperatureC(inputs.medianTemperatureC) },
      { label: 'Season', value: inputs.season },
    ],
    // States only what the stored record says; the app itself fetches no weather.
    weatherNote:
      inputs.weatherSource === 'forecast'
        ? 'Weather: forecast values recorded with this recommendation.'
        : 'Weather: local seasonal defaults from the rule set (no forecast was used).',
    showOpenMeteoCredit: inputs.weatherSource === 'forecast',
    shortlist: recommendation.shortlist.slice(0, 5).map((s, i) => ({
      rank: i + 1,
      cropName: s.cropName,
      category: s.category,
      score: Number(s.score.toFixed(2)).toString(),
      scoreValue: s.score,
      reasons: s.reasons,
    })),
  };
}
