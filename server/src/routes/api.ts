import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { LIMITS, SESSION_CODE_LENGTH } from '../../../shared/protocol.js';
import type { AuditLog } from '../audit.js';
import type { AgentDirectory } from '../auth/agentAccounts.js';
import { bearerToken, type AgentPrincipal, type AgentTokenStore } from '../auth/agentTokens.js';
import type { AppConfig } from '../config.js';
import { describeIce } from '../ice.js';
import type { GenesysPlatformAdapter } from '../integrations/genesysPlatform.js';
import type { WebhookDispatcher } from '../integrations/webhook.js';
import type { Logger } from '../logger.js';
import { canonicalOrigin, isAllowedOrigin, isValidTargetEnv } from '../security/origins.js';
import { clientIp as resolveClientIp, RateLimiter, rateLimitMiddleware } from '../security/rateLimit.js';
import { SessionError, type SessionService } from '../sessions/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_ID_RE = new RegExp(`^[A-Za-z0-9._-]{1,${LIMITS.salesforceCaseIdMax}}$`);

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const createSessionSchema = z.object({
  conversationId: z.string().regex(UUID_RE, 'conversationId must be a Genesys Cloud conversation UUID'),
  source: z.enum(['genesys', 'demo']).default('genesys'),
  gcHostOrigin: z.string().max(255).optional().nullable(),
  gcTargetEnv: z.string().max(64).optional().nullable(),
  customerLanguage: z.enum(['de', 'en']).optional().nullable(),
  salesforceCaseId: z.string().regex(CASE_ID_RE).optional().nullable(),
  forceRelay: z.boolean().optional().default(false),
});

const patchSessionSchema = z.object({
  salesforceCaseId: z.union([z.string().regex(CASE_ID_RE), z.literal(''), z.null()]),
});

const joinSchema = z.union([
  z.object({ inviteToken: z.string().min(1).max(200) }).strict(),
  z.object({ code: z.string().regex(new RegExp(`^\\d{${SESSION_CODE_LENGTH}}$`)) }).strict(),
]);

