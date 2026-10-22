import { createHash } from 'node:crypto';

/**
 * Stable identity shared by SQLite and the Supabase mirror.
 *
 * Each mirrored row's primary key is a UUIDv5 derived from its natural key.
 * The same record therefore has the same ID locally and in the cloud, and a
 * gateway rebuilt from robot flash replay re-derives identical IDs instead of
 * creating cloud duplicates. Firmware identifiers (robot/run IDs) are treated
 * as opaque text — they are NOT assumed to be UUIDs.
 *
 * NEVER change this namespace or the name formats below: doing so would
 * change every ID and break idempotent cloud upserts.
 */
export const ROBOLIME_ID_NAMESPACE = '77911ce3-a0d7-4b34-80f4-1788ffa77ace';

/** Separator that cannot appear in the canonical parts (unit separator). */
const SEP = '\u001f';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new RangeError(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/** RFC 9562 UUID version 5 (SHA-1, name-based). */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableId(kind: string, ...parts: (string | number)[]): string {
  return uuidV5([kind, ...parts.map(String)].join(SEP), ROBOLIME_ID_NAMESPACE);
}

export const stableIds = {
  robot: (sourceRobotId: string) => stableId('robot', sourceRobotId),
  field: (robotId: string, fieldKey: string) => stableId('field', robotId, fieldKey),
  run: (robotId: string, sourceRunId: string) => stableId('run', robotId, sourceRunId),
  /** The reading idempotency key (run_id, cell_index, seq). */
  reading: (runId: string, cellIndex: number, seq: number) =>
    stableId('reading', runId, cellIndex, seq),
  statusReport: (robotId: string, robotReportedAt: string, state: string, cellsCompleted: number) =>
    stableId('status', robotId, robotReportedAt, state, cellsCompleted),
  ruleSet: (version: string) => stableId('rule-set', version),
  /** One recommendation per dosing run. */
  recommendation: (runId: string) => stableId('recommendation', runId),
};
