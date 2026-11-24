import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, CONVERSATION_ID, createSession, inviteTokenFromUrl, login, PASSWORD, startTestApp, type TestApp } from '../helpers.js';

let app: TestApp;

beforeEach(async () => {
  app = await startTestApp();
});
afterEach(async () => {
  await app.stop();
});

describe('agent authentication', () => {
  it('logs in with an individual account and validates the token server-side', async () => {
    const token = await login(app);
    const me = await api(app, 'GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.agent).toEqual({ id: 'alice', displayName: 'Alice Agent' });
    expect(me.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects wrong passwords, unknown users and missing or forged tokens', async () => {
    expect((await api(app, 'POST', '/api/auth/login', { username: 'alice', password: 'wrong-password' })).status).toBe(401);
    expect((await api(app, 'POST', '/api/auth/login', { username: 'mallory', password: PASSWORD })).status).toBe(401);
    expect((await api(app, 'GET', '/api/auth/me')).status).toBe(401);
    expect((await api(app, 'GET', '/api/auth/me', undefined, 'A'.repeat(43))).status).toBe(401);
  });

  it('revokes the token on logout', async () => {
    const token = await login(app);
    expect((await api(app, 'POST', '/api/auth/logout', undefined, token)).status).toBe(200);
    expect((await api(app, 'GET', '/api/auth/me', undefined, token)).status).toBe(401);
  });

  it('rate limits login attempts per user', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await api(app, 'POST', '/api/auth/login', { username: 'bob', password: 'wrong-password' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('session creation', () => {
  it('stores the Genesys conversation id and returns a single-use invitation', async () => {
    const token = await login(app);
    const r = await createSession(app, token, { salesforceCaseId: '5003000000D8cuI' });
    expect(r.session).toMatchObject({
      conversationId: CONVERSATION_ID,
      agentId: 'alice',
      salesforceCaseId: '5003000000D8cuI',
      gcHostOrigin: 'https://apps.mypurecloud.de',
      gcTargetEnv: 'prod-euc1',
      status: 'waiting_customer',
    });
    expect(r.invite.code).toMatch(/^\d{6}$/);
    expect(r.invite.url).toMatch(/\/join#t=[A-Za-z0-9_-]{43}$/);
    const row = app.db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session.sessionId) as Record<string, unknown>;
    expect(row.conversation_id).toBe(CONVERSATION_ID);
    // Only hashes are persisted.
    expect(JSON.stringify(row)).not.toContain(inviteTokenFromUrl(r.invite.url));
    expect(JSON.stringify(row)).not.toContain(`"${r.invite.code}"`);
  });

  it('validates the Genesys host origin against the allowlist', async () => {
    const token = await login(app);
    const bad = await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID, gcHostOrigin: 'https://evil.example.com', gcTargetEnv: 'prod' }, token);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('gc_host_origin_not_allowed');
    const missing = await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID }, token);
    expect(missing.body.error).toBe('genesys_context_required');
    const env = await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID, gcHostOrigin: 'https://apps.mypurecloud.de', gcTargetEnv: 'prod;drop' }, token);
    expect(env.body.error).toBe('invalid_gc_target_env');
    const fed = await createSession(app, token, { gcHostOrigin: 'https://app.use2.us-gov-pure.cloud', gcTargetEnv: 'fedramp-use2-core' });
    expect(fed.session).toBeTruthy();
  });

  it('rejects invalid conversation ids and case ids', async () => {
    const token = await login(app);
    expect((await api(app, 'POST', '/api/sessions', { conversationId: 'not-a-uuid', source: 'demo' }, token)).status).toBe(400);
    expect((await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID, source: 'demo', salesforceCaseId: '<script>' }, token)).status).toBe(400);
  });

  it('requires authentication; conversation ids are not credentials', async () => {
    const r = await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID, gcHostOrigin: 'https://apps.mypurecloud.de', gcTargetEnv: 'prod' });
    expect(r.status).toBe(401);
  });
});

