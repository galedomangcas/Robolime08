import {
  LORA_CONTRACT_VERSION,
  robotStateFromCode,
  type LoRaReadingMessage,
  type LoRaStatusMessage,
  type LoRaStorageAckMessage,
  type LoRaUplinkMessage,
  type StorageAckResult,
} from '@robolime/shared';

import type { Database } from '../db/connection';
import { IngestError, recordReading, type DecodedReading, type RecordOutcome } from '../store/readings';
import { recordStatusReport, type DecodedStatus } from '../store/status';

/** Maps the durable outcome of `recordReading` to what the robot is told. */
const ACK_RESULT: Readonly<Record<RecordOutcome, StorageAckResult>> = {
  inserted: 'STORED',
  duplicate: 'DUPLICATE',
  conflict: 'CONFLICT_RECORDED',
};

export function toDecodedReading(m: LoRaReadingMessage): DecodedReading {
  return {
    sourceRobotId: m.robotId,
    sourceRunId: m.runId,
    runType: m.runType,
    cellIndex: m.cellIndex,
    seq: m.seq,
    attemptCount: m.attemptCount,
    ph: m.ph,
    ec: m.ec,
    moisturePercent: m.moisturePercent,
    temperatureC: m.temperatureC,
    doseVolumeMl: m.doseVolumeMl,
    expectedPostCorrectionPh: m.expectedPostCorrectionPh,
    gps: m.gps,
    rawFlags: m.rawFlags,
    robotRecordedAt: m.robotRecordedAt,
  };
}

export function toDecodedStatus(m: LoRaStatusMessage): DecodedStatus {
  const state = robotStateFromCode(m.stateCode);
  // validateLoRaMessage already rejects undocumented codes; this guards direct callers.
  if (state === null) throw new RangeError(`undocumented robot state code ${m.stateCode}`);
  return {
    sourceRobotId: m.robotId,
    state,
    errorFlags: m.errorFlags,
    componentFlags: m.componentFlags,
    batteryVoltage: m.batteryVoltage,
    totalLimeCommandedMl: m.totalLimeCommandedMl,
    cellsCompleted: m.cellsCompleted,
    totalCells: m.totalCells,
    robotReportedAt: m.robotReportedAt,
  };
}

export type UplinkResult =
  /** Committed to SQLite; `ack` may now be transmitted. */
  | { kind: 'reading_stored'; outcome: RecordOutcome; readingId: string; ack: AckDraft }
  /** Not stored for a known reason; robot keeps the record in flash. `ack` is null for an unknown robot. */
  | { kind: 'reading_rejected'; reason: IngestError['code']; ack: AckDraft | null }
  /** Status packets are never retried, so they are never acknowledged. */
  | { kind: 'status_stored'; outcome: 'inserted' | 'duplicate' }
  | { kind: 'status_rejected'; reason: IngestError['code'] }
  /** Manual-command reports: handed to the (disabled) command tracker, nothing is stored yet. */
  | { kind: 'command_report'; message: Extract<LoRaUplinkMessage, { kind: 'COMMAND_ACK' | 'COMMAND_STATUS' }> };

/** A STORAGE_ACK without the gateway's message id, which the session assigns at transmit time. */
export type AckDraft = Omit<LoRaStorageAckMessage, 'messageId'>;

function ackFor(m: LoRaReadingMessage, result: StorageAckResult): AckDraft {
  return {
    contractVersion: LORA_CONTRACT_VERSION,
    kind: 'STORAGE_ACK',
    robotId: m.robotId,
    runId: m.runId,
    cellIndex: m.cellIndex,
    seq: m.seq,
    result,
  };
}

/**
 * Handles one validated uplink. The STORAGE_ACK is built only after
 * `recordReading` has returned, i.e. after the SQLite transaction committed
 * (`synchronous=FULL`). Any other failure (disk full, I/O error, locked
 * database) propagates to the caller and produces NO acknowledgement, so the
 * robot keeps the record in flash and retries.
 */
export function handleUplink(db: Database, message: LoRaUplinkMessage, receivedAt: Date): UplinkResult {
  switch (message.kind) {
    case 'READING':
      try {
        const stored = recordReading(db, toDecodedReading(message), receivedAt);
        return { kind: 'reading_stored', outcome: stored.outcome, readingId: stored.readingId, ack: ackFor(message, ACK_RESULT[stored.outcome]) };
      } catch (error) {
        if (!(error instanceof IngestError)) throw error;
        // Unknown robot: stay silent (it may be another team's radio on the channel).
        return { kind: 'reading_rejected', reason: error.code, ack: error.code === 'UNKNOWN_ROBOT' ? null : ackFor(message, 'REJECTED') };
      }
    case 'STATUS':
      try {
        return { kind: 'status_stored', outcome: recordStatusReport(db, toDecodedStatus(message), receivedAt).outcome };
      } catch (error) {
        if (!(error instanceof IngestError)) throw error;
        return { kind: 'status_rejected', reason: error.code };
      }
    case 'COMMAND_ACK':
    case 'COMMAND_STATUS':
      return { kind: 'command_report', message };
  }
}
