import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../server/src/integrations/webhook.js';
import { api, CONVERSATION_ID, createSession, login, sleep, startTestApp, type TestApp } from '../helpers.js';

let app: TestApp | null = null;
let receiver: http.Server | null = null;

afterEach(async () => {
  await app?.stop();
  await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
  app = null;
  receiver = null;
});

describe('session-end webhook (CRM / Salesforce preparation)', () => {
  it('posts signed session metadata to the configured endpoint', async () => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => receiver!.listen(0, '127.0.0.1', () => r()));
    const port = (receiver.address() as AddressInfo).port;

    app = await startTestApp({ SESSION_END_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`, SESSION_END_WEBHOOK_SECRET: 'whsec_test' });
    const token = await login(app);
    const { session } = await createSession(app, token, { salesforceCaseId: '5003000000D8cuI' });
    await api(app, 'POST', `/api/sessions/${session.sessionId}/end`, undefined, token);

    for (let i = 0; i < 40 && received.length === 0; i++) await sleep(50);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers['x-remote-support-signature']).toBe(signWebhook('whsec_test', String(headers['x-remote-support-timestamp']), body));
    const payload = JSON.parse(body);
    expect(payload.session).toMatchObject({
      sessionId: session.sessionId,
      genesysConversationId: CONVERSATION_ID,
      agentId: 'alice',
      salesforceCaseId: '5003000000D8cuI',
      endReason: 'agent_ended',
    });

    for (let i = 0; i < 20; i++) {
      const row = app.db.prepare('SELECT webhook_status FROM sessions WHERE id = ?').get(session.sessionId) as any;
      if (row.webhook_status) {
        expect(row.webhook_status).toBe('delivered');
        return;
      }
      await sleep(50);
    }
    throw new Error('webhook status not stored');
  });
});
