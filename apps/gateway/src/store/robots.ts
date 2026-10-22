import type { Field, FieldCell, GpsFix } from '@robolime/shared';

import { bool, num, numOrNull, str, withTransaction, type Database, type Row } from '../db/connection';
import { stableIds } from '../db/ids';
import { toCanonicalUtc } from '../db/time';
import { enqueue } from './outbox';

export class ProvisioningError extends Error {
  override name = 'ProvisioningError';
}

export interface RobotRecord {
  id: string;
  sourceRobotId: string;
  displayName: string;
  isSynthetic: boolean;
}

export interface ProvisionRobotInput {
  sourceRobotId: string;
  displayName: string;
  isSynthetic: boolean;
}

/** Registers the robot this gateway serves. Idempotent for identical input. */
export function provisionRobot(db: Database, input: ProvisionRobotInput, now: Date): RobotRecord {
  const id = stableIds.robot(input.sourceRobotId);
  return withTransaction(db, () => {
    const existing = getRobot(db, id);
    if (existing) {
      if (existing.displayName !== input.displayName || existing.isSynthetic !== input.isSynthetic) {
        throw new ProvisioningError(`Robot ${input.sourceRobotId} is already provisioned with different details`);
      }
      return existing;
    }
    db.prepare(
      `INSERT INTO robots (id, source_robot_id, display_name, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.sourceRobotId, input.displayName, input.isSynthetic ? 1 : 0, toCanonicalUtc(now));
    enqueue(db, 'robot', id, now);
    return { id, ...input };
  });
}

function toRobot(row: Row): RobotRecord {
  return {
    id: str(row, 'id'),
    sourceRobotId: str(row, 'source_robot_id'),
    displayName: str(row, 'display_name'),
    isSynthetic: bool(row, 'is_synthetic'),
  };
}

export function getRobot(db: Database, robotId: string): RobotRecord | null {
  const row = db.prepare('SELECT * FROM robots WHERE id = ?').get(robotId);
  return row === undefined ? null : toRobot(row);
}

export function getRobotBySourceId(db: Database, sourceRobotId: string): RobotRecord | null {
  const row = db.prepare('SELECT * FROM robots WHERE source_robot_id = ?').get(sourceRobotId);
  return row === undefined ? null : toRobot(row);
}

export interface ProvisionFieldInput {
  robotId: string;
  fieldKey: string;
  name: string;
  locationLabel: string;
  areaSquareMeters: number | null;
  cellSizeMeters: number;
  totalCells: number | null;
  cells: FieldCell[];
  isSynthetic: boolean;
}

/**
 * Registers the robot's active field and its cells from operator-supplied
 * survey data. Idempotent: an already-provisioned field key is left unchanged.
 */
export function provisionField(db: Database, input: ProvisionFieldInput, now: Date): string {
  const id = stableIds.field(input.robotId, input.fieldKey);
  if (input.totalCells !== null && input.cells.some((c) => c.cellIndex >= (input.totalCells ?? 0))) {
    throw new ProvisioningError('A cell index is outside the declared total cell count');
  }
  return withTransaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM fields WHERE id = ?').get(id);
    if (exists) {
      return id;
    }
    db.prepare(
      `INSERT INTO fields (id, robot_id, field_key, name, location_label, area_m2, cell_size_m, total_cells, is_active, is_synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.robotId,
      input.fieldKey,
      input.name,
      input.locationLabel,
      input.areaSquareMeters,
      input.cellSizeMeters,
      input.totalCells,
      input.isSynthetic ? 1 : 0,
      toCanonicalUtc(now),
    );
    const insertCell = db.prepare(
      `INSERT INTO field_cells (field_id, cell_index, grid_row, grid_column, center_latitude, center_longitude)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const cell of input.cells) {
      insertCell.run(
        id,
        cell.cellIndex,
        cell.gridRow,
        cell.gridColumn,
        cell.center?.latitude ?? null,
        cell.center?.longitude ?? null,
      );
    }
    enqueue(db, 'field', id, now);
    return id;
  });
}

export interface ActiveField {
  field: Field;
  cells: FieldCell[];
}

export function getActiveField(db: Database, robotId: string): ActiveField | null {
  const row = db.prepare('SELECT * FROM fields WHERE robot_id = ? AND is_active = 1').get(robotId);
  if (row === undefined) {
    return null;
  }
  const fieldId = str(row, 'id');
  const cells = db
    .prepare('SELECT * FROM field_cells WHERE field_id = ? ORDER BY cell_index')
    .all(fieldId)
    .map((cell): FieldCell => {
      const latitude = numOrNull(cell, 'center_latitude');
      const longitude = numOrNull(cell, 'center_longitude');
      const center: GpsFix | null =
        latitude !== null && longitude !== null ? { latitude, longitude } : null;
      return {
        cellIndex: num(cell, 'cell_index'),
        gridRow: numOrNull(cell, 'grid_row'),
        gridColumn: numOrNull(cell, 'grid_column'),
        center,
      };
    });
  return {
    field: {
      id: fieldId,
      name: str(row, 'name'),
      locationLabel: str(row, 'location_label'),
      areaSquareMeters: numOrNull(row, 'area_m2'),
      cellSizeMeters: num(row, 'cell_size_m'),
      totalCells: numOrNull(row, 'total_cells'),
      isSynthetic: bool(row, 'is_synthetic'),
    },
    cells,
  };
}
