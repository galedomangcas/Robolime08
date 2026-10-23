import {
  API_V1_ROUTES,
  type ApiErrorBody,
  type FieldResponse,
  type PairingResponse,
  type RobotStatusResponse,
  type RunReadingsResponse,
  type RunRecommendationResponse,
  type RunsResponse,
} from '@robolime/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../db/connection';
import { initDatabase } from '../db/init';
import { provisionPairingCredential } from '../pairing/sessions';
import { DEMO_DOSING_RUN, DEMO_SOURCE_ROBOT_ID, DEMO_VERIFICATION_RUN, seedDemo } from '../seed/demo';
import { recordReading } from '../store/readings';
import { getRobotBySourceId, provisionRobot } from '../store/robots';
import {
  T0,
  TEST_ONLY_OTHER_PAIRING_CODE,
  TEST_ONLY_PAIRING_CODE,
  tempDir,
  testReading,
} from '../test/helpers';
import { createLocalApi, type ApiResponse } from './localApi';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/** Demo robot (seeded) plus a second robot "OTHER" with its own run and code. */
function setup(db: Database = initDatabase(':memory:', 'demo', T0)) {
  seedDemo(db);
  const demo = getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID);
  if (!demo) throw new Error('demo robot missing');
  const other = provisionRobot(db, { sourceRobotId: 'OTHER', displayName: 'Other robot', isSynthetic: true }, T0);
  const otherRun = recordReading(db, testReading({ sourceRobotId: 'OTHER', sourceRunId: 'OTHER-RUN' }), T0).runId;
  provisionPairingCredential(db, { robotId: demo.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
  provisionPairingCredential(db, { robotId: other.id, code: TEST_ONLY_OTHER_PAIRING_CODE, now: T0 });
  const api = createLocalApi({ db, clock: () => NOW });
  const runIds = (sourceRunId: string) =>
    String(db.prepare('SELECT id FROM runs WHERE source_run_id = ?').get(sourceRunId)?.id);
  return { db, api, demo, other, otherRun, dosingRun: runIds(DEMO_DOSING_RUN), verificationRun: runIds(DEMO_VERIFICATION_RUN) };
}

function pair(api: ReturnType<typeof createLocalApi>, code: string): string {
  const res = api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: code } });
  expect(res.status).toBe(201);
  return (res.body as PairingResponse).sessionToken;
}

const get = (api: ReturnType<typeof createLocalApi>, path: string, token?: string) =>
  api.handle({ method: 'GET', path, authorization: token === undefined ? null : `Bearer ${token}` });

const errorCode = (res: ApiResponse) => (res.body as ApiErrorBody).error.code;

