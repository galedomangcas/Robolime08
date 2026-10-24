import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

/**
 * Opt-in static serving of the exported web app (Phase 5 M5a, decision D33).
 *
 * At startup the export folder is scanned ONCE into an exact allowlist of URL
 * paths, and every allowed file is read into memory. A request is a map
 * lookup by its exact pathname: no filesystem path is ever built from the URL,
 * so traversal (`..`, encoded forms, backslashes, NUL) and symlink swaps after
 * startup cannot reach other files, and error responses never contain paths.
 *
 * Allowed: `/` and `/index.html` (the app shell), `/favicon.ico`, and regular
 * files under `/_expo/static/` with an allowed extension. Everything else —
 * including Expo's `metadata.json`, dotfiles, directories and symlinks — is
 * not served. There is no single-page-app fallback: unknown paths get 404.
 * Rebuilding the export requires restarting the gateway.
 */

const sha256Source = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * A browser hashes an inline style's TEXT AS PARSED, not the file bytes. For
 * a <style> element (RAWTEXT) the HTML parser changes exactly two things:
 * - input-stream preprocessing normalizes newlines: CRLF and lone CR → LF;
 * - in the RAWTEXT state, U+0000 is replaced by U+FFFD.
 * The element ends at the first `</style` followed by whitespace, `/` or `>`
 * (case-insensitive). Verified in Edge (D33): a CRLF index.html is hashed by
 * the browser exactly like its LF version.
 */
const OPEN_STYLE = /<style(?=[\t\n\f />])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const CLOSE_STYLE = /<\/style[\t\n\f />]/i;

function inlineStyleTexts(html: string): string[] {
  const normalized = html.replace(/\r\n?/g, '\n');
  const texts: string[] = [];
  for (const open of normalized.matchAll(OPEN_STYLE)) {
    const start = open.index + open[0].length;
    const close = CLOSE_STYLE.exec(normalized.slice(start));
    if (close === null) continue; // unterminated: no hash, so the browser would block it (fails closed)
    texts.push(normalized.slice(start, start + close.index).replace(/\0/g, String.fromCharCode(0xfffd)));
  }
  return texts;
}

/**
 * CSP hash sources for the inline styles the app needs, and nothing more
 * ('unsafe-inline' is NOT used; decision D33, verified in a browser):
 * - each inline <style> in the served index.html (Expo's "expo-reset"),
 *   hashed as the browser parses it, so a rebuilt export (LF or CRLF) stays
 *   covered after a gateway restart;
 * - the empty string, because react-native-web creates an EMPTY <style>
 *   element and fills it through the CSSOM (insertRule), which CSP does not
 *   govern. This hash only permits an empty style element.
 */
export function inlineStyleHashes(indexHtml: string): string[] {
  return [...new Set([...inlineStyleTexts(indexHtml), ''].map(sha256Source))].sort();
}

/** The static CSP: same origin only, no inline scripts, styles only by hash. */
export function contentSecurityPolicy(styleHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    ["style-src 'self'", ...styleHashes].join(' '),
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

function securityHeaders(csp: string): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Expo puts a content hash in bundle names, e.g. index-bbb209777cb2cc5e344db2bea4ca4185.js. */
const CONTENT_HASHED = /-[0-9a-f]{16,}\.[a-z0-9]+$/;

/** Refuse to load an implausibly large export into memory. */
export const MAX_STATIC_SITE_BYTES = 64 * 1024 * 1024;

export interface StaticFile {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

export interface StaticSite {
  /** Exact URL pathname → file. */
  readonly files: ReadonlyMap<string, StaticFile>;
  /** Security headers (including the CSP) sent with every static response, 404s included. */
  readonly headers: Readonly<Record<string, string>>;
}

export class StaticSiteError extends Error {
  override name = 'StaticSiteError';
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Scans and loads the export; throws a StaticSiteError describing what is wrong. */
export function loadStaticSite(dir: string): StaticSite {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    throw new StaticSiteError(`Web export folder not found: ${dir}. Build it with "npm run build:web -w @robolime/mobile".`);
  }
  if (!statSync(root).isDirectory()) throw new StaticSiteError(`Web export path is not a folder: ${dir}`);

  const files = new Map<string, StaticFile>();
  let total = 0;
  const add = (urlPath: string, absPath: string, cacheControl: string) => {
    const contentType = CONTENT_TYPES[extname(absPath).toLowerCase()];
    if (contentType === undefined) return;
    // Defence in depth: the file must really live inside the export folder.
    const real = realpathSync(absPath);
    if (!real.startsWith(root + sep)) return;
    const body = readFileSync(real);
    total += body.length;
    if (total > MAX_STATIC_SITE_BYTES) throw new StaticSiteError(`Web export is larger than ${MAX_STATIC_SITE_BYTES} bytes.`);
    files.set(urlPath, { body, contentType, cacheControl });
  };

  const index = join(root, 'index.html');
  if (!regularFile(index)) throw new StaticSiteError(`Web export has no index.html (as a regular file): ${dir}`);
  add('/', index, 'no-store');
  files.set('/index.html', files.get('/') as StaticFile);

  const favicon = join(root, 'favicon.ico');
  if (regularFile(favicon)) add('/favicon.ico', favicon, 'no-cache');

  const assetRoot = join(root, '_expo', 'static');
  const walk = (folder: string) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const abs = join(folder, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const url = `/${relative(root, abs).split(sep).join('/')}`;
        add(url, abs, CONTENT_HASHED.test(entry.name) ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    }
  };
  walk(assetRoot);
  const shell = files.get('/') as StaticFile;
  return { files, headers: securityHeaders(contentSecurityPolicy(inlineStyleHashes(shell.body.toString('utf8')))) };
}

function sendText(res: ServerResponse, site: StaticSite, status: number, text: string, extra: Record<string, string> = {}): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...site.headers,
    ...extra,
  });
  res.end(body);
}

/** Serves one static request. Returns the HTTP status for the request log. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, site: StaticSite): number {
  const method = req.method ?? '';
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(res, site, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    return 405;
  }
  // Only canonical targets: the raw path must equal the parsed one, so
  // "//x", "/a/../index.html" and percent-encoded forms are never resolved.
  const rawPath = (req.url ?? '').split('?')[0];
  const file = rawPath === path ? site.files.get(path) : undefined;
  if (file === undefined) {
    sendText(res, site, 404, 'Not found.');
    return 404;
  }
  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': file.body.length,
    'Cache-Control': file.cacheControl,
    ...site.headers,
  });
  res.end(method === 'HEAD' ? undefined : file.body);
  return 200;
}
