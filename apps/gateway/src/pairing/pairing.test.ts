import { describe, expect, it } from 'vitest';

import { addTestRobot, count, memoryDb, minutesAfter, T0, TEST_ONLY_PAIRING_CODE } from '../test/helpers';
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PairingCodeFormatError,
  verifyPairingCode,
} from './codes';
import { pairDevice, provisionPairingCredential, revokeSession, validateSession } from './sessions';

describe('pairing codes', () => {
  it('generates 12-symbol codes from an unambiguous alphabet', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(Array.from({ length: 20 }, generatePairingCode)).size).toBe(20);
  });

  it('stores a salted scrypt verifier, never the code', () => {
    const a = hashPairingCode(TEST_ONLY_PAIRING_CODE);
    const b = hashPairingCode(TEST_ONLY_PAIRING_CODE);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b); // unique salt
    expect(a).not.toContain(normalizePairingCode(TEST_ONLY_PAIRING_CODE));
  });

  it('verifies case-, spacing- and hyphen-insensitively', () => {
    const verifier = hashPairingCode('ABCD-EFGH-JKMN');
    expect(verifyPairingCode('abcd efgh jkmn', verifier)).toBe(true);
    expect(verifyPairingCode('ABCDEFGHJKMM', verifier)).toBe(false);
  });

  it('never matches a malformed verifier', () => {
    expect(verifyPairingCode('ABCD-EFGH-JKMN', 'plain-text')).toBe(false);
    expect(verifyPairingCode('ABCD-EFGH-JKMN', 'scrypt$x$8$1$a$b')).toBe(false);
  });

  it('refuses codes too short to resist guessing', () => {
    expect(() => hashPairingCode('1234')).toThrow(PairingCodeFormatError);
  });
});

describe('local pairing and sessions (offline, no cloud)', () => {
  it('pairs with the provisioned code and validates the session', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const paired = pairDevice(db, TEST_ONLY_PAIRING_CODE, T0);
    if (!paired.ok) throw new Error(paired.error);

    expect(paired.token).toMatch(/^rlg1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(validateSession(db, paired.token, minutesAfter(1))).toMatchObject({ ok: true, robotId: robot.id });
  });

  it('never stores the pairing code itself in the database', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const generated = provisionPairingCredential(db, { robotId: robot.id, now: minutesAfter(1) }).generatedCode ?? '';
    const dump = JSON.stringify(db.prepare('SELECT * FROM pairing_credentials').all()).toUpperCase();
    for (const code of [TEST_ONLY_PAIRING_CODE, generated]) {
      expect(dump).not.toContain(code.toUpperCase());
      expect(dump).not.toContain(normalizePairingCode(code));
    }
  });

  it('stores only a hash of the session secret', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const paired = pairDevice(db, TEST_ONLY_PAIRING_CODE, T0);
    if (!paired.ok) throw new Error(paired.error);
    const secret = paired.token.split('.')[2] ?? '';
    const dump = JSON.stringify(db.prepare('SELECT * FROM local_sessions').all());
    expect(dump).not.toContain(secret);
  });

  it('reports a missing provisioning step distinctly from a wrong code', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    expect(pairDevice(db, TEST_ONLY_PAIRING_CODE, T0)).toEqual({ ok: false, error: 'NO_PAIRING_PROVISIONED' });
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    expect(pairDevice(db, 'WRONG-CODE-VALUE', T0)).toEqual({ ok: false, error: 'INVALID_PAIRING_CODE' });
    expect(count(db, 'local_sessions')).toBe(0);
  });

  it('distinguishes unpaired, invalid, expired and revoked sessions', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const paired = pairDevice(db, TEST_ONLY_PAIRING_CODE, T0, 1);
    if (!paired.ok) throw new Error(paired.error);

    expect(validateSession(db, null, T0)).toEqual({ ok: false, error: 'UNPAIRED' });
    expect(validateSession(db, 'garbage', T0)).toEqual({ ok: false, error: 'INVALID_SESSION' });
    const forged = paired.token.replace(/\.[^.]+$/, '.forged-secret');
    expect(validateSession(db, forged, T0)).toEqual({ ok: false, error: 'INVALID_SESSION' });
    expect(validateSession(db, paired.token, minutesAfter(24 * 60))).toEqual({ ok: false, error: 'SESSION_EXPIRED' });
    revokeSession(db, paired.sessionId, T0);
    expect(validateSession(db, paired.token, T0)).toEqual({ ok: false, error: 'SESSION_REVOKED' });
  });

  it('re-provisioning revokes the old code and every session paired with it', () => {
    const db = memoryDb();
    const robot = addTestRobot(db);
    provisionPairingCredential(db, { robotId: robot.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
    const paired = pairDevice(db, TEST_ONLY_PAIRING_CODE, T0);
    if (!paired.ok) throw new Error(paired.error);

    const next = provisionPairingCredential(db, { robotId: robot.id, now: minutesAfter(1) });
    expect(next.generatedCode).toMatch(/^[0-9A-Z]{4}-/);
    expect(validateSession(db, paired.token, minutesAfter(2))).toEqual({ ok: false, error: 'SESSION_REVOKED' });
    expect(pairDevice(db, TEST_ONLY_PAIRING_CODE, minutesAfter(2))).toEqual({ ok: false, error: 'INVALID_PAIRING_CODE' });
    expect(pairDevice(db, next.generatedCode ?? '', minutesAfter(2)).ok).toBe(true);
  });
});
