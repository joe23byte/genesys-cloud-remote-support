import { randomBytes } from 'node:crypto';
import { hashPassword, parsePasswordHash, verifyPassword, type ParsedHash } from './passwords.js';

export interface AgentAccount {
  id: string;
  displayName: string;
  hash: ParsedHash;
}

export const AGENT_ID_RE = /^[A-Za-z0-9._@-]{2,64}$/;

/**
 * AGENT_ACCOUNTS: entries separated by ";" or newlines, each "id|Display Name|scrypt:..."
 * Create entries with: npm run agent:create -- <id> "<Display Name>"
 */
export function parseAgentAccounts(raw: string): AgentAccount[] {
  const accounts: AgentAccount[] = [];
  const seen = new Set<string>();
  const entries = raw
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split('|').map((s) => s.trim());
    if (parts.length !== 3) throw new Error('AGENT_ACCOUNTS entries must have the form id|Display Name|scrypt:...');
    const [id, displayName, hashValue] = parts as [string, string, string];
    if (!AGENT_ID_RE.test(id)) throw new Error(`AGENT_ACCOUNTS: invalid agent id "${id}"`);
    if (!displayName || displayName.length > 80) throw new Error(`AGENT_ACCOUNTS: invalid display name for "${id}"`);
    const hash = parsePasswordHash(hashValue);
    if (!hash) throw new Error(`AGENT_ACCOUNTS: invalid password hash for "${id}" (use npm run agent:create)`);
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error(`AGENT_ACCOUNTS: duplicate agent id "${id}"`);
    seen.add(key);
    accounts.push({ id, displayName, hash });
  }
  return accounts;
}

export class AgentDirectory {
  private readonly byId: Map<string, AgentAccount>;
  private readonly dummy: Promise<ParsedHash>;

  constructor(accounts: AgentAccount[]) {
    this.byId = new Map(accounts.map((a) => [a.id.toLowerCase(), a]));
    // Unknown usernames still pay the scrypt cost so response timing does not reveal valid ids.
    this.dummy = hashPassword(randomBytes(16).toString('hex')).then((h) => parsePasswordHash(h)!);
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): AgentAccount | undefined {
    return this.byId.get(id.toLowerCase());
  }

  async authenticate(username: string, password: string): Promise<AgentAccount | null> {
    const account = AGENT_ID_RE.test(username) ? this.get(username) : undefined;
    const ok = await verifyPassword(password, account?.hash ?? (await this.dummy));
    return account && ok ? account : null;
  }
}

/** Development convenience: a single "demo" account when no accounts are configured. */
export async function createDevAccount(password?: string): Promise<{ account: AgentAccount; password: string; generated: boolean }> {
  const pw = password ?? randomBytes(9).toString('base64url');
  const hash = parsePasswordHash(await hashPassword(pw))!;
  return { account: { id: 'demo', displayName: 'Demo Agent', hash }, password: pw, generated: !password };
}
