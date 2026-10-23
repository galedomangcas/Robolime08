import {
  LORA_MAX_PAYLOAD_BYTES,
  SerialFrameReader,
  UNSIGNED_LORA_CODEC,
  cobsEncode,
  crc16CcittFalse,
  encodeSerialFrame,
  type LoRaStorageAckMessage,
  type RadioScheduleConfig,
  type SerialFrame,
} from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import type { Database } from '../db/connection';
import { initDatabase } from '../db/init';
import { chunkStream, simulateRun, toBridgeStream, type RunScenario } from '../sim/packetSimulator';
import { SimulationLoRaCodec } from '../sim/simulationCodec';
import { countByState } from '../store/outbox';
import { addTestRobot, count, memoryDb, T0, tempDir } from '../test/helpers';
import { BridgeProtocolSession, type SessionEvent, type SessionOutput } from './bridgeSession';

/** TEST-ONLY radio timing (real values unconfirmed, OPEN_ITEMS #20). A generous window keeps tests about ordering, not timing. */
const TEST_ONLY_SCHEDULE: RadioScheduleConfig = {
  responseWindowDelayMs: 0,
  responseWindowMs: 60_000,
  maxTransmissionsPerWindow: 1,
  txResultTimeoutMs: 1_000,
};

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

function session(db: Database, codec = new SimulationLoRaCodec(), schedule = TEST_ONLY_SCHEDULE) {
  return { codec, s: new BridgeProtocolSession({ db, codec, schedule, hostBuildId: 'test-host' }) };
}

/** Decodes the serial frames the gateway wrote. */
function written(outputs: SessionOutput[]): SerialFrame[] {
  const reader = new SerialFrameReader();
  return outputs.flatMap((o) => o.outgoing.flatMap((bytes) => reader.push(bytes))).flatMap((e) => (e.kind === 'frame' ? [e.frame] : []));
}

function acksIn(frames: SerialFrame[], codec: SimulationLoRaCodec): LoRaStorageAckMessage[] {
  return frames.flatMap((f) => (f.message.type === 'LORA_TX' ? [codec.decode(f.message.radioPayload) as LoRaStorageAckMessage] : []));
}

const events = (outputs: SessionOutput[]): SessionEvent[] => outputs.flatMap((o) => o.events);

/**
 * Plays the bridge side faithfully: feeds the stream in random-sized reads
 * (partial frames, several frames per read) and answers every LORA_TX with
 * LORA_TX_RESULT = SENT. Like a real bridge, it writes its replies only
 * between complete frames, never inside one.
 */
function playBridge(s: BridgeProtocolSession, stream: Uint8Array, seed: number, now = T0): SessionOutput[] {
  const outputs: SessionOutput[] = [];
  const bridgeIds = { next: 50_000 };
  const replies: Uint8Array[] = [];
  const collect = (out: SessionOutput) => {
    outputs.push(out);
    for (const frame of written([out])) {
      if (frame.message.type !== 'LORA_TX') continue;
      replies.push(encodeSerialFrame({ frameId: bridgeIds.next++, message: { type: 'LORA_TX_RESULT', refFrameId: frame.frameId, result: 'SENT' } }));
    }
  };
  const flushReplies = () => {
    while (replies.length > 0) collect(s.receive(replies.shift() ?? new Uint8Array(), now));
  };
  for (const chunk of chunkStream(stream, seed)) {
    const boundary = chunk.lastIndexOf(0) + 1;
    collect(s.receive(chunk.subarray(0, boundary), now));
    if (boundary > 0) flushReplies();
    collect(s.receive(chunk.subarray(boundary), now));
  }
  flushReplies();
  return outputs;
}

