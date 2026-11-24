import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface ConversationLookup {
  /** true = conversation exists in the configured org, false = not found, null = could not be checked */
  exists: boolean | null;
  hasVoice?: boolean;
  ended?: boolean;
}

/**
 * Optional, strictly read-only adapter for the Genesys Cloud Platform API
 * (OAuth client credentials). It never modifies conversations or routing.
 * Required OAuth role permission: Conversation > Communication > View (conversation:communication:view)
 * for the divisions of the relevant queues.
 */
export interface GenesysPlatformAdapter {
  readonly enabled: boolean;
  /** Origin of the Genesys Cloud UI that belongs to the configured API region (e.g. https://apps.mypurecloud.de). */
  readonly expectedHostOrigin: string | null;
  lookupConversation(conversationId: string): Promise<ConversationLookup>;
}

export const disabledGenesysAdapter: GenesysPlatformAdapter = {
  enabled: false,
  expectedHostOrigin: null,
  lookupConversation: async () => ({ exists: null }),
};

export class GenesysClientCredentialsAdapter implements GenesysPlatformAdapter {
  readonly enabled = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly region: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get expectedHostOrigin(): string {
    // FedRAMP uses "app." instead of "apps." (see Genesys Client Apps documentation).
    return this.region.endsWith('us-gov-pure.cloud') ? `https://app.${this.region}` : `https://apps.${this.region}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`https://login.${this.region}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Genesys OAuth failed with HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Genesys OAuth response without access_token');
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async lookupConversation(conversationId: string): Promise<ConversationLookup> {
    try {
      const token = await this.accessToken();
      const res = await this.fetchImpl(`https://api.${this.region}/api/v2/conversations/${encodeURIComponent(conversationId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return { exists: false };
      if (!res.ok) {
        this.logger.warn('genesys_lookup_failed', { httpStatus: res.status });
        return { exists: null };
      }
      const body = (await res.json()) as {
        endTime?: string;
        participants?: Array<{ calls?: unknown[] }>;
      };
      const hasVoice = (body.participants ?? []).some((p) => Array.isArray(p.calls) && p.calls.length > 0);
      return { exists: true, hasVoice, ended: Boolean(body.endTime) };
    } catch (err) {
      this.logger.warn('genesys_lookup_error', { error: (err as Error).message });
      return { exists: null };
    }
  }
}

export function createGenesysAdapter(config: AppConfig, logger: Logger): GenesysPlatformAdapter {
  const g = config.genesys;
  if (!g.enabled || !g.region || !g.clientId || !g.clientSecret) return disabledGenesysAdapter;
  return new GenesysClientCredentialsAdapter(g.region, g.clientId, g.clientSecret, logger);
}
