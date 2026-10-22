import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './connection';
import {
  DatabaseMissingError,
  DatabasePurposeError,
  getDatabasePurpose,
  initDatabase,
  openExistingDatabase,
} from './init';
import { loadMigrations, migrate, MigrationError } from './migrate';
import { T0, tempDir } from '../test/helpers';

const EXPECTED_TABLES = [
  'field_cells', 'field_selections', 'fields', 'gateway_settings', 'local_sessions', 'pairing_credentials',
  'reading_receipts', 'readings', 'recommendation_scores', 'recommendations', 'robot_status_reports', 'robots',
  'rule_crops', 'rule_seasonal_weather_defaults', 'rule_seasons', 'rule_sets', 'rule_suitability_ranges', 'runs',
  'schema_migrations', 'sync_outbox',
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('migrate', () => {
  it('creates the full schema on an empty database', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db, undefined, T0).applied).toEqual([1]);
    const tables = db
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(EXPECTED_TABLES);
    expect(db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'view'`).all().map((r) => r.name)).toEqual([
      'robot_latest_status',
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('is a no-op when re-run', () => {
    const db = openDatabase(':memory:');
    migrate(db, undefined, T0);
    expect(migrate(db, undefined, T0).applied).toEqual([]);
  });

  it('enables foreign keys and durable settings on every connection', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const db = openDatabase(tmp.path('gw.sqlite'));
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    db.close();
  });

  it('refuses to run when an applied migration file was modified', () => {
    const db = openDatabase(':memory:');
    const migrations = loadMigrations();
    migrate(db, migrations, T0);
    const tampered = migrations.map((m) => ({ ...m, checksum: 'different' }));
    expect(() => migrate(db, tampered, T0)).toThrow(MigrationError);
  });

  it('refuses a database migrated by a newer build', () => {
    const db = openDatabase(':memory:');
    migrate(db, undefined, T0);
    db.prepare(`INSERT INTO schema_migrations VALUES (99, 'future', 'x', '2026-01-01T00:00:00.000Z')`).run();
    expect(() => migrate(db, undefined, T0)).toThrow(/newer build/);
  });

  it('rolls back a failing migration completely', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const dir = tmp.path('migrations');
    mkdirSync(dir);
    writeFileSync(`${dir}/0001_ok.sql`, 'CREATE TABLE a (x INTEGER) STRICT;');
    writeFileSync(`${dir}/0002_broken.sql`, 'CREATE TABLE b (x INTEGER) STRICT; INSERT INTO missing VALUES (1);');
    const db = openDatabase(':memory:');
    expect(() => migrate(db, loadMigrations(dir), T0)).toThrow();
    expect(db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'b'`).get()).toBeUndefined();
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
  });

  it('normalises CRLF line endings so Windows checkouts keep the same checksum', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const lf = tmp.path('lf');
    const crlf = tmp.path('crlf');
    mkdirSync(lf);
    mkdirSync(crlf);
    writeFileSync(`${lf}/0001_x.sql`, 'CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);\n');
    writeFileSync(`${crlf}/0001_x.sql`, 'CREATE TABLE a (x INTEGER);\r\nCREATE TABLE b (y INTEGER);\r\n');
    expect(loadMigrations(lf)[0]?.checksum).toBe(loadMigrations(crlf)[0]?.checksum);
  });

  it('rejects gaps in migration numbering', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const dir = tmp.path('gap');
    mkdirSync(dir);
    writeFileSync(`${dir}/0001_a.sql`, 'SELECT 1;');
    writeFileSync(`${dir}/0003_c.sql`, 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
  });
});

describe('initDatabase', () => {
  it('records the database purpose and never seeds data', () => {
    const db = initDatabase(':memory:', 'field', T0);
    expect(getDatabasePurpose(db)).toBe('field');
    expect(db.prepare('SELECT COUNT(*) AS n FROM robots').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 0 });
  });

  it('openExistingDatabase never creates a file for a mistyped path', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const missing = tmp.path('typo.sqlite');
    expect(() => openExistingDatabase(missing)).toThrow(DatabaseMissingError);
    expect(existsSync(missing)).toBe(false);
  });

  it('openExistingDatabase rejects a SQLite file that is not a gateway database', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const foreign = openDatabase(tmp.path('other.sqlite'));
    foreign.exec('CREATE TABLE unrelated (x INTEGER)');
    foreign.close();
    expect(() => openExistingDatabase(tmp.path('other.sqlite'))).toThrow(/not an initialised/);

    initDatabase(tmp.path('gw.sqlite'), 'field', T0).close();
    const db = openExistingDatabase(tmp.path('gw.sqlite'));
    expect(getDatabasePurpose(db)).toBe('field');
    db.close();
  });

  it('refuses to reopen a field database as a demo database', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('field.sqlite');
    initDatabase(path, 'field', T0).close();
    expect(() => initDatabase(path, 'demo', T0)).toThrow(DatabasePurposeError);
    const reopened = initDatabase(path, 'field', T0);
    expect(getDatabasePurpose(reopened)).toBe('field');
    reopened.close();
  });
});