const PROTECTED_GETS = [
  API_V1_ROUTES.session,
  API_V1_ROUTES.robotStatus,
  API_V1_ROUTES.field,
  API_V1_ROUTES.runs,
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe('pairing-attempt rate limiting (D30: 5 failed attempts per client address per 15 minutes)', () => {
  const MINUTE = 60_000;
  const A = '192.0.2.10';
  const B = '192.0.2.20';

  /** Same fixture, but with a clock the test can move. */
  function limited() {
    const fixture = setup();
    let now = NOW.getTime();
    const api = createLocalApi({ db: fixture.db, clock: () => new Date(now) });
    const advance = (ms: number) => {
      now += ms;
    };
    const attempt = (body: unknown, clientAddress: string | null = A) =>
      api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body, clientAddress });
    const wrong = (clientAddress: string | null = A) => attempt({ pairingCode: 'WRNG-WRNG-WRNG' }, clientAddress);
    const right = (clientAddress: string | null = A) => attempt({ pairingCode: TEST_ONLY_PAIRING_CODE }, clientAddress);
    const sessions = () => Number(fixture.db.prepare('SELECT COUNT(*) AS n FROM local_sessions').get()?.n);
    return { ...fixture, api, advance, attempt, wrong, right, sessions };
  }

  it('answers the first five wrong codes normally and refuses the sixth attempt with 429', () => {
    const t = limited();
    for (let i = 1; i <= 5; i += 1) {
      const res = t.wrong();
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(errorCode(res)).toBe('INVALID_PAIRING_CODE');
    }
    const sixth = t.wrong();
    expect(sixth.status).toBe(429);
    expect(errorCode(sixth)).toBe('PAIRING_RATE_LIMITED');
    expect(sixth.retryAfterSeconds).toBe(15 * 60);
    expect((sixth.body as ApiErrorBody).error.message).toContain('15 minutes');
  });

  it('a limited client learns nothing: a correct code gets the same 429 and creates no session', () => {
    const t = limited();
    for (let i = 0; i < 5; i += 1) t.wrong();
    const before = t.sessions();
    const withCorrect = t.right();
    const withWrong = t.wrong();
    const malformed = t.attempt('not json object');

    expect(withCorrect).toEqual(withWrong);
    expect(malformed).toEqual(withWrong);
    expect(withCorrect.status).toBe(429);
    expect(t.sessions()).toBe(before);
    const serialized = JSON.stringify(withCorrect);
    expect(serialized).not.toContain(TEST_ONLY_PAIRING_CODE);
    expect(serialized).not.toContain('WRNG');
    expect(serialized).not.toContain('sessionToken');
    expect(serialized).not.toMatch(/correct code|robot/i);
  });

  it('counts each client address separately', () => {
    const t = limited();
    for (let i = 0; i < 5; i += 1) t.wrong(A);
    expect(t.wrong(A).status).toBe(429);
    expect(t.wrong(B).status).toBe(401);
    expect(t.right(B).status).toBe(201);
  });

  it('lifts the limit exactly 15 minutes after the oldest counted failure', () => {
    const t = limited();
    for (let i = 0; i < 5; i += 1) t.wrong();
    t.advance(15 * MINUTE - 1_000);
    const late = t.right();
    expect(late.status).toBe(429);
    expect(late.retryAfterSeconds).toBe(1);
    expect((late.body as ApiErrorBody).error.message).toContain('1 minute,');
    t.advance(1_000);
    expect(t.right().status).toBe(201);
  });

  it('does not count successful pairings as failures', () => {
    const t = limited();
    for (let i = 0; i < 4; i += 1) t.wrong();
    for (let i = 0; i < 3; i += 1) expect(t.right().status).toBe(201);
    expect(t.wrong().status).toBe(401); // the 5th failure, not the 8th attempt
    expect(t.right().status).toBe(429);
  });

  it('does not count malformed requests, wrong methods or an unprovisioned gateway (no code is tested)', () => {
    const t = limited();
    for (let i = 0; i < 10; i += 1) {
      expect(t.attempt({ code: 'x' }).status).toBe(400);
      expect(t.attempt({ pairingCode: 'x'.repeat(65) }).status).toBe(400);
      expect(t.api.handle({ method: 'GET', path: API_V1_ROUTES.pairing, clientAddress: A }).status).toBe(405);
    }
    for (let i = 0; i < 5; i += 1) expect(t.wrong().status).toBe(401);
    expect(t.wrong().status).toBe(429);

    const empty = initDatabase(':memory:', 'demo', T0);
    const unprovisioned = createLocalApi({ db: empty, clock: () => NOW });
    for (let i = 0; i < 8; i += 1) {
      const res = unprovisioned.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: 'WRNG-WRNG-WRNG' }, clientAddress: A });
      expect(errorCode(res)).toBe('NO_PAIRING_PROVISIONED');
    }
  });

  it('repeated requests while limited neither bypass nor extend the limit', () => {
    const t = limited();
    for (let i = 0; i < 5; i += 1) t.wrong();
    for (let i = 0; i < 25; i += 1) expect(t.right().status).toBe(429);
    t.advance(15 * MINUTE);
    expect(t.right().status).toBe(201);
  });

  it('does not affect other endpoints: existing sessions keep working and unpaired requests stay 401', () => {
    const t = limited();
    const token = pair(t.api, TEST_ONLY_PAIRING_CODE);
    for (let i = 0; i < 5; i += 1) t.wrong();
    expect(t.wrong().status).toBe(429);

    expect(get(t.api, API_V1_ROUTES.runs, token).status).toBe(200);
    expect(get(t.api, API_V1_ROUTES.session, token).status).toBe(200);
    const unpaired = get(t.api, API_V1_ROUTES.runs);
    expect(unpaired.status).toBe(401);
    expect(errorCode(unpaired)).toBe('UNPAIRED');
  });

  it('fails closed when the transport reports no client address: such requests share one counter', () => {
    const t = limited();
    for (let i = 0; i < 5; i += 1) t.wrong(null);
    expect(t.api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: TEST_ONLY_PAIRING_CODE } }).status).toBe(429);
    expect(t.right(A).status).toBe(201);
  });
});

