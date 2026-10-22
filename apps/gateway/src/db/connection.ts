import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

export type Database = DatabaseSync;
export type Row = Record<string, SQLOutputValue>;

/**
 * Opens the gateway database with the settings the durability contract relies
 * on: enforced foreign keys, WAL journaling, and synchronous=FULL so a
 * committed write survives power loss before the robot is acknowledged.
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = FULL');
  return db;
}

let savepointCounter = 0;

/**
 * Runs `fn` in a write transaction; rolls back and rethrows on any error.
 * Nested calls use a savepoint so they join the outer transaction atomically.
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) {
    const savepoint = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}

// Typed column accessors — rows from node:sqlite are untyped records.

export function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Column ${column} is not text`);
  }
  return value;
}

export function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return value === null ? null : str(row, column);
}

export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value !== 'number') {
    throw new TypeError(`Column ${column} is not numeric`);
  }
  return value;
}

export function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  return value === null ? null : num(row, column);
}

export function bool(row: Row, column: string): boolean {
  return num(row, column) === 1;
}
