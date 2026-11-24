import type { Db } from './db/database.js';
import { redact, type Logger } from './logger.js';
import { hmacHex } from './security/crypto.js';

export type ActorType = 'agent' | 'customer' | 'system' | 'anonymous';

export interface AuditEntry {
  event: string;
  actorType: ActorType;
  actorId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRecord {
  ts: string;
  event: string;
  actorType: ActorType;
  actorId: string | null;
  details: Record<string, unknown> | null;
}

/**
 * Audit trail without screen content, tokens or SDP. IP addresses are stored as
 * keyed hashes so abuse can be correlated without keeping raw personal data.
 */
export class AuditLog {
  private readonly insert;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly logger: Logger,
    private readonly toStdout: boolean,
  ) {
    this.insert = db.prepare(
      'INSERT INTO audit_log (ts, session_id, actor_type, actor_id, event, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  }

  record(entry: AuditEntry): void {
    const details = entry.details ? (redact(entry.details) as Record<string, unknown>) : null;
    const ipHash = entry.ip ? hmacHex(this.secret, `ip:${entry.ip}`).slice(0, 16) : null;
    try {
      this.insert.run(
        Date.now(),
        entry.sessionId ?? null,
        entry.actorType,
        entry.actorId ?? null,
        entry.event,
        details ? JSON.stringify(details) : null,
        ipHash,
      );
    } catch (err) {
      this.logger.error('audit_write_failed', { error: (err as Error).message, event: entry.event });
    }
    if (this.toStdout) {
      this.logger.info('audit', {
        event: entry.event,
        actorType: entry.actorType,
        actorId: entry.actorId ?? undefined,
        sessionId: entry.sessionId ?? undefined,
        ipHash: ipHash ?? undefined,
        ...(details ?? {}),
      });
    }
  }

  forSession(sessionId: string, limit = 200): AuditRecord[] {
    const rows = this.db
      .prepare('SELECT ts, event, actor_type, actor_id, details FROM audit_log WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit) as Array<{ ts: number; event: string; actor_type: ActorType; actor_id: string | null; details: string | null }>;
    return rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      event: r.event,
      actorType: r.actor_type,
      actorId: r.actor_id,
      details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    }));
  }

  deleteOlderThan(cutoffMs: number): number {
    return Number(this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoffMs).changes);
  }
}
