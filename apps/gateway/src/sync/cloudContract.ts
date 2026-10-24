import type { CloudDatabase } from '@robolime/shared';

import type { OutboxEntityType } from '../store/outbox';
import type { CloudTable } from './cloudRows';

/**
 * Cloud-side identity facts the sync worker relies on (M6b). Taken from
 * `supabase/migrations/20261023000000_cloud_mirror_initial.sql`; column names
 * are type-checked against the generated `CloudDatabase` types.
 */
type CloudTables = CloudDatabase['public']['Tables'];
type ColumnOf<T extends CloudTable> = keyof CloudTables[T]['Row'] & string;

/**
 * Primary key of every mirrored table. Inserts conflict-target ONLY the
 * primary key, so a clash on any other unique (natural) key is an error the
 * worker sees (23505) instead of a silently ignored row.
 */
export const CLOUD_PRIMARY_KEYS: { readonly [T in CloudTable]: readonly ColumnOf<T>[] } = {
  robots: ['id'],
  fields: ['id'],
  field_cells: ['field_id', 'cell_index'],
  runs: ['id'],
  readings: ['id'],
  robot_status_reports: ['id'],
  rule_sets: ['id'],
  rule_crops: ['rule_set_id', 'crop_key'],
  rule_suitability_ranges: ['rule_set_id', 'crop_key', 'parameter'],
  rule_seasons: ['rule_set_id', 'season_key'],
  rule_seasonal_weather_defaults: ['rule_set_id', 'season_key', 'parameter'],
  recommendations: ['id'],
  recommendation_scores: ['recommendation_id', 'crop_key'],
};

/**
 * Column that selects ALL of an aggregate's rows in a table, given the outbox
 * entity id. Reading back by this column (not by the local keys) also reveals
 * cloud rows the gateway never sent, which verification treats as a conflict.
 */
export const READ_BACK_COLUMN: { readonly [T in CloudTable]: ColumnOf<T> } = {
  robots: 'id',
  fields: 'id',
  field_cells: 'field_id',
  runs: 'id',
  readings: 'id',
  robot_status_reports: 'id',
  rule_sets: 'id',
  rule_crops: 'rule_set_id',
  rule_suitability_ranges: 'rule_set_id',
  rule_seasons: 'rule_set_id',
  rule_seasonal_weather_defaults: 'rule_set_id',
  recommendations: 'id',
  recommendation_scores: 'recommendation_id',
};

/** The table holding an aggregate's root row; its `cloud_received_at` is the confirmation time. */
export const ROOT_TABLE: Readonly<Record<OutboxEntityType, CloudTable>> = {
  robot: 'robots',
  field: 'fields',
  run: 'runs',
  reading: 'readings',
  status_report: 'robot_status_reports',
  rule_set: 'rule_sets',
  recommendation: 'recommendations',
};
