import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { bool, str, strOrNull, withTransaction, type Database } from '../db/connection';
import { getDatabasePurpose } from '../db/init';
import { toCanonicalUtc } from '../db/time';
import {
  generatePairingCode,
  hashDemoPairingCode,
  hashPairingCode,
  verifyDemoPairingCode,
  verifyPairingCode,
  type ScryptParams,
} from './codes';

/**
 * Local (offline) pairing. Possession of the pairing code is the deliberately
 * limited single-owner-device credential: it proves "this device was given the
 * code", not who the person is. No cloud service or network is involved.
 *
 * Session tokens look like `rlg1.<session-uuid>.<secret>`; only SHA-256 of
 * the 256-bit secret is stored, so a copied database cannot mint tokens.
 */
export const DEFAULT_SESSION_TTL_DAYS = 90;
const TOKEN_PREFIX = 'rlg1';

/**
 * Reserved label of the demo-only credential (D47). Credentials with this label
 * are ignored, and sessions created from them are refused, unless demo pairing
 * is explicitly enabled. Normal provisioning refuses this label.
 */
export const DEMO_CREDENTIAL_LABEL = 'demo-only fixed code (D47) - never for field use';

export class DemoPairingError extends Error {
  override name = 'DemoPairingError';
}

/** Demo pairing is off unless a caller explicitly enables it (D47). */
export interface PairingPolicy {
  allowDemoCredential?: boolean;
}

