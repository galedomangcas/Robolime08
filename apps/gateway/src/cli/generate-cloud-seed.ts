/**
 * Regenerates supabase/seeds/demo_synthetic.sql from the SQLite demo fixture.
 *   npm run cloud-seed:generate -w @robolime/gateway
 */
import { writeFileSync } from 'node:fs';

import { initDatabase } from '../db/init';
import { CLOUD_SEED_PATH, renderCloudSeedSql } from '../seed/cloudSeedSql';
import { seedDemo } from '../seed/demo';

const db = initDatabase(':memory:', 'demo', new Date('2026-01-01T00:00:00.000Z'));
seedDemo(db);
writeFileSync(CLOUD_SEED_PATH, renderCloudSeedSql(db));
db.close();
process.stdout.write(`Wrote ${CLOUD_SEED_PATH}\n`);
