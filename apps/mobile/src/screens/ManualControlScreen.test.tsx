import type { ManualCommandResult, ManualControlCommand, ManualStatusResponse } from '@robolime/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { FieldDataSource } from '../data/dataSource';
import type { GatewayResult } from '../data/gatewayClient';
import { outcomeMessage, sendFailureMessage } from '../data/manualControlView';
import type { Timers } from '../data/statusPoller';
import { ManualControlScreen } from './ManualControlScreen';

const AT = '2026-03-01T12:00:00.000Z';
const noTimers: Timers = { setTimeout: () => null, clearTimeout: () => undefined };

function status(state: ManualStatusResponse['bridge']['state'], detail: string | null = null): ManualStatusResponse {
  return { bridge: { state, port: state === 'not-configured' ? null : 'COM5', detail }, autoStopMs: 5_000, recentCommands: [], bridgeLog: [] };
}

function fakeControl(
  initial: ManualStatusResponse,
  reply: (command: ManualControlCommand) => GatewayResult<ManualCommandResult>,
  via: 'laptop' | 'online' = 'laptop',
) {
  const sent: ManualControlCommand[] = [];
  const control: NonNullable<FieldDataSource['manualControl']> = {
    via,
    status: async () => ({ ok: true, data: initial }),
    send: async (_token, command) => {
      sent.push(command);
      return reply(command);
    },
  };
  return { control, sent };
}

const ack = (command: ManualControlCommand): GatewayResult<ManualCommandResult> => ({
  ok: true,
  data: { command, line: 'x', outcome: 'acknowledged', sentAt: AT, finishedAt: AT },
});

describe('Manual control of RoboLime (D57)', () => {
  it('sends a drive command at the chosen speed and reports the robot ACK', async () => {
    const fake = fakeControl(status('connected'), ack);
    await render(<ManualControlScreen control={fake.control} token="t" timers={noTimers} onSessionInvalid={() => undefined} />);
    expect(await screen.findByText('LoRa bridge connected (COM5)')).toBeTruthy();
    expect(screen.getByText(/stops by itself after 5 s/)).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole('radio', { name: 'Fast speed, PWM 200' })));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forward' })));
    expect(fake.sent).toEqual([{ type: 'DRIVE', direction: 'FORWARD', pwm: 200 }]);
    expect(await screen.findByText('Forward (PWM 200): the robot received it.')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'STOP EVERYTHING' })));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Pump off' })));
    expect(fake.sent.slice(1)).toEqual([{ type: 'STOP_ALL' }, { type: 'PUMP', action: 'OFF' }]);
  });

  it('disables every command, STOP included, while the bridge is not connected, and says why', async () => {
    const fake = fakeControl(status('disconnected', 'Could not open COM5: Access denied'), ack);
    await render(<ManualControlScreen control={fake.control} token="t" timers={noTimers} onSessionInvalid={() => undefined} />);
    expect(await screen.findByText('Could not open COM5: Access denied')).toBeTruthy();
    for (const name of ['STOP EVERYTHING', 'Forward', 'Reverse', 'Turn left', 'Turn right', 'Extend actuator', 'Retract actuator', 'Pump on', 'Pump off']) {
      expect(screen.getByRole('button', { name }).props.accessibilityState).toMatchObject({ disabled: true });
    }
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Forward' })));
    expect(fake.sent).toEqual([]);
  });

  it('online (D58): warns that the robot may not be visible, hides the bridge log, and sends through the relay', async () => {
    const fake = fakeControl({ ...status('connected'), bridge: { state: 'connected', port: null, detail: null } }, ack, 'online');
    await render(<ManualControlScreen control={fake.control} token="t" timers={noTimers} onSessionInvalid={() => undefined} />);
    expect(await screen.findByText('LoRa bridge connected')).toBeTruthy();
    expect(screen.getByText(/You may not be able to see the robot/)).toBeTruthy();
    expect(screen.queryByText('Bridge messages')).toBeNull();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'STOP EVERYTHING' })));
    expect(fake.sent).toEqual([{ type: 'STOP_ALL' }]);
  });

  it('online (D58): explains a gateway that is offline', async () => {
    const detail = 'The field gateway was last online 5 min ago. It needs internet to relay commands to the robot.';
    const fake = fakeControl({ ...status('disconnected', detail), bridge: { state: 'disconnected', port: null, detail } }, ack, 'online');
    await render(<ManualControlScreen control={fake.control} token="t" timers={noTimers} onSessionInvalid={() => undefined} />);
    expect(await screen.findByText(detail)).toBeTruthy();
    expect(screen.getByText(/until the field gateway is online/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forward' }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('shows an unreachable gateway as not running', async () => {
    const control: NonNullable<FieldDataSource['manualControl']> = {
      via: 'laptop',
      status: async () => ({ ok: false, failure: { kind: 'unreachable' } }),
      send: async () => ({ ok: false, failure: { kind: 'unreachable' } }),
    };
    await render(<ManualControlScreen control={control} token="t" timers={noTimers} onSessionInvalid={() => undefined} />);
    expect(await screen.findByText('Field gateway not running')).toBeTruthy();
  });

  it('returns to pairing when the gateway rejects the session', async () => {
    const onSessionInvalid = jest.fn();
    const control: NonNullable<FieldDataSource['manualControl']> = {
      via: 'laptop',
      status: async () => ({ ok: false, failure: { kind: 'api', status: 401, code: 'SESSION_EXPIRED', retryAfterSeconds: null } }),
      send: async () => ({ ok: false, failure: { kind: 'unreachable' } }),
    };
    await render(<ManualControlScreen control={control} token="t" timers={noTimers} onSessionInvalid={onSessionInvalid} />);
    await act(async () => undefined);
    expect(onSessionInvalid).toHaveBeenCalledTimes(1);
  });
});

describe('manual control messages', () => {
  it('never claims more than the bridge reported', () => {
    const base = { line: 'PUMP_ON', sentAt: AT, finishedAt: AT, command: { type: 'PUMP', action: 'ON' } as const };
    expect(outcomeMessage({ ...base, outcome: 'no-ack' }).text).toMatch(/may not have received it/);
    expect(outcomeMessage({ ...base, outcome: 'rejected' }).tone).toBe('negative');
    expect(sendFailureMessage({ type: 'STOP_ALL' }, { kind: 'api', status: 503, code: 'MANUAL_BRIDGE_UNAVAILABLE', retryAfterSeconds: null })).toBe(
      'Stop everything: not sent. The LoRa bridge is not connected to this laptop.',
    );
    expect(sendFailureMessage({ type: 'STOP_ALL' }, { kind: 'timeout' })).toMatch(/may or may not have received it/);
  });
});