const listQuerySchema = z.object({
  conversationId: z.string().regex(UUID_RE).optional(),
  active: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

declare module 'express-serve-static-core' {
  interface Request {
    agent?: AgentPrincipal;
  }
}

export interface ApiDeps {
  config: AppConfig;
  sessions: SessionService;
  tokens: AgentTokenStore;
  directory: AgentDirectory;
  audit: AuditLog;
  logger: Logger;
  genesys: GenesysPlatformAdapter;
  webhook: WebhookDispatcher;
  onLogout: (tokenHash: string) => void;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { config, sessions, tokens, directory, audit, logger } = deps;
  const router = Router();
  const clientIp = (req: Request) => resolveClientIp(req, config.clientIpHeader);

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  router.use(express.json({ limit: '16kb' }));

  const general = new RateLimiter(600, 60_000);
  router.use(rateLimitMiddleware(general, (req) => `ip:${clientIp(req)}`));

  const requireAgent = (req: Request, res: Response, next: NextFunction) => {
    const principal = tokens.verify(bearerToken(req.header('authorization')));
    if (!principal) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.agent = principal;
    next();
  };

  const inviteBaseUrl = (req: Request) => (config.isProduction ? config.publicBaseUrl : `${req.protocol}://${req.get('host')}`);

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/config', (_req, res) => {
    res.json({
      demoEnabled: config.demoEnabled,
      sessionCodeLength: SESSION_CODE_LENGTH,
      inviteTtlSeconds: Math.round(config.inviteTtlMs / 1000),
      sessionMaxDurationMinutes: Math.round(config.sessionMaxDurationMs / 60_000),
    });
  });

  // ------------------------------------------------------------ auth

  const loginLimiter = new RateLimiter(config.rateLimits.loginPer15Min, 15 * 60_000);
  router.post('/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const body = loginSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const username = body.data.username.trim();
    const limitIp = loginLimiter.hit(`ip:${ip}`);
    const limitUser = loginLimiter.hit(`user:${username.toLowerCase()}`);
    if (!limitIp.allowed || !limitUser.allowed) {
      audit.record({ event: 'agent.login_rate_limited', actorType: 'anonymous', ip, details: { username } });
      res.setHeader('Retry-After', Math.ceil(Math.max(limitIp.retryAfterMs, limitUser.retryAfterMs) / 1000).toString());
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const account = await directory.authenticate(username, body.data.password);
    if (!account) {
      audit.record({ event: 'agent.login_failed', actorType: 'anonymous', ip, details: { username } });
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    loginLimiter.reset(`user:${username.toLowerCase()}`);
    const issued = tokens.issue(account.id);
    audit.record({ event: 'agent.login', actorType: 'agent', actorId: account.id, ip });
    res.json({
      token: issued.token,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      agent: { id: account.id, displayName: account.displayName },
    });
  });

  router.post('/auth/logout', requireAgent, (req, res) => {
    tokens.revoke(req.agent!.tokenHash);
    deps.onLogout(req.agent!.tokenHash);
    audit.record({ event: 'agent.logout', actorType: 'agent', actorId: req.agent!.agentId, ip: clientIp(req) });
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAgent, (req, res) => {
    res.json({
      agent: { id: req.agent!.agentId, displayName: req.agent!.displayName },
      expiresAt: new Date(req.agent!.expiresAt).toISOString(),
    });
  });

  // ------------------------------------------------------------ sessions (agent)

  const createLimiter = new RateLimiter(30, 60_000);
  router.post(
    '/sessions',
    requireAgent,
    rateLimitMiddleware(createLimiter, (req) => `agent:${req.agent!.agentId}`),
    async (req, res) => {
      const parsed = createSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', details: parsed.error.issues.map((i) => i.path.join('.')) });
        return;
      }
      const input = parsed.data;
      if (input.source === 'demo' && !config.demoEnabled) {
        res.status(403).json({ error: 'demo_disabled' });
        return;
      }
      let gcHostOrigin: string | null = null;
      if (input.gcHostOrigin) {
        gcHostOrigin = canonicalOrigin(input.gcHostOrigin);
        if (!gcHostOrigin || !isAllowedOrigin(gcHostOrigin, config.gcAllowedHostOrigins)) {
          audit.record({
            event: 'session.create_rejected',
            actorType: 'agent',
            actorId: req.agent!.agentId,
            ip: clientIp(req),
            details: { reason: 'gc_host_origin_not_allowed', gcHostOrigin: input.gcHostOrigin.slice(0, 120) },
          });
          res.status(400).json({ error: 'gc_host_origin_not_allowed' });
          return;
        }
      }
      if (input.gcTargetEnv && !isValidTargetEnv(input.gcTargetEnv)) {
        res.status(400).json({ error: 'invalid_gc_target_env' });
        return;
      }
      if (input.source === 'genesys' && (!gcHostOrigin || !input.gcTargetEnv)) {
        res.status(400).json({ error: 'genesys_context_required' });
        return;
      }
      if (gcHostOrigin && deps.genesys.enabled && deps.genesys.expectedHostOrigin && gcHostOrigin !== deps.genesys.expectedHostOrigin) {
        logger.warn('gc_host_origin_differs_from_api_region', { gcHostOrigin, expected: deps.genesys.expectedHostOrigin });
      }
      const result = await sessions.create(
        req.agent!,
        {
          conversationId: input.conversationId.toLowerCase(),
          source: input.source,
          gcHostOrigin,
          gcTargetEnv: input.gcTargetEnv ?? null,
          customerLanguage: input.customerLanguage ?? null,
          salesforceCaseId: input.salesforceCaseId || null,
          forceRelay: input.forceRelay,
        },
        inviteBaseUrl(req),
        clientIp(req),
      );
      res.status(201).json(result);
    },
  );

  router.get('/sessions', requireAgent, (req, res) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const rows = sessions.listForAgent(req.agent!.agentId, {
      conversationId: q.data.conversationId?.toLowerCase(),
      activeOnly: q.data.active === '1' || q.data.active === 'true',
      limit: q.data.limit,
    });
    res.json({ sessions: rows.map((r) => sessions.toView(r)) });
  });

  router.get('/sessions/:id', requireAgent, (req, res) => {
    res.json({ session: sessions.toView(sessions.getOwned(req.agent!, String(req.params.id))) });
  });

  router.patch('/sessions/:id', requireAgent, (req, res) => {
    const body = patchSessionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_salesforce_case_id' });
      return;
    }
    const view = sessions.updateCaseId(req.agent!, String(req.params.id), body.data.salesforceCaseId || null, clientIp(req));
    res.json({ session: view });
  });

  router.post('/sessions/:id/invite', requireAgent, (req, res) => {
    res.json(sessions.regenerateInvite(req.agent!, String(req.params.id), inviteBaseUrl(req), clientIp(req)));
  });

  router.post('/sessions/:id/end', requireAgent, (req, res) => {
    const row = sessions.getOwned(req.agent!, String(req.params.id));
    const view = sessions.end(row.id, 'agent_ended', { type: 'agent', id: req.agent!.agentId, ip: clientIp(req) });
    res.json({ session: view });
  });

  router.get('/sessions/:id/audit', requireAgent, (req, res) => {
    const row = sessions.getOwned(req.agent!, String(req.params.id));
    res.json({ events: audit.forSession(row.id) });
  });

  // ------------------------------------------------------------ customer join

  const codeLimiter = new RateLimiter(config.rateLimits.codeJoinPer10Min, 10 * 60_000);
  const globalCodeFailures = new RateLimiter(200, 60_000);
  const linkLimiter = new RateLimiter(30, 10 * 60_000);
  router.post('/join', (req, res) => {
    const ip = clientIp(req);
    const body = joinSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const byCode = 'code' in body.data;
    const limit = (byCode ? codeLimiter : linkLimiter).hit(`ip:${ip}`);
    if (!limit.allowed) {
      audit.record({ event: 'customer.join_rate_limited', actorType: 'anonymous', ip, details: { method: byCode ? 'code' : 'link' } });
      res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000).toString());
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if (byCode && globalCodeFailures.isExhausted('failures')) {
      // Distributed brute force protection: code entry is paused globally; invitation links keep working.
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    try {
      const result = sessions.redeem(body.data, ip);
      if (byCode) codeLimiter.reset(`ip:${ip}`);
      res.json(result);
    } catch (err) {
      if (byCode) globalCodeFailures.hit('failures');
      throw err;
    }
  });

  // ------------------------------------------------------------ demo diagnostics

  router.get('/demo/info', requireAgent, (_req, res) => {
    if (!config.demoEnabled) {
      res.status(403).json({ error: 'demo_disabled' });
      return;
    }
    res.json({
      environment: config.env,
      publicBaseUrl: config.publicBaseUrl,
      ice: describeIce(config),
      media: config.media,
      inviteTtlSeconds: Math.round(config.inviteTtlMs / 1000),
      sessionMaxDurationMinutes: Math.round(config.sessionMaxDurationMs / 60_000),
      sessionIdleTimeoutMinutes: Math.round(config.sessionIdleTimeoutMs / 60_000),
      retentionDays: Math.round(config.retentionMs / 86_400_000),
      gcAllowedHostOrigins: config.gcAllowedHostOrigins.map((p) => p.source),
      frameAncestors: config.frameAncestors,
      webhookEnabled: deps.webhook.enabled,
      genesysApiEnabled: deps.genesys.enabled,
    });
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SessionError) {
      res.status(err.httpStatus).json({ error: err.code });
      return;
    }
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: 'invalid_request' });
      return;
    }
    logger.error('api_error', { path: req.path, error: (err as Error).message });
    res.status(500).json({ error: 'internal_error' });
  });

  return router;
}