describe('BridgeProtocolSession: simulated run end-to-end (serial bytes → SQLite → ACK)', () => {
  it('stores every reading once and ACKs each after storage, across random serial chunking', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const run = simulateRun(scenario({ lostFirstAttempt: [1], lostAck: [2, 4] }));
    const outputs = playBridge(s, toBridgeStream(run, codec), 7);

    expect(count(db, 'readings')).toBe(6);
    expect(count(db, 'robot_status_reports')).toBe(6);
    const acks = acksIn(written(outputs), codec);
    expect(acks.filter((a) => a.result === 'STORED').map((a) => a.cellIndex).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(acks.filter((a) => a.result === 'DUPLICATE').map((a) => a.cellIndex).sort()).toEqual([2, 4]);
    expect(events(outputs).filter((e) => e.type === 'serial_error' || e.type === 'lora_rejected')).toEqual([]);
    expect(s.pendingDownlinks).toBe(0);
  });

  it('replaying the same buffered batch twice creates no duplicate readings or outbox rows', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const stream = toBridgeStream(simulateRun(scenario()), codec);
    playBridge(s, stream, 1);
    const outboxAfterFirst = count(db, 'sync_outbox');
    const replay = playBridge(s, stream, 2);

    expect(count(db, 'readings')).toBe(6);
    expect(count(db, 'sync_outbox')).toBe(outboxAfterFirst);
    expect(acksIn(written(replay), codec).every((a) => a.result === 'DUPLICATE')).toBe(true);
  });

  it('handles gaps, late and shuffled delivery, and dosing plus verification runs', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    playBridge(s, toBridgeStream(simulateRun(scenario({ cells: 10, missing: [3], late: [5, 6], shuffle: true })), codec), 3);
    playBridge(s, toBridgeStream(simulateRun(scenario({ runId: 'SIM-VERIFY-1', runType: 'verification', cells: 10, seed: 9 })), codec), 4);

    const byRun = db.prepare('SELECT r.run_type AS t, COUNT(*) AS n FROM readings x JOIN runs r ON r.id = x.run_id GROUP BY r.run_type ORDER BY t').all();
    expect(byRun).toEqual([
      { t: 'dosing', n: 9 },
      { t: 'verification', n: 10 },
    ]);
  });

  it('survives a gateway restart mid-run: buffered records replayed later are stored exactly once', () => {
    const tmp = tempDir();
    try {
      const file = tmp.path('field.sqlite');
      const run = simulateRun(scenario({ cells: 8 }));
      const codec = new SimulationLoRaCodec();
      const firstHalf = run.slice(0, 8); // 4 readings + 4 statuses

      let db = initDatabase(file, 'field', T0);
      addTestRobot(db);
      playBridge(session(db, codec).s, toBridgeStream(firstHalf, codec), 5);
      db.close();

      // Restart: new process, new session. The robot replays everything still un-ACKed plus the rest.
      db = initDatabase(file, 'field', T0);
      const { s } = session(db, codec);
      expect(s.pendingDownlinks).toBe(0);
      playBridge(s, toBridgeStream(run, codec), 6);

      expect(count(db, 'readings')).toBe(8);
      const readingOutbox = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE entity_type = 'reading'`).get();
      expect(readingOutbox?.n).toBe(8); // queued for the cloud exactly once each
      expect(countByState(db).synced).toBe(0); // nothing is labelled synced without a cloud confirmation
      db.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe('BridgeProtocolSession: write-before-ACK', () => {
  it('sends no ACK when the SQLite write fails, and the next copy is stored and ACKed', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    db.exec(`CREATE TRIGGER test_disk_full BEFORE INSERT ON readings BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
    const stream = toBridgeStream(simulateRun(scenario({ cells: 1 })).filter((t) => t.message.kind === 'READING'), codec);

    const failed = playBridge(s, stream, 1);
    expect(events(failed).map((e) => e.type)).toEqual(['storage_failed']);
    expect(written(failed)).toEqual([]);
    expect(count(db, 'readings')).toBe(0);

    db.exec('DROP TRIGGER test_disk_full');
    const retried = playBridge(s, stream, 2);
    expect(acksIn(written(retried), codec).map((a) => a.result)).toEqual(['STORED']);
  });

  it('queues the ACK only after storage, then transmits only inside the robot response window', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db, new SimulationLoRaCodec(), { ...TEST_ONLY_SCHEDULE, responseWindowDelayMs: 100, responseWindowMs: 200 });
    const stream = toBridgeStream(simulateRun(scenario({ cells: 1 })).filter((t) => t.message.kind === 'READING'), codec);

    const atReceipt = s.receive(stream, T0);
    expect(count(db, 'readings')).toBe(1);
    expect(written([atReceipt])).toEqual([]); // stored, window not yet open
    expect(written([s.poll(new Date(T0.getTime() + 100))]).map((f) => f.message.type)).toEqual(['LORA_TX']);
  });

  it('stays silent for an unknown robot and NACKs a run-type mismatch without storing it', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const stranger = playBridge(s, toBridgeStream(simulateRun(scenario({ robotId: 'SOMEONE-ELSE', cells: 1 })), codec), 1);
    expect(written(stranger)).toEqual([]);

    playBridge(s, toBridgeStream(simulateRun(scenario({ cells: 1 })), codec), 2);
    const mismatch = playBridge(s, toBridgeStream(simulateRun(scenario({ cells: 1, runType: 'verification' })), codec), 3);
    expect(acksIn(written(mismatch), codec).map((a) => a.result)).toEqual(['REJECTED']);
    expect(count(db, 'readings')).toBe(1);
  });
});

