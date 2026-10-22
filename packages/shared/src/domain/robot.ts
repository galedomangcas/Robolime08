import type { RobotTimestamps } from './time';

/**
 * Robot status byte → state. The numeric mapping is a confirmed requirement
 * (CLAUDE.md §4). The byte's position inside the radio packet is NOT defined
 * here; that belongs to the signed-off packet specification.
 */
export const ROBOT_STATE_BY_CODE = {
  0: 'INITIALIZING',
  1: 'IDLE',
  2: 'WORKING',
  3: 'PAUSED',
  4: 'COMPLETED',
  5: 'ERROR',
  6: 'MANUAL',
} as const;

export type RobotStateCode = keyof typeof ROBOT_STATE_BY_CODE;
export type RobotState = (typeof ROBOT_STATE_BY_CODE)[RobotStateCode];

/** Error-flag bit positions (confirmed requirement, CLAUDE.md §4). */
export const ERROR_FLAG_BITS = {
  LIME_EMPTY: 0,
  BATTERY_CRITICAL: 1,
  PROBE_FAULT: 2,
  GPS_NO_FIX: 3,
  PUMP_FAULT: 4,
  DRIVE_FAULT: 5,
  NANO_LINK_LOST: 6,
  STORAGE_FAULT: 7,
} as const;

export type ErrorFlag = keyof typeof ERROR_FLAG_BITS;

/**
 * Components covered by the robot self-check. The bit positions of the
 * component-flags field are NOT yet specified (OPEN_ITEMS: packet spec), so
 * only the component names are defined here.
 */
export const ROBOT_COMPONENTS = [
  'SOIL_PROBE',
  'GPS',
  'PUMP',
  'DRIVE_MOTORS',
  'NANO_LINK',
  'LORA_RADIO',
  'FLASH_STORAGE',
  'BATTERY_SENSOR',
] as const;

export type RobotComponent = (typeof ROBOT_COMPONENTS)[number];

/** Result of one component's self-check as reported by the robot. */
export type ComponentCheck = 'ok' | 'fault' | 'unknown';

/**
 * One decoded status packet. Sent by the robot once after each cell and not
 * retried, so the latest status can lag real robot state by up to one cell.
 */
export interface RobotStatus {
  robotId: string;
  state: RobotState;
  errorFlags: readonly ErrorFlag[];
  componentChecks: Readonly<Record<RobotComponent, ComponentCheck>>;
  batteryVoltage: number;
  /**
   * Total lime dispensed in mL. This is the robot's COMMANDED volume, not an
   * independent measurement of liquid actually delivered.
   */
  totalLimeCommandedMl: number;
  cellsCompleted: number;
  totalCells: number;
  timestamps: RobotTimestamps;
}
