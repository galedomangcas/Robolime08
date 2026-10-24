import { afterEach, describe, expect, it } from 'vitest';

import { initDatabase } from '../db/init';
import { DEMO_SOURCE_ROBOT_ID, seedDemo } from '../seed/demo';
import { getRobotBySourceId } from '../store/robots';
import { count, T0, tempDir } from '../test/helpers';
import { SimulationDatabaseError } from './bridgeRuntime';
import { SIMULATION_MAX_CELLS, SimulationArgsError, SimulationSetupError, parseSimulationArgs, runBridgeSimulation } from './simulate';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function dir() {
  const tmp = tempDir();
  cleanup = tmp.cleanup;
  return tmp;
}

function demoDb(path: string) {
  const db = initDatabase(path, 'demo', T0);
  seedDemo(db);
  db.close();
}

const readingsOfSimulatedRun = (path: string, runId: string) => {
  const db = initDatabase(path, 'demo', T0);
  const robot = getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID);
  const n = Number(
    db.prepare('SELECT COUNT(*) AS n FROM readings x JOIN runs r ON r.id = x.run_id WHERE r.source_run_id = ? AND r.robot_id = ?').get(runId, robot?.id ?? '')?.n,
  );
  db.close();
  return n;
};

describe('bridge:simulate arguments', () => {
  it('requires an explicit --db and validates --cells and --seed', () => {
    expect(() => parseSimulationArgs({})).toThrow(SimulationArgsError);
    expect(() => parseSimulationArgs({ db: '  ' })).toThrow(/--db/);
    expect(parseSimulationArgs({ db: 'demo.sqlite' })).toEqual({ dbPath: 'demo.sqlite', cells: 6, seed: 1 });
    expect(parseSimulationArgs({ db: 'd', cells: '12', seed: '0' })).toEqual({ dbPath: 'd', cells: 12, seed: 0 });
    for (const cells of ['0', '-1', '1.5', 'abc', String(SIMULATION_MAX_CELLS + 1)]) {
      expect(() => parseSimulationArgs({ db: 'd', cells })).toThrow(/--cells/);
    }
    expect(() => parseSimulationArgs({ db: 'd', seed: 'x' })).toThrow(/--seed/);
  });
});

describe('bridge:simulate run (simulated bridge → runtime → demo SQLite)', () => {
  it('stores a synthetic run once; an exact replay stores nothing new; a re-run at another time keeps the originals', async () => {
    const tmp = dir();
    const path = tmp.path('demo.sqlite');
    demoDb(path);
    const startAt = new Date('2026-03-01T06:00:00.000Z');

    const first = await runBridgeSimulation({ dbPath: path, cells: 5, seed: 7 }, { startAt });
    expect(first).toMatchObject({ runId: 'SIM-RUN-7', completed: true, readingsInserted: 5, readingsDuplicate: 0, readingsConflict: 0 });
    expect(first.acksSent).toBe(5);
    expect(readingsOfSimulatedRun(path, 'SIM-RUN-7')).toBe(5);

    const replay = await runBridgeSimulation({ dbPath: path, cells: 5, seed: 7 }, { startAt });
    expect(replay).toMatchObject({ completed: true, readingsInserted: 0, readingsDuplicate: 5, readingsConflict: 0 });

    const later = await runBridgeSimulation({ dbPath: path, cells: 5, seed: 7 }, { startAt: new Date('2026-03-02T06:00:00.000Z') });
    expect(later).toMatchObject({ completed: true, readingsInserted: 0, readingsConflict: 5 });
    expect(readingsOfSimulatedRun(path, 'SIM-RUN-7')).toBe(5);
  });

  it('refuses a field database and leaves it untouched', async () => {
    const tmp = dir();
    const path = tmp.path('field.sqlite');
    initDatabase(path, 'field', T0).close();
    await expect(runBridgeSimulation({ dbPath: path, cells: 2, seed: 1 })).rejects.toThrow(SimulationDatabaseError);
    const db = initDatabase(path, 'field', T0);
    expect(count(db, 'readings')).toBe(0);
    expect(count(db, 'runs')).toBe(0);
    db.close();
  });

  it('refuses a missing database instead of creating one, and a demo database without the demo robot', async () => {
    const tmp = dir();
    await expect(runBridgeSimulation({ dbPath: tmp.path('typo.sqlite'), cells: 2, seed: 1 })).rejects.toThrow(/No database/);
    const empty = tmp.path('empty-demo.sqlite');
    initDatabase(empty, 'demo', T0).close();
    await expect(runBridgeSimulation({ dbPath: empty, cells: 2, seed: 1 })).rejects.toThrow(SimulationSetupError);
  });

  it('stops cleanly when aborted and releases the database', async () => {
    const tmp = dir();
    const path = tmp.path('demo.sqlite');
    demoDb(path);
    const controller = new AbortController();
    controller.abort();
    const summary = await runBridgeSimulation({ dbPath: path, cells: 50, seed: 3 }, { signal: controller.signal });
    expect(summary.completed).toBe(false);
    // The database was closed: it can be reopened and the simulated run is not complete.
    expect(readingsOfSimulatedRun(path, 'SIM-RUN-3')).toBeLessThan(50);
  });
});
