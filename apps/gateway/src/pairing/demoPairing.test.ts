import { API_V1_ROUTES, type PairingResponse } from '@robolime/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalApi } from '../api/localApi';
import { initDatabase } from '../db/init';
import { GatewayConfigError, resolveDemoPairing } from '../http/config';
import { startGateway, type RunningGateway } from '../http/serve';
import { provisionRobot } from '../store/robots';
import { T0, TEST_ONLY_PAIRING_CODE, addTestRobot, memoryDb, minutesAfter, tempDir } from '../test/helpers';
import {
  DEMO_PAIRING_CODE,
  PairingCodeFormatError,
  hashDemoPairingCode,
  hashPairingCode,
  verifyDemoPairingCode,
  verifyPairingCode,
} from './codes';
import {
  DEMO_CREDENTIAL_LABEL,
  DemoPairingError,
  pairDevice,
  provisionDemoPairingCredential,
  provisionPairingCredential,
  validateSession,
} from './sessions';

/** Decision D47: the fixed demo pairing code, accepted only in explicit, loopback, demo-database mode. */

const DEMO = { allowDemoCredential: true } as const;

function demoDbWithDemoCode() {
  const db = memoryDb('demo');
  const robot = addTestRobot(db); // synthetic
  provisionDemoPairingCredential(db, { robotId: robot.id, now: T0 });
  return { db, robot };
}

describe('demo pairing code hashing (D47)', () => {
  it('is the documented fixed value', () => {
    expect(DEMO_PAIRING_CODE).toBe('10302026');
  });

  it('cannot be provisioned through the normal mechanism (too short), which stays unchanged', () => {
    expect(() => hashPairingCode(DEMO_PAIRING_CODE)).toThrow(PairingCodeFormatError);
  });

  it('stores a normal-format salted verifier that only the demo check accepts', () => {
    const verifier = hashDemoPairingCode();
    expect(verifier).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifier).not.toContain(DEMO_PAIRING_CODE);
    expect(hashDemoPairingCode()).not.toBe(verifier); // unique salt
    expect(verifyDemoPairingCode(DEMO_PAIRING_CODE, verifier)).toBe(true);
    expect(verifyDemoPairingCode('1030 2026', verifier)).toBe(true); // normal spacing rules
    expect(verifyDemoPairingCode('10302027', verifier)).toBe(false);
    // Domain separation: the normal verifier never accepts the demo verifier, whatever is typed.
    expect(verifyPairingCode(DEMO_PAIRING_CODE, verifier)).toBe(false);
    expect(verifyPairingCode('robolime-demo-pairing:10302026', verifier)).toBe(false);
  });

  it('never accepts a normally provisioned verifier through the demo check', () => {
    const normal = hashPairingCode(TEST_ONLY_PAIRING_CODE);
    expect(verifyDemoPairingCode(TEST_ONLY_PAIRING_CODE, normal)).toBe(false);
  });
});

describe('demo credential provisioning (explicit operator action only)', () => {
  it('refuses a field database', () => {
    const db = memoryDb('field');
    const robot = addTestRobot(db);
    expect(() => provisionDemoPairingCredential(db, { robotId: robot.id, now: T0 })).toThrow(DemoPairingError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pairing_credentials').get()).toEqual({ n: 0 });
  });

  it('refuses a robot that is not synthetic, even in a demo database', () => {
    const db = memoryDb('demo');
    const real = provisionRobot(db, { sourceRobotId: 'REAL-1', displayName: 'Real robot', isSynthetic: false }, T0);
    expect(() => provisionDemoPairingCredential(db, { robotId: real.id, now: T0 })).toThrow(DemoPairingError);
  });

  it('reserves its label: normal provisioning cannot mark a credential as the demo one', () => {
    const db = memoryDb('demo');
    const robot = addTestRobot(db);
    expect(() =>
      provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, label: DEMO_CREDENTIAL_LABEL, now: T0 }),
    ).toThrow(DemoPairingError);
  });
});

