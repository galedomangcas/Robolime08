import {
  ROBOT_COMPONENTS,
  decodeErrorFlags,
  type ComponentCheck,
  type RobotComponent,
  type RobotState,
  type RobotStatus,
} from '@robolime/shared';

import { num, str, strOrNull, withTransaction, type Database, type Row } from '../db/connection';
import { stableIds } from '../db/ids';
import { toCanonicalUtc } from '../db/time';
import { IngestError } from './readings';
import { enqueue } from './outbox';
import { getRobotBySourceId } from './robots';

/** A status packet after decoding (Phase 3). No wire layout is assumed. */
export interface DecodedStatus {
  sourceRobotId: string;
  state: RobotState;
  /** Error-flags byte (bit meanings confirmed in CLAUDE.md §4). */
  errorFlags: number;
  /** Component self-check flags; bit layout pending packet spec, kept raw. */
  componentFlags: number | null;
  batteryVoltage: number;
  totalLimeCommandedMl: number;
  cellsCompleted: number;
  totalCells: number;
  robotReportedAt: string;
}

/** Stores a status report once; an identical re-delivery is a no-op. */
export function recordStatusReport(
  db: Database,
  input: DecodedStatus,
  receivedAt: Date,
): { outcome: 'inserted' | 'duplicate'; statusId: string } {
  const robotReportedAt = toCanonicalUtc(input.robotReportedAt);
  return withTransaction(db, () => {
    const robot = getRobotBySourceId(db, input.sourceRobotId);
    if (!robot) {
      throw new IngestError('UNKNOWN_ROBOT', `Robot ${input.sourceRobotId} is not provisioned on this gateway`);
    }
    const statusId = stableIds.statusReport(robot.id, robotReportedAt, input.state, input.cellsCompleted);
    const result = db
      .prepare(
        `INSERT INTO robot_status_reports (id, robot_id, state, error_flags, component_flags, battery_voltage,
           total_lime_commanded_ml, cells_completed, total_cells, robot_reported_at, gateway_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        statusId,
        robot.id,
        input.state,
        input.errorFlags,
        input.componentFlags,
        input.batteryVoltage,
        input.totalLimeCommandedMl,
        input.cellsCompleted,
        input.totalCells,
        robotReportedAt,
        toCanonicalUtc(receivedAt),
      );
    const inserted = Number(result.changes) === 1;
    if (inserted) {
      enqueue(db, 'status_report', statusId, receivedAt);
    }
    return { outcome: inserted ? 'inserted' : 'duplicate', statusId };
  });
}

/** Component bit layout is unconfirmed, so every component reports 'unknown' for now. */
function unknownComponentChecks(): Record<RobotComponent, ComponentCheck> {
  return Object.fromEntries(ROBOT_COMPONENTS.map((c) => [c, 'unknown'])) as Record<RobotComponent, ComponentCheck>;
}

function toRobotStatus(row: Row): RobotStatus {
  return {
    robotId: str(row, 'robot_id'),
    state: str(row, 'state') as RobotState,
    errorFlags: decodeErrorFlags(num(row, 'error_flags')),
    componentChecks: unknownComponentChecks(),
    batteryVoltage: num(row, 'battery_voltage'),
    totalLimeCommandedMl: num(row, 'total_lime_commanded_ml'),
    cellsCompleted: num(row, 'cells_completed'),
    totalCells: num(row, 'total_cells'),
    timestamps: {
      robotAt: str(row, 'robot_reported_at'),
      gatewayReceivedAt: str(row, 'gateway_received_at'),
      cloudSyncedAt: strOrNull(row, 'cloud_confirmed_at'),
    },
  };
}

/** Latest status by robot-side time, or null if the robot has never reported. */
export function getLatestStatus(db: Database, robotId: string): RobotStatus | null {
  const row = db
    .prepare(
      `SELECT s.*, o.cloud_confirmed_at
       FROM robot_latest_status AS s
       LEFT JOIN sync_outbox AS o ON o.entity_type = 'status_report' AND o.entity_id = s.id
       WHERE s.robot_id = ?`,
    )
    .get(robotId);
  return row === undefined ? null : toRobotStatus(row);
}
