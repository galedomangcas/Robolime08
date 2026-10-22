import { describe, expect, it } from 'vitest';

import { stableIds } from '../db/ids';
import { seedDemo } from '../seed/demo';
import { addTestRobot, memoryDb, T0, testReading } from '../test/helpers';
import { recordReading } from '../store/readings';
import { allOutboxEntities, cloudRowsFor, CloudMappingError } from './cloudRows';

describe('local → cloud row mapping', () => {
  it('copies the stable primary key and natural key unchanged and adds robot_id for RLS', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const { readingId, runId } = recordReading(db, testReading({ cellIndex: 7, seq: 3 }), T0);
    const [readings] = cloudRowsFor(db, 'reading', readingId);

    expect(readings?.table).toBe('readings');
    expect(readings?.rows[0]).toMatchObject({
      id: stableIds.reading(runId, 7, 3),
      run_id: runId,
      robot_id: robot.id,
      cell_index: 7,
      seq: 3,
      robot_recorded_at: '2026-03-01T00:00:00.000Z',
      gateway_received_at: T0.toISOString(),
    });
    // Cloud receipt time is assigned by the cloud, never sent from the gateway.
    expect(readings?.rows[0]).not.toHaveProperty('cloud_received_at');
  });

  it('maps SQLite 0/1 flags to booleans and JSON text to jsonb', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const rec = allOutboxEntities(db).find((e) => e.entityType === 'recommendation');
    if (!rec) throw new Error('no recommendation');
    const [recommendations, scores] = cloudRowsFor(db, 'recommendation', rec.entityId);
    expect(recommendations?.rows[0]?.inputs).toEqual({ jsonb: expect.stringContaining('medianPh') });
    expect(scores?.rows).toHaveLength(6);
    const robot = allOutboxEntities(db).find((e) => e.entityType === 'robot');
    expect(cloudRowsFor(db, 'robot', robot?.entityId ?? '')[0]?.rows[0]?.is_synthetic).toBe(true);
  });

  it('orders entities parents-first for foreign keys', () => {
    const db = memoryDb('demo');
    seedDemo(db);
    const types = allOutboxEntities(db).map((e) => e.entityType);
    const firstIndex = (t: string) => types.indexOf(t as (typeof types)[number]);
    expect(firstIndex('robot')).toBeLessThan(firstIndex('field'));
    expect(firstIndex('field')).toBeLessThan(firstIndex('run'));
    expect(firstIndex('rule_set')).toBeLessThan(firstIndex('recommendation'));
    expect(firstIndex('run')).toBeLessThan(firstIndex('reading'));
  });

  it('fails loudly for an entity that does not exist locally', () => {
    const db = memoryDb();
    expect(() => cloudRowsFor(db, 'reading', 'missing')).toThrow(CloudMappingError);
  });
});
