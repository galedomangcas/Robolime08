import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createLocalApi } from '../api/localApi';
import { initDatabase } from '../db/init';
import { T0 } from '../test/helpers';
import { resolveHttpConfig } from './config';
import { startGateway } from './serve';
import { startGatewayHttpServer, type RunningGatewayHttpServer } from './server';
import { contentSecurityPolicy, inlineStyleHashes, loadStaticSite, StaticSiteError, type StaticSite } from './static';

const BUNDLE = '/_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js';
const RESET_CSS = '\n      html, body { height: 100%; }\n    ';
const INDEX_HTML = `<!doctype html><title>RoboLime</title><style id="expo-reset">${RESET_CSS}</style><script src="${BUNDLE}" defer></script>`;
const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const OUTSIDE_SECRET = 'OUTSIDE-SECRET-CONTENT';

let base: string;
let exportDir: string;
let symlinkSupported = false;

/** A fake export shaped like the real `expo export --platform web` output, plus hostile extras. */
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'robolime-static-'));
  exportDir = join(base, 'dist');
  const web = join(exportDir, '_expo', 'static', 'js', 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(join(exportDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(exportDir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(exportDir, 'metadata.json'), '{"version":0}');
  writeFileSync(join(exportDir, 'notes.txt'), 'root file not on the allowlist');
  writeFileSync(join(exportDir, '.env'), 'SECRET=1');
  writeFileSync(join(exportDir, `.${BUNDLE}`), 'console.log("bundle");');
  writeFileSync(join(web, '.hidden.js'), 'hidden');
  writeFileSync(join(web, 'index.js.map'), '{}');
  writeFileSync(join(web, 'plain.js'), 'unhashed');
  writeFileSync(join(base, 'outside.txt'), OUTSIDE_SECRET);
  // A directory junction (no special privileges on Windows; a directory
  // symlink elsewhere) pointing at a folder outside the export.
  const outsideDir = join(base, 'outside-dir');
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, 'escape-0123456789abcdef.js'), OUTSIDE_SECRET);
  symlinkSync(outsideDir, join(exportDir, '_expo', 'static', 'js', 'linked'), 'junction');
  try {
    symlinkSync(join(base, 'outside.txt'), join(web, 'link-0123456789abcdef.js'));
    symlinkSupported = true;
  } catch {
    // Creating symlinks needs extra privileges on Windows; the symlink test is skipped then.
  }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

let running: RunningGatewayHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** null = static serving disabled. */
async function start(site?: StaticSite | null) {
  const staticSite = site === null ? undefined : (site ?? loadStaticSite(exportDir));
  const db = initDatabase(':memory:', 'demo', T0);
  running = await startGatewayHttpServer({ api: createLocalApi({ db, clock: () => T0 }), host: '127.0.0.1', port: 0, staticSite });
  return running;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function get(server: RunningGatewayHttpServer, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: server.host, port: server.port, method: opts.method ?? 'GET', path, headers: opts.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Sends the request target byte-for-byte, bypassing any client-side normalisation. */
function rawTarget(server: RunningGatewayHttpServer, target: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, server.host);
    let out = '';
    socket.on('data', (c: Buffer) => (out += c.toString('latin1')));
    socket.on('end', () => resolve({ status: Number(out.split(' ')[1] ?? 0), text: out }));
    socket.on('error', reject);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
  });
}

describe('loadStaticSite: startup validation', () => {
  it('refuses a missing folder, a file, and a folder without index.html', () => {
    expect(() => loadStaticSite(join(base, 'nope'))).toThrow(StaticSiteError);
    expect(() => loadStaticSite(join(base, 'outside.txt'))).toThrow(StaticSiteError);
    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(() => loadStaticSite(empty)).toThrow(/no index\.html/);
  });

  it('allowlists only the app shell, the favicon and allowed files under /_expo/static/', () => {
    const paths = [...loadStaticSite(exportDir).files.keys()].sort();
    expect(paths).toEqual(['/', '/_expo/static/js/web/plain.js', '/favicon.ico', '/index.html', BUNDLE].sort());
  });
});

