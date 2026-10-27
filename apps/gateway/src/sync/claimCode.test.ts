import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { claimCodeSha256, provisionCloudClaimCode } from './claimCode';
import { parseCloudTarget } from './postgrest';

const TEST_ONLY_KEY = 'test-only-service-key-0123456789';
const target = parseCloudTarget({ url: 'https://abcdefghijklmnopqrst.supabase.co', serviceRoleKey: TEST_ONLY_KEY }, 'field');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('claimCodeSha256 (matches claim_robot normalisation)', () => {
  it('hashes the upper-cased code without separators, mapping O/I/L', () => {
    expect(claimCodeSha256('abcd-2345-efgh')).toBe(sha('ABCD2345EFGH'));
    expect(claimCodeSha256('oil1 2345 efgh')).toBe(sha('01112345EFGH'));
  });
});

describe('provisionCloudClaimCode', () => {
  it('sends only the hash, with the service key, and returns the generated code once', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const result = await provisionCloudClaimCode({
      target,
      sourceRobotId: 'ROBOT-1',
      generate: () => 'ABCD-2345-EFGH',
      fetch: async (url, init) => {
        calls.push({ url, body: init.body, headers: init.headers });
        return { status: 200, text: async () => '"458df5a8-212c-54c7-ac9b-364ab56d03b3"' };
      },
    });
    expect(result).toEqual({ ok: true, code: 'ABCD-2345-EFGH', robotId: '458df5a8-212c-54c7-ac9b-364ab56d03b3' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/provision_robot_claim_code');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ p_source_robot_id: 'ROBOT-1', p_code_sha256: sha('ABCD2345EFGH') });
    expect(calls[0]?.body).not.toContain('ABCD');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_ONLY_KEY}`);
  });

  it.each([
    [401, '{}', 'refused the gateway key'],
    [404, '{"code":"PGRST202"}', 'no claim-flow schema'],
    [404, '{"code":"P0002"}', 'has not been synchronised'],
    [500, '{}', 'HTTP 500'],
  ])('reports HTTP %i without the key or a code', async (status, body, expected) => {
    const result = await provisionCloudClaimCode({
      target,
      sourceRobotId: 'ROBOT-1',
      generate: () => 'ABCD-2345-EFGH',
      fetch: async () => ({ status, text: async () => body }),
    });
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.message;
    expect(message).toContain(expected);
    expect(message).not.toContain(TEST_ONLY_KEY);
    expect(message).not.toContain('ABCD');
  });

  it('reports an unreachable project', async () => {
    const result = await provisionCloudClaimCode({
      target,
      sourceRobotId: 'ROBOT-1',
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    expect(result).toEqual({ ok: false, message: 'Cannot reach the cloud project (no internet?). Nothing was changed.' });
  });
});
