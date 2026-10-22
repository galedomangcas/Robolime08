import type { CloudDatabase } from '@robolime/shared';
import type { SQLOutputValue } from 'node:sqlite';

import { str, type Database, type Row } from '../db/connection';
import { OUTBOX_SYNC_ORDER, type OutboxEntityType } from '../store/outbox';

/**
 * Local SQLite row → hosted Supabase (PostgreSQL) row mapping for the one-way
 * mirror. Primary keys are copied unchanged (shared UUIDv5 identity), so cloud
 * upserts are idempotent on the same keys as SQLite.
 *
 * Column lists are checked at compile time against the Supabase-GENERATED
 * types (CloudDatabase, from `npm run db:cloud:types`): a column missing from or
 * unknown to the cloud schema fails type-checking. No cloud row interface is
 * hand-written here.
 *
 * Local-only data never leaves the gateway: pairing credentials, local
 * sessions, field selections, reading receipts, the outbox, and settings.
 */
type CloudTables = CloudDatabase['public']['Tables'];

/** Mirrored tables. robot_claims is cloud-only and written by a trusted process, never by sync. */
export type CloudTable = Exclude<keyof CloudTables, 'robot_claims'>;

export interface JsonbValue {
  jsonb: string;
}

export type CloudValue = string | number | boolean | null | JsonbValue;
export type CloudRow = Readonly<Record<string, CloudValue>>;

export interface CloudTableRows {
  table: CloudTable;
  rows: CloudRow[];
}

export class CloudMappingError extends Error {
  override name = 'CloudMappingError';
}

type ColumnKind = 'text' | 'number' | 'bool' | 'jsonb';
type ColumnMap = Readonly<Record<string, ColumnKind>>;

/** Every insertable cloud column except the cloud-assigned receipt time. */
type Columns<T extends CloudTable> = Readonly<
  Record<Exclude<keyof CloudTables[T]['Insert'], 'cloud_received_at'>, ColumnKind>
>;

function convert(value: SQLOutputValue | undefined, kind: ColumnKind, column: string): CloudValue {
  if (value === null) {
    return null;
  }
  switch (kind) {
    case 'text':
      if (typeof value !== 'string') throw new CloudMappingError(`${column} is not text`);
      return value;
    case 'number':
      if (typeof value === 'bigint') return Number(value);
      if (typeof value !== 'number') throw new CloudMappingError(`${column} is not numeric`);
      return value;
    case 'bool':
      if (value !== 0 && value !== 1) throw new CloudMappingError(`${column} is not a 0/1 flag`);
      return value === 1;
    case 'jsonb':
      if (typeof value !== 'string') throw new CloudMappingError(`${column} is not JSON text`);
      return { jsonb: value };
  }
}

function mapRow(row: Row, columns: ColumnMap): CloudRow {
  const out: Record<string, CloudValue> = {};
  for (const [column, kind] of Object.entries(columns)) {
    if (!(column in row)) throw new CloudMappingError(`Missing column ${column}`);
    out[column] = convert(row[column], kind, column);
  }
  return out;
}

const ROBOT_COLUMNS: Columns<'robots'> = {
  id: 'text', source_robot_id: 'text', display_name: 'text', is_synthetic: 'bool',
  tank_capacity_ml: 'number', created_at: 'text',
};
const FIELD_COLUMNS: Columns<'fields'> = {
  id: 'text', robot_id: 'text', field_key: 'text', name: 'text', location_label: 'text', area_m2: 'number',
  cell_size_m: 'number', total_cells: 'number', is_active: 'bool', is_synthetic: 'bool', created_at: 'text',
};
const FIELD_CELL_COLUMNS: Columns<'field_cells'> = {
  field_id: 'text', robot_id: 'text', cell_index: 'number', grid_row: 'number', grid_column: 'number',
  center_latitude: 'number', center_longitude: 'number',
};
const RUN_COLUMNS: Columns<'runs'> = {
  id: 'text', robot_id: 'text', source_run_id: 'text', run_type: 'text', field_id: 'text',
  gateway_first_received_at: 'text', is_synthetic: 'bool',
};
const READING_COLUMNS: Columns<'readings'> = {
  id: 'text', run_id: 'text', robot_id: 'text', cell_index: 'number', seq: 'number', attempt_count: 'number',
  ph: 'number', ec: 'number', moisture_percent: 'number', temperature_c: 'number', dose_volume_ml: 'number',
  expected_post_correction_ph: 'number', gps_latitude: 'number', gps_longitude: 'number', raw_flags: 'number',
  robot_recorded_at: 'text', gateway_received_at: 'text',
};
const STATUS_COLUMNS: Columns<'robot_status_reports'> = {
  id: 'text', robot_id: 'text', state: 'text', error_flags: 'number', component_flags: 'number',
  battery_voltage: 'number', total_lime_commanded_ml: 'number', cells_completed: 'number', total_cells: 'number',
  robot_reported_at: 'text', gateway_received_at: 'text',
};
const RULE_SET_COLUMNS: Columns<'rule_sets'> = {
  id: 'text', version: 'text', status: 'text', scoring_method: 'text', is_synthetic: 'bool',
  source_notes: 'text', created_at: 'text', approved_at: 'text',
};
const RULE_CROP_COLUMNS: Columns<'rule_crops'> = {
  rule_set_id: 'text', crop_key: 'text', display_name: 'text', category: 'text',
  is_perennial_or_tree: 'bool', cultivation_reference: 'text',
};
const RULE_RANGE_COLUMNS: Columns<'rule_suitability_ranges'> = {
  rule_set_id: 'text', crop_key: 'text', parameter: 'text', min_value: 'number', max_value: 'number',
  unit: 'text', weight: 'number', source_reference: 'text',
};
const RULE_SEASON_COLUMNS: Columns<'rule_seasons'> = {
  rule_set_id: 'text', season_key: 'text', label: 'text', start_month: 'number', start_day: 'number',
  end_month: 'number', end_day: 'number',
};
const RULE_WEATHER_COLUMNS: Columns<'rule_seasonal_weather_defaults'> = {
  rule_set_id: 'text', season_key: 'text', parameter: 'text', value: 'number', unit: 'text',
  source_reference: 'text',
};
const RECOMMENDATION_COLUMNS: Columns<'recommendations'> = {
  id: 'text', run_id: 'text', robot_id: 'text', rule_set_id: 'text', inputs: 'jsonb',
  weather_source: 'text', computed_at: 'text',
};
const SCORE_COLUMNS: Columns<'recommendation_scores'> = {
  recommendation_id: 'text', robot_id: 'text', rule_set_id: 'text', crop_key: 'text', score: 'number',
  shortlist_rank: 'number', reasons: 'jsonb',
};

