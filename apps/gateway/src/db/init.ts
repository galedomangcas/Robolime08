import { existsSync } from 'node:fs';

import { openDatabase, str, type Database } from './connection';
import { migrate } from './migrate';
import { toCanonicalUtc } from './time';

/**
 * 'field' databases hold real operational records; 'demo' databases hold
 * synthetic fixtures only. The demo seeder refuses to touch a field database.
 */
export type DatabasePurpose = 'field' | 'demo';

const PURPOSE_KEY = 'database_purpose';

export class DatabasePurposeError extends Error {
  override name = 'DatabasePurposeError';
}

export function getDatabasePurpose(db: Database): DatabasePurpose | null {
  const row = db.prepare('SELECT value FROM gateway_settings WHERE key = ?').get(PURPOSE_KEY);
  if (row === undefined) {
    return null;
  }
  const value = str(row, 'value');
  if (value !== 'field' && value !== 'demo') {
    throw new DatabasePurposeError(`Unknown database purpose: ${value}`);
  }
  return value;
}

export class DatabaseMissingError extends Error {
  override name = 'DatabaseMissingError';
}

/**
 * Opens an EXISTING, initialised database. Operational commands (backup,
 * provisioning) use this so a mistyped path fails loudly instead of silently
 * creating — and then e.g. "backing up" — a new empty database.
 */
export function openExistingDatabase(path: string): Database {
  if (path === ':memory:' || !existsSync(path)) {
    throw new DatabaseMissingError(`No database at ${path}. Check the path, or create it with db:init first.`);
  }
  const db = openDatabase(path);
  let purpose: DatabasePurpose | null = null;
  try {
    purpose = getDatabasePurpose(db);
  } catch {
    purpose = null; // not a gateway database (e.g. no gateway_settings table)
  }
  if (purpose === null) {
    db.close();
    throw new DatabaseMissingError(`${path} is not an initialised RoboLime gateway database. Run db:init first.`);
  }
  return db;
}

/**
 * Opens (creating if needed) and migrates the gateway database, and records
 * its purpose. Never seeds data. Re-running is safe.
 */
export function initDatabase(path: string, purpose: DatabasePurpose, now: Date = new Date()): Database {
  const db = openDatabase(path);
  try {
    migrate(db, undefined, now);
    const existing = getDatabasePurpose(db);
    if (existing === null) {
      db.prepare('INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        PURPOSE_KEY,
        purpose,
        toCanonicalUtc(now),
      );
    } else if (existing !== purpose) {
      throw new DatabasePurposeError(
        `Database at ${path} is a '${existing}' database; refusing to open it as '${purpose}'.`,
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
