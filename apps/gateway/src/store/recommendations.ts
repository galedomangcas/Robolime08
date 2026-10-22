import type { CropRecommendation, CropScore, RecommendationInputs } from '@robolime/shared';

import { bool, num, numOrNull, str, withTransaction, type Database } from '../db/connection';
import { stableIds } from '../db/ids';
import { toCanonicalUtc } from '../db/time';
import { enqueue } from './outbox';

/**
 * Versioned rule tables. Contents are supplied by the research team (real
 * rule sets) or are explicitly synthetic development fixtures. The scoring
 * engine itself is a later phase; this module only stores and reads.
 */
export interface RuleSetDefinition {
  version: string;
  scoringMethod: string;
  isSynthetic: boolean;
  sourceNotes: string;
  crops: {
    cropKey: string;
    displayName: string;
    category: string;
    cultivationReference: string;
    ranges: {
      parameter: string;
      minValue: number;
      maxValue: number;
      unit: string;
      weight: number;
      sourceReference: string;
    }[];
  }[];
  seasons: {
    seasonKey: string;
    label: string;
    startMonth: number;
    startDay: number;
    endMonth: number;
    endDay: number;
    weatherDefaults: { parameter: string; value: number; unit: string; sourceReference: string }[];
  }[];
}

/** Inserts a new draft rule set with all its content. Idempotent by version. */
export function createDraftRuleSet(db: Database, def: RuleSetDefinition, now: Date): string {
  const id = stableIds.ruleSet(def.version);
  return withTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM rule_sets WHERE id = ?').get(id)) {
      return id;
    }
    db.prepare(
      `INSERT INTO rule_sets (id, version, status, scoring_method, is_synthetic, source_notes, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
    ).run(id, def.version, def.scoringMethod, def.isSynthetic ? 1 : 0, def.sourceNotes, toCanonicalUtc(now));
    const insertCrop = db.prepare(
      `INSERT INTO rule_crops (rule_set_id, crop_key, display_name, category, cultivation_reference)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertRange = db.prepare(
      `INSERT INTO rule_suitability_ranges (rule_set_id, crop_key, parameter, min_value, max_value, unit, weight, source_reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const crop of def.crops) {
      insertCrop.run(id, crop.cropKey, crop.displayName, crop.category, crop.cultivationReference);
      for (const r of crop.ranges) {
        insertRange.run(id, crop.cropKey, r.parameter, r.minValue, r.maxValue, r.unit, r.weight, r.sourceReference);
      }
    }
    const insertSeason = db.prepare(
      `INSERT INTO rule_seasons (rule_set_id, season_key, label, start_month, start_day, end_month, end_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertDefault = db.prepare(
      `INSERT INTO rule_seasonal_weather_defaults (rule_set_id, season_key, parameter, value, unit, source_reference)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of def.seasons) {
      insertSeason.run(id, s.seasonKey, s.label, s.startMonth, s.startDay, s.endMonth, s.endDay);
      for (const d of s.weatherDefaults) {
        insertDefault.run(id, s.seasonKey, d.parameter, d.value, d.unit, d.sourceReference);
      }
    }
    enqueue(db, 'rule_set', id, now);
    return id;
  });
}

export interface StoreRecommendationInput {
  runId: string;
  ruleSetId: string;
  inputs: RecommendationInputs;
  /** Every eligible candidate's score; shortlistRank 1..5 marks category leaders. */
  scores: (Omit<CropScore, 'cropName' | 'category'> & { shortlistRank: number | null })[];
  computedAt: Date;
}

/**
 * Persists a computed recommendation snapshot. Database triggers reject
 * verification runs, unapproved rule sets for real runs, and any later edit.
 */
export function storeRecommendation(db: Database, input: StoreRecommendationInput): string {
  const id = stableIds.recommendation(input.runId);
  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO recommendations (id, run_id, rule_set_id, inputs_json, weather_source, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.runId,
      input.ruleSetId,
      JSON.stringify(input.inputs),
      input.inputs.weatherSource,
      toCanonicalUtc(input.computedAt),
    );
    const insertScore = db.prepare(
      `INSERT INTO recommendation_scores (recommendation_id, rule_set_id, crop_key, score, shortlist_rank, reasons_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of input.scores) {
      insertScore.run(id, input.ruleSetId, s.cropId, s.score, s.shortlistRank, JSON.stringify(s.reasons));
    }
    enqueue(db, 'recommendation', id, input.computedAt);
    return id;
  });
}

export interface StoredRecommendation {
  recommendation: CropRecommendation;
  ruleSetStatus: 'draft' | 'approved' | 'retired';
  isSynthetic: boolean;
}

function parseReasons(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
}

export function getRecommendationForRun(db: Database, runId: string): StoredRecommendation | null {
  const rec = db
    .prepare(
      `SELECT r.*, rs.version, rs.status AS rule_set_status, rs.is_synthetic AS rule_set_synthetic
       FROM recommendations AS r JOIN rule_sets AS rs ON rs.id = r.rule_set_id
       WHERE r.run_id = ?`,
    )
    .get(runId);
  if (rec === undefined) {
    return null;
  }
  const scores = db
    .prepare(
      `SELECT s.*, c.display_name, c.category
       FROM recommendation_scores AS s
       JOIN rule_crops AS c ON c.rule_set_id = s.rule_set_id AND c.crop_key = s.crop_key
       WHERE s.recommendation_id = ?
       ORDER BY s.score DESC, s.crop_key`,
    )
    .all(str(rec, 'id'))
    .map((row) => ({
      rank: numOrNull(row, 'shortlist_rank'),
      score: {
        cropId: str(row, 'crop_key'),
        cropName: str(row, 'display_name'),
        category: str(row, 'category'),
        score: num(row, 'score'),
        reasons: parseReasons(str(row, 'reasons_json')),
      },
    }));
  const inputs = JSON.parse(str(rec, 'inputs_json')) as RecommendationInputs;
  return {
    recommendation: {
      id: str(rec, 'id'),
      runId,
      ruleSetVersion: str(rec, 'version'),
      inputs,
      allScores: scores.map((s) => s.score),
      shortlist: scores
        .filter((s) => s.rank !== null)
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        .map((s) => s.score),
      computedAt: str(rec, 'computed_at'),
    },
    ruleSetStatus: str(rec, 'rule_set_status') as StoredRecommendation['ruleSetStatus'],
    isSynthetic: bool(rec, 'rule_set_synthetic'),
  };
}
