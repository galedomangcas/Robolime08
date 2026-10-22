import { afterEach, describe, expect, it } from 'vitest';

import { seedDemo } from '../seed/demo';
import { T0, tempDir } from '../test/helpers';
import { backupDatabase, BackupError } from './backup';
import { initDatabase } from './init';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('backupDatabase', () => {
  it('produces a verified copy that restores with identical records', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const live = initDatabase(tmp.path('live.sqlite'), 'demo', T0);
    seedDemo(live);
    backupDatabase(live, tmp.path('backup.sqlite'));

    const restored = initDatabase(tmp.path('backup.sqlite'), 'demo', T0);
    const snapshot = (db: typeof live) =>
      JSON.stringify(['readings', 'sync_outbox', 'reading_receipts'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    expect(snapshot(restored)).toBe(snapshot(live));
    live.close();
    restored.close();
  });

  it('refuses to overwrite an existing file', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const live = initDatabase(tmp.path('live.sqlite'), 'field', T0);
    backupDatabase(live, tmp.path('b.sqlite'));
    expect(() => backupDatabase(live, tmp.path('b.sqlite'))).toThrow(BackupError);
    live.close();
  });
});
