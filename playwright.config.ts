import { randomBytes, scryptSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export const E2E_PASSWORD = 'e2e-password-123';
export const E2E_TURN = { port: 3479, username: 'e2e-turn', password: 'e2e-turn-password' };
const PORT = 3456;

function accountEntry(id: string, name: string) {
  const salt = randomBytes(16);
  const key = scryptSync(E2E_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 });
  return `${id}|${name}|scrypt:16384:8:1:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Google Chrome; set E2E_BROWSER_CHANNEL= to use Playwright's Chromium instead.
    channel: (process.env.E2E_BROWSER_CHANNEL ?? 'chrome') || undefined,
    headless: process.env.E2E_HEADED !== 'true',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node dist/node/server/src/index.js',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      PUBLIC_BASE_URL: `http://localhost:${PORT}`,
      SERVER_SECRET: randomBytes(32).toString('base64url'),
      DATABASE_PATH: path.join(os.tmpdir(), `rs-e2e-${Date.now()}.sqlite`),
      AGENT_ACCOUNTS: [accountEntry('alice', 'Alice Agent'), accountEntry('bob', 'Bob Agent')].join(';'),
      STUN_URLS: 'none',
      // Local TURN server started by the relay test (e2e/turn-relay.spec.ts).
      TURN_URLS: `turn:127.0.0.1:${E2E_TURN.port}?transport=udp`,
      TURN_USERNAME: E2E_TURN.username,
      TURN_PASSWORD: E2E_TURN.password,
      AUDIT_LOG_STDOUT: 'false',
      // All test browsers share 127.0.0.1; the production limits would block repeated runs.
      LOGIN_RATE_LIMIT: '500',
      CODE_JOIN_RATE_LIMIT: '500',
    },
  },
});
