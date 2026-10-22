import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from '../db/connection';
import { initDatabase, type DatabasePurpose } from '../db/init';
import type { DecodedReading } from '../store/readings';
import { provisionRobot, type RobotRecord } from '../store/robots';

/**
 * TEST-ONLY pairing fixture. It exists solely inside automated tests, is never
 * provisioned by any CLI or seed, and must never be used on a real gateway.
 */
export const TEST_ONLY_PAIRING_CODE = 'TEST-ONLY-NOT-A-REAL-CODE';
export const TEST_ONLY_OTHER_PAIRING_CODE = 'TEST-ONLY-OTHER-ROBOT-CODE';

export const T0 = new Date('2026-03-01T00:00:00.000Z');
export const minutesAfter = (minutes: number, base: Date = T0) => new Date(base.getTime() + minutes * 60_000);

export function memoryDb(purpose: DatabasePurpose = 'field'): Database {
  return initDatabase(':memory:', purpose, T0);
}

/** A temporary on-disk database directory, for restart/persistence tests. */
export function tempDir(): { path: (name: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'robolime-gateway-test-'));
  return {
    path: (name) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function addTestRobot(db: Database, sourceRobotId = 'TEST-ROBOT-1'): RobotRecord {
  return provisionRobot(db, { sourceRobotId, displayName: `Test robot ${sourceRobotId}`, isSynthetic: true }, T0);
}

export function testReading(overrides: Partial<DecodedReading> = {}): DecodedReading {
  return {
    sourceRobotId: 'TEST-ROBOT-1',
    sourceRunId: 'RUN-1',
    runType: 'dosing',
    cellIndex: 0,
    seq: 0,
    attemptCount: 1,
    ph: 5.5,
    ec: 0.3,
    moisturePercent: 25,
    temperatureC: 27,
    doseVolumeMl: 50,
    expectedPostCorrectionPh: 5.9,
    gps: null,
    rawFlags: 0,
    robotRecordedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

export function count(db: Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? 0);
}
