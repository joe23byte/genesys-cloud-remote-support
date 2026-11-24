import { describe, expect, it } from 'vitest';
import { AgentDirectory, parseAgentAccounts } from '../../server/src/auth/agentAccounts.js';
import { hashPassword, parsePasswordHash, verifyPassword } from '../../server/src/auth/passwords.js';
import { bearerToken } from '../../server/src/auth/agentTokens.js';
import { generateNumericCode, generateToken, hashToken, looksLikeToken } from '../../server/src/security/crypto.js';
import { canonicalOrigin, isAllowedOrigin, isValidTargetEnv, parseOriginPattern } from '../../server/src/security/origins.js';
import { headerIp, RateLimiter } from '../../server/src/security/rateLimit.js';
import { redact } from '../../server/src/logger.js';
import { requestIp } from '../../server/src/realtime/signaling.js';

describe('origin allowlist', () => {
  const patterns = ['https://apps.mypurecloud.de', 'https://*.pure.cloud', 'https://*.us-gov-pure.cloud'].map((p) => parseOriginPattern(p)!);

  it('accepts exact and wildcard Genesys origins', () => {
    expect(isAllowedOrigin('https://apps.mypurecloud.de', patterns)).toBe(true);
    expect(isAllowedOrigin('https://apps.euc2.pure.cloud', patterns)).toBe(true);
    expect(isAllowedOrigin('https://app.use2.us-gov-pure.cloud', patterns)).toBe(true);
  });

  it('rejects lookalikes, other schemes and ports', () => {
    expect(isAllowedOrigin('http://apps.mypurecloud.de', patterns)).toBe(false);
    expect(isAllowedOrigin('https://apps.mypurecloud.de:8443', patterns)).toBe(false);
    expect(isAllowedOrigin('https://apps.mypurecloud.de.evil.com', patterns)).toBe(false);
    expect(isAllowedOrigin('https://evilpure.cloud', patterns)).toBe(false);
    expect(isAllowedOrigin('https://pure.cloud', patterns)).toBe(false);
  });

  it('refuses dangerous patterns', () => {
    expect(parseOriginPattern('https://*.com')).toBeNull();
    expect(parseOriginPattern('*')).toBeNull();
    expect(parseOriginPattern('https://apps.mypurecloud.de/path')).toBeNull();
    expect(parseOriginPattern('javascript://x')).toBeNull();
  });

  it('canonicalizes origins and rejects paths, credentials and queries', () => {
    expect(canonicalOrigin('https://apps.mypurecloud.de/')).toBe('https://apps.mypurecloud.de');
    expect(canonicalOrigin('https://user:pw@apps.mypurecloud.de')).toBeNull();
    expect(canonicalOrigin('https://apps.mypurecloud.de/x')).toBeNull();
    expect(canonicalOrigin('https://apps.mypurecloud.de?x=1')).toBeNull();
    expect(canonicalOrigin('not a url')).toBeNull();
  });

  it('validates gcTargetEnv values from the Genesys documentation', () => {
    for (const v of ['prod', 'prod-euw1', 'fedramp-use2-core']) expect(isValidTargetEnv(v)).toBe(true);
    for (const v of ['', 'prod;rm', '<script>', '-prod', 'a'.repeat(70)]) expect(isValidTargetEnv(v)).toBe(false);
  });
});

