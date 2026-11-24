import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, E2E_TURN } from '../playwright.config';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Turn = require('node-turn') as new (opts: Record<string, unknown>) => { start(): void; stop(): void };

let turn: { start(): void; stop(): void } | null = null;

test.beforeAll(() => {
  turn = new Turn({
    authMech: 'long-term',
    credentials: { [E2E_TURN.username]: E2E_TURN.password },
    listeningPort: E2E_TURN.port,
    listeningIps: ['127.0.0.1'],
    relayIps: ['127.0.0.1'],
    debugLevel: 'OFF',
  });
  turn.start();
});

test.afterAll(() => turn?.stop());

test('TURN-only mode: media is relayed through the TURN server', async ({ browser }) => {
  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  await agent.goto('/demo');
  await agent.getByLabel(/Username|Benutzername/).fill('alice');
  await agent.getByLabel(/Password|Passwort/).fill(E2E_PASSWORD);
  await agent.getByRole('button', { name: /Sign in|Anmelden/ }).click();
  await agent.getByText(/Force TURN relay|TURN-Relay erzwingen/).click();
  await agent.getByTestId('demo-start').click();
  const panel = agent.getByTestId('agent-session').first();
  const code = (await panel.getByTestId('session-code').textContent())!.replace(/\s/g, '');

  const customerCtx = await browser.newContext();
  const customer = await customerCtx.newPage();
  await customer.goto('/join');
  await customer.getByTestId('code-input').fill(code);
  await customer.getByTestId('code-submit').click();
  await customer.getByTestId('consent').check();
  await customer.getByTestId('share-screen').click();

  const video = panel.getByTestId('remote-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(panel.getByTestId('debug-ice-transport-policy')).toHaveText('relay');
  await expect(panel.getByTestId('debug-route-local-remote-')).toHaveText('relay / relay', { timeout: 10_000 });
  await expect(panel.locator('.badge')).toHaveText(/Screen sharing active|Bildschirmfreigabe aktiv/);

  await agentCtx.close();
  await customerCtx.close();
});
