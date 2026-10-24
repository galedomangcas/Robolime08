import { API_V1_BASE_PATH } from '@robolime/shared';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { apiErrorResponse, type ApiResponse, type LocalApi } from '../api/localApi';
import {
  CONNECTIONS_CHECK_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_JSON_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  isLoopbackAddress,
} from './config';
import { serveStatic, type StaticSite } from './static';

/**
 * Thin `node:http` transport for the local API (Phase 4, milestone 1).
 *
 * All routing, validation, pairing and robot-scoped authorization stay in
 * `createLocalApi`; this layer only turns HTTP into `ApiRequest` objects and
 * `ApiResponse` objects into JSON. It adds no routes — in particular no
 * robot-control routes. Outside /api/ it serves only the optional, opt-in
 * static web export (`staticSite`, decision D33); paths under /api/ always
 * go to the API, never to static files.
 *
 * Browser-originated requests (decision D28): every request must carry a
 * `Host` naming this server's own loopback address and port (or
 * `localhost:<port>`), which defeats DNS-rebinding; and every POST must be
 * `application/json`, which browsers cannot send cross-origin without a CORS
 * preflight that this server never approves. Both checks run before the
 * request reaches the API. They complement, and do not replace, loopback-only
 * binding and the API's session authorization.
 *
 * Logging: only method, path WITHOUT query string, status and duration. Never
 * headers (Authorization, Host), bodies (pairing codes) or tokens.
 */

export interface HttpRequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface HttpErrorLog {
  /** Error class name only; messages may contain request data and are not logged. */
  errorName: string;
  method: string;
  path: string;
}

/** Connection timeouts in milliseconds. Production uses the constants in config.ts. */
export interface HttpTimeouts {
  headersMs: number;
  requestMs: number;
  keepAliveMs: number;
  /** How often Node checks open connections against headersMs/requestMs. */
  checkIntervalMs: number;
}

export interface GatewayHttpServerOptions {
  api: LocalApi;
  host: string;
  /** 0 = ephemeral (tests). */
  port: number;
  maxBodyBytes?: number;
  /** Tests only: shorter timeouts so enforcement can be observed quickly. */
  timeouts?: Partial<HttpTimeouts>;
  onRequest?: (entry: HttpRequestLog) => void;
  onError?: (entry: HttpErrorLog) => void;
  /** Opt-in exported web app (D33). Absent: non-API paths get the API's JSON 404, as before. */
  staticSite?: StaticSite;
}

export interface RunningGatewayHttpServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Stops accepting connections, closes idle ones, and resolves once closed. */
  close(): Promise<void>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST']);
const API_PREFIX = `${API_V1_BASE_PATH}/`;

/** Everything under /api is reserved for the API, including unknown versions. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
}

/**
 * Host header values accepted by a server bound to `address:port`
 * (lower-case): the bound literal (IPv6 in brackets) and `localhost`, each
 * with the port. The port may be omitted only when it is 80.
 */
export function allowedHostHeaders(address: string, port: number): ReadonlySet<string> {
  const names = [address.includes(':') ? `[${address}]` : address, 'localhost'];
  const values = names.map((name) => `${name}:${port}`);
  if (port === 80) values.push(...names);
  return new Set(values.map((value) => value.toLowerCase()));
}

export function isAllowedHost(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof header === 'string' && allowed.has(header.trim().toLowerCase());
}

/** `application/json`, optionally with parameters; a charset, if present, must be UTF-8. */
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const [mediaType, ...params] = header.split(';');
  if (mediaType?.trim().toLowerCase() !== 'application/json') return false;
  for (const param of params) {
    const [name, value] = param.split('=');
    if (name?.trim().toLowerCase() !== 'charset') continue;
    const charset = (value ?? '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    if (charset !== 'utf-8' && charset !== 'utf8') return false;
  }
  return true;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, response: ApiResponse, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(payload);
}

/** Request path without query string, for routing and logs. Null if unparseable. */
function pathOf(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith('/')) return null;
  try {
    return new URL(rawUrl, 'http://gateway.invalid').pathname;
  } catch {
    return null;
  }
}

/**
 * `allowedHosts` is read per request because the real port is only known
 * once the server is listening (port 0 in tests).
 */
