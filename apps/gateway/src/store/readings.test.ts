import { describe, expect, it } from 'vitest';

import { stableIds } from '../db/ids';
import { addTestRobot, count, memoryDb, minutesAfter, T0, testReading } from '../test/helpers';
import { getEntry } from './outbox';
import { IngestError, recordReading } from './readings';

describe('recordReading idempotency on (run_id, cell_index, seq)', () => {
  it('stores a first copy and queues it for cloud sync exactly once', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const result = recordReading(db, testReading(), T0);

    expect(result.outcome).toBe('inserted');
    const runId = stableIds.run(robot.id, 'RUN-1');
    expect(result.runId).toBe(runId);
    expect(result.readingId).toBe(stableIds.reading(runId, 0, 0));
    expect(count(db, 'readings')).toBe(1);
    expect(getEntry(db, 'reading', result.readingId)?.state).toBe('pending');
    expect(getEntry(db, 'run', runId)?.state).toBe('pending');
  });

  it('replaying the same batch twice creates no duplicates', () => {
    const db = memoryDb();
    addTestRobot(db);
    const batch = [0, 1, 2, 3].map((i) => testReading({ cellIndex: i, seq: i }));
    batch.forEach((r) => recordReading(db, r, T0));
    const replay = batch.map((r) => recordReading(db, r, minutesAfter(5)));

    expect(replay.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(count(db, 'readings')).toBe(4);
    expect(count(db, 'runs')).toBe(1);
    expect(count(db, 'sync_outbox')).toBe(1 + 1 + 4); // robot, run, 4 readings
    expect(count(db, 'reading_receipts')).toBe(8);
  });

  it('keeps the first copy when a retry (higher attempt count) arrives', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading({ attemptCount: 1 }), T0);
    const retry = recordReading(db, testReading({ attemptCount: 2 }), minutesAfter(1));

    expect(retry.outcome).toBe('duplicate');
    const stored = db.prepare('SELECT attempt_count, gateway_received_at FROM readings').get();
    expect(stored).toEqual({ attempt_count: 1, gateway_received_at: T0.toISOString() });
    const receipts = db.prepare('SELECT attempt_count, outcome FROM reading_receipts ORDER BY id').all();
    expect(receipts).toEqual([
      { attempt_count: 1, outcome: 'inserted' },
      { attempt_count: 2, outcome: 'duplicate' },
    ]);
  });

  it('accepts gaps, late and out-of-order arrivals', () => {
    const db = memoryDb();
    addTestRobot(db);
    for (const cell of [4, 0, 9, 2]) {
      expect(recordReading(db, testReading({ cellIndex: cell, seq: cell }), T0).outcome).toBe('inserted');
    }
    const cells = db.prepare('SELECT cell_index FROM readings ORDER BY cell_index').all().map((r) => r.cell_index);
    expect(cells).toEqual([0, 2, 4, 9]);
  });

  it('never overwrites a stored reading with a conflicting payload; the conflict is logged', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading({ ph: 5.5 }), T0);
    const conflict = recordReading(db, testReading({ ph: 6.1 }), minutesAfter(1));

    expect(conflict.outcome).toBe('conflict');
    expect(db.prepare('SELECT ph FROM readings').get()).toEqual({ ph: 5.5 });
    const logged = db.prepare(`SELECT conflicting_payload FROM reading_receipts WHERE outcome = 'conflict'`).get();
    expect(JSON.parse(String(logged?.conflicting_payload)).ph).toBe(6.1);
    expect(count(db, 'sync_outbox')).toBe(3);
  });

  it('stores separate rows for different sequence numbers of the same cell', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading({ seq: 0 }), T0);
    expect(recordReading(db, testReading({ seq: 1 }), T0).outcome).toBe('inserted');
    expect(count(db, 'readings')).toBe(2);
  });

  it('preserves the verification marker per run and rejects a type change', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading({ sourceRunId: 'V-1', runType: 'verification' }), T0);
    expect(db.prepare('SELECT run_type FROM runs').get()).toEqual({ run_type: 'verification' });
    expect(() => recordReading(db, testReading({ sourceRunId: 'V-1', runType: 'dosing', seq: 1 }), T0)).toThrow(
      IngestError,
    );
  });

  it('rejects records from a robot that is not provisioned, storing nothing', () => {
    const db = memoryDb();
    expect(() => recordReading(db, testReading(), T0)).toThrow(/not provisioned/);
    expect(count(db, 'readings')).toBe(0);
    expect(count(db, 'runs')).toBe(0);
  });

  it('keeps robot, gateway and cloud times separate', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading({ robotRecordedAt: '2026-02-28T23:59:00Z' }), T0);
    expect(db.prepare('SELECT robot_recorded_at, gateway_received_at FROM readings').get()).toEqual({
      robot_recorded_at: '2026-02-28T23:59:00.000Z',
      gateway_received_at: T0.toISOString(),
    });
    expect(db.prepare(`SELECT cloud_confirmed_at FROM sync_outbox WHERE entity_type = 'reading'`).get()).toEqual({
      cloud_confirmed_at: null,
    });
  });

  it('rolls back the whole record when a constraint fails', () => {
    const db = memoryDb();
    addTestRobot(db);
    expect(() => recordReading(db, testReading({ ph: 15 }), T0)).toThrow();
    expect(count(db, 'runs')).toBe(0);
    expect(count(db, 'reading_receipts')).toBe(0);
    expect(count(db, 'sync_outbox')).toBe(1); // only the robot
  });
});
