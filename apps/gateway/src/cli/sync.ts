/**
 * One-way cloud sync worker (M6d): uploads the local outbox to the cloud mirror.
 *   npx tsx src/cli/sync.ts --db <file>          # run until Ctrl+C
 *   npx tsx src/cli/sync.ts --db <file> --once   # one pass over everything due, then exit
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the gateway environment
 * (never from the app). A demo database may only sync to a loopback target.
 * Output contains counts and fixed codes only — never record content or the key.
 * Not yet wired to an npm script (needs approval to change package.json).
 */
import { DatabaseMissingError, DatabasePurposeError, getDatabasePurpose, openExistingDatabase } from '../db/init';
import { systemClock } from '../db/time';
import { acquireLease, LeaseLostError, releaseLease } from '../store/syncLease';
import { parseCloudTarget, createPostgrestTransport, CloudTargetError } from '../sync/postgrest';
import { runSyncCycle, SYNC_BATCH_LIMIT, SyncWorker, type CycleCounts, type SyncEvent } from '../sync/worker';
import { fail, parseCli, resolveDbPath } from './args';

const values = parseCli({ db: { type: 'string' }, once: { type: 'boolean' } });

function describeCounts(c: CycleCounts): string {
  const stop = c.stoppedBy === null ? '' : `, stopped by ${c.stoppedBy}`;
  return `claimed ${c.claimed}: confirmed ${c.confirmed} (${c.duplicates} already in the cloud), retry ${c.retried}, outcome unknown ${c.ambiguous}, blocked ${c.blocked}, returned ${c.returned}${stop}`;
}

function describeEvent(e: SyncEvent): string {
  switch (e.event) {
    case 'lease_waiting':
      return `Another sync worker holds the lease until ${e.heldUntil}; waiting.`;
    case 'lease_acquired':
      return e.tookOver ? `Took over an expired lease; ${e.recovered} interrupted claims returned to pending.` : 'Sync lease acquired.';
    case 'lease_lost':
      return 'Sync lease lost; nothing was recorded for in-flight work. Re-acquiring.';
    case 'cycle':
      return `Cycle: ${describeCounts(e.counts)}`;
    case 'stopped':
      return `Stopped; ${e.returnedClaims} claims returned to pending.`;
  }
}

async function main(): Promise<void> {
  const db = openExistingDatabase(resolveDbPath(values.db)); // refuses a missing or non-gateway file
  try {
    const purpose = getDatabasePurpose(db);
    if (purpose === null) fail('The database has no recorded purpose; initialise it with npm run db:init.');
    const target = parseCloudTarget(
      { url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY },
      purpose,
    );
    if (values.once) {
      const result = acquireLease(db, systemClock);
      if (!result.acquired) fail(`Another sync worker holds the lease until ${result.heldUntil}.`);
      const transport = createPostgrestTransport(target);
      try {
        for (;;) {
          const counts = await runSyncCycle({ db, transport, lease: result.lease, clock: systemClock, random: Math.random });
          process.stdout.write(`${describeCounts(counts)}\n`);
          if (counts.stoppedBy !== null || counts.claimed < SYNC_BATCH_LIMIT) break;
        }
      } finally {
        try {
          releaseLease(db, result.lease, systemClock);
        } catch (error) {
          if (!(error instanceof LeaseLostError)) throw error;
        }
      }
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const worker = new SyncWorker({ db, target, onEvent: (e) => process.stdout.write(`${describeEvent(e)}\n`) });
    await worker.run(controller.signal);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const known = [CloudTargetError, LeaseLostError, DatabaseMissingError, DatabasePurposeError].some((k) => error instanceof k);
  // Other errors are not echoed: they could carry database or network detail.
  fail(known && error instanceof Error ? error.message : 'Sync failed unexpectedly.');
});