describe('CSP style hashes', () => {
  it('hashes each inline <style> exactly as served, plus the empty string, and never allows unsafe-inline', () => {
    const html = '<style id="a">a{}</style><STYLE media="x">\nb{}\n</STYLE><script>x()</script>';
    expect(inlineStyleHashes(html)).toEqual([sha(''), sha('a{}'), sha('\nb{}\n')].sort());
    expect(inlineStyleHashes('<p>no styles</p>')).toEqual([sha('')]);
    const csp = contentSecurityPolicy(inlineStyleHashes(html));
    expect(csp).toMatch(/^default-src 'self'; script-src 'self'; style-src 'self' 'sha256-/);
    expect(csp).not.toMatch(/unsafe|\*|https?:/);
  });
});

describe('CSP style hashes follow browser HTML parsing (line endings, NUL, tag boundaries)', () => {
  /** Expo SDK 58 `expo-reset` style text, exactly as exported (LF). */
  const EXPO_RESET =
    '\n      /* These styles make the body full-height */\n      html,\n      body {\n        height: 100%;\n      }\n      /* These styles disable body scrolling if you are using <ScrollView> */\n      body {\n        overflow: hidden;\n      }\n      /* These styles make the root element full-height */\n      #root {\n        display: flex;\n        height: 100%;\n        flex: 1;\n      }\n    ';
  /** Hashes MEASURED in Edge (crypto.subtle over each <style>'s parsed textContent), D33. */
  const BROWSER_EXPO_RESET = "'sha256-+R/ZCHnQviXyQb4aRG+FfnYnvSs95Sh3781AvYd08wc='";
  const BROWSER_EMPTY = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";
  const page = (eol: string) =>
    `<!doctype html>${eol}<html>${eol}<head>${eol}<style id="expo-reset">${EXPO_RESET.replace(/\n/g, eol)}</style>${eol}</head>${eol}</html>`;

  it('matches the hashes the browser computed, for the LF export', () => {
    expect(inlineStyleHashes(page('\n'))).toEqual([BROWSER_EMPTY, BROWSER_EXPO_RESET].sort());
  });

  it('gives the CRLF and lone-CR versions the same hashes as LF (the parser normalizes newlines)', () => {
    expect(inlineStyleHashes(page('\r\n'))).toEqual(inlineStyleHashes(page('\n')));
    expect(inlineStyleHashes(page('\r'))).toEqual(inlineStyleHashes(page('\n')));
    // Raw CRLF bytes would hash differently; that is the bug this guards against.
    expect(inlineStyleHashes(page('\r\n'))).not.toContain(sha(EXPO_RESET.replace(/\n/g, '\r\n')));
  });

  it('hashes every style block once, plus the empty string', () => {
    const html = '<style>a{}</style>\r\n<style media="print">\r\nb{}\r\n</style><style>a{}</style><style></style>';
    expect(inlineStyleHashes(html)).toEqual([sha(''), sha('a{}'), sha('\nb{}\n')].sort());
  });

  it('ends a style at </style followed by whitespace, "/" or ">" (case-insensitive), not at a lookalike', () => {
    expect(inlineStyleHashes('<style>a{}</style >')).toContain(sha('a{}'));
    expect(inlineStyleHashes('<style>a{}</STYLE/>')).toContain(sha('a{}'));
    expect(inlineStyleHashes('<style>a{}</styles>b{}</style>')).toContain(sha('a{}</styles>b{}'));
  });

  it('handles ">" inside quoted attributes, ignores non-style tags, replaces NUL like the parser', () => {
    expect(inlineStyleHashes('<style data-x="a>b">c{}</style>')).toContain(sha('c{}'));
    expect(inlineStyleHashes('<styles>x</styles><style-x>y</style-x>')).toEqual([sha('')]);
    expect(inlineStyleHashes('<style>a\0b</style>')).toContain(sha(`a${String.fromCharCode(0xfffd)}b`));
  });

  it('an unterminated style gets no hash (the browser would then block it: fails closed)', () => {
    expect(inlineStyleHashes('<style>a{}')).toEqual([sha('')]);
  });

  it('loadStaticSite puts the browser-matching hash in the CSP for a CRLF export', () => {
    const dir = join(base, 'crlf-export');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page('\r\n'));
    const csp = loadStaticSite(dir).headers['Content-Security-Policy'] ?? '';
    expect(csp).toContain(BROWSER_EXPO_RESET);
    expect(csp).toContain(BROWSER_EMPTY);
    expect(csp).not.toMatch(/unsafe|\*|https?:/);
    expect(csp).toContain("script-src 'self';");
  });
});

