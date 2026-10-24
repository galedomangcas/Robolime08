import {
  MANUAL_COMMANDS_APPROVED,
  SERIAL_FRAME_DELIMITER,
  UNSIGNED_LORA_CODEC,
  encodeSerialFrame,
  type LoRaStorageAckMessage,
  type RadioScheduleConfig,
  type SerialFrame,
} from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../db/connection';
import { simulateRun, toBridgeStream, type RunScenario } from '../sim/packetSimulator';
import { SimulationLoRaCodec } from '../sim/simulationCodec';
import { initDatabase } from '../db/init';
import { addTestRobot, count, memoryDb, T0, tempDir } from '../test/helpers';
import type { ByteTransport, ByteTransportHandlers } from './byteTransport';
import {
  MIN_PENDING_WRITES,
  BridgeRuntime,
  BridgeRuntimeConfigError,
  BridgeRuntimeStoppedError,
  HardwareNotConfiguredError,
  SimulationDatabaseError,
  type BridgeRuntimeEvent,
  type BridgeRuntimeOptions,
  type BridgeRuntimeTiming,
  type RuntimeTimers,
} from './bridgeRuntime';
import { SimulatedBridgeTransport } from './simulatedBridgeTransport';

/** TEST-ONLY radio timing (real values unconfirmed, OPEN_ITEMS #20). */
const TEST_ONLY_SCHEDULE: RadioScheduleConfig = {
  responseWindowDelayMs: 0,
  responseWindowMs: 60_000,
  maxTransmissionsPerWindow: 1,
  txResultTimeoutMs: 1_000,
};

/** TEST-ONLY runtime timing; there are no production defaults. */
const TEST_ONLY_TIMING: BridgeRuntimeTiming = {
  pollIntervalMs: 50,
  reconnectDelaysMs: [100, 200, 400],
  maxConsecutiveFailures: 4,
  maxPendingWrites: 32,
};

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Deterministic timers and clock: time only moves when the test says so. */
class ManualTimers implements RuntimeTimers {
  nowMs = T0.getTime();
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  readonly clock = () => new Date(this.nowMs);

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms;
    for (;;) {
      const due = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.tasks.delete(due[0]);
      due[1].fn();
      await flush();
    }
    this.nowMs = end;
    await flush();
  }
}

const scenario = (overrides: Partial<RunScenario> = {}): RunScenario => ({
  robotId: 'TEST-ROBOT-1',
  runId: 'SIM-RUN-1',
  runType: 'dosing',
  cells: 6,
  startAt: T0,
  cellIntervalMs: 60_000,
  seed: 42,
  ...overrides,
});

/** Splits a bridge byte stream into whole serial frames (each ends with the delimiter). */
function frames(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  stream.forEach((b, i) => {
    if (b === SERIAL_FRAME_DELIMITER) {
      out.push(stream.subarray(start, i + 1));
      start = i + 1;
    }
  });
  return out;
}

/** Garbage that fails the serial CRC: each one makes the gateway write a FRAME_REJECTED. */
const corruptFrame = () => Uint8Array.of(4, 9, 9, 9, 0);

