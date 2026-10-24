import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GatewayConfigError,
  isLoopbackAddress,
  resolveHttpConfig,
} from './config';

describe('resolveHttpConfig', () => {
  it('defaults to loopback 127.0.0.1 and the documented port', () => {
    expect(resolveHttpConfig({})).toEqual({ host: '127.0.0.1', port: 8780, webDir: null });
    expect(DEFAULT_GATEWAY_HOST).toBe('127.0.0.1');
    expect(DEFAULT_GATEWAY_PORT).toBe(8780);
  });

  it('treats blank values (as in .env.example) as unset', () => {
    expect(resolveHttpConfig({ GATEWAY_HOST: '', GATEWAY_PORT: '  ' })).toEqual({ host: '127.0.0.1', port: 8780, webDir: null });
  });

  it('accepts loopback addresses and valid ports, with CLI flags taking precedence over the environment', () => {
    expect(resolveHttpConfig({ GATEWAY_HOST: '127.0.0.2', GATEWAY_PORT: '9000' })).toEqual({ host: '127.0.0.2', port: 9000, webDir: null });
    expect(resolveHttpConfig({ GATEWAY_HOST: '::1' })).toEqual({ host: '::1', port: 8780, webDir: null });
    expect(resolveHttpConfig({ GATEWAY_PORT: '9000' }, { port: '9100', host: '127.0.0.1' })).toEqual({
      host: '127.0.0.1',
      port: 9100,
      webDir: null,
    });
    expect(resolveHttpConfig({}, { port: '65535' }).port).toBe(65535);
    expect(resolveHttpConfig({}, { port: '1' }).port).toBe(1);
  });

  it.each(['0.0.0.0', '::', '[::]'])('refuses the wildcard address %s instead of falling back to it', (host) => {
    expect(() => resolveHttpConfig({ GATEWAY_HOST: host })).toThrow(GatewayConfigError);
    expect(() => resolveHttpConfig({ GATEWAY_HOST: host })).toThrow(/every network interface/);
  });

  it.each(['192.168.1.10', '10.0.0.5', '172.16.0.1', '::ffff:127.0.0.1', 'fe80::1'])(
    'refuses the non-loopback address %s in this build',
    (host) => {
      expect(() => resolveHttpConfig({ GATEWAY_HOST: host })).toThrow(/not a loopback address/);
    },
  );

  it.each(['localhost', 'gateway.local', '127.0.0', '256.0.0.1', '127.0.0.1:8780', 'http://127.0.0.1'])(
    'refuses the malformed or non-literal host %s',
    (host) => {
      expect(() => resolveHttpConfig({ GATEWAY_HOST: host })).toThrow(/not an IP address/);
    },
  );

  it.each(['0', '65536', '-1', '80.5', 'abc', '1e3', '0x50', '123456'])('refuses the invalid port %s', (port) => {
    expect(() => resolveHttpConfig({ GATEWAY_PORT: port })).toThrow(GatewayConfigError);
  });

  it('never echoes unrelated settings (e.g. secrets) in error messages', () => {
    const env = { GATEWAY_HOST: '0.0.0.0', SUPABASE_SERVICE_ROLE_KEY: 'TEST-ONLY-NOT-A-REAL-KEY' };
    try {
      resolveHttpConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('TEST-ONLY-NOT-A-REAL-KEY');
    }
  });
});

describe('isLoopbackAddress', () => {
  it('recognises 127.0.0.0/8 and ::1 only', () => {
    expect(['127.0.0.1', '127.255.255.254', '::1'].every(isLoopbackAddress)).toBe(true);
    expect(['0.0.0.0', '128.0.0.1', '192.168.0.1', '::', 'localhost'].some(isLoopbackAddress)).toBe(false);
  });
});
