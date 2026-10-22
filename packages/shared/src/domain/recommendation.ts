import type { IsoDateTime } from './time';

/**
 * Contract for a persisted, deterministic crop recommendation. Phase 1 defines
 * the shape only — scoring rules, candidate crops, suitability ranges, and
 * season boundaries come from versioned rule tables in a later phase and must
 * be sourced by the research team (OPEN_ITEMS: crop data).
 */

/** Whether weather inputs came from a live forecast or approved local defaults. */
export type WeatherSource = 'forecast' | 'seasonal-defaults';

/** Field-level inputs, captured exactly as used so the result is reproducible. */
export interface RecommendationInputs {
  /** Median of expected post-correction pH (limed cells) / measured pH (unlimed cells). */
  medianPh: number;
  medianEc: number;
  medianMoisturePercent: number;
  medianTemperatureC: number;
  /** Season label as defined by the rule set's versioned season table. */
  season: string;
  weatherSource: WeatherSource;
  /** Weather values keyed by rule-set-defined names; shape is fixed by the rule set version. */
  weather: Readonly<Record<string, number>>;
}

export interface CropScore {
  cropId: string;
  cropName: string;
  category: string;
  score: number;
  /** Plain-language reasons traceable to the scoring rules and input values. */
  reasons: readonly string[];
}

export interface CropRecommendation {
  /** Always a dosing run: verification runs never produce recommendations. */
  runId: string;
  ruleSetVersion: string;
  inputs: RecommendationInputs;
  /** Every eligible candidate's score, including those not shortlisted. */
  allScores: readonly CropScore[];
  /** Top five category leaders, highest score first. */
  shortlist: readonly CropScore[];
  computedAt: IsoDateTime;
}