function setup(overrides: Partial<BridgeRuntimeOptions> = {}, db: Database = memoryDb('demo')) {
  addTestRobot(db);
  const codec = new SimulationLoRaCodec();
  // The helpers below must talk to the transport the runtime really uses.
  const transport =
    overrides.transport instanceof SimulatedBridgeTransport ? overrides.transport : new SimulatedBridgeTransport();
  const timers = new ManualTimers();
  const events: BridgeRuntimeEvent[] = [];
  const runtime = new BridgeRuntime({
    link: 'simulation',
    db,
    transport,
    codec,
    schedule: TEST_ONLY_SCHEDULE,
    timing: TEST_ONLY_TIMING,
    hostBuildId: 'test-host',
    clock: timers.clock,
    timers,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  const ofType = <T extends BridgeRuntimeEvent['type']>(type: T) =>
    events.filter((e): e is Extract<BridgeRuntimeEvent, { type: T }> => e.type === type);
  const acks = () =>
    transport.hostFrames.flatMap((f) => (f.message.type === 'LORA_TX' ? [codec.decode(f.message.radioPayload) as LoRaStorageAckMessage] : []));
  const types = () => transport.hostFrames.map((f) => f.message.type);
  /** Plays a robot: one uplink at a time, letting the gateway answer each. */
  const robotSends = async (stream: Uint8Array) => {
    for (const frame of frames(stream)) {
      transport.deliver(frame);
      await flush();
    }
  };
  const run = (s: Partial<RunScenario> = {}) => toBridgeStream(simulateRun(scenario(s)), codec);
  const oneReading = () => toBridgeStream(simulateRun(scenario({ cells: 1 })).filter((t) => t.message.kind === 'READING'), codec);
  return { db, codec, transport, timers, events, runtime, ofType, acks, types, robotSends, run, oneReading };
}

async function started(overrides: Partial<BridgeRuntimeOptions> = {}, db?: Database) {
  const t = setup(overrides, db);
  t.runtime.start();
  await flush();
  return t;
}

describe('BridgeRuntime: lifecycle', () => {
  it('opens the transport and greets the bridge with the session’s resync + HELLO', async () => {
    const t = await started();
    expect(t.runtime.state).toBe('connected');
    expect(t.transport.opens).toBe(1);
    expect(t.types()).toEqual(['HELLO']);
    expect(t.transport.hostFrames[0]?.message).toEqual({ type: 'HELLO', role: 'host', buildId: 'test-host' });
    expect(t.ofType('connected')).toEqual([{ type: 'connected', opens: 1 }]);
    expect(t.timers.pending).toBe(1); // the poll timer
    await t.runtime.stop();
  });

  it('start is idempotent; stop is idempotent; a stopped runtime cannot be restarted', async () => {
    const t = setup();
    t.runtime.start();
    t.runtime.start();
    await flush();
    expect(t.transport.opens).toBe(1);
    const first = t.runtime.stop();
    expect(t.runtime.stop()).toBe(first);
    await first;
    expect(t.runtime.state).toBe('stopped');
    expect(() => t.runtime.start()).toThrow(BridgeRuntimeStoppedError);
    expect(t.timers.pending).toBe(0);
    expect(t.transport.isOpen).toBe(false);
  });

  it('stop during an open in progress never connects, writes nothing and closes the transport', async () => {
    let finishOpen: () => void = () => undefined;
    class SlowOpen extends SimulatedBridgeTransport {
      override open(handlers: ByteTransportHandlers): Promise<void> {
        return new Promise((resolve) => {
          finishOpen = () => void super.open(handlers).then(resolve);
        });
      }
    }
    const transport = new SlowOpen();
    const t = setup({ transport });
    t.runtime.start();
    await flush();
    expect(t.runtime.state).toBe('connecting');
    const stopping = t.runtime.stop();
    finishOpen();
    await stopping;
    await flush();
    expect(t.runtime.state).toBe('stopped');
    expect(transport.hostFrames).toEqual([]);
    expect(transport.isOpen).toBe(false);
    expect(t.ofType('connected')).toEqual([]);
    expect(t.timers.pending).toBe(0);
  });

  it('stop during a pending write abandons it; no later timer or write happens', async () => {
    const t = await started();
    t.transport.holdWrites();
    t.transport.deliver(t.oneReading());
    await flush();
    expect(t.transport.heldWrites).toBe(1); // the ACK
    await t.runtime.stop();
    await t.timers.advance(10_000);
    expect(t.transport.heldWrites).toBe(0);
    expect(t.types()).toEqual(['HELLO']);
    expect(t.transport.opens).toBe(1);
    expect(t.timers.pending).toBe(0);
    expect(count(t.db, 'readings')).toBe(1); // stored before the ACK was even attempted
  });
});

describe('BridgeRuntime: data path (simulated bridge → SQLite → ACK)', () => {
  it('stores a whole simulated run exactly once and ACKs every reading', async () => {
    const t = await started();
    await t.robotSends(t.run({ lostFirstAttempt: [1], lostAck: [2, 4] }));
    expect(count(t.db, 'readings')).toBe(6);
    expect(count(t.db, 'robot_status_reports')).toBe(6);
    expect(t.acks().filter((a) => a.result === 'STORED').map((a) => a.cellIndex).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t.acks().filter((a) => a.result === 'DUPLICATE').map((a) => a.cellIndex).sort()).toEqual([2, 4]);
    expect(t.runtime.pendingDownlinks).toBe(0);
    expect(t.runtime.pendingWrites).toBe(0);
    await t.runtime.stop();
  });

  it('passes the injected clock to the session (gateway receipt time)', async () => {
    const t = await started();
    t.timers.nowMs = Date.parse('2026-03-05T08:00:00.000Z');
    t.transport.deliver(t.oneReading());
    await flush();
    expect(t.db.prepare('SELECT gateway_received_at AS at FROM readings').get()?.at).toBe('2026-03-05T08:00:00.000Z');
    await t.runtime.stop();
  });

  it('accepts arbitrary chunking, including one byte at a time', async () => {
    const t = await started();
    for (const b of t.oneReading()) t.transport.deliver(Uint8Array.of(b));
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.acks().map((a) => a.result)).toEqual(['STORED']);
    await t.runtime.stop();
  });

  it('write before ACK: the reading is committed before the ACK write starts; a failed store sends no ACK', async () => {
    const t = await started();
    t.transport.holdWrites();
    t.transport.deliver(t.oneReading());
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.transport.heldWrites).toBe(1);
    expect(t.types()).toEqual(['HELLO']);
    t.transport.releaseWrites();
    await flush();
    expect(t.types()).toEqual(['HELLO', 'LORA_TX']);
    await t.runtime.stop();

    const f = await started();
    f.db.exec(`CREATE TRIGGER test_disk_full BEFORE INSERT ON readings BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
    f.transport.deliver(f.oneReading());
    await f.timers.advance(5_000);
    expect(count(f.db, 'readings')).toBe(0);
    expect(f.types()).toEqual(['HELLO']);
    expect(f.ofType('session').map((e) => e.sessionEvent)).toContain('storage_failed');
    await f.runtime.stop();
  });

  it('serialises writes: the next write starts only after the previous one settled', async () => {
    const t = await started();
    t.transport.holdWrites();
    t.transport.deliver(new Uint8Array([...corruptFrame(), ...corruptFrame(), ...corruptFrame()]));
    await flush();
    expect(t.transport.heldWrites).toBe(1);
    expect(t.runtime.pendingWrites).toBe(3);
    t.transport.releaseWrites();
    await flush();
    expect(t.types()).toEqual(['HELLO', 'FRAME_REJECTED', 'FRAME_REJECTED', 'FRAME_REJECTED']);
    const ids = t.transport.hostFrames.map((f: SerialFrame) => f.frameId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(t.runtime.pendingWrites).toBe(0);
    await t.runtime.stop();
  });

  it('polls on the supplied interval, so an ACK waiting for its response window goes out on time', async () => {
    const t = await started({ schedule: { ...TEST_ONLY_SCHEDULE, responseWindowDelayMs: 100 } });
    t.transport.deliver(t.oneReading());
    await flush();
    expect(t.types()).toEqual(['HELLO']); // stored; window not open yet
    await t.timers.advance(50);
    expect(t.types()).toEqual(['HELLO']);
    await t.timers.advance(50);
    expect(t.types()).toEqual(['HELLO', 'LORA_TX']);
    await t.runtime.stop();
    expect(t.timers.pending).toBe(0);
  });
});

describe('BridgeRuntime: failures, reconnection and bounds', () => {
  it('reconnects after a disconnect using the supplied backoff, and greets the bridge again', async () => {
    const t = await started();
    t.transport.disconnect(new Error('unplugged'));
    await flush();
    expect(t.runtime.state).toBe('waiting_to_reconnect');
    expect(t.ofType('reconnect_scheduled')).toEqual([{ type: 'reconnect_scheduled', delayMs: 100, attempt: 1 }]);
    await t.timers.advance(99);
    expect(t.transport.opens).toBe(1);
    await t.timers.advance(1);
    expect(t.transport.opens).toBe(2);
    expect(t.runtime.state).toBe('connected');
    expect(t.types()).toEqual(['HELLO', 'HELLO']);
    await t.runtime.stop();
  });

  it('backs off through the supplied delays and gives up after maxConsecutiveFailures', async () => {
    const t = setup();
    t.transport.failNextOpens(99);
    t.runtime.start();
    await flush();
    await t.timers.advance(100 + 200 + 400);
    expect(t.ofType('reconnect_scheduled').map((e) => e.delayMs)).toEqual([100, 200, 400]);
    expect(t.ofType('gave_up')).toEqual([{ type: 'gave_up', consecutiveFailures: 4 }]);
    expect(t.runtime.state).toBe('failed');
    expect(t.timers.pending).toBe(0);
    await t.timers.advance(60_000);
    expect(t.transport.opens).toBe(0);
    await t.runtime.stop();
  });

  it('a link that connects but never delivers a valid frame also gives up (flapping is bounded)', async () => {
    const t = await started();
    for (let i = 0; i < 4; i += 1) {
      t.transport.disconnect(null);
      await t.timers.advance(400);
    }
    expect(t.runtime.state).toBe('failed');
    expect(t.transport.opens).toBe(4);
    await t.runtime.stop();
  });

  it('a valid frame from the bridge resets the failure count', async () => {
    const t = await started();
    const hello = encodeSerialFrame({ frameId: 1, message: { type: 'HELLO', role: 'bridge', buildId: 'sim-bridge' } });
    for (let i = 0; i < 8; i += 1) {
      t.transport.disconnect(null);
      await t.timers.advance(400);
      t.transport.deliver(hello);
      await flush();
    }
    expect(t.runtime.state).toBe('connected');
    await t.runtime.stop();
  });

  it('cancels a scheduled reconnect on stop', async () => {
    const t = await started();
    t.transport.disconnect(null);
    await flush();
    expect(t.timers.pending).toBe(1);
    await t.runtime.stop();
    expect(t.timers.pending).toBe(0);
    await t.timers.advance(10_000);
    expect(t.transport.opens).toBe(1);
  });

  it('a lost ACK write is not treated as delivered; the robot’s retry is stored once and ACKed as DUPLICATE', async () => {
    const t = await started();
    t.transport.failNextWrites(1);
    t.transport.deliver(t.oneReading());
    await flush();
    expect(t.ofType('write_failed')).toHaveLength(1);
    expect(t.runtime.state).toBe('waiting_to_reconnect');
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.runtime.pendingDownlinks).toBe(1); // still owed, not marked sent
    expect(t.acks()).toEqual([]);

    await t.timers.advance(100);
    expect(t.runtime.state).toBe('connected');
    t.transport.deliver(t.oneReading()); // the robot never got an ACK, so it retries
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.acks().map((a) => a.result)).toEqual(['DUPLICATE']);
    expect(t.runtime.pendingDownlinks).toBe(0);
    await t.runtime.stop();
  });

  it('a partial frame left by a disconnect is discarded; the full frame after reconnect is stored once', async () => {
    const t = await started();
    const reading = t.oneReading();
    t.transport.deliver(reading.subarray(0, 5));
    t.transport.disconnect(new Error('unplugged mid-frame'));
    await t.timers.advance(100);
    t.transport.deliver(reading);
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.acks().map((a) => a.result)).toEqual(['STORED']);
    expect(t.ofType('session').filter((e) => e.sessionEvent === 'serial_error')).toEqual([]);
    await t.runtime.stop();
  });

  it('frames queued for a lost connection are dropped, not replayed on the next one', async () => {
    const t = await started();
    t.transport.holdWrites();
    t.transport.deliver(new Uint8Array([...corruptFrame(), ...corruptFrame()]));
    await flush();
    t.transport.disconnect(null);
    await flush();
    expect(t.ofType('disconnected')).toEqual([{ type: 'disconnected', consecutiveFailures: 1, errorName: null, droppedWrites: 1 }]);
    t.transport.releaseWrites();
    await t.timers.advance(100);
    expect(t.types()).toEqual(['HELLO', 'HELLO']);
    await t.runtime.stop();
  });

  it('bounds the write queue: excess frames are dropped and reported; storage is unaffected and the ACK is retried later', async () => {
    const t = await started({ timing: { ...TEST_ONLY_TIMING, maxPendingWrites: 2 } });
    t.transport.holdWrites();
    t.transport.deliver(new Uint8Array([...corruptFrame(), ...corruptFrame(), ...corruptFrame(), ...corruptFrame(), ...corruptFrame()]));
    await flush();
    expect(t.ofType('writes_dropped')).toEqual([{ type: 'writes_dropped', count: 3, reason: 'queue_full' }]);
    // Capacity counts the write in progress: one is being written and one waits, so 2 of 2 are held.
    expect(t.runtime.pendingWrites).toBe(2);
    t.transport.deliver(corruptFrame());
    await flush();
    expect(t.ofType('writes_dropped').at(-1)).toEqual({ type: 'writes_dropped', count: 1, reason: 'queue_full' });
    expect(t.runtime.pendingWrites).toBe(2);

    t.transport.deliver(t.oneReading()); // its ACK cannot be queued
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.ofType('writes_dropped').at(-1)).toEqual({ type: 'writes_dropped', count: 1, reason: 'queue_full' });

    t.transport.releaseWrites();
    await flush();
    expect(t.acks()).toEqual([]);
    expect(t.runtime.pendingDownlinks).toBe(1); // still owed: dropping it did not mark it sent
    // The session never saw a TX result for the dropped ACK. Its TX-result timeout clears the lost
    // attempt; the ACK goes out in the next response window, opened by the robot's retry.
    await t.timers.advance(TEST_ONLY_SCHEDULE.txResultTimeoutMs + TEST_ONLY_TIMING.pollIntervalMs);
    expect(t.acks()).toEqual([]); // the window's single transmission was used by the dropped attempt
    t.transport.deliver(t.oneReading());
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.acks().map((a) => a.result)).toEqual(['DUPLICATE']);
    expect(t.runtime.pendingDownlinks).toBe(0);
    await t.runtime.stop();
  });
});

describe('BridgeRuntime: audit regressions (D31)', () => {
  it('a throwing event sink does not stop the runtime from connecting, storing, ACKing or shutting down', async () => {
    const t = setup({
      onEvent: () => {
        throw new Error('event sink failure');
      },
    });
    t.runtime.start();
    await flush();
    expect(t.runtime.state).toBe('connected');
    expect(t.types()).toEqual(['HELLO']);
    t.transport.deliver(t.oneReading());
    await flush();
    expect(count(t.db, 'readings')).toBe(1);
    expect(t.acks().map((a) => a.result)).toEqual(['STORED']);

    const stopping = t.runtime.stop(); // must not throw synchronously
    expect(t.runtime.stop()).toBe(stopping);
    await stopping;
    expect(t.runtime.state).toBe('stopped');
    expect(t.transport.isOpen).toBe(false);
    expect(t.timers.pending).toBe(0);
  });

  it('a "stopped" listener that calls stop() again gets the same promise, and the transport is closed exactly once', async () => {
    const transport = new SimulatedBridgeTransport();
    let closes = 0;
    const realClose = transport.close.bind(transport);
    transport.close = () => {
      closes += 1;
      return realClose();
    };
    const inner: Promise<void>[] = [];
    const holder: { runtime?: BridgeRuntime } = {};
    const t = setup({
      transport,
      onEvent: (e) => {
        if (e.type === 'state' && e.state === 'stopped' && holder.runtime) inner.push(holder.runtime.stop(), holder.runtime.stop());
      },
    });
    holder.runtime = t.runtime;
    t.runtime.start();
    await flush();

    const outer = t.runtime.stop();
    expect(inner).toHaveLength(2);
    expect(inner.every((p) => p === outer)).toBe(true);
    await expect(Promise.all([outer, ...inner])).resolves.toEqual([undefined, undefined, undefined]);
    expect(t.runtime.stop()).toBe(outer);
    expect(closes).toBe(1);
    expect(t.runtime.state).toBe('stopped');
    expect(transport.isOpen).toBe(false);
    expect(t.timers.pending).toBe(0);
  });

  it('shutdown still records its promise and reaches "stopped" when close() throws synchronously or rejects', async () => {
    for (const failure of ['throws', 'rejects'] as const) {
      const transport = new SimulatedBridgeTransport();
      transport.close = () => {
        if (failure === 'throws') throw new Error('close threw');
        return Promise.reject(new Error('close rejected'));
      };
      const t = setup({ transport });
      t.runtime.start();
      await flush();
      const stopping = t.runtime.stop();
      expect(t.runtime.stop()).toBe(stopping);
      await expect(stopping).resolves.toBeUndefined();
      expect(t.runtime.state).toBe('stopped');
      expect(t.timers.pending).toBe(0);
    }
  });

  it('with the minimum capacity, the opening resync byte and HELLO are both written, on every connection', async () => {
    expect(MIN_PENDING_WRITES).toBe(2);
    const t = await started({ timing: { ...TEST_ONLY_TIMING, maxPendingWrites: MIN_PENDING_WRITES } });
    expect(t.transport.rawWrites.map((w) => Array.from(w).length > 1 ? 'frame' : Array.from(w))).toEqual([[0], 'frame']);
    expect(t.types()).toEqual(['HELLO']);
    expect(t.ofType('writes_dropped')).toEqual([]);

    t.transport.disconnect(null);
    await t.timers.advance(100);
    expect(t.types()).toEqual(['HELLO', 'HELLO']);
    expect(t.transport.rawWrites).toHaveLength(4);
    expect(t.ofType('writes_dropped')).toEqual([]);
    await t.runtime.stop();
  });

  it('capacity counts the write in progress the same way whether the runtime was idle or busy', async () => {
    const t = await started({ timing: { ...TEST_ONLY_TIMING, maxPendingWrites: 3 } });
    t.transport.holdWrites();
    t.transport.deliver(new Uint8Array([...corruptFrame(), ...corruptFrame(), ...corruptFrame(), ...corruptFrame()]));
    await flush();
    expect(t.runtime.pendingWrites).toBe(3); // 1 being written + 2 queued
    expect(t.ofType('writes_dropped')).toEqual([{ type: 'writes_dropped', count: 1, reason: 'queue_full' }]);
    t.transport.deliver(new Uint8Array([...corruptFrame(), ...corruptFrame()]));
    await flush();
    expect(t.runtime.pendingWrites).toBe(3);
    expect(t.ofType('writes_dropped').at(-1)).toEqual({ type: 'writes_dropped', count: 2, reason: 'queue_full' });
    t.transport.releaseWrites();
    await flush();
    expect(t.types().filter((x) => x === 'FRAME_REJECTED')).toHaveLength(3);
    await t.runtime.stop();
  });

  it('a stalled write from a lost connection delays, but never loses or reorders, the next connection’s handshake', async () => {
    /** A driver whose pending write survives close() and settles only later (allowed, but slow). */
    class StallingWrite extends SimulatedBridgeTransport {
      stallNext = false;
      settleStalled: () => void = () => undefined;
      override write(bytes: Uint8Array): Promise<void> {
        if (!this.stallNext) return super.write(bytes);
        this.stallNext = false;
        return new Promise((resolve) => {
          this.settleStalled = resolve;
        });
      }
    }
    const transport = new StallingWrite();
    const t = await started({ transport, timing: { ...TEST_ONLY_TIMING, maxPendingWrites: MIN_PENDING_WRITES } });
    transport.stallNext = true;
    t.transport.deliver(corruptFrame()); // its FRAME_REJECTED write stalls
    await flush();
    t.transport.disconnect(new Error('unplugged'));
    await t.timers.advance(100); // reconnected; the new handshake waits behind the stalled write
    expect(t.runtime.state).toBe('connected');
    expect(t.types()).toEqual(['HELLO']);
    expect(t.ofType('writes_dropped')).toEqual([]); // the stale write does not count against the new connection

    transport.settleStalled();
    await flush();
    expect(t.types()).toEqual(['HELLO', 'HELLO']); // the stale FRAME_REJECTED is never replayed
    t.transport.deliver(t.oneReading());
    await flush();
    expect(t.acks().map((a) => a.result)).toEqual(['STORED']);
    await t.runtime.stop();
  });

  it('when the ACK reaches the transport, the reading is already committed (visible to a second SQLite connection)', async () => {
    const tmp = tempDir();
    try {
      const path = tmp.path('demo.sqlite');
      const db = initDatabase(path, 'demo', T0);
      const seenByOtherConnection: number[] = [];
      class ObservingTransport extends SimulatedBridgeTransport {
        override write(bytes: Uint8Array): Promise<void> {
          const before = this.hostFrames.length;
          const result = super.write(bytes);
          if (this.hostFrames.slice(before).some((f) => f.message.type === 'LORA_TX')) {
            const other = openDatabase(path);
            seenByOtherConnection.push(Number(other.prepare('SELECT COUNT(*) AS n FROM readings').get()?.n));
            other.close();
          }
          return result;
        }
      }
      const t = setup({ transport: new ObservingTransport() }, db);
      t.runtime.start();
      await flush();
      t.transport.deliver(t.oneReading());
      await flush();
      expect(seenByOtherConnection).toEqual([1]);
      expect(db.isTransaction).toBe(false);
      await t.runtime.stop();
      db.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe('BridgeRuntime: safety guards', () => {
  const hardwareTransport: ByteTransport = {
    kind: 'hardware',
    isOpen: false,
    open: () => Promise.reject(new Error('must never be opened')),
    write: () => Promise.reject(new Error('must never be written')),
    close: () => Promise.resolve(),
  };

  it('refuses a hardware runtime while the radio schedule and wire codec are unconfirmed', () => {
    const db = memoryDb('field');
    const make = (codec: BridgeRuntimeOptions['codec'], schedule?: RadioScheduleConfig) =>
      new BridgeRuntime({ link: 'hardware', db, transport: hardwareTransport, codec, schedule, timing: TEST_ONLY_TIMING, hostBuildId: 'h' });
    expect(() => make(UNSIGNED_LORA_CODEC)).toThrow(HardwareNotConfiguredError);
    expect(() => make(UNSIGNED_LORA_CODEC)).toThrow(/OPEN_ITEMS #20.*OPEN_ITEMS #1/);
    expect(() => make(new SimulationLoRaCodec())).toThrow(HardwareNotConfiguredError);
    expect(() => make(UNSIGNED_LORA_CODEC, TEST_ONLY_SCHEDULE)).toThrow(/committed RADIO_SCHEDULE/);
  });

  it('refuses mismatched link and transport kinds, and a wire codec in simulation', () => {
    const db = memoryDb('demo');
    const base = { db, codec: new SimulationLoRaCodec(), schedule: TEST_ONLY_SCHEDULE, timing: TEST_ONLY_TIMING, hostBuildId: 'h' };
    expect(() => new BridgeRuntime({ ...base, link: 'simulation', transport: hardwareTransport })).toThrow(BridgeRuntimeConfigError);
    expect(() => new BridgeRuntime({ ...base, link: 'hardware', transport: new SimulatedBridgeTransport() })).toThrow(BridgeRuntimeConfigError);
    expect(() => new BridgeRuntime({ ...base, link: 'simulation', transport: new SimulatedBridgeTransport(), codec: UNSIGNED_LORA_CODEC })).toThrow(
      /simulation codec/,
    );
    expect(() => new BridgeRuntime({ ...base, link: 'simulation', transport: new SimulatedBridgeTransport(), schedule: undefined })).toThrow(
      /explicit/,
    );
  });

  it('refuses to simulate into a field database, or one whose purpose cannot be verified', () => {
    expect(() => setup({}, memoryDb('field'))).toThrow(SimulationDatabaseError);
    expect(() => setup({}, memoryDb('field'))).toThrow(/marked 'field'/);
    const unverifiable = openDatabase(':memory:'); // no gateway_settings table at all
    expect(() =>
      new BridgeRuntime({
        link: 'simulation',
        db: unverifiable,
        transport: new SimulatedBridgeTransport(),
        codec: new SimulationLoRaCodec(),
        schedule: TEST_ONLY_SCHEDULE,
        timing: TEST_ONLY_TIMING,
        hostBuildId: 'h',
      }),
    ).toThrow(/not a verifiable gateway database/);
  });

  it('nothing is written to a field database when the simulation is refused', () => {
    const field = memoryDb('field');
    expect(() => setup({}, field)).toThrow(SimulationDatabaseError);
    expect(count(field, 'readings')).toBe(0);
    expect(count(field, 'runs')).toBe(0);
  });

  it.each<[string, Partial<BridgeRuntimeTiming>]>([
    ['pollIntervalMs', { pollIntervalMs: 0 }],
    ['reconnectDelaysMs', { reconnectDelaysMs: [] }],
    ['reconnectDelaysMs', { reconnectDelaysMs: [-1] }],
    ['maxConsecutiveFailures', { maxConsecutiveFailures: 0 }],
    ['maxPendingWrites', { maxPendingWrites: 1.5 }],
    ['maxPendingWrites', { maxPendingWrites: 1 }],
  ])('requires explicit, valid timing (%s)', (field, bad) => {
    expect(() => setup({ timing: { ...TEST_ONLY_TIMING, ...bad } })).toThrow(new RegExp(field));
  });

  it('only STORAGE_ACK downlinks ever leave; the manual-command gate stays closed', async () => {
    const t = await started();
    await t.robotSends(t.run({ cells: 4 }));
    expect(new Set(t.types())).toEqual(new Set(['HELLO', 'LORA_TX']));
    expect(t.acks().every((a) => a.kind === 'STORAGE_ACK')).toBe(true);
    expect(MANUAL_COMMANDS_APPROVED).toBe(false);
    await t.runtime.stop();
  });

  it('events carry only types, counts and short codes: no payload bytes or reading values', async () => {
    const t = await started();
    await t.robotSends(t.run({ lostAck: [1] }));
    t.transport.deliver(corruptFrame());
    t.transport.disconnect(new Error('unplugged: detail that must not be logged'));
    await t.timers.advance(100);
    await t.runtime.stop();

    const allowedKeys = new Set(['type', 'state', 'opens', 'consecutiveFailures', 'errorName', 'droppedWrites', 'delayMs', 'attempt', 'count', 'reason', 'sessionEvent', 'outcome']);
    for (const e of t.events) {
      for (const [key, value] of Object.entries(e)) {
        expect(allowedKeys.has(key), key).toBe(true);
        expect(value === null || ['string', 'number'].includes(typeof value), key).toBe(true);
      }
    }
    const serialized = JSON.stringify(t.events);
    expect(serialized).not.toContain('detail that must not be logged');
    expect(serialized).not.toMatch(/radioPayload|robotRecordedAt|"ph"|TEST-ROBOT-1|SIM-RUN-1/);
    expect(t.ofType('session').map((e) => e.outcome)).toContain('reading_stored:inserted');
  });
});
