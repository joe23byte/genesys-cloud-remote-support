import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { parseOriginPattern, type OriginPattern } from './security/origins.js';

/**
 * Public Genesys Cloud regions. Sovereign or new environments are added via
 * GC_ALLOWED_HOST_ORIGINS, which fully replaces this list when set.
 */
export const DEFAULT_GC_HOST_ORIGINS = [
  'https://apps.mypurecloud.com',
  'https://apps.mypurecloud.ie',
  'https://apps.mypurecloud.de',
  'https://apps.mypurecloud.com.au',
  'https://apps.mypurecloud.jp',
  'https://*.pure.cloud',
  'https://*.us-gov-pure.cloud',
];

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().optional().default('0.0.0.0'),
  PUBLIC_BASE_URL: optionalString,
  RENDER_EXTERNAL_URL: optionalString,
  TRUST_PROXY: optionalString,
  CLIENT_IP_HEADER: optionalString,
  FORCE_HTTPS: optionalString,
  HTTPS_CERT_FILE: optionalString,
  HTTPS_KEY_FILE: optionalString,
  SERVER_SECRET: optionalString,
  DATABASE_PATH: optionalString,
  AGENT_ACCOUNTS: optionalString,
  DEV_AGENT_PASSWORD: optionalString,
  AGENT_TOKEN_TTL_HOURS: int(10, 1, 72),
  INVITE_TTL_SECONDS: int(600, 60, 3600),
  SESSION_MAX_DURATION_MINUTES: int(120, 5, 720),
  SESSION_IDLE_TIMEOUT_MINUTES: int(15, 1, 240),
  METADATA_RETENTION_DAYS: int(30, 1, 3650),
  GC_ALLOWED_HOST_ORIGINS: list,
  FRAME_ANCESTORS_EXTRA: list,
  STUN_URLS: optionalString,
  TURN_URLS: list,
  TURN_SECRET: optionalString,
  TURN_USERNAME: optionalString,
  TURN_PASSWORD: optionalString,
  TURN_CREDENTIAL_TTL_SECONDS: int(4 * 3600, 600, 48 * 3600),
  ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).optional().default('all'),
  MEDIA_MAX_WIDTH: int(1920, 320, 3840),
  MEDIA_MAX_HEIGHT: int(1080, 240, 2160),
  MEDIA_MAX_FPS: int(15, 1, 30),
  MEDIA_MAX_BITRATE_KBPS: int(2500, 200, 20000),
  SESSION_END_WEBHOOK_URL: optionalString,
  SESSION_END_WEBHOOK_SECRET: optionalString,
  WEBHOOK_TIMEOUT_MS: int(10000, 1000, 60000),
  GENESYS_API_ENABLED: bool(false),
  GENESYS_API_REGION: optionalString,
  GENESYS_CLIENT_ID: optionalString,
  GENESYS_CLIENT_SECRET: optionalString,
  GENESYS_VERIFY_CONVERSATION: bool(false),
  LOGIN_RATE_LIMIT: int(10, 1, 1000),
  CODE_JOIN_RATE_LIMIT: int(10, 1, 1000),
  DEMO_ENABLED: bool(true),
  AUDIT_LOG_STDOUT: bool(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
});

export interface AppConfig {
  env: 'production' | 'development' | 'test';
  isProduction: boolean;
  port: number;
  host: string;
  publicBaseUrl: string;
  publicOrigin: string;
  trustProxy: boolean | number | string;
  /** Lower-case header name carrying the client IP, set by an edge proxy such as Cloudflare. */
  clientIpHeader: string | undefined;
  forceHttps: boolean;
  https: { certFile: string; keyFile: string } | null;
  serverSecret: string;
  serverSecretGenerated: boolean;
  databasePath: string;
  agentAccountsRaw: string | undefined;
  devAgentPassword: string | undefined;
  agentTokenTtlMs: number;
  inviteTtlMs: number;
  sessionMaxDurationMs: number;
  sessionIdleTimeoutMs: number;
  retentionMs: number;
  gcAllowedHostOrigins: OriginPattern[];
  frameAncestors: string[];
  ice: {
    stunUrls: string[];
    turnUrls: string[];
    turnSecret: string | undefined;
    turnUsername: string | undefined;
    turnPassword: string | undefined;
    turnCredentialTtlSeconds: number;
    transportPolicy: 'all' | 'relay';
  };
  media: { maxWidth: number; maxHeight: number; maxFrameRate: number; maxBitrateKbps: number };
  webhook: { url: string; secret: string | undefined; timeoutMs: number } | null;
  genesys: {
    enabled: boolean;
    region: string | undefined;
    clientId: string | undefined;
    clientSecret: string | undefined;
    verifyConversation: boolean;
  };
  rateLimits: { loginPer15Min: number; codeJoinPer10Min: number };
  demoEnabled: boolean;
  auditToStdout: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

function normalizeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_BASE_URL must use http or https');
  }
  return url;
}

