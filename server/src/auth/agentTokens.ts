import type { Db } from '../db/database.js';
import { generateToken, hashToken, looksLikeToken } from '../security/crypto.js';
import type { AgentDirectory } from './agentAccounts.js';

export interface AgentPrincipal {
  agentId: string;
  displayName: string;
  tokenHash: string;
  expiresAt: number;
}

/** Opaque bearer tokens, stored hashed and validated server-side on every request and socket event. */
export class AgentTokenStore {
  constructor(
    private readonly db: Db,
    private readonly directory: AgentDirectory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(agentId: string): { token: string; expiresAt: number } {
    const token = generateToken();
    const t = this.now();
    const expiresAt = t + this.ttlMs;
    this.db
      .prepare('INSERT INTO agent_tokens (token_hash, agent_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), agentId, t, expiresAt, t);
    return { token, expiresAt };
  }

  verify(token: unknown): AgentPrincipal | null {
    if (!looksLikeToken(token)) return null;
    const tokenHash = hashToken(token);
    const row = this.db.prepare('SELECT agent_id, expires_at, last_used_at FROM agent_tokens WHERE token_hash = ?').get(tokenHash) as
      | { agent_id: string; expires_at: number; last_used_at: number }
      | undefined;
    if (!row) return null;
    const t = this.now();
    if (row.expires_at <= t) {
      this.db.prepare('DELETE FROM agent_tokens WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    const account = this.directory.get(row.agent_id);
    if (!account) return null; // account removed from configuration
    if (t - row.last_used_at > 60_000) {
      this.db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?').run(t, tokenHash);
    }
    return { agentId: account.id, displayName: account.displayName, tokenHash, expiresAt: row.expires_at };
  }

  revoke(tokenHash: string): void {
    this.db.prepare('DELETE FROM agent_tokens WHERE token_hash = ?').run(tokenHash);
  }

  isValidHash(tokenHash: string): boolean {
    const row = this.db.prepare('SELECT expires_at FROM agent_tokens WHERE token_hash = ?').get(tokenHash) as { expires_at: number } | undefined;
    return !!row && row.expires_at > this.now();
  }

  deleteExpired(): number {
    return Number(this.db.prepare('DELETE FROM agent_tokens WHERE expires_at <= ?').run(this.now()).changes);
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/.exec(header.trim());
  return m ? m[1]! : null;
}
