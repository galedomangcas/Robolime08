import {
  API_V1_ROUTES,
  MANUAL_AUTO_STOP_MS,
  manualControlLine,
  parseManualControlCommand,
  type ApiErrorBody,
  type ManualCommandResult,
  type ManualStatusResponse,
  type PairingResponse,
} from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import { createLocalApi, type ApiResponse } from '../api/localApi';
import { initDatabase } from '../db/init';
import { provisionPairingCredential } from '../pairing/sessions';
import { provisionRobot } from '../store/robots';
import { T0, TEST_ONLY_PAIRING_CODE } from '../test/helpers';
import type { LineTransport } from './lineTransport';
import { ManualControlLink, type LinkTimers } from './manualControlLink';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/** In-memory bridge: records written lines and lets the test print bridge output. */
class FakeBridge implements LineTransport {
  written: string[] = [];
  failOpen = false;
  failWrite = false;
  private onLine: ((line: string) => void) | null = null;
  private onClose: ((error: Error | null) => void) | null = null;

  open(onLine: (line: string) => void, onClose: (error: Error | null) => void): Promise<void> {
    if (this.failOpen) return Promise.reject(new Error('Access denied'));
    this.onLine = onLine;
    this.onClose = onClose;
    return Promise.resolve();
  }
  writeLine(line: string): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error('write failed'));
    this.written.push(line);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.onLine = null;
    return Promise.resolve();
  }
  print(line: string): void {
    this.onLine?.(line);
  }
  unplug(): void {
    this.onClose?.(null);
  }
}

