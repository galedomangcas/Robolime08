import type { RunType } from '@robolime/shared';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { bool, str, strOrNull, type Database } from '../db/connection';
import { DatabaseMissingError, getDatabasePurpose, type DatabasePurpose } from '../db/init';

/**
 * Read-only access to a gateway database for the research exports (D32).
 * The connection is opened with SQLite's read-only flag, so an export can
 * never change the database; it does not use `openDatabase`, which sets
 * journal and durability pragmas meant for the writing gateway.
 */
export function openDatabaseReadOnly(path: string): { db: Database; purpose: DatabasePurpose } {
  if (path === ':memory:' || !existsSync(path)) {
    throw new DatabaseMissingError(`No database at ${path}. Check the path.`);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  let purpose: DatabasePurpose | null = null;
  try {
    purpose = getDatabasePurpose(db);
  } catch {
    purpose = null;
  }
  if (purpose === null) {
    db.close();
    throw new DatabaseMissingError(`${path} is not an initialised RoboLime gateway database.`);
  }
  return { db, purpose };
}

export class ExportError extends Error {
  override name = 'ExportError';
}

/** A run as the exports identify it: by the firmware's run id (and robot id when needed). */
export interface ExportRun {
  id: string;
  sourceRunId: string;
  runType: RunType;
  robotId: string;
  sourceRobotId: string;
  fieldId: string | null;
  isSynthetic: boolean;
}

/**
 * Finds a run by the firmware run id. Run ids are unique per robot, so a
 * gateway serving several robots may need `sourceRobotId` to disambiguate.
 */
export function resolveRun(db: Database, sourceRunId: string, sourceRobotId?: string): ExportRun {
  const rows = db
    .prepare(
      `SELECT r.id, r.source_run_id, r.run_type, r.robot_id, r.field_id, r.is_synthetic, b.source_robot_id
       FROM runs AS r JOIN robots AS b ON b.id = r.robot_id
       WHERE r.source_run_id = ? AND (? IS NULL OR b.source_robot_id = ?)
       ORDER BY b.source_robot_id`,
    )
    .all(sourceRunId, sourceRobotId ?? null, sourceRobotId ?? null);
  if (rows.length === 0) {
    throw new ExportError(
      `No run "${sourceRunId}"${sourceRobotId === undefined ? '' : ` for robot "${sourceRobotId}"`} in this database.`,
    );
  }
  if (rows.length > 1) {
    throw new ExportError(`Run "${sourceRunId}" exists for more than one robot; choose one with --robot <firmware robot id>.`);
  }
  const row = rows[0] as (typeof rows)[number];
  return {
    id: str(row, 'id'),
    sourceRunId: str(row, 'source_run_id'),
    runType: str(row, 'run_type') as RunType,
    robotId: str(row, 'robot_id'),
    sourceRobotId: str(row, 'source_robot_id'),
    fieldId: strOrNull(row, 'field_id'),
    isSynthetic: bool(row, 'is_synthetic'),
  };
}
