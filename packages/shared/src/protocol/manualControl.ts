/**
 * Manual control of RoboLime over LoRa (decision D57, project owner, 2026-10-29).
 *
 * D57 lifts the observe-only rule for MANUAL CONTROL ONLY: an operator on the
 * field laptop can drive the robot, run the pump and move the linear actuator.
 * It uses the text commands the Sprint 1 firmware already understands
 * (`Robot Code/Final Code`), sent as one line over USB serial to the gateway
 * LoRa bridge, which relays it to the robot and waits for `ACK:<command>`.
 *
 * Online (D58): the Vercel site and Android app queue the same lines in
 * hosted Supabase (`manual_commands`); the gateway relays them while it has
 * internet. Commands older than MANUAL_CLOUD_MAX_AGE_SECONDS are never sent.
 *
 * Separate from the binary D21 contract (`manualCommands.ts`), which stays
 * disabled: its wire format and limits are still unsigned.
 *
 * Safety: the robot firmware stops every output started by a LoRa command
 * after MANUAL_AUTO_STOP_MS, whether or not a STOP arrives. The 5 s value was
 * chosen by the project owner and still needs the hardware owner's sign-off
 * (OPEN_ITEMS #22). Dosing runs, navigation and field decisions stay on the robot.
 */

/** Committed D57 decision. The gateway refuses manual-control routes when false. */
export const MANUAL_CONTROL_APPROVED: boolean = true;

export const MANUAL_CONTROL_DECISION = 'D57';

/** Robot-enforced limit for every output started by a LoRa command (drive, pump, actuator). */
export const MANUAL_AUTO_STOP_MS = 5_000;

/** D58: an online command not picked up by the gateway within this many seconds expires unsent. */
export const MANUAL_CLOUD_MAX_AGE_SECONDS = 10;

/** D58: the online relay counts as offline when the gateway has not polled for this long. */
export const MANUAL_RELAY_STALE_SECONDS = 10;

/** BTS7960 PWM duty range accepted by `finalcode_sprint1_esp.ino`. */
export const MANUAL_PWM_MIN = 0;
export const MANUAL_PWM_MAX = 255;

export const MANUAL_DRIVE_DIRECTIONS = ['FORWARD', 'REVERSE', 'LEFT', 'RIGHT'] as const;
export type ManualDriveDirection = (typeof MANUAL_DRIVE_DIRECTIONS)[number];

export type ManualControlCommand =
  | { type: 'STOP_ALL' }
  | { type: 'DRIVE'; direction: ManualDriveDirection; pwm: number }
  | { type: 'ACTUATOR'; action: 'EXTEND' | 'RETRACT' }
  | { type: 'PUMP'; action: 'ON' | 'OFF' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses an untrusted request body field; null when it is not exactly one valid command. */
export function parseManualControlCommand(value: unknown): ManualControlCommand | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'STOP_ALL':
      return { type: 'STOP_ALL' };
    case 'DRIVE': {
      const { direction, pwm } = value;
      if (typeof direction !== 'string' || !(MANUAL_DRIVE_DIRECTIONS as readonly string[]).includes(direction)) return null;
      if (typeof pwm !== 'number' || !Number.isInteger(pwm) || pwm < MANUAL_PWM_MIN || pwm > MANUAL_PWM_MAX) return null;
      return { type: 'DRIVE', direction: direction as ManualDriveDirection, pwm };
    }
    case 'ACTUATOR':
      return value.action === 'EXTEND' || value.action === 'RETRACT' ? { type: 'ACTUATOR', action: value.action } : null;
    case 'PUMP':
      return value.action === 'ON' || value.action === 'OFF' ? { type: 'PUMP', action: value.action } : null;
    default:
      return null;
  }
}

/** The exact text line sent to the bridge; the robot replies `ACK:<line>`. */
export function manualControlLine(command: ManualControlCommand): string {
  switch (command.type) {
    case 'STOP_ALL':
      return 'STOP_ALL';
    case 'DRIVE':
      return `DRIVE:${command.direction}:${command.pwm}`;
    case 'ACTUATOR':
      return `ACTUATOR_${command.action}`;
    case 'PUMP':
      return `PUMP_${command.action}`;
  }
}

/** Inverse of {@link manualControlLine}; null for anything else (cloud rows, D58). */
export function parseManualControlLine(line: string): ManualControlCommand | null {
  if (line === 'STOP_ALL') return { type: 'STOP_ALL' };
  if (line === 'ACTUATOR_EXTEND' || line === 'ACTUATOR_RETRACT') return { type: 'ACTUATOR', action: line === 'ACTUATOR_EXTEND' ? 'EXTEND' : 'RETRACT' };
  if (line === 'PUMP_ON' || line === 'PUMP_OFF') return { type: 'PUMP', action: line === 'PUMP_ON' ? 'ON' : 'OFF' };
  const drive = /^DRIVE:(FORWARD|REVERSE|LEFT|RIGHT):(0|[1-9]\d{0,2})$/.exec(line);
  if (!drive) return null;
  return parseManualControlCommand({ type: 'DRIVE', direction: drive[1], pwm: Number(drive[2]) });
}

/** Plain-English label for the app. */
export function describeManualControlCommand(command: ManualControlCommand): string {
  switch (command.type) {
    case 'STOP_ALL':
      return 'Stop everything';
    case 'DRIVE': {
      const name = { FORWARD: 'Forward', REVERSE: 'Reverse', LEFT: 'Turn left', RIGHT: 'Turn right' }[command.direction];
      return `${name} (PWM ${command.pwm})`;
    }
    case 'ACTUATOR':
      return command.action === 'EXTEND' ? 'Extend actuator' : 'Retract actuator';
    case 'PUMP':
      return command.action === 'ON' ? 'Pump on' : 'Pump off';
  }
}
