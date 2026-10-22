import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { str, type Database } from './connection';

export class BackupError extends Error {
  override name = 'BackupError';
}

/**
 * Writes a consistent, compacted copy of the live database to `destination`
 * using SQLite's `VACUUM INTO`. Safe while the gateway keeps running (WAL
 * readers see a stable snapshot). Refuses to overwrite an existing file, and
 * verifies the copy with `PRAGMA integrity_check`.
 */
export function backupDatabase(db: Database, destination: string): void {
  if (existsSync(destination)) {
    throw new BackupError(`Backup target already exists: ${destination}`);
  }
  db.prepare('VACUUM INTO ?').run(destination);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA integrity_check').get();
    if (result === undefined || str(result, 'integrity_check') !== 'ok') {
      throw new BackupError(`Backup failed integrity check: ${destination}`);
    }
  } finally {
    copy.close();
  }
}
