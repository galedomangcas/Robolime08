import { parseCloudConfig } from './cloudConfig';

/** Builds an UNSIGNED, test-only JWT-shaped string with the given payload (never a real key). */
const base64url = (text: string) => globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (payload: Record<string, unknown>) =>
  ['eyJhbGciOiJIUzI1NiJ9', base64url(JSON.stringify(payload)), 'test-signature'].join('.');

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';

describe('public cloud configuration (D49)', () => {
  it('fails closed when either value is missing', () => {
    expect(parseCloudConfig(undefined, undefined)).toEqual({ ok: false, problem: 'missing' });
    expect(parseCloudConfig(URL_OK, '  ')).toEqual({ ok: false, problem: 'missing' });
    expect(parseCloudConfig('', 'sb_publishable_abcdefghij')).toEqual({ ok: false, problem: 'missing' });
  });

  it('accepts only a hosted https project URL', () => {
    for (const bad of ['http://abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co/rest/v1', 'https://evil.example.com', 'https://short.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co.evil.com']) {
      expect(parseCloudConfig(bad, 'sb_publishable_abcdefghij')).toEqual({ ok: false, problem: 'invalid-url' });
    }
  });

  it('accepts a publishable key or an anon JWT for the same project', () => {
    expect(parseCloudConfig(`${URL_OK}/`, 'sb_publishable_abcdefghij')).toMatchObject({ ok: true, projectRef: 'abcdefghijklmnopqrst', url: URL_OK });
    expect(parseCloudConfig(URL_OK, fakeJwt({ role: 'anon', ref: 'abcdefghijklmnopqrst' }))).toMatchObject({ ok: true });
  });

  it('refuses privileged keys and never returns them', () => {
    // Assembled at runtime so no secret-shaped literal sits in the repository (it is fake anyway).
    const secret = ['sb', 'secret', 'TEST_ONLY_NOT_A_KEY'].join('_');
    const serviceRole = fakeJwt({ role: 'service_role', ref: 'abcdefghijklmnopqrst' });
    for (const key of [secret, serviceRole, fakeJwt({ role: 'authenticated' })]) {
      const result = parseCloudConfig(URL_OK, key);
      expect(result).toEqual({ ok: false, problem: 'privileged-key' });
      expect(JSON.stringify(result)).not.toContain(key);
    }
    // A secret key is reported as privileged even with a bad URL.
    expect(parseCloudConfig('nonsense', secret)).toEqual({ ok: false, problem: 'privileged-key' });
  });

  it('rejects malformed keys and a key issued for another project', () => {
    expect(parseCloudConfig(URL_OK, 'not-a-key')).toEqual({ ok: false, problem: 'invalid-key' });
    expect(parseCloudConfig(URL_OK, 'a.b.c')).toEqual({ ok: false, problem: 'invalid-key' });
    expect(parseCloudConfig(URL_OK, fakeJwt({ ref: 'abcdefghijklmnopqrst' }))).toEqual({ ok: false, problem: 'invalid-key' });
    expect(parseCloudConfig(URL_OK, fakeJwt({ role: 'anon', ref: 'zzzzzzzzzzzzzzzzzzzz' }))).toEqual({ ok: false, problem: 'key-project-mismatch' });
  });
});
