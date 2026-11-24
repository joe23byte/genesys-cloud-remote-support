import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import { SOCKET_EVENTS, type Ack, type EndReason, type LiveSessionState } from '../../../shared/protocol.js';
import type { AuditLog } from '../audit.js';
import type { AgentPrincipal, AgentTokenStore } from '../auth/agentTokens.js';
import type { AppConfig } from '../config.js';
import { buildIceConfig } from '../ice.js';
import type { Logger } from '../logger.js';
import { canonicalOrigin } from '../security/origins.js';
import { headerIp, RateLimiter } from '../security/rateLimit.js';
import { hashToken } from '../security/crypto.js';
import type { SessionService } from '../sessions/service.js';
import { attachSchema, mediaStateSchema, requestOfferSchema, shareStateSchema, signalSchema } from './validation.js';

type SocketData =
  | { role: 'agent'; agent: AgentPrincipal; tokenHash: string; sessionId: string | null; ip: string }
  | { role: 'customer'; tokenHash: string; sessionId: string; ip: string };

type AppSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

const room = (sessionId: string) => `s:${sessionId}`;

/** Mirrors Express "trust proxy" semantics for the cases this app supports (boolean, hop count, loopback). */
export function requestIp(req: IncomingMessage, trustProxy: AppConfig['trustProxy']): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const header = req.headers['x-forwarded-for'];
  if (!trustProxy || typeof header !== 'string' || header.trim() === '') return remote;
  const chain = [...header.split(',').map((s) => s.trim()).filter(Boolean), remote];
  if (trustProxy === true) return chain[0]!;
  if (typeof trustProxy === 'number') return chain[Math.max(0, chain.length - 1 - trustProxy)]!;
  const isLoopback = /^(::1|127\.|::ffff:127\.)/.test(remote);
  return isLoopback ? chain[chain.length - 2]! : remote;
}

/** Browsers always send Origin for WebSocket and XHR; it must be this application's own origin. */
export function isSameOriginRequest(req: IncomingMessage, config: AppConfig): boolean {
  const origin = typeof req.headers.origin === 'string' ? canonicalOrigin(req.headers.origin) : null;
  if (!origin) return false;
  if (origin === config.publicOrigin) return true;
  if (config.isProduction) return false;
  const host = req.headers.host;
  return !!host && new URL(origin).host === host;
}

