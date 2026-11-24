import { EventEmitter } from 'node:events';
import type {
  CreateSessionResponse,
  CustomerLanguage,
  EndReason,
  InviteView,
  JoinResponse,
  LiveSessionState,
  MediaStatePayload,
  SessionSource,
  SessionStatus,
  SessionView,
  ShareStatePayload,
} from '../../../shared/protocol.js';
import { SESSION_CODE_LENGTH } from '../../../shared/protocol.js';
import type { AuditLog } from '../audit.js';
import type { AgentPrincipal } from '../auth/agentTokens.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import type { GenesysPlatformAdapter } from '../integrations/genesysPlatform.js';
import type { WebhookDispatcher } from '../integrations/webhook.js';
import type { Logger } from '../logger.js';
import { generateId, generateNumericCode, generateToken, hashToken, hmacHex, looksLikeToken } from '../security/crypto.js';
import { deriveStatus } from './status.js';

export interface SessionRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  agent_display_name: string;
  salesforce_case_id: string | null;
  source: SessionSource;
  gc_host_origin: string | null;
  gc_target_env: string | null;
  genesys_verified: number | null;
  customer_language: CustomerLanguage | null;
  force_relay: number;
  status: SessionStatus;
  connection_status: string | null;
  ice_candidate_type: string | null;
  created_at: number;
  started_at: number;
  customer_joined_at: number | null;
  consent_at: number | null;
  share_started_at: number | null;
  ended_at: number | null;
  duration_seconds: number | null;
  end_reason: EndReason | null;
  last_activity_at: number;
  max_ends_at: number;
  invite_token_hash: string | null;
  invite_code_hmac: string | null;
  invite_expires_at: number | null;
  invite_used_at: number | null;
  customer_token_hash: string | null;
  verification_code: string | null;
  webhook_status: string | null;
  webhook_attempts: number;
}

export interface CreateSessionInput {
  conversationId: string;
  source: SessionSource;
  gcHostOrigin: string | null;
  gcTargetEnv: string | null;
  customerLanguage: CustomerLanguage | null;
  salesforceCaseId: string | null;
  forceRelay: boolean;
}

