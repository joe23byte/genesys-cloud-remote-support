import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';

const GC_HOST = 'https://apps.mypurecloud.de';

function conversationId() {
  return crypto.randomUUID();
}

async function login(page: Page, username: string) {
  await page.getByLabel(/Username|Benutzername/).fill(username);
  await page.getByLabel(/Password|Passwort/).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /Sign in|Anmelden/ }).click();
}

/** Waits until the agent's <video> renders frames from the customer's screen and returns its size. */
async function expectLiveVideo(page: Page, scope = page.locator('body')) {
  const video = scope.getByTestId('remote-video');
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const frames = async () => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  const before = await frames();
  await page.waitForTimeout(1500);
  expect(await frames()).toBeGreaterThan(before);
  return video.evaluate((v: HTMLVideoElement) => ({ width: v.videoWidth, height: v.videoHeight }));
}

async function shareAsCustomer(customer: Page) {
  await expect(customer.getByTestId('share-screen')).toBeDisabled();
  await customer.getByTestId('consent').check();
  await customer.getByTestId('share-screen').click();
  await expect(customer.getByTestId('sharing-banner')).toBeVisible();
}

test('Genesys interaction widget: invite link, consent, live screen, stop/restart, agent reload, end', async ({ browser }) => {
  const conv = conversationId();
  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  await agent.goto(`/agent?conversationId=${conv}&gcHostOrigin=${encodeURIComponent(GC_HOST)}&gcTargetEnv=prod-euc1&language=en-us`);
  await login(agent, 'alice');

  await agent.getByLabel('Salesforce Case ID (optional)').fill('5003000000D8cuI');
  await agent.getByTestId('start-remote-support').click();
  const badge = agent.getByTestId('agent-session').locator('.badge');
  await expect(badge).toHaveText('Waiting for customer');
  await expect(agent.getByTestId('conversation-id')).toHaveText(conv);
  const code = (await agent.getByTestId('session-code').textContent())!.replace(/\s/g, '');
  expect(code).toMatch(/^\d{6}$/);
  const inviteUrl = await agent.getByTestId('invite-url').inputValue();
  expect(inviteUrl).toMatch(/\/join#t=/);
  await expect(agent.locator('img.qr')).toBeVisible();

  // Customer in a separate browser profile (no shared storage), German browser language.
  const customerCtx = await browser.newContext({ locale: 'de-DE' });
  const customer = await customerCtx.newPage();
  await customer.goto(inviteUrl);
  await expect(customer.getByRole('heading', { name: 'Bildschirmfreigabe für den Support' })).toBeVisible();
  expect(customer.url()).not.toContain('#t=');
  await customer.getByTestId('join-invite').click();
  await expect(customer.getByTestId('agent-name')).toHaveText('Alice Agent');
  await expect(badge).toHaveText('Customer connected');
  const verification = (await customer.getByTestId('customer-verification').textContent())!;
  await expect(agent.getByTestId('agent-verification')).toHaveText(verification);

  // A second use of the single-use link must fail.
  const intruderCtx = await browser.newContext();
  const intruder = await intruderCtx.newPage();
  await intruder.goto(inviteUrl);
  await intruder.getByTestId('join-invite').click();
  await expect(intruder.getByRole('alert')).toContainText(/invalid|already been used|ungültig/i);
  await intruderCtx.close();

  await shareAsCustomer(customer);
  const size = await expectLiveVideo(agent);
  expect(size).toEqual({ width: 1920, height: 1080 });
  await expect(badge).toHaveText('Screen sharing active');
  await expect(customer.getByTestId('customer-connection')).toContainText('Verbunden');

  // Viewer controls and debug information.
  await agent.getByRole('button', { name: '100%' }).click();
  await expect(agent.getByTestId('zoom-level')).toHaveText('100%');
  await agent.getByRole('button', { name: 'Zoom in' }).click();
  await expect(agent.getByTestId('zoom-level')).toHaveText('125%');
  await agent.getByRole('button', { name: 'Fit' }).click();
  await agent.getByRole('button', { name: /Connection details/ }).click();
  await expect(agent.getByTestId('debug-resolution')).toHaveText('1920×1080', { timeout: 10_000 });
  await expect(agent.getByTestId('debug-peer-connection')).toHaveText('connected');
  await expect.poll(async () => Number.parseFloat((await agent.getByTestId('debug-frame-rate').textContent()) ?? '0'), { timeout: 10_000 }).toBeGreaterThan(0);

  // Customer stops sharing via the banner, then shares again.
  await customer.getByTestId('stop-sharing').click();
  await expect(badge).toHaveText('Screen sharing stopped');
  await expect(customer.getByTestId('sharing-banner')).toHaveCount(0);
  await customer.getByTestId('share-screen').click();
  await expect(customer.getByTestId('sharing-banner')).toBeVisible();
  await expectLiveVideo(agent);
  await expect(badge).toHaveText('Screen sharing active');

  // Genesys reloads the widget (e.g. switching interactions): the session is resumed and the video re-negotiated.
  await agent.reload();
  await expect(agent.getByText('Existing session for this conversation resumed.')).toBeVisible();
  await expectLiveVideo(agent);
  await expect(agent.getByTestId('agent-session').locator('.badge')).toHaveText('Screen sharing active');

  // Agent ends the session; the customer is informed and sharing stops.
  await agent.getByTestId('end-session').click();
  await agent.getByTestId('confirm-end').click();
  await expect(agent.getByTestId('agent-session').locator('.badge')).toHaveText('Session ended');
  await expect(customer.getByTestId('customer-ended')).toBeVisible();
  await expect(customer.getByTestId('sharing-banner')).toHaveCount(0);

  // Stored metadata.
  const token = await agent.evaluate(() => sessionStorage.getItem('rs.agentToken'));
  const res = await agent.request.get(`/api/sessions?conversationId=${conv}`, { headers: { Authorization: `Bearer ${token}` } });
  const { sessions } = await res.json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    conversationId: conv,
    agentId: 'alice',
    salesforceCaseId: '5003000000D8cuI',
    gcHostOrigin: GC_HOST,
    gcTargetEnv: 'prod-euc1',
    status: 'ended',
    endReason: 'agent_ended',
    iceCandidateType: 'host',
  });
  expect(sessions[0].consentAt).toBeTruthy();
  expect(sessions[0].shareStartedAt).toBeTruthy();
  expect(sessions[0].durationSeconds).toBeGreaterThan(0);

  await agentCtx.close();
  await customerCtx.close();
});

