import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { AuditLog } from './audit.js';
import { AgentDirectory, createDevAccount, parseAgentAccounts, type AgentAccount } from './auth/agentAccounts.js';
import { AgentTokenStore } from './auth/agentTokens.js';
import type { AppConfig } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { createGenesysAdapter, type GenesysPlatformAdapter } from './integrations/genesysPlatform.js';
import { WebhookDispatcher } from './integrations/webhook.js';
import { createLogger, type Logger } from './logger.js';
import { createSignalingServer } from './realtime/signaling.js';
import { createApiRouter } from './routes/api.js';
import { baseSecurityHeaders, httpsRedirect, pageKindForPath, setDocumentHeaders } from './security/headers.js';
import { SessionService } from './sessions/service.js';

export interface AppOptions {
  logger?: Logger;
  /** Serve the React client through Vite middleware (development only). */
  viteDev?: boolean;
  clientDistDir?: string;
  db?: Db;
  genesys?: GenesysPlatformAdapter;
  webhook?: WebhookDispatcher;
  accounts?: AgentAccount[];
  now?: () => number;
  /** Disable background timers (tests drive sweep/purge explicitly). */
  disableTimers?: boolean;
}

const HTML_ROUTES = ['/', '/agent', '/join', '/demo'];

const FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Remote Support</title></head>
<body><div id="root">Client not built. Run "npm run build" or "npm run dev".</div></body></html>`;

export async function createApp(config: AppConfig, options: AppOptions = {}) {
  const logger = options.logger ?? createLogger(config.logLevel);
  const db = options.db ?? openDatabase(config.databasePath);
  const now = options.now ?? Date.now;

  let accounts = options.accounts;
  if (!accounts) {
    accounts = config.agentAccountsRaw ? parseAgentAccounts(config.agentAccountsRaw) : [];
    if (accounts.length === 0) {
      if (config.isProduction) throw new Error('AGENT_ACCOUNTS must define at least one agent in production');
      const dev = await createDevAccount(config.devAgentPassword);
      accounts = [dev.account];
      logger.warn('dev_agent_account_created', {
        username: dev.account.id,
        note: dev.generated
          ? `No AGENT_ACCOUNTS configured. Development login: demo / ${dev.password}`
          : 'No AGENT_ACCOUNTS configured. Development login: demo / DEV_AGENT_PASSWORD',
      });
    }
  }
  if (config.serverSecretGenerated) logger.warn('server_secret_generated', { note: 'SERVER_SECRET not set; a random secret is used until restart (pending session codes stop working after a restart)' });

  const directory = new AgentDirectory(accounts);
  const tokens = new AgentTokenStore(db, directory, config.agentTokenTtlMs, now);
  const audit = new AuditLog(db, config.serverSecret, logger, config.auditToStdout);
  const genesys = options.genesys ?? createGenesysAdapter(config, logger);
  const webhook = options.webhook ?? new WebhookDispatcher(config.webhook, logger);
  const sessions = new SessionService(db, config, audit, genesys, webhook, logger, now);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const server = config.https
    ? https.createServer({ cert: readFileSync(config.https.certFile), key: readFileSync(config.https.keyFile) }, app)
    : http.createServer(app);

  const devMode = !!options.viteDev;
  const signaling = createSignalingServer({ httpServer: server, config, sessions, tokens, audit, logger, sharesUpgrades: devMode });

  app.use(httpsRedirect(config));
  app.use(baseSecurityHeaders(config));
  app.use(
    '/api',
    createApiRouter({
      config,
      sessions,
      tokens,
      directory,
      audit,
      logger,
      genesys,
      webhook,
      onLogout: signaling.disconnectAgentToken,
    }),
  );

  let renderHtml: (req: Request) => Promise<string>;

  if (devMode) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.resolve('vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    renderHtml = async (req) => vite.transformIndexHtml(req.originalUrl, readFileSync(path.resolve('client/index.html'), 'utf8'));
  } else {
    const distDir = options.clientDistDir ?? path.resolve('dist/client');
    const indexFile = path.join(distDir, 'index.html');
    const html = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : FALLBACK_HTML;
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        immutable: true,
        maxAge: '365d',
        index: false,
        fallthrough: false,
        setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
      }),
    );
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    renderHtml = async () => html;
  }

  app.get(HTML_ROUTES, async (req: Request, res: Response) => {
    const kind = pageKindForPath(req.path);
    if (kind === 'demo' && !config.demoEnabled) {
      res.status(404).send('Not found');
      return;
    }
    setDocumentHeaders(res, kind, config, devMode);
    res.type('html').send(await renderHtml(req));
  });

  app.use((_req, res) => {
    res.status(404).type('text').send('Not found');
  });

  const timers: NodeJS.Timeout[] = [];
  const runMaintenance = () => {
    try {
      tokens.deleteExpired();
      sessions.purge();
      audit.deleteOlderThan(now() - config.retentionMs);
    } catch (err) {
      logger.error('maintenance_failed', { error: (err as Error).message });
    }
  };
  if (!options.disableTimers) {
    timers.push(
      setInterval(() => {
        try {
          sessions.sweep();
        } catch (err) {
          logger.error('sweep_failed', { error: (err as Error).message });
        }
      }, 30_000),
    );
    timers.push(setInterval(runMaintenance, 3600_000));
    runMaintenance();
    for (const t of timers) t.unref();
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    await new Promise<void>((resolve) => signaling.io.close(() => resolve()));
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!options.db) db.close();
  }

  return { app, server, io: signaling.io, sessions, tokens, audit, db, logger, runMaintenance, close };
}

export type RemoteSupportApp = Awaited<ReturnType<typeof createApp>>;