export function createRequestListener(options: GatewayHttpServerOptions, allowedHosts: () => ReadonlySet<string>) {
  const limit = options.maxBodyBytes ?? MAX_JSON_BODY_BYTES;

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<number> {
    const method = req.method ?? '';
    // Runs after the Host check in the listener below, so static files keep
    // the same DNS-rebinding defence as the API.
    if (options.staticSite !== undefined && !isApiPath(path)) {
      return serveStatic(req, res, path, options.staticSite);
    }
    if (!ALLOWED_METHODS.has(method)) {
      const response = apiErrorResponse('METHOD_NOT_ALLOWED');
      send(res, response, { Allow: 'GET, POST' });
      return response.status;
    }
    if (!path.startsWith(API_PREFIX)) {
      const response = apiErrorResponse('NOT_FOUND', 'Unknown API route.');
      send(res, response);
      return response.status;
    }
    // Checked before any of the body is read; the connection is not reused.
    if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
      const response = apiErrorResponse('UNSUPPORTED_MEDIA_TYPE');
      send(res, response, { Connection: 'close' });
      return response.status;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req, limit);
    } catch (error) {
      const response =
        error instanceof BodyTooLargeError
          ? apiErrorResponse('PAYLOAD_TOO_LARGE', `The request body exceeds ${limit} bytes.`)
          : apiErrorResponse('BAD_REQUEST', 'The request body could not be read.');
      // Do not keep reading an oversized upload on this connection.
      send(res, response, { Connection: 'close' });
      return response.status;
    }

    let body: unknown;
    if (method === 'POST' && raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        const response = apiErrorResponse('BAD_REQUEST', 'The request body must be valid JSON.');
        send(res, response);
        return response.status;
      }
    }

    const response = options.api.handle({
      method,
      // The handler routes on the path and strips any query itself; pass the
      // parsed pathname so absolute-form request targets are normalised.
      path,
      authorization: req.headers.authorization ?? null,
      body,
      // The socket's peer address only. Forwarded headers (X-Forwarded-For,
      // Forwarded) are never trusted: no proxy sits in front of this server.
      clientAddress: req.socket.remoteAddress ?? null,
    });
    send(res, response, response.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(response.retryAfterSeconds) });
    return response.status;
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    const started = performance.now();
    const method = req.method ?? '';
    const path = pathOf(req.url);
    const logPath = path ?? '<invalid>';

    const finish = (status: number) =>
      options.onRequest?.({ method, path: logPath, status, durationMs: Math.round(performance.now() - started) });

    if (!isAllowedHost(req.headers.host, allowedHosts())) {
      // The rejected Host value is not echoed or logged.
      const response = apiErrorResponse('BAD_REQUEST', 'This gateway only answers requests addressed to its own loopback address.');
      send(res, response, { Connection: 'close' });
      finish(response.status);
      return;
    }

    if (path === null) {
      const response = apiErrorResponse('BAD_REQUEST', 'The request target is not valid.');
      send(res, response);
      finish(response.status);
      return;
    }

    handle(req, res, path).then(finish, (error: unknown) => {
      options.onError?.({ errorName: error instanceof Error ? error.name : typeof error, method, path: logPath });
      const response = apiErrorResponse('INTERNAL_ERROR');
      if (!res.headersSent) send(res, response, { Connection: 'close' });
      else res.destroy();
      finish(response.status);
    });
  };
}

/**
 * Starts the server and resolves once it is listening. Refuses non-loopback
 * hosts as defence in depth (configuration is validated in `config.ts` too).
 */
export function startGatewayHttpServer(options: GatewayHttpServerOptions): Promise<RunningGatewayHttpServer> {
  if (!isLoopbackAddress(options.host)) {
    return Promise.reject(new Error('The gateway HTTP server only binds to loopback addresses in this build.'));
  }
  const timeouts: HttpTimeouts = {
    headersMs: HEADERS_TIMEOUT_MS,
    requestMs: REQUEST_TIMEOUT_MS,
    keepAliveMs: KEEP_ALIVE_TIMEOUT_MS,
    checkIntervalMs: CONNECTIONS_CHECK_INTERVAL_MS,
    ...options.timeouts,
  };
  let allowedHosts: ReadonlySet<string> = new Set();
  // Timeouts are passed at construction: Node only sweeps for header/request
  // timeouts every connectionsCheckingInterval (default 30 s), so without it
  // a stalled request outlives its configured timeout by up to 30 s.
  // Node rejects headersTimeout > requestTimeout (ERR_OUT_OF_RANGE).
  const server = createServer(
    {
      headersTimeout: timeouts.headersMs,
      requestTimeout: timeouts.requestMs,
      keepAliveTimeout: timeouts.keepAliveMs,
      connectionsCheckingInterval: timeouts.checkIntervalMs,
    },
    createRequestListener(options, () => allowedHosts),
  );

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      allowedHosts = allowedHostHeaders(address.address, address.port);
      const hostForUrl = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      resolve({
        server,
        host: address.address,
        port: address.port,
        url: `http://${hostForUrl}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeIdleConnections();
          }),
      });
    });
  });
}
