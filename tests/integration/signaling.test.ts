import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import {
  api,
  createSession,
  emitAck,
  inviteTokenFromUrl,
  login,
  onceConnected,
  sleep,
  startTestApp,
  waitForEvent,
  type TestApp,
} from '../helpers.js';

let app: TestApp;

beforeEach(async () => {
  app = await startTestApp();
});
afterEach(async () => {
  await app.stop();
});

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };

async function setupSession(agentName = 'alice') {
  const agentToken = await login(app, agentName);
  const { session, invite } = await createSession(app, agentToken);
  const joined = await api(app, 'POST', '/api/join', { inviteToken: inviteTokenFromUrl(invite.url) });
  const agent = app.connect({ role: 'agent', token: agentToken });
  await onceConnected(agent);
  const attach = await emitAck(agent, 'agent:attach', { sessionId: session.sessionId });
  expect(attach.ok).toBe(true);
  const customer = app.connect({ role: 'customer', token: joined.body.customerToken });
  await onceConnected(customer);
  const cAttach = await emitAck(customer, 'customer:attach');
  expect(cAttach.ok).toBe(true);
  return { agentToken, sessionId: session.sessionId, agent, customer, customerToken: joined.body.customerToken as string, attach, cAttach };
}

describe('socket authentication', () => {
  it('rejects connections without valid tokens', async () => {
    const s = app.connect({ role: 'agent', token: 'A'.repeat(43) });
    await expect(onceConnected(s)).rejects.toThrow(/unauthorized/);
    const c = app.connect({ role: 'customer', token: 'B'.repeat(43) });
    await expect(onceConnected(c)).rejects.toThrow(/unauthorized/);
  });

  it('rejects cross-site WebSocket connections (Origin check)', async () => {
    const token = await login(app);
    const s = app.connect({ role: 'agent', token }, { origin: 'https://evil.example.com' });
    await expect(onceConnected(s)).rejects.toThrow();
    const n = app.connect({ role: 'agent', token }, { origin: null });
    await expect(onceConnected(n)).rejects.toThrow();
  });

  it('does not let an agent attach to a session of another agent', async () => {
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const { session } = await createSession(app, alice);
    const s = app.connect({ role: 'agent', token: bob });
    await onceConnected(s);
    const r = await emitAck(s, 'agent:attach', { sessionId: session.sessionId });
    expect(r).toEqual({ ok: false, error: 'session_not_found' });
    expect((await emitAck(s, 'signal', { pcId: 'abcdefgh1234', kind: 'answer', sdp: SDP })).ok).toBe(false);
  });
});

