import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GatewayConfigError,
  isAssignedLocalIpv4,
  isLoopbackAddress,
  isRfc1918Ipv4,
  parseLanAddress,
  parseLanMode,
  resolveHttpConfig,
  type NetworkInterfacesProvider,
} from './config';

/** A fake interface list (no real network access): one private IPv4 on "wlan0". */
const interfacesWith =
  (...addresses: string[]): NetworkInterfacesProvider =>
  () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: addresses.map((address) => ({ address, family: 'IPv4', internal: false })),
  });
const LAN = '192.168.137.1';

describe('resolveHttpConfig', () => {
  it('defaults to loopback 127.0.0.1 and the documented port', () => {
    expect(resolveHttpConfig({})).toEqual({ mode: 'loopback', host: '127.0.0.1', port: 8780, webDir: null });
    expect(DEFAULT_GATEWAY_HOST).toBe('127.0.0.1');
    expect(DEFAULT_GATEWAY_PORT).toBe(8780);
  });

  it('treats blank values (as in .env.example) as unset', () => {
    expect(resolveHttpConfig({ GATEWAY_HOST: '', GATEWAY_PORT: '  ' })).toEqual({ mode: 'loopback', host: '127.0.0.1', port: 8780, webDir: null });
  });

  it('accepts loopback addresses and valid ports, with CLI flags taking precedence over the environment', () => {
    expect(resolveHttpConfig({ GATEWAY_HOST: '127.0.0.2', GATEWAY_PORT: '9000' })).toEqual({ mode: 'loopback', host: '127.0.0.2', port: 9000, webDir: null });
    expect(resolveHttpConfig({ GATEWAY_HOST: '::1' })).toEqual({ mode: 'loopback', host: '::1', port: 8780, webDir: null });
    expect(resolveHttpConfig({ GATEWAY_PORT: '9000' }, { port: '9100', host: '127.0.0.1' })).toEqual({
      mode: 'loopback',
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

describe('LAN mode (decision D36)', () => {
  const deps = { networkInterfaces: interfacesWith(LAN) };

  it('stays loopback-only by default, even when an assigned private address exists', () => {
    expect(resolveHttpConfig({}, {}, deps)).toMatchObject({ mode: 'loopback', host: '127.0.0.1' });
    expect(resolveHttpConfig({ GATEWAY_LAN_MODE: '' }, {}, deps)).toMatchObject({ mode: 'loopback' });
    expect(resolveHttpConfig({ GATEWAY_LAN_MODE: 'off' }, {}, deps)).toMatchObject({ mode: 'loopback' });
  });

  it('requires the opt-in: a private address alone is refused', () => {
    expect(() => resolveHttpConfig({ GATEWAY_HOST: LAN }, {}, deps)).toThrow(/LAN mode is off/);
    expect(() => resolveHttpConfig({ GATEWAY_LAN_MODE: 'off', GATEWAY_HOST: LAN }, {}, deps)).toThrow(/LAN mode is off/);
  });

  it('requires an address: the opt-in alone is refused (no fallback to loopback)', () => {
    for (const config of [{ GATEWAY_LAN_MODE: 'on' }, { GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '  ' }]) {
      expect(() => resolveHttpConfig(config, {}, deps)).toThrow(/no address is set/);
    }
    expect(() => resolveHttpConfig({}, { lan: true }, deps)).toThrow(/no address is set/);
  });

  it('enables LAN mode with GATEWAY_LAN_MODE=on (any case) or --lan, for an assigned RFC 1918 address', () => {
    for (const value of ['on', 'ON', ' On ']) {
      expect(resolveHttpConfig({ GATEWAY_LAN_MODE: value, GATEWAY_HOST: LAN, GATEWAY_PORT: '8780' }, {}, deps)).toEqual({
        mode: 'lan',
        host: LAN,
        port: 8780,
        webDir: null,
      });
    }
    expect(resolveHttpConfig({ GATEWAY_HOST: LAN }, { lan: true }, deps)).toMatchObject({ mode: 'lan', host: LAN });
    // An absent --lan defers to the environment; it does not turn LAN mode off.
    expect(resolveHttpConfig({ GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: LAN }, { lan: undefined }, deps)).toMatchObject({ mode: 'lan' });
    // --host takes precedence over GATEWAY_HOST in LAN mode too.
    expect(resolveHttpConfig({ GATEWAY_HOST: '10.0.0.9' }, { lan: true, host: LAN }, deps)).toMatchObject({ host: LAN });
  });

  it.each(['yes', 'true', '1', 'enabled', 'onn', 'o n'])('fails closed on the invalid GATEWAY_LAN_MODE value %s', (value) => {
    expect(() => resolveHttpConfig({ GATEWAY_LAN_MODE: value, GATEWAY_HOST: LAN }, {}, deps)).toThrow(/must be "on" or "off"/);
    expect(() => parseLanMode(value)).toThrow(GatewayConfigError);
  });

  it.each(['maybe', 'yes', '0'])('fails closed on the invalid GATEWAY_LAN_MODE value %s even with --lan', (value) => {
    expect(() => resolveHttpConfig({ GATEWAY_LAN_MODE: value, GATEWAY_HOST: LAN }, { lan: true }, deps)).toThrow(
      /must be "on" or "off"/,
    );
  });

  it('lets --lan enable LAN mode when GATEWAY_LAN_MODE is a valid "off"', () => {
    expect(resolveHttpConfig({ GATEWAY_LAN_MODE: 'off', GATEWAY_HOST: LAN }, { lan: true }, deps)).toMatchObject({
      mode: 'lan',
      host: LAN,
    });
  });

  it.each([
    '10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255', '192.168.137.1',
  ])('classifies %s as RFC 1918', (host) => {
    expect(isRfc1918Ipv4(host)).toBe(true);
    expect(parseLanAddress(host, interfacesWith(host))).toBe(host);
  });

  it.each([
    ['172.15.255.255', /public address/],
    ['172.32.0.0', /public address/],
    ['192.169.0.1', /public address/],
    ['11.0.0.1', /public address/],
    ['8.8.8.8', /public address/],
    ['169.254.1.1', /link-local/],
    ['100.64.0.1', /carrier-grade NAT/],
    ['100.127.255.255', /carrier-grade NAT/],
    ['224.0.0.1', /multicast or reserved/],
    ['255.255.255.255', /multicast or reserved/],
    ['0.0.0.0', /every network interface/],
    ['::', /every network interface/],
    ['127.0.0.1', /loopback/],
    ['fe80::1', /IPv6/],
    ['fd00::1', /IPv6/],
    ['::ffff:192.168.1.10', /IPv6/],
    ['localhost', /not an IP address literal/],
    ['gateway.local', /not an IP address literal/],
    ['192.168.1.10:8780', /not an IP address literal/],
    ['192.168.001.010', /not an IP address literal/],
    ['192.168.1', /not an IP address literal/],
  ])('refuses %s in LAN mode, with no fallback', (host, reason) => {
    expect(isRfc1918Ipv4(host)).toBe(false);
    // Even if the (fake) machine "had" the address, the policy refuses it.
    expect(() => resolveHttpConfig({ GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: host }, {}, { networkInterfaces: interfacesWith(host) })).toThrow(reason);
  });

  it('refuses a private address that is not assigned to any local interface (no fallback)', () => {
    expect(() => resolveHttpConfig({ GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '10.9.8.7' }, {}, deps)).toThrow(/not assigned/);
    // An internal (loopback-type) entry or an IPv6 entry with the same text does not count as assigned.
    const odd: NetworkInterfacesProvider = () => ({
      x: [{ address: '10.9.8.7', family: 'IPv4', internal: true }],
      y: [{ address: '10.9.8.7', family: 'IPv6', internal: false }],
    });
    expect(isAssignedLocalIpv4('10.9.8.7', odd)).toBe(false);
    expect(isAssignedLocalIpv4('10.9.8.7', () => ({ z: [{ address: '10.9.8.7', family: 4, internal: false }] }))).toBe(true);
    expect(isAssignedLocalIpv4('10.9.8.7', () => ({ z: undefined }))).toBe(false);
  });

  it('never echoes unrelated settings (e.g. secrets) in LAN-mode errors', () => {
    const secret = 'TEST-ONLY-NOT-A-REAL-KEY';
    for (const env of [
      { GATEWAY_LAN_MODE: 'on', GATEWAY_HOST: '8.8.8.8', SUPABASE_SERVICE_ROLE_KEY: secret },
      { GATEWAY_LAN_MODE: 'on', SUPABASE_SERVICE_ROLE_KEY: secret },
      { GATEWAY_LAN_MODE: secret, GATEWAY_HOST: LAN },
    ]) {
      let message = '';
      try {
        resolveHttpConfig(env, {}, deps);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });
});

describe('isLoopbackAddress', () => {
  it('recognises 127.0.0.0/8 and ::1 only', () => {
    expect(['127.0.0.1', '127.255.255.254', '::1'].every(isLoopbackAddress)).toBe(true);
    expect(['0.0.0.0', '128.0.0.1', '192.168.0.1', '::', 'localhost'].some(isLoopbackAddress)).toBe(false);
  });
});