describe('local API authorization boundary', () => {
  it('1. denies an unpaired client on every protected route', () => {
    const { api, dosingRun } = setup();
    for (const path of [...PROTECTED_GETS, API_V1_ROUTES.runReadings(dosingRun), API_V1_ROUTES.runRecommendation(dosingRun)]) {
      const res = get(api, path);
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('UNPAIRED');
      expect(JSON.stringify(res.body)).not.toContain('"readings"');
    }
  });

  it('2. denies an invalid credential or session', () => {
    const { api } = setup();
    const wrongCode = api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: 'WRONG-CODE-1234' } });
    expect(wrongCode.status).toBe(401);
    expect(errorCode(wrongCode)).toBe('INVALID_PAIRING_CODE');

    for (const token of ['nonsense', 'rlg1.00000000-0000-0000-0000-000000000000.abc']) {
      const res = get(api, API_V1_ROUTES.runs, token);
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('INVALID_SESSION');
    }
    const basic = api.handle({ method: 'GET', path: API_V1_ROUTES.runs, authorization: 'Basic abc' });
    expect(errorCode(basic)).toBe('INVALID_SESSION');
  });

  it("3. a session cannot access another robot's data", () => {
    const { api, otherRun, dosingRun } = setup();
    const demoToken = pair(api, TEST_ONLY_PAIRING_CODE);
    const otherToken = pair(api, TEST_ONLY_OTHER_PAIRING_CODE);

    const crossReadings = get(api, API_V1_ROUTES.runReadings(otherRun), demoToken);
    expect(crossReadings.status).toBe(404);
    expect(errorCode(crossReadings)).toBe('NOT_FOUND');
    expect(get(api, API_V1_ROUTES.runRecommendation(dosingRun), otherToken).status).toBe(404);

    const otherRuns = get(api, API_V1_ROUTES.runs, otherToken).body as RunsResponse;
    expect(otherRuns.runs.map((r) => r.sourceRunId)).toEqual(['OTHER-RUN']);
    expect(errorCode(get(api, API_V1_ROUTES.field, otherToken))).toBe('NO_ACTIVE_FIELD');
    const otherStatus = get(api, API_V1_ROUTES.robotStatus, otherToken).body as RobotStatusResponse;
    expect(otherStatus.status).toBeNull();

    const selection = api.handle({
      method: 'POST',
      path: API_V1_ROUTES.fieldSelections,
      authorization: `Bearer ${otherToken}`,
      body: { fieldId: (get(api, API_V1_ROUTES.field, demoToken).body as FieldResponse).field.id },
    });
    expect(selection.status).toBe(404);
  });

  it('4. a valid session receives only its own, farmer-facing data', () => {
    const { api, demo, dosingRun, verificationRun } = setup();
    const token = pair(api, TEST_ONLY_PAIRING_CODE);

    const runs = get(api, API_V1_ROUTES.runs, token).body as RunsResponse;
    expect(runs.runs.map((r) => r.sourceRunId)).toEqual([DEMO_DOSING_RUN]); // verification run hidden
    expect(runs.runs[0]).toMatchObject({ readingCount: 20, isSynthetic: true });

    const readings = get(api, API_V1_ROUTES.runReadings(dosingRun), token).body as RunReadingsResponse;
    expect(readings.readings).toHaveLength(20);
    expect(readings.readings.every((r) => r.runId === dosingRun && r.runType === 'dosing')).toBe(true);
    expect(readings.readings[0]?.timestamps.cloudSyncedAt).toBeNull();

    expect(get(api, API_V1_ROUTES.runReadings(verificationRun), token).status).toBe(404);

    const status = get(api, API_V1_ROUTES.robotStatus, token).body as RobotStatusResponse;
    expect(status.status).toMatchObject({ robotId: demo.id, state: 'COMPLETED', cellsCompleted: 20 });
    expect(status.staleThresholdSeconds).toBe(240);

    const field = get(api, API_V1_ROUTES.field, token).body as FieldResponse;
    expect(field.cells).toHaveLength(20);
    expect(field.field.isSynthetic).toBe(true);

    const rec = get(api, API_V1_ROUTES.runRecommendation(dosingRun), token).body as RunRecommendationResponse;
    expect(rec.isSynthetic).toBe(true);
    expect(rec.ruleSetStatus).toBe('draft');
    expect(rec.recommendation.shortlist).toHaveLength(5);
    expect(rec.recommendation.allScores).toHaveLength(6);

    const selection = api.handle({
      method: 'POST',
      path: API_V1_ROUTES.fieldSelections,
      authorization: `Bearer ${token}`,
      body: { fieldId: field.field.id },
    });
    expect(selection.status).toBe(201);
  });

  it('5. pairing and authorization need no Supabase client, cloud request or network', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is not allowed in local pairing');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { api } = setup();
    const token = pair(api, TEST_ONLY_PAIRING_CODE);
    expect(get(api, API_V1_ROUTES.runs, token).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Static guard: the gateway's pairing/API/store code imports no cloud or network modules.
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    for (const dir of ['pairing', 'api', 'store', 'db']) {
      for (const file of readdirSync(`${srcDir}/${dir}`).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
        const source = readFileSync(`${srcDir}/${dir}/${file}`, 'utf8');
        expect(source, `${dir}/${file}`).not.toMatch(/from\s+['"][^'"]*(supabase|node:(http|https|net|dgram))/i);
        expect(source, `${dir}/${file}`).not.toMatch(/\bfetch\(/);
      }
    }
  });

  it('6. a session survives a gateway restart (file-backed database)', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    const path = tmp.path('gw.sqlite');
    const first = setup(initDatabase(path, 'demo', T0));
    const token = pair(first.api, TEST_ONLY_PAIRING_CODE);
    first.db.close();

    const db = initDatabase(path, 'demo', T0);
    const api = createLocalApi({ db, clock: () => NOW });
    expect(get(api, API_V1_ROUTES.session, token).status).toBe(200);
    db.close();
  });

  it('exposes no robot-control route', () => {
    const { api } = setup();
    const token = pair(api, TEST_ONLY_PAIRING_CODE);
    for (const path of ['/api/v1/robot/start', '/api/v1/robot/stop', '/api/v1/robot/commands', '/api/v1/dose']) {
      const res = api.handle({ method: 'POST', path, authorization: `Bearer ${token}`, body: {} });
      expect(res.status).toBe(404);
    }
    expect(get(api, API_V1_ROUTES.robotStatus, token).status).toBe(200);
    expect(api.handle({ method: 'POST', path: API_V1_ROUTES.robotStatus, authorization: `Bearer ${token}` }).status).toBe(405);
  });

  it('gives actionable guidance when no pairing code is provisioned', () => {
    const db = initDatabase(':memory:', 'field', T0);
    const api = createLocalApi({ db, clock: () => NOW });
    const res = api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: TEST_ONLY_PAIRING_CODE } });
    expect(res.status).toBe(503);
    expect((res.body as ApiErrorBody).error.message).toContain('pairing:provision');
  });

  it('rejects malformed pairing requests', () => {
    const { api } = setup();
    expect(api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: 'x' }).status).toBe(400);
    expect(api.handle({ method: 'GET', path: API_V1_ROUTES.pairing }).status).toBe(405);
  });

  it('answers malformed percent-encoding in a run id with 400 instead of throwing', () => {
    const { api } = setup();
    const token = pair(api, TEST_ONLY_PAIRING_CODE);
    const res = get(api, '/api/v1/runs/%E0%A4%A/readings', token);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('BAD_REQUEST');
  });
});