interface LiveState {
  agentSocketId: string | null;
  customerSocketId: string | null;
  shareActive: boolean;
  shareStopped: boolean;
  mediaConnected: boolean;
  mediaInterrupted: boolean;
}

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class SessionService extends EventEmitter {
  private readonly live = new Map<string, LiveState>();
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly audit: AuditLog,
    private readonly genesys: GenesysPlatformAdapter,
    private readonly webhook: WebhookDispatcher,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  // ---------------------------------------------------------------- queries

  private row(sessionId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  }

  /** Returns the session only if it belongs to the agent; otherwise behaves exactly like "not found". */
  getOwned(agent: AgentPrincipal, sessionId: string): SessionRow {
    const row = typeof sessionId === 'string' && sessionId.length <= 64 ? this.row(sessionId) : undefined;
    if (!row || row.agent_id.toLowerCase() !== agent.agentId.toLowerCase()) throw new SessionError('session_not_found', 404);
    return row;
  }

  getActive(sessionId: string): SessionRow | null {
    const row = this.row(sessionId);
    return row && row.ended_at === null ? row : null;
  }

  listForAgent(agentId: string, opts: { conversationId?: string; activeOnly?: boolean; limit?: number }): SessionRow[] {
    const where = ['agent_id = ? COLLATE NOCASE'];
    const params: Array<string | number> = [agentId];
    if (opts.conversationId) {
      where.push('conversation_id = ?');
      params.push(opts.conversationId);
    }
    if (opts.activeOnly) where.push('ended_at IS NULL');
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as unknown as SessionRow[];
  }

  toView(row: SessionRow): SessionView {
    const durationSeconds =
      row.duration_seconds ?? (row.ended_at === null ? Math.max(0, Math.round((this.now() - row.started_at) / 1000)) : null);
    return {
      sessionId: row.id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      agentDisplayName: row.agent_display_name,
      salesforceCaseId: row.salesforce_case_id,
      source: row.source,
      gcHostOrigin: row.gc_host_origin,
      gcTargetEnv: row.gc_target_env,
      genesysVerified: row.genesys_verified === null ? null : row.genesys_verified === 1,
      customerLanguage: row.customer_language,
      forceRelay: row.force_relay === 1,
      status: row.ended_at !== null ? 'ended' : this.computeStatus(row),
      connectionStatus: row.connection_status,
      iceCandidateType: row.ice_candidate_type,
      createdAt: iso(row.created_at)!,
      startedAt: iso(row.started_at)!,
      customerJoinedAt: iso(row.customer_joined_at),
      consentAt: iso(row.consent_at),
      shareStartedAt: iso(row.share_started_at),
      endedAt: iso(row.ended_at),
      durationSeconds,
      endReason: row.end_reason,
      inviteExpiresAt: iso(row.invite_expires_at),
      inviteUsed: row.invite_used_at !== null,
      verificationCode: row.ended_at === null ? row.verification_code : null,
      maxEndsAt: iso(row.max_ends_at)!,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async create(agent: AgentPrincipal, input: CreateSessionInput, baseUrl: string, ip: string): Promise<CreateSessionResponse> {
    let genesysVerified: number | null = null;
    if (this.genesys.enabled && input.source === 'genesys') {
      const lookup = await this.genesys.lookupConversation(input.conversationId);
      genesysVerified = lookup.exists === null ? null : lookup.exists ? 1 : 0;
      if (this.config.genesys.verifyConversation && lookup.exists !== true) {
        this.audit.record({
          event: 'session.create_rejected',
          actorType: 'agent',
          actorId: agent.agentId,
          ip,
          details: { reason: 'conversation_not_verified', conversationId: input.conversationId },
        });
        throw new SessionError('conversation_not_verified', 422);
      }
    }

    const t = this.now();
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO sessions (id, conversation_id, agent_id, agent_display_name, salesforce_case_id, source, gc_host_origin,
          gc_target_env, genesys_verified, customer_language, force_relay, status, created_at, started_at, last_activity_at, max_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_customer', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        agent.agentId,
        agent.displayName,
        input.salesforceCaseId,
        input.source,
        input.gcHostOrigin,
        input.gcTargetEnv,
        genesysVerified,
        input.customerLanguage,
        input.forceRelay ? 1 : 0,
        t,
        t,
        t,
        t + this.config.sessionMaxDurationMs,
      );
    const invite = this.issueInvite(id, baseUrl, input.customerLanguage);
    this.audit.record({
      event: 'session.created',
      actorType: 'agent',
      actorId: agent.agentId,
      sessionId: id,
      ip,
      details: {
        conversationId: input.conversationId,
        source: input.source,
        gcTargetEnv: input.gcTargetEnv,
        gcHostOrigin: input.gcHostOrigin,
        forceRelay: input.forceRelay,
        genesysVerified,
        salesforceCaseId: input.salesforceCaseId,
      },
    });
    return { session: this.toView(this.row(id)!), invite };
  }

  regenerateInvite(agent: AgentPrincipal, sessionId: string, baseUrl: string, ip: string): CreateSessionResponse {
    const row = this.getOwned(agent, sessionId);
    if (row.ended_at !== null) throw new SessionError('session_ended', 409);
    const invite = this.issueInvite(row.id, baseUrl, row.customer_language);
    this.audit.record({ event: 'invite.regenerated', actorType: 'agent', actorId: agent.agentId, sessionId, ip });
    this.publish(row.id);
    return { session: this.toView(this.row(sessionId)!), invite };
  }

  private issueInvite(sessionId: string, baseUrl: string, language: CustomerLanguage | null): InviteView {
    const token = generateToken();
    const t = this.now();
    let code = '';
    let codeHmac = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      code = generateNumericCode(SESSION_CODE_LENGTH);
      codeHmac = this.codeHmac(code);
      const clash = this.db
        .prepare('SELECT 1 FROM sessions WHERE invite_code_hmac = ? AND invite_expires_at > ? AND ended_at IS NULL')
        .get(codeHmac, t);
      if (!clash) break;
      if (attempt === 19) throw new SessionError('code_space_exhausted', 503);
    }
    const expiresAt = t + this.config.inviteTtlMs;
    this.db
      .prepare(
        'UPDATE sessions SET invite_token_hash = ?, invite_code_hmac = ?, invite_expires_at = ?, invite_used_at = NULL, last_activity_at = ? WHERE id = ?',
      )
      .run(hashToken(token), codeHmac, expiresAt, t, sessionId);
    const fragment = new URLSearchParams({ t: token });
    if (language) fragment.set('lang', language);
    return { url: `${baseUrl}/join#${fragment.toString()}`, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private codeHmac(code: string): string {
    return hmacHex(this.config.serverSecret, `session-code:${code}`);
  }

  /**
   * Exchanges a single-use invite token or session code for a customer token.
   * The invite (link and code together) is consumed atomically; a previous customer token is revoked.
   */
  redeem(credential: { inviteToken?: string; code?: string }, ip: string): JoinResponse {
    const t = this.now();
    let row: SessionRow | undefined;
    let method: 'link' | 'code';
    if (credential.inviteToken !== undefined) {
      method = 'link';
      if (!looksLikeToken(credential.inviteToken)) throw new SessionError('invalid_invite', 404);
      row = this.db.prepare('SELECT * FROM sessions WHERE invite_token_hash = ?').get(hashToken(credential.inviteToken)) as SessionRow | undefined;
    } else if (credential.code !== undefined && /^\d{6}$/.test(credential.code)) {
      method = 'code';
      row = this.db
        .prepare('SELECT * FROM sessions WHERE invite_code_hmac = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1')
        .get(this.codeHmac(credential.code)) as SessionRow | undefined;
    } else {
      throw new SessionError('invalid_invite', 404);
    }

    const reason = !row
      ? 'unknown'
      : row.ended_at !== null
        ? 'session_ended'
        : row.invite_used_at !== null
          ? 'already_used'
          : (row.invite_expires_at ?? 0) <= t
            ? 'expired'
            : null;
    if (!row || reason) {
      this.audit.record({
        event: 'customer.join_failed',
        actorType: 'anonymous',
        sessionId: row?.id ?? null,
        ip,
        details: { method, reason },
      });
      throw new SessionError(reason === 'expired' ? 'invite_expired' : 'invalid_invite', reason === 'expired' ? 410 : 404);
    }

    const customerToken = generateToken();
    const verificationCode = generateNumericCode(4);
    const hadCustomer = row.customer_token_hash !== null;
    this.db
      .prepare(
        `UPDATE sessions SET invite_used_at = ?, invite_token_hash = NULL, invite_code_hmac = NULL, customer_token_hash = ?,
          verification_code = ?, customer_joined_at = COALESCE(customer_joined_at, ?), last_activity_at = ? WHERE id = ?`,
      )
      .run(t, hashToken(customerToken), verificationCode, t, t, row.id);
    this.audit.record({
      event: 'customer.joined',
      actorType: 'customer',
      sessionId: row.id,
      ip,
      details: { method, replacedPreviousCustomer: hadCustomer },
    });
    if (hadCustomer) this.emit('customer-replaced', row.id);
    this.publish(row.id);
    return {
      customerToken,
      sessionId: row.id,
      agentDisplayName: row.agent_display_name,
      customerLanguage: row.customer_language,
      verificationCode,
    };
  }

  verifyCustomerToken(token: unknown): SessionRow | null {
    if (!looksLikeToken(token)) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE customer_token_hash = ?').get(hashToken(token)) as SessionRow | undefined;
    if (!row || row.ended_at !== null || row.max_ends_at <= this.now()) return null;
    return row;
  }

  updateCaseId(agent: AgentPrincipal, sessionId: string, caseId: string | null, ip: string): SessionView {
    const row = this.getOwned(agent, sessionId);
    this.db.prepare('UPDATE sessions SET salesforce_case_id = ? WHERE id = ?').run(caseId, row.id);
    this.audit.record({
      event: 'session.salesforce_case_updated',
      actorType: 'agent',
      actorId: agent.agentId,
      sessionId,
      ip,
      details: { salesforceCaseId: caseId },
    });
    return this.toView(this.row(sessionId)!);
  }

  end(sessionId: string, reason: EndReason, actor: { type: 'agent' | 'system'; id?: string; ip?: string }): SessionView | null {
    const row = this.row(sessionId);
    if (!row || row.ended_at !== null) return row ? this.toView(row) : null;
    const t = this.now();
    const duration = Math.max(0, Math.round((t - row.started_at) / 1000));
    this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, duration_seconds = ?, end_reason = ?, status = 'ended', invite_token_hash = NULL,
          invite_code_hmac = NULL, customer_token_hash = NULL, verification_code = NULL WHERE id = ? AND ended_at IS NULL`,
      )
      .run(t, duration, reason, sessionId);
    this.live.delete(sessionId);
    this.lastTouch.delete(sessionId);
    this.audit.record({
      event: 'session.ended',
      actorType: actor.type,
      actorId: actor.id ?? null,
      sessionId,
      ip: actor.ip ?? null,
      details: { reason, durationSeconds: duration, lastStatus: row.status },
    });
    const ended = this.row(sessionId)!;
    this.emit('ended', sessionId, reason);
    void this.dispatchWebhook(ended, row.status);
    return this.toView(ended);
  }

  private async dispatchWebhook(row: SessionRow, finalStatus: SessionStatus): Promise<void> {
    if (!this.webhook.enabled) return;
    const result = await this.webhook.deliver({
      sessionId: row.id,
      genesysConversationId: row.conversation_id,
      agentId: row.agent_id,
      salesforceCaseId: row.salesforce_case_id,
      source: row.source,
      gcHostOrigin: row.gc_host_origin,
      gcTargetEnv: row.gc_target_env,
      startedAt: iso(row.started_at)!,
      endedAt: iso(row.ended_at)!,
      durationSeconds: row.duration_seconds ?? 0,
      endReason: row.end_reason ?? 'agent_ended',
      finalStatus,
      connectionStatus: row.connection_status,
      iceCandidateType: row.ice_candidate_type,
      customerJoinedAt: iso(row.customer_joined_at),
      customerConsentAt: iso(row.consent_at),
      shareStartedAt: iso(row.share_started_at),
    });
    try {
      this.db.prepare('UPDATE sessions SET webhook_status = ?, webhook_attempts = ? WHERE id = ?').run(result.status, result.attempts, row.id);
    } catch {
      // session may already be purged
    }
    this.audit.record({ event: `webhook.${result.status}`, actorType: 'system', sessionId: row.id, details: { attempts: result.attempts } });
    this.emit('webhook', row.id, result);
  }

  // ---------------------------------------------------------------- live state

  private liveFor(sessionId: string): LiveState {
    let s = this.live.get(sessionId);
    if (!s) {
      s = {
        agentSocketId: null,
        customerSocketId: null,
        shareActive: false,
        shareStopped: false,
        mediaConnected: false,
        mediaInterrupted: false,
      };
      this.live.set(sessionId, s);
    }
    return s;
  }

  private computeStatus(row: SessionRow): SessionStatus {
    const s = this.live.get(row.id);
    return deriveStatus({
      ended: row.ended_at !== null,
      customerJoined: row.customer_joined_at !== null,
      customerOnline: !!s?.customerSocketId,
      consentGiven: row.consent_at !== null,
      shareActive: !!s?.shareActive,
      shareStopped: !!s?.shareStopped,
      mediaConnected: !!s?.mediaConnected,
      mediaInterrupted: !!s?.mediaInterrupted,
    });
  }

  liveState(sessionId: string): LiveSessionState | null {
    const row = this.row(sessionId);
    if (!row) return null;
    const s = this.live.get(sessionId);
    return {
      sessionId,
      status: row.ended_at !== null ? 'ended' : this.computeStatus(row),
      agentOnline: !!s?.agentSocketId,
      customerOnline: !!s?.customerSocketId,
      customerJoined: row.customer_joined_at !== null,
      invitePending: row.ended_at === null && row.invite_token_hash !== null && (row.invite_expires_at ?? 0) > this.now(),
      consentGiven: row.consent_at !== null,
      shareActive: !!s?.shareActive,
      mediaConnected: !!s?.mediaConnected,
      verificationCode: row.ended_at === null ? row.verification_code : null,
      startedAt: iso(row.started_at)!,
      endedAt: iso(row.ended_at),
    };
  }

  /** Persists the derived status and notifies listeners (the socket layer broadcasts it to the session room). */
  private publish(sessionId: string): void {
    const state = this.liveState(sessionId);
    if (!state) return;
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ? AND ended_at IS NULL').run(state.status, sessionId);
    this.emit('state', sessionId, state);
  }

  touch(sessionId: string): void {
    const t = this.now();
    if (t - (this.lastTouch.get(sessionId) ?? 0) < 15_000) return;
    this.lastTouch.set(sessionId, t);
    this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ? AND ended_at IS NULL').run(t, sessionId);
  }

  /** Returns the socket id that was replaced, if any. */
  attachAgent(sessionId: string, socketId: string): string | null {
    const s = this.liveFor(sessionId);
    const previous = s.agentSocketId && s.agentSocketId !== socketId ? s.agentSocketId : null;
    s.agentSocketId = socketId;
    s.mediaConnected = false;
    this.lastTouch.delete(sessionId);
    this.touch(sessionId);
    this.publish(sessionId);
    return previous;
  }

  detachAgent(sessionId: string, socketId: string): void {
    const s = this.live.get(sessionId);
    if (!s || s.agentSocketId !== socketId) return;
    s.agentSocketId = null;
    s.mediaConnected = false;
    this.lastTouch.delete(sessionId);
    this.touch(sessionId);
    this.publish(sessionId);
  }

  attachCustomer(sessionId: string, socketId: string): string | null {
    const s = this.liveFor(sessionId);
    const previous = s.customerSocketId && s.customerSocketId !== socketId ? s.customerSocketId : null;
    s.customerSocketId = socketId;
    // A (re)connected customer must re-announce an active share; the agent reports media state independently.
    s.shareActive = false;
    this.lastTouch.delete(sessionId);
    this.touch(sessionId);
    this.publish(sessionId);
    return previous;
  }

  detachCustomer(sessionId: string, socketId: string): void {
    const s = this.live.get(sessionId);
    if (!s || s.customerSocketId !== socketId) return;
    s.customerSocketId = null;
    this.lastTouch.delete(sessionId);
    this.touch(sessionId);
    this.publish(sessionId);
  }

  socketIdFor(sessionId: string, role: 'agent' | 'customer'): string | null {
    const s = this.live.get(sessionId);
    if (!s) return null;
    return role === 'agent' ? s.agentSocketId : s.customerSocketId;
  }

  isCustomerSocket(sessionId: string, socketId: string): boolean {
    return this.live.get(sessionId)?.customerSocketId === socketId;
  }

  isAgentSocket(sessionId: string, socketId: string): boolean {
    return this.live.get(sessionId)?.agentSocketId === socketId;
  }

  hasConsent(sessionId: string): boolean {
    return this.row(sessionId)?.consent_at != null;
  }

  recordConsent(sessionId: string, ip: string): void {
    const t = this.now();
    this.db.prepare('UPDATE sessions SET consent_at = COALESCE(consent_at, ?), last_activity_at = ? WHERE id = ? AND ended_at IS NULL').run(t, t, sessionId);
    this.audit.record({ event: 'customer.consent_given', actorType: 'customer', sessionId, ip });
    this.publish(sessionId);
  }

  setShareState(sessionId: string, payload: ShareStatePayload, ip: string): void {
    const s = this.liveFor(sessionId);
    if (payload.state === 'started') {
      const wasActive = s.shareActive;
      s.shareActive = true;
      s.shareStopped = false;
      s.mediaInterrupted = false;
      const t = this.now();
      this.db.prepare('UPDATE sessions SET share_started_at = COALESCE(share_started_at, ?) WHERE id = ?').run(t, sessionId);
      if (!wasActive) {
        this.audit.record({
          event: 'share.started',
          actorType: 'customer',
          sessionId,
          ip,
          details: { displaySurface: payload.displaySurface, width: payload.width, height: payload.height },
        });
      }
    } else {
      if (s.shareActive) this.audit.record({ event: 'share.stopped', actorType: 'customer', sessionId, ip });
      s.shareActive = false;
      s.shareStopped = true;
      s.mediaConnected = false;
      s.mediaInterrupted = false;
    }
    this.publish(sessionId);
  }

  setMediaState(sessionId: string, payload: MediaStatePayload): void {
    const s = this.liveFor(sessionId);
    const before = `${s.mediaConnected}/${s.mediaInterrupted}`;
    s.mediaConnected = payload.state === 'connected';
    s.mediaInterrupted = payload.state !== 'connected';
    this.db
      .prepare('UPDATE sessions SET connection_status = ?, ice_candidate_type = COALESCE(?, ice_candidate_type) WHERE id = ?')
      .run(payload.state, payload.candidateType ?? null, sessionId);
    if (before !== `${s.mediaConnected}/${s.mediaInterrupted}`) {
      this.audit.record({
        event: `media.${payload.state}`,
        actorType: 'agent',
        sessionId,
        details: payload.candidateType ? { candidateType: payload.candidateType } : undefined,
      });
    }
    this.publish(sessionId);
  }

  // ---------------------------------------------------------------- maintenance

  /** Ends sessions that exceeded their maximum duration or were abandoned. */
  sweep(): number {
    const t = this.now();
    const rows = this.db
      .prepare('SELECT id, max_ends_at, last_activity_at, customer_joined_at, invite_expires_at FROM sessions WHERE ended_at IS NULL')
      .all() as Array<Pick<SessionRow, 'id' | 'max_ends_at' | 'last_activity_at' | 'customer_joined_at' | 'invite_expires_at'>>;
    let ended = 0;
    for (const r of rows) {
      const s = this.live.get(r.id);
      const someoneOnline = !!(s?.agentSocketId || s?.customerSocketId);
      let reason: EndReason | null = null;
      if (r.max_ends_at <= t) reason = 'max_duration';
      else if (!someoneOnline && t - r.last_activity_at >= this.config.sessionIdleTimeoutMs) {
        reason = r.customer_joined_at === null && (r.invite_expires_at ?? 0) <= t ? 'invite_expired' : 'idle_timeout';
      }
      if (reason) {
        this.end(r.id, reason, { type: 'system' });
        ended++;
      }
    }
    return ended;
  }

  /** Deletes ended sessions (and their audit trail) older than the retention period. */
  purge(): { sessions: number } {
    const cutoff = this.now() - this.config.retentionMs;
    const ids = this.db.prepare('SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').all(cutoff) as Array<{ id: string }>;
    const del = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const delAudit = this.db.prepare('DELETE FROM audit_log WHERE session_id = ?');
    for (const { id } of ids) {
      delAudit.run(id);
      del.run(id);
    }
    if (ids.length > 0) this.logger.info('retention_purged_sessions', { count: ids.length });
    return { sessions: ids.length };
  }
}
