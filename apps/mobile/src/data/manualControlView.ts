import {
  describeManualControlCommand,
  type ManualBridgeState,
  type ManualCommandResult,
  type ManualControlCommand,
} from '@robolime/shared';

import { isSessionInvalid, type GatewayFailure } from './gatewayClient';

/** Display logic for the "Manual control of RoboLime" tab (D57). No UI code here. */

export type Tone = 'positive' | 'negative' | 'neutral';

/** Speed presets: BTS7960 PWM duty values in the firmware's 0–255 range. 127 is the firmware default. */
export const SPEED_PRESETS: readonly { label: string; pwm: number }[] = [
  { label: 'Slow', pwm: 90 },
  { label: 'Medium', pwm: 127 },
  { label: 'Fast', pwm: 200 },
];

export const DEFAULT_PWM = 127;

export function bridgeLabel(state: ManualBridgeState | null, port: string | null): { label: string; tone: Tone } {
  switch (state) {
    case 'connected':
      return { label: `LoRa bridge connected${port ? ` (${port})` : ''}`, tone: 'positive' };
    case 'connecting':
      return { label: 'Connecting to LoRa bridge…', tone: 'neutral' };
    case 'disconnected':
      return { label: 'LoRa bridge disconnected', tone: 'negative' };
    case 'not-configured':
      return { label: 'LoRa bridge not set up', tone: 'negative' };
    case null:
      return { label: 'Checking LoRa bridge…', tone: 'neutral' };
  }
}

/** What happened to a command, in words that do not overstate what is known. */
export function outcomeMessage(result: ManualCommandResult): { text: string; tone: Tone } {
  const name = describeManualControlCommand(result.command);
  switch (result.outcome) {
    case 'acknowledged':
      return { text: `${name}: the robot received it.`, tone: 'positive' };
    case 'rejected':
      return { text: `${name}: the robot did not recognise this command.`, tone: 'negative' };
    case 'no-ack':
      return {
        text: `${name}: no reply from the robot after 3 retries. It may not have received it; check the robot before trying again.`,
        tone: 'negative',
      };
    case 'superseded':
      return { text: `${name}: replaced by a newer command before the robot replied.`, tone: 'neutral' };
    case 'expired':
      return { text: `${name}: not sent. The field gateway did not pick it up within 10 s (it may be offline).`, tone: 'negative' };
    case 'unavailable':
      return { text: `${name}: not sent. The LoRa bridge was not connected to the field laptop.`, tone: 'negative' };
  }
}

export type ManualVia = 'laptop' | 'online';

export function sendFailureMessage(command: ManualControlCommand, failure: GatewayFailure, via: ManualVia = 'laptop'): string {
  const name = describeManualControlCommand(command);
  if (failure.kind === 'api' && failure.code === 'MANUAL_BRIDGE_UNAVAILABLE') {
    return `${name}: not sent. The LoRa bridge is not connected to this laptop.`;
  }
  if (isSessionInvalid(failure)) return via === 'online' ? `${name}: not sent. Sign in again.` : `${name}: not sent. Pair this device again.`;
  if (failure.kind === 'api' && failure.status === 429) return `${name}: not sent. Too many commands in the last minute; wait a moment.`;
  if (failure.kind === 'timeout') {
    return via === 'online'
      ? `${name}: no answer from the field gateway in time. The robot may or may not have received it.`
      : `${name}: the gateway did not answer in time. The robot may or may not have received it.`;
  }
  if (failure.kind === 'unreachable') {
    return via === 'online'
      ? `${name}: not sent. RoboLime online could not be reached; check this device's internet.`
      : `${name}: not sent. The field gateway on this laptop is not running.`;
  }
  return via === 'online' ? `${name}: RoboLime online could not queue this command.` : `${name}: the gateway could not send this command.`;
}

/** "12:03:04" in the laptop's local time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
