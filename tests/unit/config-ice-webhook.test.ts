import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, DEFAULT_GC_HOST_ORIGINS, loadConfig } from '../../server/src/config.js';
import { buildIceConfig, turnRestCredentials } from '../../server/src/ice.js';
import { signWebhook, WebhookDispatcher } from '../../server/src/integrations/webhook.js';
import { GenesysClientCredentialsAdapter } from '../../server/src/integrations/genesysPlatform.js';
import { silentLogger } from '../../server/src/logger.js';
import { buildCsp } from '../../server/src/security/headers.js';
import { deriveStatus, type StatusInputs } from '../../server/src/sessions/status.js';

const SECRET = 'x'.repeat(40);

describe('configuration', () => {
  it('uses safe development defaults', () => {
    const c = loadConfig({});
    expect(c.isProduction).toBe(false);
    expect(c.port).toBe(3000);
    expect(c.gcAllowedHostOrigins.map((p) => p.source)).toEqual(DEFAULT_GC_HOST_ORIGINS);
    expect(c.ice.transportPolicy).toBe('all');
    expect(c.media).toEqual({ maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15, maxBitrateKbps: 2500 });
    expect(c.serverSecretGenerated).toBe(true);
  });

  it('enforces production requirements', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://rs.example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://rs.example.com', SERVER_SECRET: SECRET })).toThrow(/https/);
    const c = loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://rs.example.com/', SERVER_SECRET: SECRET });
    expect(c.publicOrigin).toBe('https://rs.example.com');
    expect(c.forceHttps).toBe(true);
    expect(c.trustProxy).toBe(1);
  });

  it('falls back to RENDER_EXTERNAL_URL', () => {
    const c = loadConfig({ RENDER_EXTERNAL_URL: 'https://rs.onrender.com' });
    expect(c.publicBaseUrl).toBe('https://rs.onrender.com');
  });

  it('replaces the Genesys allowlist (sovereign clouds) and extends frame ancestors', () => {
    const c = loadConfig({ GC_ALLOWED_HOST_ORIGINS: 'https://apps.sovereign.example', FRAME_ANCESTORS_EXTRA: 'https://*.lightning.force.com' });
    expect(c.gcAllowedHostOrigins.map((p) => p.source)).toEqual(['https://apps.sovereign.example']);
    expect(c.frameAncestors).toEqual(['https://apps.sovereign.example', 'https://*.lightning.force.com']);
  });

  it('validates TURN settings', () => {
    expect(() => loadConfig({ TURN_URLS: 'turn:turn.example.com:3478' })).toThrow(/TURN_SECRET/);
    expect(() => loadConfig({ ICE_TRANSPORT_POLICY: 'relay' })).toThrow(/TURN_URLS/);
    expect(() => loadConfig({ STUN_URLS: 'http://x' })).toThrow();
    const c = loadConfig({ TURN_URLS: 'turn:t.example.com:3478?transport=udp, turns:t.example.com:5349', TURN_SECRET: 's', STUN_URLS: 'none' });
    expect(c.ice.turnUrls).toHaveLength(2);
    expect(c.ice.stunUrls).toEqual([]);
  });

  it('rejects invalid numbers and origins', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ GC_ALLOWED_HOST_ORIGINS: 'https://*.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ GENESYS_API_ENABLED: 'true' })).toThrow(/GENESYS_API_REGION/);
  });
});

describe('CSP', () => {
  it('allows framing of /agent only by the configured Genesys origins', () => {
    const c = loadConfig({ GC_ALLOWED_HOST_ORIGINS: 'https://apps.mypurecloud.de' });
    expect(buildCsp('agent', c, false)).toContain("frame-ancestors 'self' https://apps.mypurecloud.de");
    expect(buildCsp('join', c, false)).toContain("frame-ancestors 'none'");
    expect(buildCsp('demo', c, false)).toContain("frame-ancestors 'self'");
    expect(buildCsp('agent', c, false)).toContain("script-src 'self';");
  });
});

describe('ICE / TURN', () => {
  it('creates coturn compatible ephemeral credentials', () => {
    const now = Date.UTC(2026, 0, 1);
    const c = turnRestCredentials('secret', 'rs-abc', 3600, now);
    expect(c.username).toBe(`${now / 1000 + 3600}:rs-abc`);
    expect(c.credential).toBe(createHmac('sha1', 'secret').update(c.username).digest('base64'));
  });

  it('builds STUN/TURN servers and honours TURN-only mode', () => {
    const base = { TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 'secret' };
    const all = buildIceConfig(loadConfig(base), { label: 'x', forceRelay: false });
    expect(all.iceTransportPolicy).toBe('all');
    expect(all.iceServers).toHaveLength(2);
    expect(all.iceServers[1]!.username).toMatch(/^\d+:x$/);
    expect(buildIceConfig(loadConfig(base), { label: 'x', forceRelay: true }).iceTransportPolicy).toBe('relay');
    expect(buildIceConfig(loadConfig({ ...base, ICE_TRANSPORT_POLICY: 'relay' }), { label: 'x', forceRelay: false }).iceTransportPolicy).toBe('relay');
    // Without TURN a forced relay would make connections impossible, so it is ignored.
    expect(buildIceConfig(loadConfig({}), { label: 'x', forceRelay: true }).iceTransportPolicy).toBe('all');
  });

  it('supports static TURN credentials', () => {
    const cfg = buildIceConfig(loadConfig({ TURN_URLS: 'turn:t:3478', TURN_USERNAME: 'u', TURN_PASSWORD: 'p' }), { label: 'x', forceRelay: false });
    expect(cfg.iceServers[1]).toEqual({ urls: ['turn:t:3478'], username: 'u', credential: 'p' });
  });
});

