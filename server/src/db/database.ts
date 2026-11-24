import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_display_name TEXT NOT NULL,
    salesforce_case_id TEXT,
    source TEXT NOT NULL,
    gc_host_origin TEXT,
    gc_target_env TEXT,
    genesys_verified INTEGER,
    customer_language TEXT,
    force_relay INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    connection_status TEXT,
    ice_candidate_type TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    customer_joined_at INTEGER,
    consent_at INTEGER,
    share_started_at INTEGER,
    ended_at INTEGER,
    duration_seconds INTEGER,
    end_reason TEXT,
    last_activity_at INTEGER NOT NULL,
    max_ends_at INTEGER NOT NULL,
    invite_token_hash TEXT,
    invite_code_hmac TEXT,
    invite_expires_at INTEGER,
    invite_used_at INTEGER,
    customer_token_hash TEXT,
    verification_code TEXT,
    webhook_status TEXT,
    webhook_attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_sessions_agent ON sessions(agent_id, created_at);
  CREATE INDEX idx_sessions_conversation ON sessions(conversation_id);
  CREATE INDEX idx_sessions_created ON sessions(created_at);
  CREATE UNIQUE INDEX idx_sessions_invite ON sessions(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
  CREATE INDEX idx_sessions_code ON sessions(invite_code_hmac) WHERE invite_code_hmac IS NOT NULL;
  CREATE UNIQUE INDEX idx_sessions_customer ON sessions(customer_token_hash) WHERE customer_token_hash IS NOT NULL;

  CREATE TABLE agent_tokens (
    token_hash TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_id TEXT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    event TEXT NOT NULL,
    details TEXT,
    ip_hash TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);
  CREATE INDEX idx_audit_session ON audit_log(session_id);
  `,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