describe('session isolation between agents', () => {
  it('hides sessions of other agents', async () => {
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const { session } = await createSession(app, alice);
    for (const [method, path, body] of [
      ['GET', `/api/sessions/${session.sessionId}`],
      ['PATCH', `/api/sessions/${session.sessionId}`, { salesforceCaseId: 'X1' }],
      ['POST', `/api/sessions/${session.sessionId}/invite`],
      ['POST', `/api/sessions/${session.sessionId}/end`],
      ['GET', `/api/sessions/${session.sessionId}/audit`],
    ] as Array<[string, string, unknown?]>) {
      const r = await api(app, method, path, body, bob);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect((await api(app, 'GET', `/api/sessions?conversationId=${CONVERSATION_ID}`, undefined, bob)).body.sessions).toEqual([]);
    expect((await api(app, 'GET', `/api/sessions?conversationId=${CONVERSATION_ID}&active=1`, undefined, alice)).body.sessions).toHaveLength(1);
  });
});

describe('customer join', () => {
  it('redeems an invitation link exactly once', async () => {
    const token = await login(app);
    const { invite, session } = await createSession(app, token);
    const inviteToken = inviteTokenFromUrl(invite.url);
    const first = await api(app, 'POST', '/api/join', { inviteToken });
    expect(first.status).toBe(200);
    expect(first.body.sessionId).toBe(session.sessionId);
    expect(first.body.agentDisplayName).toBe('Alice Agent');
    expect(first.body.customerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.verificationCode).toMatch(/^\d{4}$/);
    expect((await api(app, 'POST', '/api/join', { inviteToken })).status).toBe(404);
    // The code of the same invitation is consumed as well.
    expect((await api(app, 'POST', '/api/join', { code: invite.code })).status).toBe(404);
  });

  it('redeems a session code', async () => {
    const token = await login(app);
    const { invite } = await createSession(app, token);
    const r = await api(app, 'POST', '/api/join', { code: invite.code });
    expect(r.status).toBe(200);
  });

  it('rejects expired invitations', async () => {
    let now = Date.now();
    await app.stop();
    app = await startTestApp({}, { now: () => now });
    const token = await login(app);
    const { invite } = await createSession(app, token);
    now += app.config.inviteTtlMs + 1000;
    const r = await api(app, 'POST', '/api/join', { code: invite.code });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('invite_expired');
  });

  it('rate limits code guessing per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await api(app, 'POST', '/api/join', { code: String(100000 + i) })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('invalidates the previous invitation when a new one is issued', async () => {
    const token = await login(app);
    const { invite, session } = await createSession(app, token);
    const r = await api(app, 'POST', `/api/sessions/${session.sessionId}/invite`, undefined, token);
    expect(r.status).toBe(200);
    expect((await api(app, 'POST', '/api/join', { inviteToken: inviteTokenFromUrl(invite.url) })).status).toBe(404);
    expect((await api(app, 'POST', '/api/join', { inviteToken: inviteTokenFromUrl(r.body.invite.url) })).status).toBe(200);
  });

  it('rejects malformed join requests', async () => {
    expect((await api(app, 'POST', '/api/join', { code: '12' })).status).toBe(400);
    expect((await api(app, 'POST', '/api/join', { code: '123456', inviteToken: 'x' })).status).toBe(400);
    expect((await api(app, 'POST', '/api/join', { inviteToken: 'short' })).status).toBe(404);
  });
});

describe('session end and metadata', () => {
  it('ends a session, stores duration and invalidates customer access', async () => {
    const token = await login(app);
    const { session, invite } = await createSession(app, token, { salesforceCaseId: 'CASE-1' });
    await api(app, 'POST', '/api/join', { code: invite.code });
    const patched = await api(app, 'PATCH', `/api/sessions/${session.sessionId}`, { salesforceCaseId: '5003000000D8cuI' }, token);
    expect(patched.body.session.salesforceCaseId).toBe('5003000000D8cuI');
    const ended = await api(app, 'POST', `/api/sessions/${session.sessionId}/end`, undefined, token);
    expect(ended.status).toBe(200);
    expect(ended.body.session).toMatchObject({ status: 'ended', endReason: 'agent_ended' });
    expect(ended.body.session.endedAt).toBeTruthy();
    expect(typeof ended.body.session.durationSeconds).toBe('number');
    const row = app.db.prepare('SELECT customer_token_hash, invite_token_hash FROM sessions WHERE id = ?').get(session.sessionId) as Record<string, unknown>;
    expect(row).toEqual({ customer_token_hash: null, invite_token_hash: null });
    const auditTrail = await api(app, 'GET', `/api/sessions/${session.sessionId}/audit`, undefined, token);
    const events = auditTrail.body.events.map((e: { event: string }) => e.event);
    expect(events).toEqual(expect.arrayContaining(['session.created', 'customer.joined', 'session.salesforce_case_updated', 'session.ended']));
  });

  it('never writes tokens to the audit log', async () => {
    const token = await login(app);
    const { invite } = await createSession(app, token);
    const joined = await api(app, 'POST', '/api/join', { inviteToken: inviteTokenFromUrl(invite.url) });
    const dump = JSON.stringify(app.db.prepare('SELECT * FROM audit_log').all());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(inviteTokenFromUrl(invite.url));
    expect(dump).not.toContain(joined.body.customerToken);
  });
});

describe('HTTP security headers', () => {
  it('allows only Genesys Cloud to frame /agent', async () => {
    const res = await fetch(`${app.baseUrl}/agent?conversationId=${CONVERSATION_ID}`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors 'self' https://apps.mypurecloud.com");
    expect(csp).toContain('https://*.pure.cloud');
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('forbids framing of the customer page (clickjacking on consent)', async () => {
    const res = await fetch(`${app.baseUrl}/join`);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toContain('display-capture=(self)');
    expect(res.headers.get('permissions-policy')).toContain('microphone=()');
  });

  it('serves the demo page only same-origin framed and can disable it', async () => {
    const res = await fetch(`${app.baseUrl}/demo`);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    await app.stop();
    app = await startTestApp({ DEMO_ENABLED: 'false' });
    expect((await fetch(`${app.baseUrl}/demo`)).status).toBe(404);
    const token = await login(app);
    expect((await api(app, 'POST', '/api/sessions', { conversationId: CONVERSATION_ID, source: 'demo' }, token)).status).toBe(403);
  });

  it('redirects to HTTPS when enforced', async () => {
    await app.stop();
    app = await startTestApp({ FORCE_HTTPS: 'true', PUBLIC_BASE_URL: 'https://rs.example.com' });
    const res = await fetch(`${app.baseUrl}/join`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://rs.example.com/join');
    expect((await fetch(`${app.baseUrl}/api/health`)).status).toBe(200);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const r = await api(app, 'GET', '/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});
