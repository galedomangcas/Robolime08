import type { CloudConfig } from '../config/cloudConfig';
import { createCloudReader, manualResultFromRow, relayBridge, type CloudSessionProvider } from './cloudReader';
import type { FetchLike } from './gatewayClient';

const CONFIG: CloudConfig = { ok: true, url: 'https://abcdefghijklmnopqrst.supabase.co', projectRef: 'abcdefghijklmnopqrst', publicKey: 'sb_publishable_test_only' };
const ROBOT = '7f9c2ba4-e88f-4f3b-9c1d-111111111111';
const COMMAND_ID = '0b5e1c9a-6f1d-4c55-9a4e-222222222222';
const signedIn: CloudSessionProvider = { accessToken: async () => 'user-access-token-test-only' };
const T = '2026-03-01T08:00:00+00:00';

/** Answers each request from `replies` in order (by URL substring), recording every call. */
function scriptedFetch(replies: { match: string; body: unknown; status?: number }[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const index = replies.findIndex((r) => url.includes(r.match));
    const reply = index === -1 ? { body: [], status: 200 } : replies.splice(index, 1)[0]!;
    const status = reply.status ?? 200;
    return { ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(reply.body) };
  };
  return { fetch, calls };
}

const reader = (fetch: FetchLike) => createCloudReader({ config: CONFIG, session: signedIn, fetch, sleep: async () => undefined });

describe('online manual control: relay status (D58)', () => {
  it('reads the server-judged heartbeat and finished commands only', async () => {
    const { fetch, calls } = scriptedFetch([
      { match: 'rpc/manual_relay_status', body: [{ bridge_state: 'connected', seen_seconds_ago: 1.2 }] },
      {
        match: 'manual_commands?',
        body: [
          { line: 'STOP_ALL', status: 'sent', requested_at: T, finished_at: null },
          { line: 'DRIVE:FORWARD:127', status: 'acknowledged', requested_at: T, finished_at: T },
        ],
      },
    ]);
    const result = await reader(fetch).manualStatus(ROBOT);
    expect(result).toEqual({
      ok: true,
      data: {
        bridge: { state: 'connected', port: null, detail: null },
        autoStopMs: 5_000,
        recentCommands: [{ command: { type: 'DRIVE', direction: 'FORWARD', pwm: 127 }, line: 'DRIVE:FORWARD:127', outcome: 'acknowledged', sentAt: T, finishedAt: T }],
        bridgeLog: [],
      },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ p_robot_id: ROBOT }) });
    expect(calls[1]?.url).toContain(`robot_id=eq.${ROBOT}`);
  });

  it('treats a missing or old heartbeat as not reachable', () => {
    expect(relayBridge(undefined)).toMatchObject({ state: 'not-configured' });
    expect(relayBridge({ bridge_state: 'connected', seen_seconds_ago: 300 })).toMatchObject({
      state: 'disconnected',
      detail: 'The field gateway was last online 5 min ago. It needs internet to relay commands to the robot.',
    });
    expect(relayBridge({ bridge_state: 'disconnected', seen_seconds_ago: 2 })?.detail).toMatch(/LoRa bridge is not connected/);
    expect(relayBridge({ bridge_state: 'weird', seen_seconds_ago: 2 })).toBeNull();
  });

  it('never maps a pending row or an unknown line to a result', () => {
    expect(manualResultFromRow({ line: 'PUMP_ON', status: 'pending', requested_at: T, finished_at: null })).toBeNull();
    expect(manualResultFromRow({ line: 'REBOOT', status: 'acknowledged', requested_at: T, finished_at: T })).toBeNull();
    expect(manualResultFromRow({ line: 'PUMP_ON', status: 'expired', requested_at: T, finished_at: T })).toMatchObject({ outcome: 'expired' });
  });
});

describe('online manual control: commands (D58)', () => {
  it('queues the firmware line and waits for the gateway verdict', async () => {
    const { fetch, calls } = scriptedFetch([
      { match: 'rpc/request_manual_command', body: [{ result: 'queued', id: COMMAND_ID, requested_at: T }] },
      { match: `id=eq.${COMMAND_ID}`, body: [{ line: 'PUMP_OFF', status: 'sent', requested_at: T, finished_at: null }] },
      { match: `id=eq.${COMMAND_ID}`, body: [{ line: 'PUMP_OFF', status: 'acknowledged', requested_at: T, finished_at: T }] },
    ]);
    const result = await reader(fetch).manualCommand(ROBOT, { type: 'PUMP', action: 'OFF' });
    expect(result).toMatchObject({ ok: true, data: { line: 'PUMP_OFF', outcome: 'acknowledged' } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ p_robot_id: ROBOT, p_line: 'PUMP_OFF' }) });
    expect(calls).toHaveLength(3);
  });

  it('reports rate limiting as HTTP 429 and never polls', async () => {
    const { fetch, calls } = scriptedFetch([{ match: 'rpc/request_manual_command', body: [{ result: 'rate-limited', id: null, requested_at: null }] }]);
    expect(await reader(fetch).manualCommand(ROBOT, { type: 'STOP_ALL' })).toEqual({ ok: false, failure: { kind: 'http', status: 429 } });
    expect(calls).toHaveLength(1);
  });

  it('refuses a malformed robot id before any request', async () => {
    const { fetch, calls } = scriptedFetch([]);
    expect(await reader(fetch).manualCommand('not-a-uuid', { type: 'STOP_ALL' })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});