describe('static serving: allowed files and headers', () => {
  it('serves / and /index.html as uncacheable HTML with the restrictive CSP', async () => {
    const server = await start();
    for (const path of ['/', '/index.html', '/?x=1']) {
      const res = await get(server, path);
      expect(res.status, path).toBe(200);
      expect(res.text).toBe(INDEX_HTML);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      const csp = String(res.headers['content-security-policy']);
      for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
        expect(csp).toContain(directive);
      }
      expect(csp).not.toMatch(/script-src[^;]*(unsafe|https?:|\*)/);
      // Styles only by hash: the served inline <style> and the empty <style> react-native-web creates.
      expect(csp).toContain(`style-src 'self' ${[sha(''), sha(RESET_CSS)].sort().join(' ')}`);
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('caches only content-hashed bundles immutably, with correct MIME types', async () => {
    const server = await start();
    const bundle = await get(server, BUNDLE);
    expect(bundle.status).toBe(200);
    expect(bundle.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(bundle.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const plain = await get(server, '/_expo/static/js/web/plain.js');
    expect(plain.headers['cache-control']).toBe('no-cache');
    const icon = await get(server, '/favicon.ico');
    expect(icon.headers['content-type']).toBe('image/x-icon');
  });

  it('answers HEAD without a body and refuses other methods with 405', async () => {
    const server = await start();
    const head = await get(server, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(INDEX_HTML));
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await get(server, '/', { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
    }
  });

  it('adds no CORS headers, even for a cross-origin request', async () => {
    const server = await start();
    const res = await get(server, '/', { headers: { Origin: 'http://evil.example' } });
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

describe('static serving: everything else is 404 with no path leak', () => {
  it('does not serve metadata.json, dotfiles, unlisted files, directories, source maps or unknown paths (no SPA fallback)', async () => {
    const server = await start();
    const paths = [
      '/metadata.json',
      '/.env',
      '/notes.txt',
      '/_expo',
      '/_expo/static/js/web/',
      '/_expo/static/js/web/.hidden.js',
      '/_expo/static/js/web/index.js.map',
      '/dashboard',
      '/index.htm',
      '/INDEX.HTML',
    ];
    for (const path of paths) {
      const res = await get(server, path);
      expect(res.status, path).toBe(404);
      expect(res.text).toBe('Not found.');
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    }
  });

  it('refuses traversal, encoded separators, backslashes and NUL without revealing files or paths', async () => {
    const server = await start();
    const targets = [
      '/../outside.txt',
      '/_expo/static/../../outside.txt',
      '/%2e%2e/outside.txt',
      '/%2E%2E%2Foutside.txt',
      '/_expo%2fstatic%2fjs%2fweb%2fplain.js',
      '/..%5coutside.txt',
      String.raw`/..\outside.txt`,
      '/index.html%00.js',
      '//outside.txt',
    ];
    for (const target of targets) {
      const res = await rawTarget(server, target);
      expect([400, 404], target).toContain(res.status);
      expect(res.text, target).not.toContain('RoboLime</title>');
      expect(res.text, target).not.toContain(OUTSIDE_SECRET);
      expect(res.text, target).not.toContain(base);
    }
  });

  it('does not follow a symlink that points outside the export', async (ctx) => {
    if (!symlinkSupported) ctx.skip();
    const server = await start();
    const res = await get(server, '/_expo/static/js/web/link-0123456789abcdef.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(OUTSIDE_SECRET);
  });

  it('does not follow a directory junction/symlink that points outside the export (runs on Windows without privileges)', async () => {
    const site = loadStaticSite(exportDir);
    expect([...site.files.keys()].some((p) => p.includes('linked') || p.includes('escape'))).toBe(false);
    const server = await start(site);
    const res = await get(server, '/_expo/static/js/linked/escape-0123456789abcdef.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(OUTSIDE_SECRET);
  });

  it('serves the startup snapshot: files changed on disk later are not read', async () => {
    const site = loadStaticSite(exportDir);
    writeFileSync(join(exportDir, 'index.html'), 'REPLACED');
    try {
      const server = await start(site);
      expect((await get(server, '/')).text).toBe(INDEX_HTML);
    } finally {
      writeFileSync(join(exportDir, 'index.html'), INDEX_HTML);
    }
  });
});

describe('static serving: API routes and existing defences are unchanged', () => {
  it('never answers /api paths with static files, even for unknown API routes', async () => {
    const server = await start();
    for (const path of ['/api', '/api/', '/api/v1/robot/status', '/api/v1/unknown', '/api/v2/anything', '/api/index.html']) {
      const res = await get(server, path);
      expect(res.headers['content-type'], path).toBe('application/json; charset=utf-8');
      expect([401, 404], path).toContain(res.status);
      expect(res.text).not.toContain('<!doctype html>');
    }
  });

  it('keeps the Host check for static paths (DNS-rebinding defence)', async () => {
    const server = await start();
    const res = await get(server, '/', { headers: { Host: 'evil.example' } });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('RoboLime</title>');
  });

  it('is disabled unless configured: / keeps the API JSON 404', async () => {
    const server = await start(null);
    const res = await get(server, '/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('reads GATEWAY_WEB_DIR, lets --web-dir override it, and treats blank as disabled', () => {
    expect(resolveHttpConfig({}).webDir).toBeNull();
    expect(resolveHttpConfig({ GATEWAY_WEB_DIR: '  ' }).webDir).toBeNull();
    expect(resolveHttpConfig({ GATEWAY_WEB_DIR: '/env/dist' }).webDir).toBe('/env/dist');
    expect(resolveHttpConfig({ GATEWAY_WEB_DIR: '/env/dist' }, { webDir: '/flag/dist' }).webDir).toBe('/flag/dist');
  });

  it('startGateway fails on a bad export before opening the database', async () => {
    await expect(
      startGateway({ dbPath: join(base, 'no-such.sqlite'), env: {}, webDir: join(base, 'nope'), portOverride: 0 }),
    ).rejects.toThrow(StaticSiteError);
  });
});
