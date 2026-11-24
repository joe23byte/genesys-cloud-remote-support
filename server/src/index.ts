import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

if (existsSync('.env')) loadEnvFile('.env');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);
  const viteDev = !config.isProduction && process.argv.includes('--dev');
  const remote = await createApp(config, { logger, viteDev });

  remote.server.listen(config.port, config.host, () => {
    logger.info('server_started', {
      url: config.publicBaseUrl,
      listen: `${config.https ? 'https' : 'http'}://${config.host}:${config.port}`,
      env: config.env,
      viteDev,
      turnConfigured: config.ice.turnUrls.length > 0,
      iceTransportPolicy: config.ice.transportPolicy,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_stopping', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await remote.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
