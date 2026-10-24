import {
  ERROR_FLAG_BITS,
  ROBOT_STATE_BY_CODE,
  type ErrorFlag,
  type RobotState,
  type RobotStateCode,
} from '../domain/robot';

/** Maps a status byte to a state; null for codes outside the documented range. */
export function robotStateFromCode(code: number): RobotState | null {
  return Object.hasOwn(ROBOT_STATE_BY_CODE, code)
    ? ROBOT_STATE_BY_CODE[code as RobotStateCode]
    : null;
}

/** Decodes the error-flags byte into named flags, in bit order. */
export function decodeErrorFlags(bits: number): ErrorFlag[] {
  return (Object.keys(ERROR_FLAG_BITS) as ErrorFlag[]).filter(
    (flag) => (bits & (1 << ERROR_FLAG_BITS[flag])) !== 0,
  );
}

export const ERROR_FLAG_LABELS: Readonly<Record<ErrorFlag, string>> = {
  LIME_EMPTY: 'Lime tank empty',
  BATTERY_CRITICAL: 'Battery critical',
  PROBE_FAULT: 'Soil probe fault',
  GPS_NO_FIX: 'No GPS fix',
  PUMP_FAULT: 'Pump fault',
  DRIVE_FAULT: 'Drive motor fault',
  NANO_LINK_LOST: 'Nano link lost',
  STORAGE_FAULT: 'Storage fault',
};

export interface CellProgress {
  completed: number;
  total: number;
  /** Whole percent, rounded down so a run never shows 100% before it finishes. */
  percent: number;
}

/** Returns null for inconsistent counts rather than showing a misleading figure. */
export function cellProgress(completed: number, total: number): CellProgress | null {
  if (
    !Number.isInteger(completed) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    completed < 0 ||
    completed > total
  ) {
    return null;
  }
  return { completed, total, percent: Math.floor((completed / total) * 100) };
}

export interface RobotStateLabelInput {
  state: RobotState;
  errorFlags: readonly ErrorFlag[];
  cellsCompleted: number;
  totalCells: number;
}

/** User-facing label for the monitoring strip. */
export function robotStateLabel(input: RobotStateLabelInput): string {
  switch (input.state) {
    case 'INITIALIZING':
      return 'Starting up';
    case 'IDLE':
      return 'Ready';
    case 'WORKING': {
      const progress = cellProgress(input.cellsCompleted, input.totalCells);
      return progress
        ? `Working: ${progress.completed} of ${progress.total} cells (${progress.percent}%)`
        : 'Working (cell progress unavailable)';
    }
    case 'PAUSED':
      return 'Paused';
    case 'COMPLETED':
      return 'Run complete';
    case 'ERROR':
      return input.errorFlags.length > 0
        ? `Error: ${input.errorFlags.map((flag) => ERROR_FLAG_LABELS[flag]).join(', ')}`
        : 'Error: reason not reported';
    case 'MANUAL':
      return 'Manual control';
  }
}

export interface ProgressFreeStateLabelInput {
  state: RobotState;
  errorFlags: readonly ErrorFlag[];
}

/**
 * The same wording as `robotStateLabel`, but it never mentions cells or
 * progress: WORKING is just "Working". Used where cell-progress display is out
 * of scope (D33); it takes no cell counts, so none can leak into the label.
 */
export function robotStateLabelWithoutProgress(input: ProgressFreeStateLabelInput): string {
  if (input.state === 'WORKING') return 'Working';
  return robotStateLabel({ state: input.state, errorFlags: input.errorFlags, cellsCompleted: 0, totalCells: 0 });
}