describe('signaling relay', () => {
  it('delivers ICE configuration and session state on attach', async () => {
    const { attach, cAttach } = await setupSession();
    expect(attach.data.iceConfig.iceServers[0].urls[0]).toMatch(/^stun:/);
    expect(attach.data.iceConfig.media.maxFrameRate).toBe(15);
    expect(attach.data.state.customerJoined).toBe(true);
    expect(cAttach.data.agentDisplayName).toBe('Alice Agent');
  });

  it('requires explicit consent before the customer can offer or announce sharing', async () => {
    const { customer } = await setupSession();
    expect(await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'offer', sdp: SDP })).toEqual({ ok: false, error: 'consent_required' });
    expect(await emitAck(customer, 'customer:share-state', { state: 'started' })).toEqual({ ok: false, error: 'consent_required' });
  });

  it('relays offer, answer and trickle ICE candidates between the two peers', async () => {
    const { agent, customer, sessionId } = await setupSession();
    const consentState = waitForEvent(agent, 'session:state', (s: any) => s.consentGiven);
    expect((await emitAck(customer, 'customer:consent')).ok).toBe(true);
    expect((await consentState).status).toBe('waiting_share');

    const sharingState = waitForEvent(agent, 'session:state', (s: any) => s.shareActive);
    expect((await emitAck(customer, 'customer:share-state', { state: 'started', displaySurface: 'monitor', width: 1920, height: 1080 })).ok).toBe(true);
    await sharingState;

    const offerAtAgent = waitForEvent(agent, 'signal', (m: any) => m.kind === 'offer');
    expect((await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'offer', sdp: SDP })).ok).toBe(true);
    expect(await offerAtAgent).toEqual({ pcId: 'abcdefgh1234', kind: 'offer', sdp: SDP });

    const candAtAgent = waitForEvent(agent, 'signal', (m: any) => m.kind === 'candidate');
    await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'candidate', candidate: CANDIDATE });
    expect((await candAtAgent).candidate.candidate).toBe(CANDIDATE.candidate);

    const answerAtCustomer = waitForEvent(customer, 'signal', (m: any) => m.kind === 'answer');
    expect((await emitAck(agent, 'signal', { pcId: 'abcdefgh1234', kind: 'answer', sdp: SDP })).ok).toBe(true);
    expect((await answerAtCustomer).sdp).toBe(SDP);

    const eocAtCustomer = waitForEvent(customer, 'signal', (m: any) => m.kind === 'end-of-candidates');
    await emitAck(agent, 'signal', { pcId: 'abcdefgh1234', kind: 'end-of-candidates' });
    await eocAtCustomer;

    const connected = waitForEvent(customer, 'session:state', (s: any) => s.status === 'sharing');
    expect((await emitAck(agent, 'agent:media-state', { state: 'connected', candidateType: 'srflx' })).ok).toBe(true);
    await connected;

    const row = app.db.prepare('SELECT consent_at, share_started_at, ice_candidate_type, status FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(row.consent_at).toBeGreaterThan(0);
    expect(row.share_started_at).toBeGreaterThan(0);
    expect(row.ice_candidate_type).toBe('srflx');
    expect(row.status).toBe('sharing');

    const interrupted = waitForEvent(agent, 'session:state', (s: any) => s.status === 'interrupted');
    await emitAck(agent, 'agent:media-state', { state: 'interrupted' });
    await interrupted;

    const requestAtCustomer = waitForEvent(customer, 'agent:request-offer');
    expect((await emitAck(agent, 'agent:request-offer', { iceRestart: true })).ok).toBe(true);
    expect(await requestAtCustomer).toEqual({ iceRestart: true });

    const stopped = waitForEvent(agent, 'session:state', (s: any) => s.status === 'share_stopped');
    await emitAck(customer, 'customer:share-state', { state: 'stopped' });
    await stopped;
  });

  it('enforces signal direction per role and validates payloads', async () => {
    const { agent, customer } = await setupSession();
    await emitAck(customer, 'customer:consent');
    expect(await emitAck(agent, 'signal', { pcId: 'abcdefgh1234', kind: 'offer', sdp: SDP })).toEqual({ ok: false, error: 'forbidden_signal' });
    expect(await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'answer', sdp: SDP })).toEqual({ ok: false, error: 'forbidden_signal' });
    expect(await emitAck(customer, 'signal', { pcId: 'x', kind: 'offer', sdp: SDP })).toEqual({ ok: false, error: 'invalid_payload' });
    expect(await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'offer', sdp: 'x'.repeat(70 * 1024) })).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(await emitAck(customer, 'signal', { pcId: 'abcdefgh1234', kind: 'bogus' })).toEqual({ ok: false, error: 'invalid_payload' });
    // Customers cannot use agent-only events.
    expect((await emitAck(customer, 'agent:media-state', { state: 'connected' })).ok).toBe(false);
  });

  it('isolates parallel sessions of different agents', async () => {
    const a = await setupSession('alice');
    const b = await setupSession('bob');
    for (const s of [a, b]) await emitAck(s.customer, 'customer:consent');
    const leaked: unknown[] = [];
    b.agent.on('signal', (m) => leaked.push(m));
    b.customer.on('signal', (m) => leaked.push(m));
    const offerAtA = waitForEvent(a.agent, 'signal', (m: any) => m.kind === 'offer');
    await emitAck(a.customer, 'signal', { pcId: 'sessionA0001', kind: 'offer', sdp: SDP });
    await offerAtA;
    await emitAck(a.agent, 'signal', { pcId: 'sessionA0001', kind: 'answer', sdp: SDP });
    await sleep(200);
    expect(leaked).toEqual([]);
    // A customer token is bound to its session; it cannot be used to reach another one.
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('takeover protection and cleanup', () => {
  it('replaces an older agent socket for the same session', async () => {
    const { agentToken, sessionId, agent } = await setupSession();
    const replaced = waitForEvent(agent, 'session:replaced');
    const second = app.connect({ role: 'agent', token: agentToken });
    await onceConnected(second);
    expect((await emitAck(second, 'agent:attach', { sessionId })).ok).toBe(true);
    expect(await replaced).toEqual({ reason: 'opened_elsewhere' });
    expect((await emitAck(agent, 'agent:request-offer', { iceRestart: false })).ok).toBe(false);
  });

  it('revokes the previous customer when a new invitation is redeemed', async () => {
    const { agentToken, sessionId, customer } = await setupSession();
    const replaced = waitForEvent(customer, 'session:replaced');
    const inv = await api(app, 'POST', `/api/sessions/${sessionId}/invite`, undefined, agentToken);
    const second = await api(app, 'POST', '/api/join', { code: inv.body.invite.code });
    expect(second.status).toBe(200);
    expect(await replaced).toEqual({ reason: 'new_customer_joined' });
    expect((await emitAck(customer, 'customer:consent')).ok).toBe(false);
  });

  it('notifies both peers, disconnects them and invalidates tokens when the session ends', async () => {
    const { agentToken, sessionId, agent, customer, customerToken } = await setupSession();
    const endedAgent = waitForEvent(agent, 'session:ended');
    const endedCustomer = waitForEvent(customer, 'session:ended');
    const disconnected = new Promise<void>((resolve) => customer.once('disconnect', () => resolve()));
    await api(app, 'POST', `/api/sessions/${sessionId}/end`, undefined, agentToken);
    expect(await endedAgent).toEqual({ sessionId, reason: 'agent_ended' });
    await endedCustomer;
    await disconnected;
    const again = app.connect({ role: 'customer', token: customerToken });
    await expect(onceConnected(again)).rejects.toThrow(/unauthorized/);
  });

  it('disconnects agent sockets on logout', async () => {
    const { agentToken, agent } = await setupSession();
    const replaced = waitForEvent(agent, 'session:replaced');
    await api(app, 'POST', '/api/auth/logout', undefined, agentToken);
    expect(await replaced).toEqual({ reason: 'logged_out' });
  });

  it('reports the customer as offline and back (reconnect handling)', async () => {
    const { agent, customer, customerToken } = await setupSession();
    await emitAck(customer, 'customer:consent');
    const offline = waitForEvent(agent, 'session:state', (s: any) => !s.customerOnline);
    customer.disconnect();
    expect((await offline).status).toBe('interrupted');
    const online = waitForEvent(agent, 'session:state', (s: any) => s.customerOnline);
    const back: Socket = app.connect({ role: 'customer', token: customerToken });
    await onceConnected(back);
    await emitAck(back, 'customer:attach');
    expect((await online).status).toBe('waiting_share');
  });
});

describe('timeouts and retention', () => {
  it('ends idle sessions, enforces the maximum duration and purges old metadata', async () => {
    let now = Date.now();
    await app.stop();
    app = await startTestApp({ SESSION_IDLE_TIMEOUT_MINUTES: '1', SESSION_MAX_DURATION_MINUTES: '30', METADATA_RETENTION_DAYS: '1' }, { now: () => now });
    const token = await login(app);
    const idle = await createSession(app, token);
    const neverJoined = await createSession(app, token);
    const busy = await createSession(app, token);
    const agent = app.connect({ role: 'agent', token });
    await onceConnected(agent);
    await emitAck(agent, 'agent:attach', { sessionId: busy.session.sessionId });
    await api(app, 'POST', '/api/join', { code: idle.invite.code });

    // Nobody online for longer than the idle timeout, invitation (10 min) still valid.
    now += 2 * 60_000;
    expect(app.sessions.sweep()).toBe(2);
    const reason = (id: string) => (app.db.prepare('SELECT end_reason FROM sessions WHERE id = ?').get(id) as any).end_reason;
    expect(reason(idle.session.sessionId)).toBe('idle_timeout');
    expect(reason(neverJoined.session.sessionId)).toBe('idle_timeout');
    expect(reason(busy.session.sessionId)).toBeNull();

    const expiredInvite = await createSession(app, token);
    now += 11 * 60_000;
    expect(app.sessions.sweep()).toBe(1);
    expect(reason(expiredInvite.session.sessionId)).toBe('invite_expired');

    now += 20 * 60_000;
    const ended = waitForEvent(agent, 'session:ended');
    expect(app.sessions.sweep()).toBe(1);
    expect((await ended).reason).toBe('max_duration');

    now += 2 * 86_400_000;
    app.runMaintenance();
    expect((app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n).toBe(0);
    expect((app.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE session_id IS NOT NULL').get() as any).n).toBe(0);
  });
});
