import { API_V1_ROUTES, type ApiErrorBody, type ExportCsvResponse, type ExportRunsResponse, type PairingResponse } from '@robolime/shared';
import { describe, expect, it } from 'vitest';

import { initDatabase } from '../db/init';
import { PAIRED_HEADER } from '../exports/pairedExport';
import { READINGS_HEADER } from '../exports/readingsExport';
import { provisionPairingCredential } from '../pairing/sessions';
import { DEMO_DOSING_RUN, DEMO_SOURCE_ROBOT_ID, DEMO_VERIFICATION_RUN, seedDemo } from '../seed/demo';
import { recordReading } from '../store/readings';
import { getRobotBySourceId, provisionRobot } from '../store/robots';
import { T0, TEST_ONLY_OTHER_PAIRING_CODE, TEST_ONLY_PAIRING_CODE, testReading } from '../test/helpers';
import { splitCsvLine } from './exportRoutes';
import { createLocalApi, type ApiResponse } from './localApi';

/** D54: research exports over the loopback API; same CSVs as `export:csv`. */
function setup() {
  const db = initDatabase(':memory:', 'demo', T0);
  seedDemo(db);
  const demo = getRobotBySourceId(db, DEMO_SOURCE_ROBOT_ID);
  if (!demo) throw new Error('demo robot missing');
  const other = provisionRobot(db, { sourceRobotId: 'OTHER', displayName: 'Other robot', isSynthetic: true }, T0);
  const otherRun = recordReading(db, testReading({ sourceRobotId: 'OTHER', sourceRunId: 'OTHER-RUN' }), T0).runId;
  provisionPairingCredential(db, { robotId: demo.id, code: TEST_ONLY_PAIRING_CODE, now: T0 });
  provisionPairingCredential(db, { robotId: other.id, code: TEST_ONLY_OTHER_PAIRING_CODE, now: T0 });
  const api = createLocalApi({ db, clock: () => new Date('2026-03-01T12:00:00.000Z') });
  const pair = (code: string) =>
    (api.handle({ method: 'POST', path: API_V1_ROUTES.pairing, body: { pairingCode: code } }).body as PairingResponse).sessionToken;
  const id = (source: string) => String(db.prepare('SELECT id FROM runs WHERE source_run_id = ?').get(source)?.id);
  return { api, token: pair(TEST_ONLY_PAIRING_CODE), otherToken: pair(TEST_ONLY_OTHER_PAIRING_CODE), dosing: id(DEMO_DOSING_RUN), verification: id(DEMO_VERIFICATION_RUN), otherRun };
}

const csv = (api: ReturnType<typeof createLocalApi>, token: string | null, body: unknown): ApiResponse =>
  api.handle({ method: 'POST', path: API_V1_ROUTES.exportCsv, authorization: token === null ? null : `Bearer ${token}`, body });
const code = (res: ApiResponse) => (res.body as ApiErrorBody).error.code;

describe('export routes (D54)', () => {
  it('require a paired session', () => {
    const { api } = setup();
    expect(code(api.handle({ method: 'GET', path: API_V1_ROUTES.exportRuns }))).toBe('UNPAIRED');
    expect(code(csv(api, null, { kind: 'readings', runId: 'x' }))).toBe('UNPAIRED');
  });

  it('list this robot’s dosing AND verification runs, never another robot’s', () => {
    const { api, token, otherRun } = setup();
    const res = api.handle({ method: 'GET', path: API_V1_ROUTES.exportRuns, authorization: `Bearer ${token}` });
    const runs = (res.body as ExportRunsResponse).runs;
    expect(runs.map((r) => r.sourceRunId).sort()).toEqual([DEMO_DOSING_RUN, DEMO_VERIFICATION_RUN].sort());
    expect(new Set(runs.map((r) => r.runType))).toEqual(new Set(['dosing', 'verification']));
    expect(runs.some((r) => r.id === otherRun)).toBe(false);
  });

  it('return the readings CSV with the documented header', () => {
    const { api, token, dosing } = setup();
    const res = csv(api, token, { kind: 'readings', runId: dosing });
    expect(res.status).toBe(200);
    const body = res.body as ExportCsvResponse;
    expect(splitCsvLine(body.csv.split(/\r?\n/)[0] ?? '')).toEqual([...READINGS_HEADER]);
    expect(body.rows).toBeGreaterThan(0);
    expect(body.filename).toBe(`readings_${DEMO_DOSING_RUN}.csv`);
  });

  it('return the paired CSV with pair counts, and refuse a dosing run as the verification run', () => {
    const { api, token, dosing, verification } = setup();
    const body = csv(api, token, { kind: 'paired', runId: dosing, verificationRunId: verification }).body as ExportCsvResponse;
    expect(splitCsvLine(body.csv.split(/\r?\n/)[0] ?? '')).toEqual([...PAIRED_HEADER]);
    expect(body.pairCounts?.paired).toBeGreaterThan(0);
    expect(code(csv(api, token, { kind: 'paired', runId: dosing, verificationRunId: dosing }))).toBe('BAD_REQUEST');
    expect(code(csv(api, token, { kind: 'paired', runId: dosing }))).toBe('BAD_REQUEST');
  });

  it('return the delivery CSV with completeness figures and the first-attempt note (#15)', () => {
    const { api, token, dosing } = setup();
    const body = csv(api, token, { kind: 'delivery', runId: dosing }).body as ExportCsvResponse;
    expect(body.delivery?.firstAttemptNote).toMatch(/OPEN_ITEMS #15/);
    expect(body.delivery?.completenessDenominator).toBe(20);
  });

  it('hide other robots’ runs and reject malformed requests', () => {
    const { api, token, otherToken, dosing, otherRun } = setup();
    expect(code(csv(api, token, { kind: 'readings', runId: otherRun }))).toBe('NOT_FOUND');
    expect(code(csv(api, otherToken, { kind: 'readings', runId: dosing }))).toBe('NOT_FOUND');
    expect(code(csv(api, token, { kind: 'everything', runId: dosing }))).toBe('BAD_REQUEST');
    expect(code(api.handle({ method: 'GET', path: API_V1_ROUTES.exportCsv, authorization: `Bearer ${token}` }))).toBe('METHOD_NOT_ALLOWED');
  });
});
