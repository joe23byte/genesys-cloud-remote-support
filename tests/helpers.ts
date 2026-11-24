import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp, type AppOptions } from '../server/src/app.js';
import { parsePasswordHash, hashPassword } from '../server/src/auth/passwords.js';
import type { AgentAccount } from '../server/src/auth/agentAccounts.js';
import { loadConfig, type AppConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { silentLogger } from '../server/src/logger.js';

export const PASSWORD = 'correct-horse-battery';

let cachedAccounts: AgentAccount[] | null = null;
export async function testAccounts(): Promise<AgentAccount[]> {
  if (cachedAccounts) return cachedAccounts;
  const hash = parsePasswordHash(await hashPassword(PASSWORD))!;
  cachedAccounts = [
    { id: 'alice', displayName: 'Alice Agent', hash },
    { id: 'bob', displayName: 'Bob Agent', hash },
  ];
  return cachedAccounts;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SERVER_SECRET: 'test-secret-test-secret-test-secret-123',
    DATABASE_PATH: ':memory:',
    AUDIT_LOG_STDOUT: 'false',
    LOG_LEVEL: 'error',
    ...env,
  });
}

export async function startTestApp(env: Record<string, string> = {}, options: AppOptions = {}) {
  const config = testConfig(env);
  const db = options.db ?? openDatabase(':memory:');
  const remote = await createApp(config, {
    logger: silentLogger,
    db,
    accounts: await testAccounts(),
    disableTimers: true,
    clientDistDir: '/nonexistent',
    ...options,
  });
  await new Promise<void>((resolve) => remote.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (remote.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];

  const connect = (auth: { role: string; token: string }, opts: { origin?: string | null } = {}) => {
    const origin = opts.origin === undefined ? baseUrl : opts.origin;
    const s = ioClient(baseUrl, {
      transports: ['websocket'],
      auth,
      reconnection: false,
      forceNew: true,
      extraHeaders: origin ? { origin } : {},
    });
    sockets.push(s);
    return s;
  };

  const stop = async () => {
    for (const s of sockets) s.disconnect();
    await remote.close();
    db.close();
  };

  return { ...remote, config, baseUrl, port, connect, stop };
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

export async function api(app: TestApp, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, body: json ?? {}, headers: res.headers };
}

export async function login(app: TestApp, username = 'alice'): Promise<string> {
  const r = await api(app, 'POST', '/api/auth/login', { username, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return r.body.token as string;
}

export const CONVERSATION_ID = '85ff71c0-f96d-45f6-9d98-fa5e01b22af8';

export async function createSession(app: TestApp, token: string, overrides: Record<string, unknown> = {}) {
  const r = await api(
    app,
    'POST',
    '/api/sessions',
    {
      conversationId: CONVERSATION_ID,
      source: 'genesys',
      gcHostOrigin: 'https://apps.mypurecloud.de',
      gcTargetEnv: 'prod-euc1',
      ...overrides,
    },
    token,
  );
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { session: { sessionId: string }; invite: { url: string; code: string; expiresAt: string } };
}

export function inviteTokenFromUrl(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;
}

export function waitForEvent<T = any>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

export function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

export function emitAck<T = any>(socket: Socket, event: string, payload: unknown = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  return new Promise((resolve) => socket.timeout(3000).emit(event, payload, (err: unknown, res: any) => resolve(err ? { ok: false, error: 'timeout' } : res)));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
