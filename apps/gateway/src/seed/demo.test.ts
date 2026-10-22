import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import { DatabasePurposeError, initDatabase } from '../db/init';
import { stableIds } from '../db/ids';
import { count, memoryDb, T0 } from '../test/helpers';
import { CLOUD_SEED_PATH, renderCloudSeedSql } from './cloudSeedSql';
import { DEMO_DOSING_RUN, DEMO_SOURCE_ROBOT_ID, DEMO_VERIFICATION_RUN, seedDemo } from './demo';

const TABLES = [
  'robots', 'fields', 'field_cells', 'runs', 'readings', 'reading_receipts', 'robot_status_reports',
  'rule_sets', 'rule_crops', 'rule_suitability_ranges', 'rule_seasons', 'rule_seasonal_weather_defaults',
  'recommendations', 'recommendation_scores', 'sync_outbox', 'pairing_credentials', 'local_sessions',
];

function snapshot(db: Database): string {
  return JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
}

describe('synthetic demo seed', () => {
  it('is deterministic across fresh databases', () => {
    const a = memoryDb('demo');
    const b = memoryDb('demo');
    seedDemo(a);
    seedDemo(b);
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('re-running changes nothing', () => {
    const db = memoryDb('demo');
    expect(seedDemo(db)).toBe(true);
    const before = snapshot(db);
    expect(seedDemo(db)).toBe(false);
    expect(snapshot(db)).toBe(before);
  });

  it('refuses to seed a field database', () => {
    const db = memoryDb('field');
    expect(() => seedDemo(db)).toThrow(DatabasePurposeError);
    expect(count(db, 'robots')).toBe(0);
  });

  it('never runs during normal initialisation', () => {
    const db = initDatabase(':memory:', 'demo', T0);
    expect(count(db, 'readings')).toBe(0);
  });

  it('marks everything synthetic and implies no real location or credential', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    expect(db.prepare('SELECT is_synthetic FROM robots').all()).toEqual([{ is_synthetic: 1 }]);
    expect(db.prepare('SELECT is_synthetic, location_label FROM fields').get()).toEqual({
      is_synthetic: 1,
      location_label: 'Synthetic data — not a real location',
    });
    expect(db.prepare('SELECT DISTINCT is_synthetic FROM runs').all()).toEqual([{ is_synthetic: 1 }]);
    expect(db.prepare('SELECT is_synthetic, status FROM rule_sets').get()).toEqual({ is_synthetic: 1, status: 'draft' });
    expect(count(db, 'readings WHERE gps_latitude IS NOT NULL')).toBe(0);
    expect(count(db, 'pairing_credentials')).toBe(0);
  });

  it('contains dosing and verification runs with a deliberate missing verification cell', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const robotId = stableIds.robot(DEMO_SOURCE_ROBOT_ID);
    const readingsIn = (sourceRunId: string) =>
      count(db, `readings WHERE run_id = '${stableIds.run(robotId, sourceRunId)}'`);
    expect(readingsIn(DEMO_DOSING_RUN)).toBe(20);
    expect(readingsIn(DEMO_VERIFICATION_RUN)).toBe(19);
    expect(count(db, `reading_receipts WHERE outcome = 'duplicate'`)).toBe(1);
    expect(count(db, 'recommendations')).toBe(1);
  });
});

describe('cloud demo seed (supabase/seeds/demo_synthetic.sql)', () => {
  it('is up to date with the SQLite fixture (run cloud-seed:generate if this fails)', () => {
    const db = initDatabase(':memory:', 'demo', new Date('2026-01-01T00:00:00.000Z'));
    seedDemo(db);
    const committed = readFileSync(CLOUD_SEED_PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderCloudSeedSql(db));
  });

  it('uses exactly the same primary keys as SQLite', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const sql = readFileSync(CLOUD_SEED_PATH, 'utf8');
    const localIds = [
      ...db.prepare('SELECT id FROM robots').all(),
      ...db.prepare('SELECT id FROM runs').all(),
      ...db.prepare('SELECT id FROM readings').all(),
      ...db.prepare('SELECT id FROM recommendations').all(),
    ].map((r) => String(r.id));
    expect(localIds.length).toBe(1 + 2 + 39 + 1);
    for (const id of localIds) {
      expect(sql).toContain(`'${id}'`);
    }
    expect(sql).not.toMatch(/pairing|local_sessions|reading_receipts|sync_outbox|field_selections/);
  });
});
