import {
  LORA_CONTRACT_VERSION,
  SerialFrameIdCounter,
  encodeSerialFrame,
  type LoRaReadingMessage,
  type LoRaStatusMessage,
  type LoRaUplinkMessage,
  type RunType,
} from '@robolime/shared';

import type { SimulationLoRaCodec } from './simulationCodec';

/**
 * SYNTHETIC packet simulator. Generates one robot run as the radio would
 * carry it, with the delivery faults the gateway must survive. Values are
 * random but physically plausible; they are not field data.
 */

/** Small deterministic PRNG (mulberry32) so every scenario is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RunScenario {
  robotId: string;
  runId: string;
  runType: RunType;
  cells: number;
  startAt: Date;
  cellIntervalMs: number;
  seed: number;
  /** First transmission lost in the air; the robot retries (attempt 2). */
  lostFirstAttempt?: number[];
  /** Reading delivered but the ACK was lost; the robot resends it (a duplicate). */
  lostAck?: number[];
  /** Reading never arrives during the run (a gap); still in robot flash. */
  missing?: number[];
  /** Reading arrives only after the run's last status (late, out of order). */
  late?: number[];
  /** Shuffle delivery order within the run. */
  shuffle?: boolean;
}

export interface SimulatedTransmission {
  message: LoRaUplinkMessage;
  /** False when lost in the air (sent by the robot, never received). */
  delivered: boolean;
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export function simulateRun(s: RunScenario): SimulatedTransmission[] {
  const rand = seededRandom(s.seed);
  const has = (list: number[] | undefined, cell: number) => list?.includes(cell) ?? false;
  let messageId = 0;
  const inRun: SimulatedTransmission[] = [];
  const late: SimulatedTransmission[] = [];
  let limeMl = 0;

  for (let cell = 0; cell < s.cells; cell++) {
    const at = new Date(s.startAt.getTime() + cell * s.cellIntervalMs).toISOString();
    const ph = round(4.5 + rand() * 2.5, 2);
    const dose = s.runType === 'dosing' && ph < 6 ? round(10 + rand() * 60, 1) : 0;
    limeMl += dose;
    const base: Omit<LoRaReadingMessage, 'messageId' | 'attemptCount'> = {
      contractVersion: LORA_CONTRACT_VERSION,
      kind: 'READING',
      robotId: s.robotId,
      runId: s.runId,
      runType: s.runType,
      cellIndex: cell,
      seq: cell,
      ph,
      ec: round(0.1 + rand() * 0.5, 3),
      moisturePercent: round(15 + rand() * 25, 1),
      temperatureC: round(25 + rand() * 6, 1),
      doseVolumeMl: dose,
      expectedPostCorrectionPh: s.runType === 'dosing' ? (dose > 0 ? round(ph + 0.3 + rand() * 0.4, 2) : ph) : null,
      gps: { latitude: round(13.8 + rand() * 0.01, 6), longitude: round(120.6 + rand() * 0.01, 6) },
      rawFlags: s.runType === 'verification' ? 1 : 0,
      robotRecordedAt: at,
    };
    const reading = (attemptCount: number): LoRaReadingMessage => ({ ...base, attemptCount, messageId: messageId++ });

    const target = has(s.late, cell) ? late : inRun;
    if (has(s.missing, cell)) {
      inRun.push({ message: reading(1), delivered: false });
    } else if (has(s.lostFirstAttempt, cell)) {
      inRun.push({ message: reading(1), delivered: false });
      target.push({ message: reading(2), delivered: true });
    } else {
      target.push({ message: reading(1), delivered: true });
      if (has(s.lostAck, cell)) target.push({ message: reading(2), delivered: true });
    }

    const status: LoRaStatusMessage = {
      contractVersion: LORA_CONTRACT_VERSION,
      kind: 'STATUS',
      robotId: s.robotId,
      messageId: messageId++,
      stateCode: cell === s.cells - 1 ? 4 : 2,
      errorFlags: 0,
      componentFlags: null,
      batteryVoltage: round(12.6 - cell * 0.01, 2),
      totalLimeCommandedMl: round(limeMl, 1),
      cellsCompleted: cell + 1,
      totalCells: s.cells,
      robotReportedAt: at,
    };
    inRun.push({ message: status, delivered: true });
  }

  if (s.shuffle) {
    for (let i = inRun.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [inRun[i], inRun[j]] = [inRun[j] as SimulatedTransmission, inRun[i] as SimulatedTransmission];
    }
  }
  return [...inRun, ...late];
}

/** Wraps delivered transmissions as the gateway ESP32 would: one LORA_RX serial frame each. */
export function toBridgeStream(transmissions: SimulatedTransmission[], codec: SimulationLoRaCodec, frameIds = new SerialFrameIdCounter()): Uint8Array {
  const frames = transmissions
    .filter((t) => t.delivered)
    .map((t, i) =>
      encodeSerialFrame({
        frameId: frameIds.take(),
        message: { type: 'LORA_RX', rssiDbm: -90 - (i % 20), snrTenthsDb: 55, bridgeUptimeMs: i * 1_000, radioPayload: codec.encode(t.message) },
      }),
    );
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** Splits a byte stream into random-sized reads, as a USB serial driver would deliver it. */
export function chunkStream(stream: Uint8Array, seed: number, maxChunk = 64): Uint8Array[] {
  const rand = seededRandom(seed);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < stream.length; ) {
    const size = 1 + Math.floor(rand() * maxChunk);
    chunks.push(stream.subarray(i, i + size));
    i += size;
  }
  return chunks;
}
