import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';

export type PageKind = 'agent' | 'join' | 'demo' | 'other';

export function pageKindForPath(pathname: string): PageKind {
  if (pathname === '/agent' || pathname.startsWith('/agent/')) return 'agent';
  if (pathname === '/join' || pathname.startsWith('/join/')) return 'join';
  if (pathname === '/demo' || pathname.startsWith('/demo/')) return 'demo';
  return 'other';
}

export function frameAncestorsFor(kind: PageKind, config: AppConfig): string {
  switch (kind) {
    case 'agent':
      return ["'self'", ...config.frameAncestors].join(' ');
    case 'demo':
      return "'self'";
    default:
      return "'none'";
  }
}

export function buildCsp(kind: PageKind, config: AppConfig, devMode: boolean): string {
  const wsOrigin = config.publicOrigin.replace(/^http/, 'ws');
  const connect = ["'self'", wsOrigin];
  if (devMode) connect.push('ws:', 'wss:');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': devMode ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'",
    'style-src': devMode ? "'self' 'unsafe-inline'" : "'self'",
    'img-src': "'self' data: blob:",
    'media-src': "'self' blob: mediastream:",
    'font-src': "'self'",
    'connect-src': connect.join(' '),
    'frame-src': "'self'",
    'worker-src': "'self'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'self'",
    'frame-ancestors': frameAncestorsFor(kind, config),
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v}`);
  if (config.isProduction) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

const PERMISSIONS: Record<PageKind, string> = {
  join: 'display-capture=(self), camera=(), microphone=(), geolocation=(), fullscreen=(self)',
  agent: 'display-capture=(), camera=(), microphone=(), geolocation=(), fullscreen=(self)',
  demo: 'display-capture=(self), camera=(), microphone=(), geolocation=(), fullscreen=(self)',
  other: 'display-capture=(), camera=(), microphone=(), geolocation=()',
};

/** Headers for every response. */
export function baseSecurityHeaders(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.removeHeader('X-Powered-By');
    if (config.isProduction && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
    next();
  };
}

/** Headers for HTML documents; differs per page because only /agent may be framed by Genesys Cloud. */
export function setDocumentHeaders(res: Response, kind: PageKind, config: AppConfig, devMode: boolean): void {
  res.setHeader('Content-Security-Policy', buildCsp(kind, config, devMode));
  res.setHeader('Permissions-Policy', PERMISSIONS[kind]);
  res.setHeader('Cache-Control', 'no-store');
  if (kind === 'agent') {
    // X-Frame-Options cannot express an allowlist; frame-ancestors in the CSP is authoritative.
    res.removeHeader('X-Frame-Options');
  } else if (kind === 'demo') {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  } else {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
}

export function httpsRedirect(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.forceHttps || req.secure || req.path === '/api/health') return next();
    const target = new URL(req.originalUrl, config.publicBaseUrl);
    if (target.protocol !== 'https:') target.protocol = 'https:';
    res.redirect(308, target.toString());
  };
}