describe('pairing with the demo code', () => {
  it('is rejected in normal mode: the demo credential does not exist there', () => {
    const { db } = demoDbWithDemoCode();
    expect(pairDevice(db, DEMO_PAIRING_CODE, T0)).toEqual({ ok: false, error: 'NO_PAIRING_PROVISIONED' });
  });

  it('works only when demo pairing is explicitly enabled', () => {
    const { db, robot } = demoDbWithDemoCode();
    expect(pairDevice(db, '10302027', T0, undefined, DEMO)).toEqual({ ok: false, error: 'INVALID_PAIRING_CODE' });
    const paired = pairDevice(db, DEMO_PAIRING_CODE, T0, undefined, DEMO);
    if (!paired.ok) throw new Error('expected demo pairing to succeed');
    expect(paired.robotId).toBe(robot.id);
    expect(validateSession(db, paired.token, minutesAfter(1), DEMO)).toMatchObject({ ok: true, robotId: robot.id });
    // The same session is refused as soon as demo pairing is off again.
    expect(validateSession(db, paired.token, minutesAfter(1))).toEqual({ ok: false, error: 'SESSION_REVOKED' });
  });

  it('a normally provisioned credential replaces the demo one, which then stops working everywhere', () => {
    const { db, robot } = demoDbWithDemoCode();
    const demoSession = pairDevice(db, DEMO_PAIRING_CODE, T0, undefined, DEMO);
    if (!demoSession.ok) throw new Error('expected demo pairing to succeed');
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: minutesAfter(1) });
    expect(pairDevice(db, DEMO_PAIRING_CODE, minutesAfter(2), undefined, DEMO)).toEqual({ ok: false, error: 'INVALID_PAIRING_CODE' });
    expect(validateSession(db, demoSession.token, minutesAfter(2), DEMO)).toEqual({ ok: false, error: 'SESSION_REVOKED' });
    // Normal codes behave exactly as before, with or without demo mode.
    expect(pairDevice(db, TEST_ONLY_PAIRING_CODE, minutesAfter(2)).ok).toBe(true);
    expect(pairDevice(db, TEST_ONLY_PAIRING_CODE, minutesAfter(2), undefined, DEMO).ok).toBe(true);
  });

  it('the fixed code is rejected on a field database, even with demo mode requested at the pairing layer', () => {
    const db = memoryDb('field');
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    expect(pairDevice(db, DEMO_PAIRING_CODE, T0, undefined, DEMO)).toEqual({ ok: false, error: 'INVALID_PAIRING_CODE' });
  });
});

describe('local API demo option', () => {
  it('is off by default and refuses to start against a field database', () => {
    const field = memoryDb('field');
    expect(() => createLocalApi({ db: field, demoPairing: true })).toThrow(DemoPairingError);
    expect(() => createLocalApi({ db: field })).not.toThrow();
    const { db } = demoDbWithDemoCode();
    const api = createLocalApi({ db, clock: () => T0 });
    const res = api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, authorization: null, body: { pairingCode: DEMO_PAIRING_CODE }, clientAddress: '127.0.0.1' });
    expect(res.status).toBe(503);
  });
});

describe('resolveDemoPairing (fail closed)', () => {
  it('defaults to off', () => {
    expect(resolveDemoPairing({}, undefined, 'loopback')).toBe(false);
    expect(resolveDemoPairing({ GATEWAY_DEMO_PAIRING: '' }, undefined, 'loopback')).toBe(false);
    expect(resolveDemoPairing({ GATEWAY_DEMO_PAIRING: 'off' }, undefined, 'loopback')).toBe(false);
  });

  it('is enabled only by an explicit on or --demo-pairing, on loopback', () => {
    expect(resolveDemoPairing({ GATEWAY_DEMO_PAIRING: 'ON ' }, undefined, 'loopback')).toBe(true);
    expect(resolveDemoPairing({}, true, 'loopback')).toBe(true);
  });

  it('rejects any other value, even when the flag is given', () => {
    for (const value of ['yes', '1', 'true', 'enabled']) {
      expect(() => resolveDemoPairing({ GATEWAY_DEMO_PAIRING: value }, undefined, 'loopback')).toThrow(GatewayConfigError);
      expect(() => resolveDemoPairing({ GATEWAY_DEMO_PAIRING: value }, true, 'loopback')).toThrow(GatewayConfigError);
    }
  });

  it('can never be combined with LAN mode', () => {
    expect(() => resolveDemoPairing({ GATEWAY_DEMO_PAIRING: 'on' }, undefined, 'lan')).toThrow(GatewayConfigError);
    expect(() => resolveDemoPairing({}, true, 'lan')).toThrow(GatewayConfigError);
    expect(resolveDemoPairing({}, undefined, 'lan')).toBe(false);
  });
});