describe('tokens and codes', () => {
  it('generates 256-bit url-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeToken(a)).toBe(true);
    expect(looksLikeToken('short')).toBe(false);
    expect(looksLikeToken('x'.repeat(40) + '!')).toBe(false);
  });

  it('hashes tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('generates numeric codes of the requested length', () => {
    for (let i = 0; i < 50; i++) expect(generateNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('parses bearer headers strictly', () => {
    const t = generateToken();
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`bearer ${t}`)).toBeNull();
    expect(bearerToken('Bearer short')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('passwords and agent accounts', () => {
  it('hashes and verifies passwords with scrypt', async () => {
    const h = await hashPassword('a-long-password');
    expect(h).toMatch(/^scrypt:16384:8:1:/);
    expect(h).not.toContain('$');
    const parsed = parsePasswordHash(h)!;
    expect(await verifyPassword('a-long-password', parsed)).toBe(true);
    expect(await verifyPassword('wrong-password', parsed)).toBe(false);
  });

  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('parses AGENT_ACCOUNTS and authenticates case-insensitively', async () => {
    const h = await hashPassword('a-long-password');
    const accounts = parseAgentAccounts(`alice|Alice A.|${h};\nbob|Bob B.|${h}`);
    expect(accounts.map((a) => a.id)).toEqual(['alice', 'bob']);
    const dir = new AgentDirectory(accounts);
    expect((await dir.authenticate('ALICE', 'a-long-password'))?.id).toBe('alice');
    expect(await dir.authenticate('alice', 'nope-nope-nope')).toBeNull();
    expect(await dir.authenticate('mallory', 'a-long-password')).toBeNull();
  });

  it('rejects malformed or duplicate entries', async () => {
    const h = await hashPassword('a-long-password');
    expect(() => parseAgentAccounts('alice|Alice')).toThrow();
    expect(() => parseAgentAccounts('al ice|Alice|' + h)).toThrow();
    expect(() => parseAgentAccounts('alice|Alice|plaintext')).toThrow();
    expect(() => parseAgentAccounts(`alice|A|${h};ALICE|B|${h}`)).toThrow();
  });
});

describe('rate limiter', () => {
  it('limits per key within the window and resets afterwards', () => {
    let now = 0;
    const rl = new RateLimiter(3, 1000, () => now);
    expect([1, 2, 3].map(() => rl.hit('a').allowed)).toEqual([true, true, true]);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.isExhausted('a')).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
    now = 1001;
    expect(rl.hit('a').allowed).toBe(true);
  });
});

describe('log redaction', () => {
  it('removes tokens, SDP, candidates and passwords', () => {
    const out = redact({
      customerToken: 'x',
      password: 'y',
      sdp: 'v=0',
      candidate: 'candidate:1',
      nested: { inviteUrl: 'https://x/join#t=abc', authorization: 'Bearer z' },
      candidateType: 'relay',
      conversationId: 'c',
    }) as Record<string, any>;
    expect(out.customerToken).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.sdp).toBe('[redacted]');
    expect(out.candidate).toBe('[redacted]');
    expect(out.nested.inviteUrl).toBe('[redacted]');
    expect(out.nested.authorization).toBe('[redacted]');
    expect(out.candidateType).toBe('relay');
    expect(out.conversationId).toBe('c');
  });
});

describe('client IP behind proxies', () => {
  const req = (xff: string | undefined, remote: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } }) as any;
  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(requestIp(req('1.1.1.1', '10.0.0.1'), false)).toBe('10.0.0.1');
  });
  it('uses the hop-count semantics of Express', () => {
    expect(requestIp(req('6.6.6.6, 1.1.1.1', '10.0.0.1'), 1)).toBe('1.1.1.1');
    expect(requestIp(req('1.1.1.1', '127.0.0.1'), 'loopback')).toBe('1.1.1.1');
    expect(requestIp(req('1.1.1.1', '10.0.0.1'), 'loopback')).toBe('10.0.0.1');
  });
  it('prefers a configured edge header (CF-Connecting-IP) and rejects non-IP values', () => {
    const r = (value: string) => ({ headers: { 'cf-connecting-ip': value }, socket: { remoteAddress: '10.0.0.1' } }) as any;
    expect(headerIp(r('203.0.113.7'), 'cf-connecting-ip')).toBe('203.0.113.7');
    expect(headerIp(r('2001:db8::1'), 'cf-connecting-ip')).toBe('2001:db8::1');
    expect(headerIp(r('not-an-ip'), 'cf-connecting-ip')).toBeNull();
    expect(headerIp(r('203.0.113.7'), undefined)).toBeNull();
  });
});