function parseTrustProxy(raw: string | undefined, isProduction: boolean): boolean | number | string {
  if (raw === undefined) return isProduction ? 1 : 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const env = e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development';
  const isProduction = env === 'production';

  const https = e.HTTPS_CERT_FILE && e.HTTPS_KEY_FILE ? { certFile: e.HTTPS_CERT_FILE, keyFile: e.HTTPS_KEY_FILE } : null;
  const defaultBase = `${https ? 'https' : 'http'}://localhost:${e.PORT}`;
  const baseUrl = normalizeBaseUrl(e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL ?? defaultBase);
  if (isProduction && baseUrl.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must use https in production');
  }

  if (e.CLIENT_IP_HEADER && !/^[a-z0-9-]+$/i.test(e.CLIENT_IP_HEADER)) {
    throw new ConfigError('CLIENT_IP_HEADER must be a plain header name such as cf-connecting-ip');
  }

  let serverSecret = e.SERVER_SECRET;
  let serverSecretGenerated = false;
  if (!serverSecret) {
    if (isProduction) throw new ConfigError('SERVER_SECRET is required in production (at least 32 characters)');
    serverSecret = randomBytes(32).toString('base64url');
    serverSecretGenerated = true;
  }
  if (serverSecret.length < 32) throw new ConfigError('SERVER_SECRET must be at least 32 characters long');

  const originSources = e.GC_ALLOWED_HOST_ORIGINS.length > 0 ? e.GC_ALLOWED_HOST_ORIGINS : DEFAULT_GC_HOST_ORIGINS;
  const gcAllowedHostOrigins = originSources.map((o) => {
    const p = parseOriginPattern(o);
    if (!p) throw new ConfigError(`GC_ALLOWED_HOST_ORIGINS contains an invalid origin pattern: ${o}`);
    return p;
  });
  for (const extra of e.FRAME_ANCESTORS_EXTRA) {
    if (!parseOriginPattern(extra)) throw new ConfigError(`FRAME_ANCESTORS_EXTRA contains an invalid origin pattern: ${extra}`);
  }
  const frameAncestors = [...gcAllowedHostOrigins.map((p) => p.source), ...e.FRAME_ANCESTORS_EXTRA];

  const stunUrls = (e.STUN_URLS ?? 'stun:stun.l.google.com:19302')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== 'none');
  for (const u of stunUrls) {
    if (!/^stuns?:/i.test(u)) throw new ConfigError(`STUN_URLS entry must start with stun: or stuns: (${u})`);
  }
  for (const u of e.TURN_URLS) {
    if (!/^turns?:/i.test(u)) throw new ConfigError(`TURN_URLS entry must start with turn: or turns: (${u})`);
  }
  if (e.TURN_URLS.length > 0 && !e.TURN_SECRET && !(e.TURN_USERNAME && e.TURN_PASSWORD)) {
    throw new ConfigError('TURN_URLS requires either TURN_SECRET (coturn use-auth-secret) or TURN_USERNAME and TURN_PASSWORD');
  }
  if (e.ICE_TRANSPORT_POLICY === 'relay' && e.TURN_URLS.length === 0) {
    throw new ConfigError('ICE_TRANSPORT_POLICY=relay (TURN-only mode) requires TURN_URLS');
  }

  let webhook: AppConfig['webhook'] = null;
  if (e.SESSION_END_WEBHOOK_URL) {
    let url: URL;
    try {
      url = new URL(e.SESSION_END_WEBHOOK_URL);
    } catch {
      throw new ConfigError('SESSION_END_WEBHOOK_URL is not a valid URL');
    }
    if (isProduction && url.protocol !== 'https:') throw new ConfigError('SESSION_END_WEBHOOK_URL must use https in production');
    if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('SESSION_END_WEBHOOK_URL must use http(s)');
    if (isProduction && !e.SESSION_END_WEBHOOK_SECRET) throw new ConfigError('SESSION_END_WEBHOOK_SECRET is required in production when a webhook is configured');
    webhook = { url: url.toString(), secret: e.SESSION_END_WEBHOOK_SECRET, timeoutMs: e.WEBHOOK_TIMEOUT_MS };
  }

  if (e.GENESYS_API_ENABLED && !(e.GENESYS_API_REGION && e.GENESYS_CLIENT_ID && e.GENESYS_CLIENT_SECRET)) {
    throw new ConfigError('GENESYS_API_ENABLED requires GENESYS_API_REGION, GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET');
  }
  if (e.GENESYS_API_REGION && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(e.GENESYS_API_REGION)) {
    throw new ConfigError('GENESYS_API_REGION must be a domain such as mypurecloud.de or euc2.pure.cloud');
  }

  return {
    env,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    publicBaseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/+$/, ''),
    publicOrigin: baseUrl.origin,
    trustProxy: parseTrustProxy(e.TRUST_PROXY, isProduction),
    clientIpHeader: e.CLIENT_IP_HEADER?.toLowerCase(),
    forceHttps: e.FORCE_HTTPS !== undefined ? e.FORCE_HTTPS === 'true' : isProduction,
    https,
    serverSecret,
    serverSecretGenerated,
    databasePath: e.DATABASE_PATH ?? path.resolve('data', 'remote-support.sqlite'),
    agentAccountsRaw: e.AGENT_ACCOUNTS,
    devAgentPassword: e.DEV_AGENT_PASSWORD,
    agentTokenTtlMs: e.AGENT_TOKEN_TTL_HOURS * 3600_000,
    inviteTtlMs: e.INVITE_TTL_SECONDS * 1000,
    sessionMaxDurationMs: e.SESSION_MAX_DURATION_MINUTES * 60_000,
    sessionIdleTimeoutMs: e.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
    retentionMs: e.METADATA_RETENTION_DAYS * 86_400_000,
    gcAllowedHostOrigins,
    frameAncestors,
    ice: {
      stunUrls,
      turnUrls: e.TURN_URLS,
      turnSecret: e.TURN_SECRET,
      turnUsername: e.TURN_USERNAME,
      turnPassword: e.TURN_PASSWORD,
      turnCredentialTtlSeconds: e.TURN_CREDENTIAL_TTL_SECONDS,
      transportPolicy: e.ICE_TRANSPORT_POLICY,
    },
    media: {
      maxWidth: e.MEDIA_MAX_WIDTH,
      maxHeight: e.MEDIA_MAX_HEIGHT,
      maxFrameRate: e.MEDIA_MAX_FPS,
      maxBitrateKbps: e.MEDIA_MAX_BITRATE_KBPS,
    },
    webhook,
    genesys: {
      enabled: e.GENESYS_API_ENABLED,
      region: e.GENESYS_API_REGION,
      clientId: e.GENESYS_CLIENT_ID,
      clientSecret: e.GENESYS_CLIENT_SECRET,
      verifyConversation: e.GENESYS_VERIFY_CONVERSATION,
    },
    rateLimits: { loginPer15Min: e.LOGIN_RATE_LIMIT, codeJoinPer10Min: e.CODE_JOIN_RATE_LIMIT },
    demoEnabled: e.DEMO_ENABLED,
    auditToStdout: e.AUDIT_LOG_STDOUT,
    logLevel: e.LOG_LEVEL,
  };
}