test('demo page: two parallel sessions joined by session code stay isolated', async ({ browser }) => {
  const agentCtx = await browser.newContext();
  const agent = await agentCtx.newPage();
  await agent.goto('/demo');
  await login(agent, 'alice');
  await agent.getByTestId('demo-start').click();
  await agent.getByTestId('demo-start').click();
  const panels = agent.getByTestId('agent-session');
  await expect(panels).toHaveCount(2);

  const customers: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const code = (await panels.nth(i).getByTestId('session-code').textContent())!.replace(/\s/g, '');
    const ctx = await browser.newContext({ locale: 'en-US' });
    const c = await ctx.newPage();
    await c.goto('/join');
    await c.getByTestId('code-input').fill(code);
    await c.getByTestId('code-submit').click();
    await shareAsCustomer(c);
    customers.push(c);
  }
  for (let i = 0; i < 2; i++) {
    await expectLiveVideo(agent, panels.nth(i));
    await expect(panels.nth(i).locator('.badge')).toHaveText('Screen sharing active');
  }
  const ids = await panels.evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')));
  expect(new Set(ids).size).toBe(2);

  // The first customer stops; only the first session changes.
  await customers[0]!.getByTestId('stop-sharing').click();
  await expect(panels.nth(0).locator('.badge')).toHaveText('Screen sharing stopped');
  await expect(panels.nth(1).locator('.badge')).toHaveText('Screen sharing active');

  // Another agent cannot read Alice's sessions.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  const login2 = await bob.request.post('/api/auth/login', { data: { username: 'bob', password: E2E_PASSWORD } });
  const { token } = await login2.json();
  const r = await bob.request.get(`/api/sessions/${ids[1]}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(r.status()).toBe(404);
  const list = await (await bob.request.get('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(list.sessions).toEqual([]);

  await expect(agent.getByTestId('session-table')).toBeVisible();
  await bobCtx.close();
  await agentCtx.close();
});

test('agent widget works inside a sandboxed iframe (Interaction Widget simulation)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/demo');
  await login(page, 'alice');
  await page.getByRole('button', { name: /embedded widget/ }).click();
  const frame = page.frameLocator('iframe[title="Interaction widget test"]');
  await frame.getByTestId('start-remote-support').click();
  await expect(frame.getByTestId('session-code')).toHaveText(/^\d{3} \d{3}$/);
  await expect(frame.getByTestId('agent-session').locator('.badge')).toHaveText(/Waiting for customer|Warten auf Kunden/);
  await ctx.close();
});

test('customer page refuses to be framed and rejects unknown session codes', async ({ page }) => {
  const res = await page.goto('/join');
  expect(res!.headers()['x-frame-options']).toBe('DENY');
  expect(res!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await page.getByTestId('code-input').fill('000000');
  await page.getByTestId('code-submit').click();
  await expect(page.getByRole('alert')).toBeVisible();
});
