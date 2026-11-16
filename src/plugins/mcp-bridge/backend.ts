/**
 * Local HTTP endpoint for the MCP server: `POST /rpc` with
 * `{ method, params }` and the bearer token from the connection file.
 * Listens on 127.0.0.1 only; requests are run in the renderer.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { app } from 'electron';

import { createBackend } from '@/utils';

import {
  type BridgeRequest,
  type BridgeResponse,
  CONNECTION_FILE,
  DEFAULT_PORT,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
} from './protocol';

const TIMEOUT = 60_000;
const MAX_BODY = 64 * 1024;

let server: Server | undefined;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (response: BridgeResponse) => void; timer: NodeJS.Timeout }
>();

/** Reuse the token across restarts so the MCP server keeps working. */
const loadConnection = () => {
  const file = join(app.getPath('userData'), CONNECTION_FILE);
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      port?: number;
      token?: string;
    };
    if (saved.token && saved.port) {
      return { port: saved.port, token: saved.token };
    }
  } catch {
    // No connection file yet.
  }
  const connection = {
    port: DEFAULT_PORT,
    token: randomBytes(24).toString('hex'),
  };
  writeFileSync(file, JSON.stringify(connection, null, 2), { mode: 0o600 });
  return connection;
};

export const backend = createBackend({
  start({ ipc }) {
    const { port, token } = loadConnection();

    ipc.on(RESPONSE_CHANNEL, (response: BridgeResponse) => {
      const entry = pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(response.id);
      entry.resolve(response);
    });

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<BridgeResponse>((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ id, error: 'Timed out waiting for the app' });
        }, TIMEOUT);
        pending.set(id, { resolve, timer });
        const request: BridgeRequest = { id, method, params };
        ipc.send(REQUEST_CHANNEL, request);
      });

    server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/rpc') {
        reply(404, { error: 'Not found' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: 'Unauthorized' });
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let parsed: { method?: unknown; params?: unknown };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          reply(400, { error: 'Invalid JSON' });
          return;
        }
        if (typeof parsed.method !== 'string') {
          reply(400, { error: 'Missing method' });
          return;
        }
        const params =
          parsed.params && typeof parsed.params === 'object'
            ? (parsed.params as Record<string, unknown>)
            : {};
        call(parsed.method, params)
          .then((response) =>
            response.error
              ? reply(500, { error: response.error })
              : reply(200, { result: response.result ?? null }),
          )
          .catch((err) => reply(500, { error: String(err) }));
      });
    });
    server.on('error', (err) => console.warn('[mcp-bridge]', err));
    server.listen(port, '127.0.0.1');
  },
  stop() {
    server?.close();
    server = undefined;
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  },
});
