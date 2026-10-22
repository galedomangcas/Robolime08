import { afterEach, describe, expect, it } from 'vitest';

import { initDatabase } from '../db/init';
import { addTestRobot, memoryDb, minutesAfter, T0, tempDir, testReading } from '../test/helpers';
import {
  claimBatch,
  countByState,
  getEntry,
  markChanged,
  markFailed,
  markSynced,
  OutboxStateError,
  recoverInterrupted,
} from './outbox';
import { recordReading } from './readings';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const confirmation = { cloudReceivedAt: '2026-03-01T01:00:00.000Z' };

describe('sync outbox state machine', () => {
  it('claims parents before children', () => {
    const db = memoryDb();
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    const claimed = claimBatch(db, 10, T0);
    expect(claimed.map((e) => e.entityType)).toEqual(['robot', 'run', 'reading']);
    expect(claimed.every((e) => e.state === 'syncing' && e.attemptCount === 1)).toBe(true);
  });

  it('marks synced only with a cloud confirmation, after an attempt', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const entry = getEntry(db, 'robot', robot.id);
    if (!entry) throw new Error('missing entry');

    // Attempting is not success: a pending entry cannot be marked synced.
    expect(() => markSynced(db, entry.id, confirmation)).toThrow(OutboxStateError);
    // The database itself refuses to skip the 'syncing' step or omit the confirmation time.
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'synced', cloud_confirmed_at = ? WHERE id = ?`).run(confirmation.cloudReceivedAt, entry.id)).toThrow(/transition/);
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'syncing' WHERE id = ?`).run(entry.id)).not.toThrow();
    expect(() => db.prepare(`UPDATE sync_outbox SET state = 'synced' WHERE id = ?`).run(entry.id)).toThrow(/CHECK/);

    markSynced(db, entry.id, confirmation);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({
      state: 'synced',
      cloudConfirmedAt: confirmation.cloudReceivedAt,
    });
  });

  it('records failures and retries only when due', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const [entry] = claimBatch(db, 10, T0);
    if (!entry) throw new Error('nothing claimed');
    markFailed(db, entry.id, 'network unreachable', minutesAfter(5));

    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ state: 'failed', lastError: 'network unreachable' });
    expect(claimBatch(db, 10, minutesAfter(1))).toEqual([]);
    const retried = claimBatch(db, 10, minutesAfter(5));
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attemptCount).toBe(2);
  });

  it('returns interrupted (syncing) entries to pending after a restart, on disk', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('gw.sqlite');
    const db = initDatabase(path, 'field', T0);
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    claimBatch(db, 2, T0);
    db.close(); // simulated crash/restart mid-sync

    const reopened = initDatabase(path, 'field', T0);
    expect(countByState(reopened)).toEqual({ pending: 1, syncing: 2, synced: 0, failed: 0 });
    expect(recoverInterrupted(reopened)).toBe(2);
    expect(countByState(reopened)).toEqual({ pending: 3, syncing: 0, synced: 0, failed: 0 });
    reopened.close();
  });

  it('re-queues a synced entity whose content legitimately changed', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const [entry] = claimBatch(db, 1, T0);
    if (!entry) throw new Error('nothing claimed');
    markSynced(db, entry.id, confirmation);
    markChanged(db, 'robot', robot.id);
    expect(getEntry(db, 'robot', robot.id)).toMatchObject({ state: 'pending', cloudConfirmedAt: null });
  });

  it('rejects other invalid transitions at the database level', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    const entry = getEntry(db, 'robot', robot.id);
    expect(() =>
      db.prepare(`UPDATE sync_outbox SET state = 'failed', last_error = 'x' WHERE id = ?`).run(entry?.id ?? 0),
    ).toThrow(/transition/);
  });
});
