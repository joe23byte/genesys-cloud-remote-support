import { createHmac } from 'node:crypto';
import type { IceConfig } from '../../shared/protocol.js';
import type { AppConfig } from './config.js';

/**
 * Ephemeral TURN credentials compatible with coturn "use-auth-secret"
 * (TURN REST API draft): username = "<expiry>:<label>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function turnRestCredentials(secret: string, label: string, ttlSeconds: number, nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiry}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

export function buildIceConfig(config: AppConfig, opts: { label: string; forceRelay: boolean; nowMs?: number }): IceConfig {
  const iceServers: IceConfig['iceServers'] = [];
  const { ice } = config;
  if (ice.stunUrls.length > 0) iceServers.push({ urls: ice.stunUrls });
  if (ice.turnUrls.length > 0) {
    if (ice.turnSecret) {
      const c = turnRestCredentials(ice.turnSecret, opts.label, ice.turnCredentialTtlSeconds, opts.nowMs);
      iceServers.push({ urls: ice.turnUrls, username: c.username, credential: c.credential });
    } else if (ice.turnUsername && ice.turnPassword) {
      iceServers.push({ urls: ice.turnUrls, username: ice.turnUsername, credential: ice.turnPassword });
    }
  }
  const relay = ice.transportPolicy === 'relay' || (opts.forceRelay && ice.turnUrls.length > 0);
  return {
    iceServers,
    iceTransportPolicy: relay ? 'relay' : 'all',
    media: { ...config.media },
  };
}

/** Non-secret summary for diagnostics screens. */
export function describeIce(config: AppConfig) {
  return {
    stunUrls: config.ice.stunUrls,
    turnUrls: config.ice.turnUrls,
    turnAuth: config.ice.turnSecret ? 'ephemeral (TURN REST secret)' : config.ice.turnUsername ? 'static credentials' : 'none',
    transportPolicy: config.ice.transportPolicy,
    turnConfigured: config.ice.turnUrls.length > 0,
  };
}
