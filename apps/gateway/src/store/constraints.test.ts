import { describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import { stableIds } from '../db/ids';
import { DEMO_RULE_SET } from '../seed/demo';
import { addTestRobot, memoryDb, minutesAfter, T0, testReading } from '../test/helpers';
import { recordReading } from './readings';
import { createDraftRuleSet, storeRecommendation } from './recommendations';
import { provisionRobot } from './robots';
import { getLatestStatus, recordStatusReport, type DecodedStatus } from './status';

function status(overrides: Partial<DecodedStatus> = {}): DecodedStatus {
  return {
    sourceRobotId: 'TEST-ROBOT-1',
    state: 'WORKING',
    errorFlags: 0,
    componentFlags: null,
    batteryVoltage: 12.3,
    totalLimeCommandedMl: 100,
    cellsCompleted: 2,
    totalCells: 20,
    robotReportedAt: '2026-03-01T00:10:00.000Z',
    ...overrides,
  };
}

const recommendationInput = (db: Database, runId: string, ruleSetId: string) =>
  storeRecommendation(db, {
    runId,
    ruleSetId,
    inputs: {
      medianPh: 5.9, medianEc: 0.3, medianMoisturePercent: 25, medianTemperatureC: 27,
      season: 'synthetic-season-1', weatherSource: 'seasonal-defaults', weather: {},
    },
    scores: [{ cropId: 'synthetic-crop-a', score: 1, reasons: ['fixture'], shortlistRank: 1 }],
    computedAt: T0,
  });

describe('schema constraints', () => {
  it('rejects non-canonical timestamps', () => {
    const db = memoryDb();
    expect(() =>
      db.prepare(`INSERT INTO robots (id, source_robot_id, display_name, created_at) VALUES ('x', 'y', 'z', '2026-03-01 00:00:00')`).run(),
    ).toThrow(/CHECK/);
  });

  it('rejects a tank capacity above the confirmed 5,000 mL ceiling but allows it to stay unset', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    expect(() => db.prepare('UPDATE robots SET tank_capacity_ml = 5001 WHERE id = ?').run(robot.id)).toThrow(/CHECK/);
    expect(db.prepare('SELECT tank_capacity_ml FROM robots').get()).toEqual({ tank_capacity_ml: null });
  });

  it('requires both or neither GPS coordinates', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    expect(() =>
      db.prepare('UPDATE readings SET gps_latitude = 13.9').run(),
    ).toThrow(); // readings are immutable anyway
    expect(() =>
      recordReading(db, { ...testReading({ seq: 1 }), gps: { latitude: 13.9, longitude: Number.NaN } }, T0),
    ).toThrow();
  });

  it('makes stored readings immutable', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    expect(() => db.prepare('UPDATE readings SET ph = 7').run()).toThrow(/immutable/);
  });

  it('allows only one active field per robot', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const insert = db.prepare(
      `INSERT INTO fields (id, robot_id, field_key, name, location_label, created_at) VALUES (?, ?, ?, 'f', 'l', ?)`,
    );
    insert.run('f1', robot.id, 'k1', T0.toISOString());
    expect(() => insert.run('f2', robot.id, 'k2', T0.toISOString())).toThrow(/UNIQUE/);
  });

  it('allows only one active pairing credential per robot', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const insert = db.prepare(
      `INSERT INTO pairing_credentials (id, robot_id, verifier, created_at) VALUES (?, ?, 'scrypt$x', ?)`,
    );
    insert.run('c1', robot.id, T0.toISOString());
    expect(() => insert.run('c2', robot.id, T0.toISOString())).toThrow(/UNIQUE/);
  });

  it('never allows a synthetic rule set to be approved', () => {
    const db = memoryDb();
    const id = createDraftRuleSet(db, DEMO_RULE_SET, T0);
    expect(() =>
      db.prepare(`UPDATE rule_sets SET status = 'approved', approved_at = ? WHERE id = ?`).run(T0.toISOString(), id),
    ).toThrow(/CHECK/);
  });

  it('locks rule content once the rule set is approved', () => {
    const db = memoryDb();
    const id = createDraftRuleSet(db, { ...DEMO_RULE_SET, version: 'real-test-1', isSynthetic: false }, T0);
    db.prepare(`UPDATE rule_sets SET status = 'approved', approved_at = ? WHERE id = ?`).run(T0.toISOString(), id);
    expect(() => db.prepare('UPDATE rule_suitability_ranges SET max_value = 9 WHERE rule_set_id = ?').run(id)).toThrow(
      /locked/,
    );
    expect(() => db.prepare('DELETE FROM rule_crops WHERE rule_set_id = ?').run(id)).toThrow(/locked/);
    expect(() => db.prepare(`UPDATE rule_sets SET version = 'x' WHERE id = ?`).run(id)).toThrow(/fixed/);
    expect(() => db.prepare(`UPDATE rule_sets SET status = 'draft', approved_at = NULL WHERE id = ?`).run(id)).toThrow();
  });

  it('locks a draft rule set once a stored recommendation references it', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { runId } = recordReading(db, testReading(), T0);
    const ruleSetId = createDraftRuleSet(db, DEMO_RULE_SET, T0);
    recommendationInput(db, runId, ruleSetId);
    expect(() => db.prepare('UPDATE rule_crops SET category = ? WHERE rule_set_id = ?').run('x', ruleSetId)).toThrow(
      /locked/,
    );
  });

  it('rejects recommendations for verification runs', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { runId } = recordReading(db, testReading({ runType: 'verification' }), T0);
    const ruleSetId = createDraftRuleSet(db, DEMO_RULE_SET, T0);
    expect(() => recommendationInput(db, runId, ruleSetId)).toThrow(/dosing runs/);
  });

  it('rejects synthetic rule sets for real (non-synthetic) runs', () => {
    const db = memoryDb();
    provisionRobot(db, { sourceRobotId: 'REAL-1', displayName: 'Real robot', isSynthetic: false }, T0);
    const { runId } = recordReading(db, testReading({ sourceRobotId: 'REAL-1' }), T0);
    const ruleSetId = createDraftRuleSet(db, DEMO_RULE_SET, T0);
    expect(() => recommendationInput(db, runId, ruleSetId)).toThrow(/approved rule set/);
  });

  it('makes stored recommendations immutable and one per run', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { runId } = recordReading(db, testReading(), T0);
    const ruleSetId = createDraftRuleSet(db, DEMO_RULE_SET, T0);
    recommendationInput(db, runId, ruleSetId);
    expect(() => db.prepare(`UPDATE recommendations SET weather_source = 'forecast'`).run()).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE recommendation_scores SET score = 99').run()).toThrow(/immutable/);
    expect(() => recommendationInput(db, runId, ruleSetId)).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe('robot status history', () => {
  it('stores each status once and returns the latest by robot-side time', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordStatusReport(db, status({ cellsCompleted: 5, robotReportedAt: '2026-03-01T00:30:00.000Z' }), T0);
    // An older report that arrives later must not become "latest".
    recordStatusReport(db, status({ cellsCompleted: 2, robotReportedAt: '2026-03-01T00:10:00.000Z' }), minutesAfter(1));
    expect(recordStatusReport(db, status({ cellsCompleted: 2 }), minutesAfter(2)).outcome).toBe('duplicate');

    const latest = getLatestStatus(db, stableIds.robot('TEST-ROBOT-1'));
    expect(latest?.cellsCompleted).toBe(5);
    expect(latest?.timestamps.robotAt).toBe('2026-03-01T00:30:00.000Z');
    expect(latest?.timestamps.gatewayReceivedAt).toBe(T0.toISOString());
    expect(latest?.timestamps.cloudSyncedAt).toBeNull();
  });

  it('decodes error flags and reports unconfirmed component checks as unknown', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordStatusReport(db, status({ state: 'ERROR', errorFlags: 0b0001_0001, componentFlags: 0xff }), T0);
    const latest = getLatestStatus(db, stableIds.robot('TEST-ROBOT-1'));
    expect(latest?.errorFlags).toEqual(['LIME_EMPTY', 'PUMP_FAULT']);
    expect(new Set(Object.values(latest?.componentChecks ?? {}))).toEqual(new Set(['unknown']));
  });

  it('returns null when the robot has never reported', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    expect(getLatestStatus(db, robot.id)).toBeNull();
  });
});