describe('gateway over loopback HTTP with the demo code', () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  const started: RunningGateway[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((g) => g.close()));
    tmp?.cleanup();
    tmp = undefined;
  });

  function onDiskDb(purpose: 'demo' | 'field', withDemoCode: boolean): string {
    tmp ??= tempDir();
    const file = tmp.path(`${purpose}-${withDemoCode ? 'demo-code' : 'no-code'}.sqlite`);
    const db = initDatabase(file, purpose, T0);
    const robot = addTestRobot(db);
    if (withDemoCode) provisionDemoPairingCredential(db, { robotId: robot.id, now: T0 });
    db.close();
    return file;
  }

  async function serve(dbPath: string, extra: Partial<Parameters<typeof startGateway>[0]> = {}) {
    const gateway = await startGateway({ dbPath, env: {}, portOverride: 0, clock: () => T0, ...extra });
    started.push(gateway);
    return gateway;
  }

  const pair = (url: string, pairingCode: string) =>
    fetch(`${url}${API_V1_ROUTES.pairing}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });

  it('pairs with the demo code only when started with demo pairing, and the session is refused once it is off', async () => {
    const file = onDiskDb('demo', true);
    const demo = await serve(file, { demoPairing: true });
    expect(demo.demoPairing).toBe(true);
    expect(demo.mode).toBe('loopback');
    const res = await pair(demo.url, DEMO_PAIRING_CODE);
    expect(res.status).toBe(201);
    const { sessionToken } = (await res.json()) as PairingResponse;
    const status = await fetch(`${demo.url}${API_V1_ROUTES.robotStatus}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(status.status).toBe(200);
    await demo.close();

    const normal = await serve(file);
    expect(normal.demoPairing).toBe(false);
    expect((await pair(normal.url, DEMO_PAIRING_CODE)).status).toBe(503); // NO_PAIRING_PROVISIONED
    const refused = await fetch(`${normal.url}${API_V1_ROUTES.robotStatus}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  it('keeps the normal rate limit on wrong codes in demo mode', async () => {
    const demo = await serve(onDiskDb('demo', true), { demoPairing: true });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await pair(demo.url, '10302027')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await pair(demo.url, DEMO_PAIRING_CODE)).status).toBe(429); // limited client is refused before any check
  });

  it('refuses to start in demo mode against a field database, and on LAN', async () => {
    const field = onDiskDb('field', false);
    await expect(startGateway({ dbPath: field, env: {}, portOverride: 0, demoPairing: true })).rejects.toThrow(DemoPairingError);
    // LAN settings that are otherwise valid (the address is "assigned"), so the refusal comes from the demo guard.
    const assigned = () => ({ eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }] });
    const demoDb = onDiskDb('demo', true);
    await expect(
      startGateway({
        dbPath: demoDb,
        env: { GATEWAY_DEMO_PAIRING: 'on', GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '192.168.1.10' },
        portOverride: 0,
        networkInterfaces: assigned,
      }),
    ).rejects.toThrow(/loopback-only/);
  });

  it('never provisions, overwrites or revokes anything at startup', async () => {
    const file = onDiskDb('demo', true);
    const first = await serve(file, { demoPairing: true });
    const paired = (await (await pair(first.url, DEMO_PAIRING_CODE)).json()) as PairingResponse;
    await first.close();
    const snapshot = () => {
      const db = initDatabase(file, 'demo', T0);
      const rows = db.prepare('SELECT id, verifier, revoked_at FROM pairing_credentials ORDER BY id').all();
      const sessions = db.prepare('SELECT id, revoked_at FROM local_sessions ORDER BY id').all();
      db.close();
      return JSON.stringify({ rows, sessions });
    };
    const before = snapshot();
    const again = await serve(file, { demoPairing: true });
    await again.close();
    expect(snapshot()).toBe(before);
    expect(paired.sessionToken).toMatch(/^rlg1\./);
  });
});