function insertActiveCredential(db: Database, robotId: string, verifier: string, label: string, now: Date): string {
  const credentialId = randomUUID();
  const nowText = toCanonicalUtc(now);
  withTransaction(db, () => {
    db.prepare('UPDATE pairing_credentials SET revoked_at = ? WHERE robot_id = ? AND revoked_at IS NULL').run(nowText, robotId);
    db.prepare(`INSERT INTO pairing_credentials (id, robot_id, verifier, label, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      credentialId,
      robotId,
      verifier,
      label,
      nowText,
    );
  });
  return credentialId;
}

export interface ProvisionedCredential {
  credentialId: string;
  /** Present only when the gateway generated the code; show once, never log. */
  generatedCode: string | null;
}

/**
 * Creates the robot's pairing credential, revoking any previous one (and,
 * through validation, every session created from it). If `code` is omitted a
 * random code is generated and returned exactly once.
 */
export function provisionPairingCredential(
  db: Database,
  options: { robotId: string; code?: string; label?: string; now: Date; scryptParams?: ScryptParams },
): ProvisionedCredential {
  if (options.label === DEMO_CREDENTIAL_LABEL) {
    throw new DemoPairingError('That label is reserved for the demo-only credential.');
  }
  const code = options.code ?? generatePairingCode();
  const verifier = hashPairingCode(code, options.scryptParams);
  const credentialId = insertActiveCredential(db, options.robotId, verifier, options.label ?? '', options.now);
  return { credentialId, generatedCode: options.code === undefined ? code : null };
}

/**
 * DEMO ONLY (D47): makes the fixed `DEMO_PAIRING_CODE` the robot's active
 * credential, revoking the previous one exactly as normal provisioning does.
 * An explicit operator action; never run at gateway startup. Refuses unless
 * the database purpose is 'demo' and the robot is synthetic. The code is
 * never returned or printed.
 */
export function provisionDemoPairingCredential(
  db: Database,
  options: { robotId: string; now: Date; scryptParams?: ScryptParams },
): { credentialId: string } {
  if (getDatabasePurpose(db) !== 'demo') {
    throw new DemoPairingError('The demo pairing code can only be provisioned in a demo database (db:seed:demo).');
  }
  const robot = db.prepare('SELECT is_synthetic FROM robots WHERE id = ?').get(options.robotId);
  if (robot === undefined || !bool(robot, 'is_synthetic')) {
    throw new DemoPairingError('The demo pairing code can only be provisioned for a synthetic robot.');
  }
  const verifier = hashDemoPairingCode(options.scryptParams);
  return { credentialId: insertActiveCredential(db, options.robotId, verifier, DEMO_CREDENTIAL_LABEL, options.now) };
}

export type PairResult =
  | { ok: true; token: string; sessionId: string; robotId: string; expiresAt: string }
  | { ok: false; error: 'NO_PAIRING_PROVISIONED' | 'INVALID_PAIRING_CODE' };

/** Exchanges a pairing code for a new persisted session. */
export function pairDevice(
  db: Database,
  pairingCode: string,
  now: Date,
  ttlDays: number = DEFAULT_SESSION_TTL_DAYS,
  policy: PairingPolicy = {},
): PairResult {
  // A demo credential does not exist as far as normal mode is concerned (D47).
  const credentials = db
    .prepare('SELECT id, robot_id, verifier, label FROM pairing_credentials WHERE revoked_at IS NULL')
    .all()
    .filter((c) => policy.allowDemoCredential === true || str(c, 'label') !== DEMO_CREDENTIAL_LABEL);
  if (credentials.length === 0) {
    return { ok: false, error: 'NO_PAIRING_PROVISIONED' };
  }
  const match = credentials.find((c) =>
    str(c, 'label') === DEMO_CREDENTIAL_LABEL
      ? verifyDemoPairingCode(pairingCode, str(c, 'verifier'))
      : verifyPairingCode(pairingCode, str(c, 'verifier')),
  );
  if (!match) {
    return { ok: false, error: 'INVALID_PAIRING_CODE' };
  }
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = toCanonicalUtc(new Date(now.getTime() + ttlDays * 86_400_000));
  db.prepare(
    `INSERT INTO local_sessions (id, robot_id, pairing_credential_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, str(match, 'robot_id'), str(match, 'id'), sha256Hex(secret), toCanonicalUtc(now), expiresAt);
  return {
    ok: true,
    token: `${TOKEN_PREFIX}.${sessionId}.${secret}`,
    sessionId,
    robotId: str(match, 'robot_id'),
    expiresAt,
  };
}

export type SessionCheck =
  | { ok: true; sessionId: string; robotId: string; expiresAt: string }
  | { ok: false; error: 'UNPAIRED' | 'INVALID_SESSION' | 'SESSION_EXPIRED' | 'SESSION_REVOKED' };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Validates a bearer token and returns the single robot it may read. */
export function validateSession(
  db: Database,
  token: string | null | undefined,
  now: Date,
  policy: PairingPolicy = {},
): SessionCheck {
  if (!token) {
    return { ok: false, error: 'UNPAIRED' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, error: 'INVALID_SESSION' };
  }
  const [, sessionId, secret] = parts as [string, string, string];
  const row = db
    .prepare(
      `SELECT s.robot_id, s.token_hash, s.expires_at, s.revoked_at, c.revoked_at AS credential_revoked_at, c.label AS credential_label
       FROM local_sessions AS s JOIN pairing_credentials AS c ON c.id = s.pairing_credential_id
       WHERE s.id = ?`,
    )
    .get(sessionId);
  if (row === undefined) {
    return { ok: false, error: 'INVALID_SESSION' };
  }
  const expected = Buffer.from(str(row, 'token_hash'), 'hex');
  const actual = Buffer.from(sha256Hex(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: 'INVALID_SESSION' };
  }
  if (strOrNull(row, 'revoked_at') !== null || strOrNull(row, 'credential_revoked_at') !== null) {
    return { ok: false, error: 'SESSION_REVOKED' };
  }
  // A session paired with the demo code is not valid once demo pairing is off (D47).
  if (str(row, 'credential_label') === DEMO_CREDENTIAL_LABEL && policy.allowDemoCredential !== true) {
    return { ok: false, error: 'SESSION_REVOKED' };
  }
  const expiresAt = str(row, 'expires_at');
  if (Date.parse(expiresAt) <= now.getTime()) {
    return { ok: false, error: 'SESSION_EXPIRED' };
  }
  return { ok: true, sessionId, robotId: str(row, 'robot_id'), expiresAt };
}

export function revokeSession(db: Database, sessionId: string, now: Date): void {
  db.prepare('UPDATE local_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    toCanonicalUtc(now),
    sessionId,
  );
}