export function createSignalingServer(deps: {
  httpServer: HttpServer;
  config: AppConfig;
  sessions: SessionService;
  tokens: AgentTokenStore;
  audit: AuditLog;
  logger: Logger;
  /** Leave foreign WebSocket upgrades alone (Vite HMR shares the server in development). */
  sharesUpgrades?: boolean;
}) {
  const { httpServer, config, sessions, tokens, audit, logger } = deps;

  const io = new Server(httpServer, {
    path: '/socket.io',
    destroyUpgrade: !deps.sharesUpgrades,
    serveClient: false,
    maxHttpBufferSize: 128 * 1024,
    pingInterval: 10_000,
    pingTimeout: 10_000,
    allowRequest: (req, callback) => {
      const ok = isSameOriginRequest(req, config);
      if (!ok) logger.warn('socket_origin_rejected', { origin: req.headers.origin ?? null });
      callback(null, ok);
    },
  });

  const eventLimiter = new RateLimiter(300, 10_000);

  io.use((rawSocket, next) => {
    const socket = rawSocket as AppSocket;
    const auth = (socket.handshake.auth ?? {}) as { role?: unknown; token?: unknown };
    const ip = headerIp(socket.request, config.clientIpHeader) ?? requestIp(socket.request, config.trustProxy);
    if (auth.role === 'agent') {
      const principal = tokens.verify(auth.token);
      if (principal) {
        socket.data = { role: 'agent', agent: principal, tokenHash: principal.tokenHash, sessionId: null, ip };
        return next();
      }
    } else if (auth.role === 'customer') {
      const row = sessions.verifyCustomerToken(auth.token);
      if (row) {
        socket.data = { role: 'customer', tokenHash: hashToken(auth.token as string), sessionId: row.id, ip };
        return next();
      }
    }
    audit.record({ event: 'socket.unauthorized', actorType: 'anonymous', ip, details: { role: typeof auth.role === 'string' ? auth.role : null } });
    next(new Error('unauthorized'));
  });

  /** Central authorization check executed before every event handler. */
  function authorized(socket: AppSocket): string | null {
    const d = socket.data;
    if (!d.sessionId) return null;
    const row = sessions.getActive(d.sessionId);
    if (!row) return null;
    if (d.role === 'agent') {
      if (!tokens.isValidHash(d.tokenHash)) return null;
      if (row.agent_id.toLowerCase() !== d.agent.agentId.toLowerCase()) return null;
      if (!sessions.isAgentSocket(d.sessionId, socket.id)) return null;
    } else {
      if (row.customer_token_hash !== d.tokenHash) return null;
      if (!sessions.isCustomerSocket(d.sessionId, socket.id)) return null;
    }
    return d.sessionId;
  }

  function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> | null {
    const r = schema.safeParse(payload);
    return r.success ? r.data : null;
  }

  function limited(socket: AppSocket): boolean {
    const r = eventLimiter.hit(socket.id);
    if (!r.allowed) {
      logger.warn('socket_rate_limited', { role: socket.data.role, sessionId: socket.data.sessionId });
      return true;
    }
    return false;
  }

  const safeAck = (ack: unknown): Ack<unknown> => (typeof ack === 'function' ? (ack as Ack<unknown>) : () => {});

  const counterpartSocketId = (sessionId: string, role: 'agent' | 'customer') =>
    sessions.socketIdFor(sessionId, role === 'agent' ? 'customer' : 'agent');

  function kick(socketId: string, event: string, payload: unknown) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.emit(event as never, payload as never);
    setTimeout(() => s.disconnect(true), 200);
  }

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AppSocket;
    const on = (event: string, handler: (payload: unknown, ack: Ack<unknown>) => void) => {
      socket.on(event as never, ((payload: unknown, ack: unknown) => {
        if (limited(socket)) return safeAck(ack)({ ok: false, error: 'rate_limited' });
        try {
          handler(payload, safeAck(ack));
        } catch (err) {
          logger.error('socket_handler_error', { event, error: (err as Error).message });
          safeAck(ack)({ ok: false, error: 'internal_error' });
        }
      }) as never);
    };

    if (socket.data.role === 'agent') {
      const data = socket.data;
      on(SOCKET_EVENTS.agentAttach, (payload, ack) => {
        const p = parse(attachSchema, payload);
        if (!p) return ack({ ok: false, error: 'invalid_payload' });
        if (data.sessionId && data.sessionId !== p.sessionId) return ack({ ok: false, error: 'already_attached' });
        if (!tokens.isValidHash(data.tokenHash)) return ack({ ok: false, error: 'unauthorized' });
        let row;
        try {
          row = sessions.getOwned(data.agent, p.sessionId);
        } catch {
          audit.record({ event: 'socket.attach_denied', actorType: 'agent', actorId: data.agent.agentId, ip: data.ip, details: { sessionId: p.sessionId } });
          return ack({ ok: false, error: 'session_not_found' });
        }
        if (row.ended_at !== null) return ack({ ok: false, error: 'session_ended' });
        data.sessionId = row.id;
        void socket.join(room(row.id));
        const previous = sessions.attachAgent(row.id, socket.id);
        if (previous) kick(previous, SOCKET_EVENTS.replaced, { reason: 'opened_elsewhere' });
        ack({
          ok: true,
          data: {
            session: sessions.toView(sessions.getActive(row.id)!),
            state: sessions.liveState(row.id),
            iceConfig: buildIceConfig(config, { label: `rs-${row.id.slice(0, 8)}-a`, forceRelay: row.force_relay === 1 }),
          },
        });
      });

      on(SOCKET_EVENTS.requestOffer, (payload, ack) => {
        const sessionId = authorized(socket);
        if (!sessionId) return ack({ ok: false, error: 'unauthorized' });
        const p = parse(requestOfferSchema, payload);
        if (!p) return ack({ ok: false, error: 'invalid_payload' });
        const target = counterpartSocketId(sessionId, 'agent');
        if (!target) return ack({ ok: false, error: 'peer_offline' });
        io.to(target).emit(SOCKET_EVENTS.requestOffer as never, p as never);
        ack({ ok: true });
      });

      on(SOCKET_EVENTS.mediaState, (payload, ack) => {
        const sessionId = authorized(socket);
        if (!sessionId) return ack({ ok: false, error: 'unauthorized' });
        const p = parse(mediaStateSchema, payload);
        if (!p) return ack({ ok: false, error: 'invalid_payload' });
        sessions.setMediaState(sessionId, p);
        ack({ ok: true });
      });
    } else {
      const data = socket.data;
      on(SOCKET_EVENTS.customerAttach, (_payload, ack) => {
        const row = sessions.getActive(data.sessionId);
        if (!row || row.customer_token_hash !== data.tokenHash) return ack({ ok: false, error: 'unauthorized' });
        void socket.join(room(row.id));
        const previous = sessions.attachCustomer(row.id, socket.id);
        if (previous) kick(previous, SOCKET_EVENTS.replaced, { reason: 'opened_elsewhere' });
        ack({
          ok: true,
          data: {
            state: sessions.liveState(row.id),
            agentDisplayName: row.agent_display_name,
            customerLanguage: row.customer_language,
            iceConfig: buildIceConfig(config, { label: `rs-${row.id.slice(0, 8)}-c`, forceRelay: row.force_relay === 1 }),
          },
        });
      });

      on(SOCKET_EVENTS.customerConsent, (_payload, ack) => {
        const sessionId = authorized(socket);
        if (!sessionId) return ack({ ok: false, error: 'unauthorized' });
        sessions.recordConsent(sessionId, data.ip);
        ack({ ok: true });
      });

      on(SOCKET_EVENTS.shareState, (payload, ack) => {
        const sessionId = authorized(socket);
        if (!sessionId) return ack({ ok: false, error: 'unauthorized' });
        const p = parse(shareStateSchema, payload);
        if (!p) return ack({ ok: false, error: 'invalid_payload' });
        if (p.state === 'started' && !sessions.hasConsent(sessionId)) return ack({ ok: false, error: 'consent_required' });
        sessions.setShareState(sessionId, p, data.ip);
        ack({ ok: true });
      });
    }

    on(SOCKET_EVENTS.signal, (payload, ack) => {
      const sessionId = authorized(socket);
      if (!sessionId) return ack({ ok: false, error: 'unauthorized' });
      const msg = parse(signalSchema, payload);
      if (!msg) return ack({ ok: false, error: 'invalid_payload' });
      const role = socket.data.role;
      if (role === 'customer' && msg.kind === 'answer') return ack({ ok: false, error: 'forbidden_signal' });
      if (role === 'agent' && msg.kind === 'offer') return ack({ ok: false, error: 'forbidden_signal' });
      if (role === 'customer' && msg.kind === 'offer' && !sessions.hasConsent(sessionId)) {
        audit.record({ event: 'signal.rejected_without_consent', actorType: 'customer', sessionId, ip: socket.data.ip });
        return ack({ ok: false, error: 'consent_required' });
      }
      const target = counterpartSocketId(sessionId, role);
      if (!target) return ack({ ok: false, error: 'peer_offline' });
      sessions.touch(sessionId);
      io.to(target).emit(SOCKET_EVENTS.signal as never, msg as never);
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      eventLimiter.reset(socket.id);
      const d = socket.data;
      if (!d.sessionId) return;
      if (d.role === 'agent') sessions.detachAgent(d.sessionId, socket.id);
      else sessions.detachCustomer(d.sessionId, socket.id);
    });
  });

  sessions.on('state', (sessionId: string, state: LiveSessionState) => {
    io.to(room(sessionId)).emit(SOCKET_EVENTS.sessionState as never, state as never);
  });

  sessions.on('ended', (sessionId: string, reason: EndReason) => {
    io.to(room(sessionId)).emit(SOCKET_EVENTS.sessionEnded as never, { sessionId, reason } as never);
    setTimeout(() => io.in(room(sessionId)).disconnectSockets(true), 300);
  });

  sessions.on('customer-replaced', (sessionId: string) => {
    for (const s of io.sockets.sockets.values()) {
      const d = (s as AppSocket).data;
      if (d?.role === 'customer' && d.sessionId === sessionId) kick(s.id, SOCKET_EVENTS.replaced, { reason: 'new_customer_joined' });
    }
  });

  /** Disconnects all sockets that authenticated with the given agent token (logout). */
  function disconnectAgentToken(tokenHash: string) {
    for (const s of io.sockets.sockets.values()) {
      const d = (s as AppSocket).data;
      if (d?.role === 'agent' && d.tokenHash === tokenHash) kick(s.id, SOCKET_EVENTS.replaced, { reason: 'logged_out' });
    }
  }

  return { io, disconnectAgentToken };
}