/** Timers the test fires by hand. */
class ManualTimers implements LinkTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(ms: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function connectedLink(bridge = new FakeBridge(), timers = new ManualTimers()) {
  const link = new ManualControlLink({ transport: bridge, port: 'COM5', clock: () => NOW, timers, responseTimeoutMs: 8_000, reconnectMs: 5_000 });
  link.start();
  await flush();
  return { link, bridge, timers };
}

describe('manual-control command contract (D57)', () => {
  it('builds the exact firmware lines', () => {
    expect(manualControlLine({ type: 'STOP_ALL' })).toBe('STOP_ALL');
    expect(manualControlLine({ type: 'DRIVE', direction: 'FORWARD', pwm: 127 })).toBe('DRIVE:FORWARD:127');
    expect(manualControlLine({ type: 'DRIVE', direction: 'LEFT', pwm: 0 })).toBe('DRIVE:LEFT:0');
    expect(manualControlLine({ type: 'ACTUATOR', action: 'RETRACT' })).toBe('ACTUATOR_RETRACT');
    expect(manualControlLine({ type: 'PUMP', action: 'ON' })).toBe('PUMP_ON');
  });

  it('rejects anything that is not exactly one valid command', () => {
    for (const bad of [
      null,
      'STOP_ALL',
      { type: 'REBOOT' },
      { type: 'DRIVE', direction: 'UP', pwm: 100 },
      { type: 'DRIVE', direction: 'FORWARD', pwm: 256 },
      { type: 'DRIVE', direction: 'FORWARD', pwm: -1 },
      { type: 'DRIVE', direction: 'FORWARD', pwm: 12.5 },
      { type: 'DRIVE', direction: 'FORWARD' },
      { type: 'PUMP', action: 'DISPENSE' },
      { type: 'ACTUATOR' },
    ]) {
      expect(parseManualControlCommand(bad)).toBeNull();
    }
    expect(parseManualControlCommand({ type: 'DRIVE', direction: 'REVERSE', pwm: 255, extra: 'x' })).toEqual({
      type: 'DRIVE',
      direction: 'REVERSE',
      pwm: 255,
    });
  });

  it('uses the 5 s auto-stop chosen for D57', () => {
    expect(MANUAL_AUTO_STOP_MS).toBe(5_000);
  });
});

describe('ManualControlLink', () => {
  it('reports not-configured and refuses commands without a serial port', async () => {
    const link = new ManualControlLink({ transport: null, port: null });
    link.start();
    expect(link.status().bridge.state).toBe('not-configured');
    expect(await link.send({ type: 'STOP_ALL' })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('resolves acknowledged when the bridge prints the robot ACK for this line', async () => {
    const { link, bridge } = await connectedLink();
    expect(link.status().bridge).toEqual({ state: 'connected', port: 'COM5', detail: null });
    const sent = link.send({ type: 'DRIVE', direction: 'FORWARD', pwm: 127 });
    await flush();
    expect(bridge.written).toEqual(['DRIVE:FORWARD:127']);
    bridge.print('[Gateway] Sending command: DRIVE:FORWARD:127');
    bridge.print('[Gateway] Received --> ACK:PUMP_ON'); // a different line: ignored
    bridge.print('[Gateway] Received --> ACK:DRIVE:FORWARD:127\r');
    const result = await sent;
    expect(result).toEqual({
      ok: true,
      result: {
        command: { type: 'DRIVE', direction: 'FORWARD', pwm: 127 },
        line: 'DRIVE:FORWARD:127',
        outcome: 'acknowledged',
        sentAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      },
    });
    expect(link.status().recentCommands).toHaveLength(1);
    expect(link.status().bridgeLog.map((e) => e.line)).toEqual([
      '[Gateway] Sending command: DRIVE:FORWARD:127',
      '[Gateway] Received --> ACK:PUMP_ON',
      '[Gateway] Received --> ACK:DRIVE:FORWARD:127',
    ]);
  });

  it('resolves rejected on NACK and no-ack when the bridge gives up', async () => {
    const { link, bridge } = await connectedLink();
    const rejected = link.send({ type: 'PUMP', action: 'ON' });
    bridge.print('[Gateway] Received --> NACK:PUMP_ON');
    expect(await rejected).toMatchObject({ ok: true, result: { outcome: 'rejected' } });

    const lost = link.send({ type: 'PUMP', action: 'OFF' });
    bridge.print('[Gateway] Error: Command timed out. No acknowledgment from robot.');
    expect(await lost).toMatchObject({ ok: true, result: { outcome: 'no-ack' } });
  });

  it('times out on its own if the bridge never reports', async () => {
    const { link, timers } = await connectedLink();
    const sent = link.send({ type: 'ACTUATOR', action: 'EXTEND' });
    timers.fire(8_000);
    expect(await sent).toMatchObject({ ok: true, result: { outcome: 'no-ack' } });
  });

  it('a new command (STOP) supersedes the pending one at once', async () => {
    const { link, bridge } = await connectedLink();
    const drive = link.send({ type: 'DRIVE', direction: 'LEFT', pwm: 90 });
    const stop = link.send({ type: 'STOP_ALL' });
    expect(await drive).toMatchObject({ ok: true, result: { outcome: 'superseded' } });
    bridge.print('[Gateway] Received --> ACK:STOP_ALL');
    expect(await stop).toMatchObject({ ok: true, result: { outcome: 'acknowledged' } });
    expect(bridge.written).toEqual(['DRIVE:LEFT:90', 'STOP_ALL']);
    expect(link.status().recentCommands.map((r: ManualCommandResult) => r.line)).toEqual(['STOP_ALL', 'DRIVE:LEFT:90']);
  });

  it('marks the bridge disconnected on unplug, fails the pending command, and reconnects', async () => {
    const { link, bridge, timers } = await connectedLink();
    const sent = link.send({ type: 'STOP_ALL' });
    bridge.unplug();
    expect(await sent).toEqual({ ok: false, reason: 'unavailable' });
    expect(link.status().bridge.state).toBe('disconnected');
    expect(await link.send({ type: 'STOP_ALL' })).toEqual({ ok: false, reason: 'unavailable' });
    timers.fire(5_000);
    await flush();
    expect(link.status().bridge.state).toBe('connected');
  });

  it('reports why the port could not be opened, and a failed write as unavailable', async () => {
    const bridge = new FakeBridge();
    bridge.failOpen = true;
    const { link } = await connectedLink(bridge);
    expect(link.status().bridge).toMatchObject({ state: 'disconnected', port: 'COM5' });
    expect(link.status().bridge.detail).toContain('Access denied');

    const ok = await connectedLink();
    ok.bridge.failWrite = true;
    expect(await ok.link.send({ type: 'STOP_ALL' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(ok.link.status().bridge.state).toBe('disconnected');
  });

  it('strips control characters from bridge lines', async () => {
    const { link, bridge } = await connectedLink();
    bridge.print('\u001b[31mnoise\u0007');
    expect(link.status().bridgeLog.at(-1)?.line).toBe('[31mnoise');
  });
});

describe('manual-control API routes', () => {
  function setup(link: ManualControlLink | null) {
    const db = initDatabase(':memory:', 'demo', T0);
    const robot = provisionRobot(db, { sourceRobotId: 'R1', displayName: 'Robot', isSynthetic: true }, T0);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const api = createLocalApi({ db, clock: () => NOW, manualControl: link });
    const paired = api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: TEST_ONLY_PAIRING_CODE } });
    return { api, token: (paired.body as PairingResponse).sessionToken };
  }
  const code = (res: ApiResponse) => (res.body as ApiErrorBody).error.code;

  it('requires a paired session for both routes', async () => {
    const { api } = setup(null);
    expect(code(await api.handleAsync({ method: 'GET', path: API_V1_ROUTES.manualStatus }))).toBe('UNPAIRED');
    const post = await api.handleAsync({ method: 'POST', path: API_V1_ROUTES.manualCommands, authorization: 'Bearer nope', body: { command: { type: 'STOP_ALL' } } });
    expect(code(post)).toBe('INVALID_SESSION');
  });

  it('reports not-configured and answers 503 to commands without a bridge', async () => {
    const { api, token } = setup(null);
    const auth = `Bearer ${token}`;
    const status = await api.handleAsync({ method: 'GET', path: API_V1_ROUTES.manualStatus, authorization: auth });
    expect(status.status).toBe(200);
    expect((status.body as ManualStatusResponse).bridge.state).toBe('not-configured');
    const post = await api.handleAsync({ method: 'POST', path: API_V1_ROUTES.manualCommands, authorization: auth, body: { command: { type: 'STOP_ALL' } } });
    expect(post.status).toBe(503);
    expect(code(post)).toBe('MANUAL_BRIDGE_UNAVAILABLE');
  });

  it('validates the command before sending, and returns the robot ACK', async () => {
    const { link, bridge } = await connectedLink();
    const { api, token } = setup(link);
    const auth = `Bearer ${token}`;
    const bad = await api.handleAsync({ method: 'POST', path: API_V1_ROUTES.manualCommands, authorization: auth, body: { command: { type: 'DRIVE', direction: 'FORWARD', pwm: 999 } } });
    expect(code(bad)).toBe('BAD_REQUEST');
    expect(bridge.written).toEqual([]);
    expect(code(await api.handleAsync({ method: 'GET', path: API_V1_ROUTES.manualCommands, authorization: auth }))).toBe('METHOD_NOT_ALLOWED');

    const pending = api.handleAsync({ method: 'POST', path: API_V1_ROUTES.manualCommands, authorization: auth, body: { command: { type: 'PUMP', action: 'OFF' } } });
    await flush();
    bridge.print('[Gateway] Received --> ACK:PUMP_OFF');
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ line: 'PUMP_OFF', outcome: 'acknowledged' });
  });

  it('still serves every other route through handleAsync', async () => {
    const { api, token } = setup(null);
    const res = await api.handleAsync({ method: 'GET', path: API_V1_ROUTES.session, authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
});
