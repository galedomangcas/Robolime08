import type { OutboxEntityType } from '../store/outbox';
import { READ_BACK_COLUMN } from './cloudContract';
import type { CloudTable, CloudTableRows } from './cloudRows';
import { classifyFailure, verifyReadBack, type SyncOutcome } from './confirmation';
import { aggregateRequestBytes, SYNC_MAX_REQUEST_BYTES, type CloudTransport } from './postgrest';

/**
 * Uploads one outbox aggregate and decides its outcome (M6c):
 * 1. refuse an aggregate over the request budget (blocked, never split — C2);
 * 2. insert each table parents-first, ignoring primary-key duplicates;
 * 3. read every table back by the entity id and verify it (confirmation.ts).
 *
 * The tables of one aggregate are separate requests, so a failure part-way
 * leaves some rows in the cloud. That is safe: the entry is not confirmed,
 * and the next attempt re-inserts idempotently and verifies the whole
 * aggregate. (Single-request atomicity would need a cloud RPC — not added.)
 */
export async function uploadEntity(
  transport: CloudTransport,
  entityType: OutboxEntityType,
  entityId: string,
  local: readonly CloudTableRows[],
  maxRequestBytes = SYNC_MAX_REQUEST_BYTES,
): Promise<SyncOutcome> {
  if (aggregateRequestBytes(local) > maxRequestBytes) return { kind: 'permanent', reason: 'aggregate_too_large' };

  let insertedRows = 0;
  for (const { table, rows } of local) {
    const inserted = await transport.insert(table, rows);
    if (!inserted.ok) return classifyFailure('write', inserted.failure);
    insertedRows += inserted.value;
  }

  const remote = new Map<CloudTable, readonly unknown[]>();
  for (const { table } of local) {
    const read = await transport.select(table, READ_BACK_COLUMN[table], entityId);
    if (!read.ok) return classifyFailure('read', read.failure);
    remote.set(table, read.value);
  }
  return verifyReadBack(entityType, entityId, local, { rows: remote, insertedRows });
}
