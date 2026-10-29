import type { ManualBridgeState, ManualCommandOutcome } from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import { CloudCredential } from '../sync/postgrest';
import { CloudRelay, createRelayRpc, type RelayRpc } from './cloudRelay';
import type { LineTransport } from './lineTransport';
import { ManualControlLink, type LinkTimers } from './manualControlLink';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ID = '0b5e1c9a-6f1d-4c55-9a4e-222222222222';

class Bridge implements LineTransport {
  written: string[] = [];
  private onLine: ((line: string) => void) | null = null;
  open(onLine: (line: string) => void): Promise<void> {
    this.onLine = onLine;
    return Promise.resolve();
  }
  writeLine(line: string): Promise<void> {
    this.written.push(line);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  print(line: string): void {
    this.onLine?.(line);
  }
}

/** Timers that never fire on their own. */
const idle: LinkTimers = { setTimeout: () => 0, clearTimeout: () => undefined };

class FakeRpc implements RelayRpc {
  queue: { id: string; line: string }[][] = [];
  takes: ManualBridgeState[] = [];
  finished: { id: string; status: string }[] = [];
  offline = false;
  take(_robot: string, bridgeState: ManualBridgeState) {
    this.takes.push(bridgeState);
    return Promise.resolve(this.offline ? null : (this.queue.shift() ?? []));
  }
  finish(id: string, status: Exclude<ManualCommandOutcome, 'expired'>) {
    this.finished.push({ id, status });
    return Promise.resolve(true);
  }
}

async function setup(connected = true) {
  const bridge = new Bridge();
  const link = new ManualControlLink({ transport: connected ? bridge : null, port: 'COM5', timers: idle });
  link.start();
  await flush();
  const rpc = new FakeRpc();
  const states: string[] = [];
  const relay = new CloudRelay({ rpc, link, sourceRobotId: 'R1', timers: idle, onStateChange: (s) => states.push(s) });
  return { bridge, link, rpc, relay, states };
}

describe('online manual control relay (D58)', () => {
  it('sends a taken command through the bridge and reports the robot ACK', async () => {
    const { bridge, rpc, relay, states } = await setup();
    rpc.queue.push([{ id: ID, line: 'DRIVE:LEFT:90' }]);
    await relay.poll();
    expect(rpc.takes).toEqual(['connected']);
    expect(states).toEqual(['online']);
    await flush();
    expect(bridge.written).toEqual(['DRIVE:LEFT:90']);
    bridge.print('[Gateway] Received --> ACK:DRIVE:LEFT:90');
    await relay.stop();
    expect(rpc.finished).toEqual([{ id: ID, status: 'acknowledged' }]);
  });

  it('does not wait for one command before taking the next: STOP supersedes a pending drive', async () => {
    const { bridge, rpc, relay } = await setup();
    rpc.queue.push([{ id: ID, line: 'DRIVE:FORWARD:200' }], [{ id: '1b5e1c9a-6f1d-4c55-9a4e-333333333333', line: 'STOP_ALL' }]);
    await relay.poll();
    await relay.poll();
    await flush();
    bridge.print('[Gateway] Received --> ACK:STOP_ALL');
    await relay.stop();
    expect(bridge.written).toEqual(['DRIVE:FORWARD:200', 'STOP_ALL']);
    expect(rpc.finished).toEqual([
      { id: ID, status: 'superseded' },
      { id: '1b5e1c9a-6f1d-4c55-9a4e-333333333333', status: 'acknowledged' },
    ]);
  });

  it('reports its bridge state in every poll and answers unavailable without a bridge', async () => {
    const { rpc, relay } = await setup(false);
    rpc.queue.push([{ id: ID, line: 'PUMP_ON' }]);
    await relay.poll();
    await relay.stop();
    expect(rpc.takes).toEqual(['not-configured']);
    expect(rpc.finished).toEqual([{ id: ID, status: 'unavailable' }]);
  });

  it('never sends a line it does not recognise', async () => {
    const { bridge, rpc, relay } = await setup();
    rpc.queue.push([{ id: ID, line: 'REBOOT' }]);
    await relay.poll();
    await relay.stop();
    expect(bridge.written).toEqual([]);
    expect(rpc.finished).toEqual([{ id: ID, status: 'rejected' }]);
  });

  it('reports going offline and back online without touching the bridge', async () => {
    const { bridge, rpc, relay, states } = await setup();
    rpc.offline = true;
    await relay.poll();
    rpc.offline = false;
    await relay.poll();
    await relay.stop();
    expect(states).toEqual(['offline', 'online']);
    expect(bridge.written).toEqual([]);
  });
});

describe('relay RPC over PostgREST', () => {
  const target = { origin: 'https://abcdefghijklmnopqrst.supabase.co', credential: new CloudCredential('service-role-key-test-only-0123456789'), isLoopback: false };

  it('calls the two RPCs with the service key and validates rows', async () => {
    const calls: { url: string; body: string; redirect?: string; auth?: string }[] = [];
    const rpc = createRelayRpc(target, async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, body: String(init.body), redirect: init.redirect, auth: headers.authorization });
      const body = url.endsWith('take_manual_commands') ? [{ id: ID, line: 'STOP_ALL', requested_at: 'x' }] : true;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(await rpc.take('R1', 'connected')).toEqual([{ id: ID, line: 'STOP_ALL' }]);
    expect(await rpc.finish(ID, 'no-ack')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/take_manual_commands',
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/finish_manual_command',
    ]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ p_source_robot_id: 'R1', p_bridge_state: 'connected', p_max_age_seconds: 10 });
    expect(calls.every((c) => c.redirect === 'manual' && c.auth === 'Bearer service-role-key-test-only-0123456789')).toBe(true);
  });

  it('returns null on network errors, HTTP errors and malformed rows', async () => {
    const failing = createRelayRpc(target, async () => {
      throw new TypeError('fetch failed');
    });
    expect(await failing.take('R1', 'connected')).toBeNull();
    expect(await failing.finish(ID, 'acknowledged')).toBe(false);
    const httpError = createRelayRpc(target, async () => new Response('{}', { status: 500 }));
    expect(await httpError.take('R1', 'connected')).toBeNull();
    const malformed = createRelayRpc(target, async () => new Response(JSON.stringify([{ id: 'nope', line: 'STOP_ALL' }]), { status: 200 }));
    expect(await malformed.take('R1', 'connected')).toBeNull();
  });
});
