import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { num, str, withTransaction, type Database } from './connection';
import { toCanonicalUtc } from './time';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** SHA-256 of the SQL with line endings normalised (Git may check out CRLF on Windows). */
  checksum: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ file, match }) => {
      const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/\r\n/g, '\n');
      return {
        version: Number(match[1]),
        name: match[2] ?? file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migrations must be numbered consecutively from 0001; found ${String(migration.version).padStart(4, '0')} at position ${index + 1}`,
      );
    }
  });
  return migrations;
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Refuses to run if an applied migration's file was edited, or if the
 * database was migrated by newer code than this build.
 */
export function migrate(
  db: Database,
  migrations: Migration[] = loadMigrations(),
  now: Date = new Date(),
): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const appliedRows = db
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all();
  const appliedChecksums = new Map(appliedRows.map((row) => [num(row, 'version'), str(row, 'checksum')]));

  const known = new Set(migrations.map((m) => m.version));
  for (const version of appliedChecksums.keys()) {
    if (!known.has(version)) {
      throw new MigrationError(
        `Database has migration ${version}, which this gateway build does not know. Use a newer build.`,
      );
    }
  }

  const applied: number[] = [];
  for (const migration of migrations) {
    const existing = appliedChecksums.get(migration.version);
    if (existing !== undefined) {
      if (existing !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.version} (${migration.name}) was modified after it was applied. Add a new migration instead.`,
        );
      }
      continue;
    }
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, migration.checksum, toCanonicalUtc(now));
    });
    applied.push(migration.version);
  }
  return { applied };
}