describe('BridgeProtocolSession: malformed and hostile input', () => {
  const rx = (radioPayload: Uint8Array, frameId = 1) =>
    encodeSerialFrame({ frameId, message: { type: 'LORA_RX', rssiDbm: -100, snrTenthsDb: 0, bridgeUptimeMs: 0, radioPayload } });

  it('with the unsigned placeholder codec, rejects every radio packet and stores nothing', () => {
    const db = memoryDb();
    addTestRobot(db);
    const s = new BridgeProtocolSession({ db, codec: UNSIGNED_LORA_CODEC, schedule: TEST_ONLY_SCHEDULE, hostBuildId: 'test-host' });
    const out = s.receive(rx(Uint8Array.of(1, 2, 3)), T0);
    expect(out.events).toEqual([{ type: 'lora_rejected', code: 'SPEC_NOT_SIGNED_OFF', rssiDbm: -100 }]);
    expect(count(db, 'readings')).toBe(0);
  });

  it('answers corrupted serial frames with FRAME_REJECTED and keeps processing the stream', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const good = toBridgeStream(simulateRun(scenario({ cells: 1 })).filter((t) => t.message.kind === 'READING'), codec);
    const corrupted = rx(Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9), 3).slice();
    corrupted[corrupted.indexOf(9)] = 8; // flip a payload data byte (not a COBS code byte)
    const out = playBridge(s, new Uint8Array([...corrupted, ...good]), 1);

    expect(events(out).filter((e) => e.type === 'serial_error')).toEqual([{ type: 'serial_error', code: 'BAD_CRC', frameId: null }]);
    const rejected = written(out).filter((f) => f.message.type === 'FRAME_REJECTED');
    expect(rejected.map((f) => f.message)).toEqual([{ type: 'FRAME_REJECTED', refFrameId: null, reason: 'BAD_CRC' }]);
    expect(count(db, 'readings')).toBe(1);
  });

  it('rejects radio packets with a version mismatch, unknown kind, invalid fields, or the wrong direction', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const [reading] = simulateRun(scenario({ cells: 1 }));
    const valid = reading?.message;
    const cases = [
      codec.encodeRaw({ ...valid, contractVersion: 2 }),
      codec.encodeRaw({ ...valid, kind: 'SELF_DESTRUCT' }),
      codec.encodeRaw({ ...valid, ph: -1 }),
      codec.encodeRaw({ contractVersion: 1, kind: 'STORAGE_ACK', robotId: 'TEST-ROBOT-1', messageId: 1, runId: 'X', cellIndex: 0, seq: 0, result: 'STORED' }),
      Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    ];
    const codes = cases.flatMap((p, i) => s.receive(rx(p, i), T0).events).map((e) => (e.type === 'lora_rejected' ? e.code : e.type));
    expect(codes).toEqual(['VERSION_MISMATCH', 'UNKNOWN_KIND', 'INVALID_FIELD', 'WRONG_DIRECTION', 'CODEC_ERROR']);
    expect(count(db, 'readings')).toBe(0);
  });

  it('refuses an oversized radio payload at the serial layer; the maximum size still reaches the codec', () => {
    const db = memoryDb();
    const { s } = session(db);
    // Hand-built, because the encoder refuses to produce it: LORA_RX with 8 metadata bytes + 256 radio bytes.
    const payload = new Uint8Array(8 + LORA_MAX_PAYLOAD_BYTES + 1).fill(1);
    const raw = new Uint8Array(6 + payload.length + 2);
    const view = new DataView(raw.buffer);
    raw.set([1, 0x10]);
    view.setUint16(2, 5, true);
    view.setUint16(4, payload.length, true);
    raw.set(payload, 6);
    view.setUint16(6 + payload.length, crc16CcittFalse(raw, 0, 6 + payload.length), true);
    const oversized = s.receive(new Uint8Array([...cobsEncode(raw), 0]), T0);
    expect(oversized.events).toEqual([{ type: 'serial_error', code: 'MALFORMED_PAYLOAD', frameId: 5 }]);
    expect(written([oversized]).map((f) => f.message)).toEqual([{ type: 'FRAME_REJECTED', refFrameId: 5, reason: 'MALFORMED_PAYLOAD' }]);

    const atLimit = s.receive(rx(new Uint8Array(LORA_MAX_PAYLOAD_BYTES).fill(1)), T0);
    expect(atLimit.events).toEqual([{ type: 'lora_rejected', code: 'CODEC_ERROR', rssiDbm: -100 }]);
  });

  it('flags frames the bridge should never send and LORA_TX_RESULTs that match nothing', () => {
    const db = memoryDb();
    const { s } = session(db);
    const out = s.receive(
      new Uint8Array([
        ...encodeSerialFrame({ frameId: 1, message: { type: 'LORA_TX', radioPayload: Uint8Array.of(1) } }),
        ...encodeSerialFrame({ frameId: 2, message: { type: 'LORA_TX_RESULT', refFrameId: 777, result: 'SENT' } }),
        ...encodeSerialFrame({ frameId: 3, message: { type: 'HELLO', role: 'bridge', buildId: 'bridge-0.1' } }),
      ]),
      T0,
    );
    expect(out.events).toEqual([
      { type: 'unexpected_frame', frameType: 'LORA_TX' },
      { type: 'unexpected_frame', frameType: 'LORA_TX_RESULT' },
      { type: 'bridge_hello', buildId: 'bridge-0.1' },
    ]);
  });

  it('re-sends an ACK whose transmission failed at the next opportunity', () => {
    const db = memoryDb();
    addTestRobot(db);
    const { codec, s } = session(db);
    const stream = toBridgeStream(simulateRun(scenario({ cells: 1 })).filter((t) => t.message.kind === 'READING'), codec);
    const [tx] = written([s.receive(stream, T0)]);
    expect(tx?.message.type).toBe('LORA_TX');
    const busy = s.receive(encodeSerialFrame({ frameId: 9, message: { type: 'LORA_TX_RESULT', refFrameId: tx?.frameId ?? 0, result: 'CHANNEL_BUSY_RX' } }), T0);
    expect(busy.events).toContainEqual({ type: 'tx_result', key: 'ack:TEST-ROBOT-1:SIM-RUN-1:0:0', outcome: 'retry_later' });
    // The window budget (1) is spent; the next uplink (the robot's retry) opens a new window.
    const retry = playBridge(s, stream, 3);
    expect(acksIn(written(retry), codec).map((a) => a.result)).toEqual(['DUPLICATE']);
    expect(s.pendingDownlinks).toBe(0);
  });

  it('greets the bridge on open with a resync delimiter and HELLO', () => {
    const { s } = session(memoryDb());
    const [resync, hello] = s.open();
    expect(Array.from(resync ?? [])).toEqual([0]);
    expect(written([{ outgoing: [hello ?? new Uint8Array()], events: [] }]).map((f) => f.message)).toEqual([
      { type: 'HELLO', role: 'host', buildId: 'test-host' },
    ]);
  });
});
