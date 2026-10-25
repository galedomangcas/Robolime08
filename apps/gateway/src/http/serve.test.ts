import { API_V1_ROUTES, type PairingResponse } from '@robolime/shared';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseMissingError, initDatabase, openExistingDatabase } from '../db/init';
import { provisionPairingCredential } from '../pairing/sessions';
import { recordReading } from '../store/readings';
import { T0, TEST_ONLY_PAIRING_CODE, addTestRobot, count, tempDir, testReading } from '../test/helpers';
import { GatewayConfigError } from './config';
import { startGateway, type RunningGateway } from './serve';

const NOW = new Date('2026-03-01T12:00:00.000Z');

let tmp: ReturnType<typeof tempDir> | undefined;
const started: RunningGateway[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((g) => g.close()));
  tmp?.cleanup();
  tmp = undefined;
});

/** A real on-disk field database with one robot, one reading and a pairing code. */
function fieldDb(): string {
  tmp = tempDir();
  const file = tmp.path('field.sqlite');
  const db = initDatabase(file, 'field', T0);
  const robot = addTestRobot(db);
  recordReading(db, testReading(), T0);
  provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
  db.close();
  return file;
}

async function serve(dbPath: string, extra: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const gateway = await startGateway({ dbPath, env: {}, portOverride: 0, clock: () => NOW, ...extra });
  started.push(gateway);
  return gateway;
}

async function pairOver(url: string): Promise<string> {
  const res = await fetch(`${url}${API_V1_ROUTES.pairing}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: TEST_ONLY_PAIRING_CODE }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as PairingResponse).sessionToken;
}

describe('startGateway', () => {
  it('validates configuration before touching the database', async () => {
    tmp = tempDir();
    const missing = tmp.path('never-created.sqlite');
    await expect(startGateway({ dbPath: missing, env: { GATEWAY_HOST: '0.0.0.0' } })).rejects.toThrow(GatewayConfigError);
    await expect(startGateway({ dbPath: missing, env: { GATEWAY_PORT: '70000' } })).rejects.toThrow(GatewayConfigError);
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses a missing database instead of creating one', async () => {
    tmp = tempDir();
    const missing = tmp.path('missing.sqlite');
    await expect(startGateway({ dbPath: missing, env: {}, portOverride: 0 })).rejects.toThrow(DatabaseMissingError);
    expect(existsSync(missing)).toBe(false);
  });

  it('serves loopback only and reports its URL', async () => {
    const gateway = await serve(fieldDb());
    expect(gateway.mode).toBe('loopback');
    expect(gateway.host).toBe('127.0.0.1');
    expect(gateway.url).toBe(`http://127.0.0.1:${gateway.port}`);
  });

  it('LAN mode (D36): invalid LAN configuration fails before the database is touched (no fallback)', async () => {
    tmp = tempDir();
    const missing = tmp.path('never-created.sqlite');
    const someLan = (): Record<string, { address: string; family: string; internal: boolean }[]> => ({
      wlan0: [{ address: '192.168.137.1', family: 'IPv4', internal: false }],
    });
    for (const attempt of [
      { env: { GATEWAY_LAN_MODE: 'on' } }, // no address
      { env: { GATEWAY_LAN_MODE: 'maybe', GATEWAY_HOST: '192.168.137.1' } }, // invalid mode value
      { env: { GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '8.8.8.8' } }, // public
      { env: { GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '10.9.8.7' } }, // private but unassigned
      { env: { GATEWAY_HOST: '192.168.137.1' } }, // private without the opt-in
      { env: {}, lan: true }, // --lan without an address
    ]) {
      await expect(
        startGateway({ dbPath: missing, portOverride: 0, networkInterfaces: someLan, ...attempt }),
      ).rejects.toThrow(GatewayConfigError);
    }
    expect(existsSync(missing)).toBe(false);
  });

  it('LAN mode (D36): a failed bind closes the database and leaves nothing listening', async (ctx) => {
    const address = ['10.255.255.254', '172.31.255.254', '192.168.255.254'].find(
      (a) => !Object.values(networkInterfaces()).flat().some((e) => e?.address === a),
    );
    if (address === undefined) {
      ctx.skip(); // every candidate is really assigned here; cannot provoke EADDRNOTAVAIL safely
      return;
    }
    const file = fieldDb();
    const claimAssigned = () => ({ wlan0: [{ address, family: 'IPv4', internal: false }] });
    await expect(
      startGateway({ dbPath: file, env: { GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: address }, portOverride: 0, networkInterfaces: claimAssigned }),
    ).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
    // The database was released (the temp-dir cleanup would fail on Windows otherwise) and is intact.
    const db = openExistingDatabase(file);
    expect(count(db, 'readings')).toBe(1);
    db.close();
  });

  it('keeps existing data and pairing sessions across a restart (no reset, no reseed)', async () => {
    const file = fieldDb();
    const first = await serve(file);
    const token = await pairOver(first.url);
    await first.close();

    const second = await serve(file);
    const session = await fetch(`${second.url}${API_V1_ROUTES.session}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(session.status).toBe(200);
    await second.close();

    const db = openExistingDatabase(file);
    try {
      expect(count(db, 'readings')).toBe(1);
      expect(count(db, 'robots')).toBe(1);
      expect(count(db, 'local_sessions')).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('close() is idempotent, releases the database and stops listening', async () => {
    const file = fieldDb();
    const gateway = await serve(file);
    await Promise.all([gateway.close(), gateway.close()]);
    await expect(fetch(`${gateway.url}${API_V1_ROUTES.session}`)).rejects.toThrow();
    // Another process could now open the same file normally.
    const db = openExistingDatabase(file);
    db.close();
  });

  it('fails cleanly when the port is already in use and leaves the first server running', async () => {
    const file = fieldDb();
    const first = await serve(file);
    await expect(startGateway({ dbPath: file, env: {}, portOverride: first.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const still = await fetch(`${first.url}${API_V1_ROUTES.session}`);
    expect(still.status).toBe(401);
  });
});
