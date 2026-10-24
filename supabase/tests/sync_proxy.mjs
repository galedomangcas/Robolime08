// TEST-ONLY fault-injecting HTTP proxy for the cloud-sync integration test
// (run by supabase/tests/run-sync-integration.mjs; never used in production).
//
// It sits between the gateway's PostgREST transport and a THROWAWAY local
// PostgREST, both on 127.0.0.1:
//   * strips the `/rest/v1` prefix the transport always adds (Supabase's
//     gateway does this; standalone PostgREST serves tables at `/<table>`);
//   * forwards everything else unchanged and logs nothing (requests carry a
//     bearer token, so headers and bodies are never printed);
//   * injects faults ONLY into requests matching an explicit rule
//     (method and/or table), each rule consumed after `times` matches:
//       - drop_after_commit: forward, wait for the full upstream response (the
//         database has committed), then destroy the client socket with no reply;
//       - status: answer with the given status/body without forwarding;
//       - delay: wait `ms` (optionally running a hook) before forwarding;
//   * setRefusing(true) stops listening AND destroys open sockets, so new
//     connections are refused (ECONNREFUSED); setRefusing(false) re-listens
//     on the same port.
//
// The upstream must be http://127.0.0.1:<port>; anything else is refused.
// Upstream requests time out (default 20 s, answered as 502) and any still
// pending are destroyed when the proxy closes.

import { Buffer } from 'node:buffer';
import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const PREFIX = '/rest/v1/';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host']);

/** Only the numeric IPv4 loopback address the harness uses: no hostnames, nothing resolved. */
function assertLoopbackUpstream(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST || isIP(url.hostname) !== 4 || url.username || url.password) {
    throw new Error('sync_proxy: the upstream must be a plain http://127.0.0.1:<port> URL');
  }
  return url;
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ upstream: string, upstreamTimeoutMs?: number }} options
 * @returns {Promise<{
 *   url: string,
 *   addFault: (rule: { method?: string, table?: string, times?: number, action: object }) => void,
 *   clearFaults: () => void,
 *   setRefusing: (refuse: boolean) => Promise<void>,
 *   requestCount: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startSyncProxy({ upstream, upstreamTimeoutMs = 20_000 }) {
  const target = assertLoopbackUpstream(upstream);
  const sockets = new Set();
  const pending = new Set();
  let faults = [];
  let requests = 0;
  let port = 0;
  let listening = false;

  function takeFault(method, table) {
    const index = faults.findIndex(
      (rule) => (rule.method === undefined || rule.method === method) && (rule.table === undefined || rule.table === table),
    );
    if (index === -1) return null;
    const rule = faults[index];
    rule.remaining -= 1;
    if (rule.remaining <= 0) faults.splice(index, 1);
    return rule.action;
  }

  function forward(req, path, body) {
    return new Promise((resolve, reject) => {
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      headers['content-length'] = String(body.length);
      const upstreamReq = httpRequest(
        { host: LOOPBACK_HOST, port: target.port, method: req.method, path, headers },
        async (res) => {
          try {
            resolve({ status: res.statusCode ?? 502, headers: res.headers, body: await readBody(res) });
          } catch (error) {
            reject(error);
          }
        },
      );
      pending.add(upstreamReq);
      upstreamReq.on('close', () => pending.delete(upstreamReq));
      upstreamReq.setTimeout(upstreamTimeoutMs, () => upstreamReq.destroy(new Error('upstream timeout')));
      upstreamReq.on('error', reject);
      upstreamReq.end(body);
    });
  }

  const server = createServer(async (req, res) => {
    requests += 1;
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    if (!url.pathname.startsWith(PREFIX)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"code":"PROXY404","message":"not a /rest/v1 path"}');
      return;
    }
    const table = url.pathname.slice(PREFIX.length);
    const path = `/${table}${url.search}`;
    try {
      const body = await readBody(req);
      const action = takeFault(req.method, table);
      if (action?.type === 'status') {
        res.writeHead(action.status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: action.code ?? null }));
        return;
      }
      if (action?.type === 'delay') {
        if (typeof action.onDelay === 'function') await action.onDelay();
        await sleep(action.ms);
      }
      const reply = await forward(req, path, body);
      if (action?.type === 'drop_after_commit') {
        req.socket.destroy(); // the upstream committed; the client never learns the outcome
        return;
      }
      const headers = {};
      for (const [name, value] of Object.entries(reply.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length' && value !== undefined) {
          headers[name] = value;
        }
      }
      res.writeHead(reply.status, headers).end(reply.body);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"code":"PROXY502"}');
      else res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const listen = (onPort) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(onPort, LOOPBACK_HOST, () => {
        server.off('error', reject);
        listening = true;
        resolve(server.address().port);
      });
    });
  const stopListening = () =>
    new Promise((resolve) => {
      if (!listening) return resolve();
      listening = false;
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });

  port = await listen(0);

  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    addFault(rule) {
      if (!rule || typeof rule.action !== 'object' || !rule.action) throw new Error('sync_proxy: a fault needs an action');
      if (rule.method === undefined && rule.table === undefined) {
        throw new Error('sync_proxy: a fault must name a method and/or a table, so it cannot hit unrelated requests');
      }
      faults.push({ method: rule.method, table: rule.table, remaining: rule.times ?? 1, action: rule.action });
    },
    clearFaults() {
      faults = [];
    },
    async setRefusing(refuse) {
      if (refuse) await stopListening();
      else if (!listening) await listen(port);
    },
    requestCount: () => requests,
    async close() {
      faults = [];
      for (const upstreamReq of pending) upstreamReq.destroy();
      await stopListening();
    },
  };
}
