import { createHmac, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface SessionEndedPayload {
  event: 'remote_support.session.ended';
  deliveryId: string;
  occurredAt: string;
  session: {
    sessionId: string;
    genesysConversationId: string;
    agentId: string;
    salesforceCaseId: string | null;
    source: string;
    gcHostOrigin: string | null;
    gcTargetEnv: string | null;
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
    endReason: string;
    finalStatus: string;
    connectionStatus: string | null;
    iceCandidateType: string | null;
    customerJoinedAt: string | null;
    customerConsentAt: string | null;
    shareStartedAt: string | null;
  };
}

/**
 * Signature: X-Remote-Support-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 * Receivers must check the timestamp (X-Remote-Support-Timestamp) to reject replays.
 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export type WebhookResult = { status: 'delivered' | 'failed' | 'disabled'; attempts: number };

export class WebhookDispatcher {
  constructor(
    private readonly config: AppConfig['webhook'],
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly backoffMs: number[] = [1000, 5000, 20000],
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  async deliver(session: SessionEndedPayload['session']): Promise<WebhookResult> {
    if (!this.config) return { status: 'disabled', attempts: 0 };
    const payload: SessionEndedPayload = {
      event: 'remote_support.session.ended',
      deliveryId: randomUUID(),
      occurredAt: new Date().toISOString(),
      session,
    };
    const body = JSON.stringify(payload);
    const maxAttempts = this.backoffMs.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'RemoteSupportForGenesysCloud-Webhook/1.0',
        'X-Remote-Support-Event': payload.event,
        'X-Remote-Support-Delivery': payload.deliveryId,
        'X-Remote-Support-Timestamp': timestamp,
      };
      if (this.config.secret) headers['X-Remote-Support-Signature'] = signWebhook(this.config.secret, timestamp, body);
      try {
        const res = await this.fetchImpl(this.config.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (res.ok) {
          this.logger.info('webhook_delivered', { sessionId: session.sessionId, attempt, httpStatus: res.status });
          return { status: 'delivered', attempts: attempt };
        }
        this.logger.warn('webhook_rejected', { sessionId: session.sessionId, attempt, httpStatus: res.status });
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          return { status: 'failed', attempts: attempt };
        }
      } catch (err) {
        this.logger.warn('webhook_error', { sessionId: session.sessionId, attempt, error: (err as Error).message });
      }
      const wait = this.backoffMs[attempt - 1];
      if (wait !== undefined) await new Promise((r) => setTimeout(r, wait));
    }
    return { status: 'failed', attempts: maxAttempts };
  }
}