function rows(db: Database, sql: string, id: string, columns: ColumnMap): CloudRow[] {
  return db.prepare(sql).all(id).map((row) => mapRow(row, columns));
}

/** Cloud rows for one outbox entity (an aggregate may span several tables). */
export function cloudRowsFor(db: Database, entityType: OutboxEntityType, entityId: string): CloudTableRows[] {
  let result: CloudTableRows[];
  switch (entityType) {
    case 'robot':
      result = [{ table: 'robots', rows: rows(db, 'SELECT * FROM robots WHERE id = ?', entityId, ROBOT_COLUMNS) }];
      break;
    case 'field':
      result = [
        { table: 'fields', rows: rows(db, 'SELECT * FROM fields WHERE id = ?', entityId, FIELD_COLUMNS) },
        {
          table: 'field_cells',
          rows: rows(
            db,
            `SELECT c.*, f.robot_id FROM field_cells AS c JOIN fields AS f ON f.id = c.field_id
             WHERE c.field_id = ? ORDER BY c.cell_index`,
            entityId,
            FIELD_CELL_COLUMNS,
          ),
        },
      ];
      break;
    case 'run':
      result = [{ table: 'runs', rows: rows(db, 'SELECT * FROM runs WHERE id = ?', entityId, RUN_COLUMNS) }];
      break;
    case 'reading':
      result = [
        {
          table: 'readings',
          rows: rows(
            db,
            'SELECT x.*, r.robot_id FROM readings AS x JOIN runs AS r ON r.id = x.run_id WHERE x.id = ?',
            entityId,
            READING_COLUMNS,
          ),
        },
      ];
      break;
    case 'status_report':
      result = [
        {
          table: 'robot_status_reports',
          rows: rows(db, 'SELECT * FROM robot_status_reports WHERE id = ?', entityId, STATUS_COLUMNS),
        },
      ];
      break;
    case 'rule_set':
      result = [
        { table: 'rule_sets', rows: rows(db, 'SELECT * FROM rule_sets WHERE id = ?', entityId, RULE_SET_COLUMNS) },
        {
          table: 'rule_crops',
          rows: rows(db, 'SELECT * FROM rule_crops WHERE rule_set_id = ? ORDER BY crop_key', entityId, RULE_CROP_COLUMNS),
        },
        {
          table: 'rule_suitability_ranges',
          rows: rows(
            db,
            'SELECT * FROM rule_suitability_ranges WHERE rule_set_id = ? ORDER BY crop_key, parameter',
            entityId,
            RULE_RANGE_COLUMNS,
          ),
        },
        {
          table: 'rule_seasons',
          rows: rows(db, 'SELECT * FROM rule_seasons WHERE rule_set_id = ? ORDER BY season_key', entityId, RULE_SEASON_COLUMNS),
        },
        {
          table: 'rule_seasonal_weather_defaults',
          rows: rows(
            db,
            'SELECT * FROM rule_seasonal_weather_defaults WHERE rule_set_id = ? ORDER BY season_key, parameter',
            entityId,
            RULE_WEATHER_COLUMNS,
          ),
        },
      ];
      break;
    case 'recommendation':
      result = [
        {
          table: 'recommendations',
          rows: rows(
            db,
            `SELECT x.*, x.inputs_json AS inputs, r.robot_id FROM recommendations AS x
             JOIN runs AS r ON r.id = x.run_id WHERE x.id = ?`,
            entityId,
            RECOMMENDATION_COLUMNS,
          ),
        },
        {
          table: 'recommendation_scores',
          rows: rows(
            db,
            `SELECT s.*, s.reasons_json AS reasons, r.robot_id FROM recommendation_scores AS s
             JOIN recommendations AS x ON x.id = s.recommendation_id JOIN runs AS r ON r.id = x.run_id
             WHERE s.recommendation_id = ? ORDER BY s.crop_key`,
            entityId,
            SCORE_COLUMNS,
          ),
        },
      ];
      break;
  }
  if (result[0]?.rows.length !== 1) {
    throw new CloudMappingError(`${entityType} ${entityId} does not exist locally`);
  }
  return result;
}

/** Every outbox entity in dependency order (parents first), e.g. for a full export. */
export function allOutboxEntities(db: Database): { entityType: OutboxEntityType; entityId: string }[] {
  const order = OUTBOX_SYNC_ORDER.map((type, index) => `WHEN '${type}' THEN ${index}`).join(' ');
  return db
    .prepare(`SELECT entity_type, entity_id FROM sync_outbox ORDER BY CASE entity_type ${order} END, entity_id`)
    .all()
    .map((row) => ({ entityType: str(row, 'entity_type') as OutboxEntityType, entityId: str(row, 'entity_id') }));
}