describe('status derivation', () => {
  const base: StatusInputs = {
    ended: false,
    customerJoined: true,
    customerOnline: true,
    consentGiven: true,
    shareActive: true,
    shareStopped: false,
    mediaConnected: true,
    mediaInterrupted: false,
  };
  it.each([
    [{ customerJoined: false }, 'waiting_customer'],
    [{ consentGiven: false, shareActive: false, mediaConnected: false }, 'customer_connected'],
    [{ shareActive: false, mediaConnected: false }, 'waiting_share'],
    [{ mediaConnected: false }, 'waiting_share'],
    [{}, 'sharing'],
    [{ mediaInterrupted: true, mediaConnected: false }, 'interrupted'],
    [{ customerOnline: false }, 'interrupted'],
    [{ shareActive: false, shareStopped: true }, 'share_stopped'],
    [{ ended: true }, 'ended'],
  ] as Array<[Partial<StatusInputs>, string]>)('%o -> %s', (patch, expected) => {
    expect(deriveStatus({ ...base, ...patch })).toBe(expected);
  });
});

describe('webhook dispatcher', () => {
  const session = {
    sessionId: 's1',
    genesysConversationId: 'c1',
    agentId: 'alice',
    salesforceCaseId: '5003000000D8cuI',
    source: 'genesys',
    gcHostOrigin: 'https://apps.mypurecloud.de',
    gcTargetEnv: 'prod-euc1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:10:00.000Z',
    durationSeconds: 600,
    endReason: 'agent_ended',
    finalStatus: 'sharing',
    connectionStatus: 'connected',
    iceCandidateType: 'srflx',
    customerJoinedAt: null,
    customerConsentAt: null,
    shareStartedAt: null,
  };

  it('signs the payload and retries on server errors', async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response('', { status: calls.length === 1 ? 503 : 200 });
    });
    const d = new WebhookDispatcher({ url: 'https://crm.example.com/hook', secret: 'whsec', timeoutMs: 1000 }, silentLogger, fetchImpl as unknown as typeof fetch, [1]);
    const result = await d.deliver(session);
    expect(result).toEqual({ status: 'delivered', attempts: 2 });
    const { headers, body } = calls[1]!;
    expect(headers['X-Remote-Support-Signature']).toBe(signWebhook('whsec', headers['X-Remote-Support-Timestamp']!, body));
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe('remote_support.session.ended');
    expect(parsed.session.salesforceCaseId).toBe('5003000000D8cuI');
    expect(body).not.toMatch(/token/i);
  });

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }));
    const d = new WebhookDispatcher({ url: 'https://x', secret: undefined, timeoutMs: 1000 }, silentLogger, fetchImpl as unknown as typeof fetch, [1, 1]);
    expect(await d.deliver(session)).toEqual({ status: 'failed', attempts: 1 });
  });

  it('is a no-op when disabled', async () => {
    const d = new WebhookDispatcher(null, silentLogger);
    expect(d.enabled).toBe(false);
    expect(await d.deliver(session)).toEqual({ status: 'disabled', attempts: 0 });
  });
});

describe('Genesys platform adapter (read-only)', () => {
  it('uses client credentials and only issues GET requests for conversations', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ url, method: init.method ?? 'GET' });
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/missing')) return new Response('', { status: 404 });
      return Response.json({ participants: [{ calls: [{}] }] });
    });
    const a = new GenesysClientCredentialsAdapter('mypurecloud.de', 'id', 'secret', silentLogger, fetchImpl as unknown as typeof fetch);
    expect(a.expectedHostOrigin).toBe('https://apps.mypurecloud.de');
    expect(await a.lookupConversation('abc')).toEqual({ exists: true, hasVoice: true, ended: false });
    expect(await a.lookupConversation('missing')).toEqual({ exists: false });
    expect(requests.filter((r) => r.url.includes('/api/v2/')).every((r) => r.method === 'GET')).toBe(true);
    expect(requests.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1);
    expect(new GenesysClientCredentialsAdapter('use2.us-gov-pure.cloud', 'i', 's', silentLogger).expectedHostOrigin).toBe(
      'https://app.use2.us-gov-pure.cloud',
    );
  });
});
