import type { RadioScheduleConfig } from '@robolime/shared';

import { openExistingDatabase } from '../db/init';
import { simulateRun, toBridgeStream } from '../sim/packetSimulator';
import { SimulationLoRaCodec } from '../sim/simulationCodec';
import { DEMO_SOURCE_ROBOT_ID } from '../seed/demo';
import { getRobotBySourceId } from '../store/robots';
import { BridgeRuntime, type BridgeRuntimeEvent, type BridgeRuntimeTiming } from './bridgeRuntime';
import { SimulatedBridgeTransport } from './simulatedBridgeTransport';

/**
 * SIMULATION ONLY: plays one synthetic robot run through the real bridge
 * runtime, session, storage and ACK path into a DEMO database. No serial
 * port, radio or hardware is involved, and the values below are not radio
 * timing — they only pace an in-memory simulation (OPEN_ITEMS #20).
 */
export const SIMULATION_ONLY_SCHEDULE: RadioScheduleConfig = {
  responseWindowDelayMs: 0,
  responseWindowMs: 5_000,
  maxTransmissionsPerWindow: 1,
  txResultTimeoutMs: 1_000,
};

export const SIMULATION_ONLY_TIMING: BridgeRuntimeTiming = {
  pollIntervalMs: 10,
  reconnectDelaysMs: [100],
  maxConsecutiveFailures: 3,
  maxPendingWrites: 64,
};

export const SIMULATION_MAX_CELLS = 200;

export interface SimulationArgs {
  dbPath: string;
  cells: number;
  seed: number;
}

export class SimulationArgsError extends Error {
  override name = 'SimulationArgsError';
}

/** Validates CLI values. `--db` is required: GATEWAY_DB_PATH is deliberately ignored to protect the field database. */
export function parseSimulationArgs(values: { db?: string; cells?: string; seed?: string }): SimulationArgs {
  if (!values.db || values.db.trim() === '') {
    throw new SimulationArgsError('--db <demo database file> is required (GATEWAY_DB_PATH is not used, to protect the field database).');
  }
  const int = (raw: string | undefined, name: string, fallback: number, min: number, max: number) => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > max) {
      throw new SimulationArgsError(`--${name} must be a whole number from ${min} to ${max}.`);
    }
    return Number(raw);
  };
  return {
    dbPath: values.db,
    cells: int(values.cells, 'cells', 6, 1, SIMULATION_MAX_CELLS),
    seed: int(values.seed, 'seed', 1, 0, 2_147_483_647),
  };
}

export interface SimulationSummary {
  runId: string;
  uplinksDelivered: number;
  readingsInserted: number;
  readingsDuplicate: number;
  /** Same run/cell/seq with different values (e.g. a re-run at another time): the original is kept. */
  readingsConflict: number;
  acksSent: number;
  completed: boolean;
}

export class SimulationSetupError extends Error {
  override name = 'SimulationSetupError';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the simulation and always stops the runtime and closes the database,
 * including on abort. Refuses a missing database, a non-demo database (the
 * runtime's guard) and a demo database without the synthetic demo robot.
 */
export async function runBridgeSimulation(
  args: SimulationArgs,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: BridgeRuntimeEvent) => void;
    maxWaitMs?: number;
    /** Robot-side time of the first cell; defaults to now. A fixed value makes a re-run an exact replay. */
    startAt?: Date;
  } = {},
): Promise<SimulationSummary> {
  const db = openExistingDatabase(args.dbPath);
  const summary: SimulationSummary = {
    runId: `SIM-RUN-${args.seed}`,
    uplinksDelivered: 0,
    readingsInserted: 0,
    readingsDuplicate: 0,
    readingsConflict: 0,
    acksSent: 0,
    completed: false,
  };
  let runtime: BridgeRuntime | null = null;
  try {
    const transport = new SimulatedBridgeTransport();
    const codec = new SimulationLoRaCodec();
    runtime = new BridgeRuntime({
      link: 'simulation',
      db,
      transport,
      codec,
      schedule: SIMULATION_ONLY_SCHEDULE,
      timing: SIMULATION_ONLY_TIMING,
      hostBuildId: 'bridge-simulate',
      onEvent: (event) => {
        if (event.type === 'session' && event.outcome === 'reading_stored:inserted') summary.readingsInserted += 1;
        if (event.type === 'session' && event.outcome === 'reading_stored:duplicate') summary.readingsDuplicate += 1;
        if (event.type === 'session' && event.outcome === 'reading_stored:conflict') summary.readingsConflict += 1;
        if (event.type === 'session' && event.sessionEvent === 'tx_result' && event.outcome === 'sent') summary.acksSent += 1;
        options.onEvent?.(event);
      },
    });
    if (!getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID)) {
      throw new SimulationSetupError('The demo robot is not provisioned in this database. Run db:seed:demo on it first.');
    }

    const active = runtime;
    const maxWaitMs = options.maxWaitMs ?? 10_000;
    const waitUntil = async (done: () => boolean) => {
      const deadline = Date.now() + maxWaitMs;
      while (!done()) {
        if (options.signal?.aborted) return false;
        if (Date.now() > deadline) throw new Error('Simulation did not settle in time.');
        await sleep(SIMULATION_ONLY_TIMING.pollIntervalMs);
      }
      return true;
    };

    active.start();
    if (!(await waitUntil(() => active.state === 'connected'))) return summary;
    const stream = toBridgeStream(
      simulateRun({
        robotId: DEMO_SOURCE_ROBOT_ID,
        runId: summary.runId,
        runType: 'dosing',
        cells: args.cells,
        startAt: options.startAt ?? new Date(),
        cellIntervalMs: 60_000,
        seed: args.seed,
      }),
      codec,
    );
    let start = 0;
    for (let i = 0; i < stream.length; i += 1) {
      if (stream[i] !== 0) continue;
      if (options.signal?.aborted) return summary;
      transport.deliver(stream.subarray(start, i + 1)); // one uplink at a time, like a robot
      start = i + 1;
      summary.uplinksDelivered += 1;
      if (!(await waitUntil(() => active.pendingWrites === 0 && active.pendingDownlinks === 0))) return summary;
    }
    summary.completed = true;
    return summary;
  } finally {
    await runtime?.stop();
    db.close();
  }
}
