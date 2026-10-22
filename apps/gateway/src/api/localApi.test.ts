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
});
