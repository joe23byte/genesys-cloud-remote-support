/**
 * Origin patterns follow CSP host-source semantics: an optional leading "*."
 * matches one or more subdomain labels. Scheme is mandatory, paths are not allowed.
 */
export interface OriginPattern {
  source: string;
  scheme: 'https:' | 'http:';
  wildcard: boolean;
  /** Host without the "*." prefix, lowercase. */
  host: string;
  port: string;
}

const HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseOriginPattern(raw: string): OriginPattern | null {
  const m = /^(https?):\/\/([^/:]+)(?::(\d{1,5}))?\/?$/i.exec(raw.trim());
  if (!m) return null;
  const scheme = `${m[1]!.toLowerCase()}:` as 'https:' | 'http:';
  const hostPart = m[2]!.toLowerCase();
  if (!HOST_RE.test(hostPart)) return null;
  const wildcard = hostPart.startsWith('*.');
  const host = wildcard ? hostPart.slice(2) : hostPart;
  if (wildcard && !host.includes('.')) return null; // refuse "*.com"-style patterns
  const port = m[3] ?? '';
  const portPart = port ? `:${port}` : '';
  return { source: `${scheme}//${hostPart}${portPart}`, scheme, wildcard, host, port };
}

/** Parses a value into a canonical origin (scheme://host[:port]) or returns null. */
export function canonicalOrigin(value: string): string | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

export function originMatches(origin: string, pattern: OriginPattern): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== pattern.scheme) return false;
  if (url.port !== pattern.port) return false;
  const host = url.hostname.toLowerCase();
  if (pattern.wildcard) return host.endsWith(`.${pattern.host}`) && host.length > pattern.host.length + 1;
  return host === pattern.host;
}

export function isAllowedOrigin(origin: string, patterns: OriginPattern[]): boolean {
  return patterns.some((p) => originMatches(origin, p));
}

/** gcTargetEnv examples: prod, prod-euw1, fedramp-use2-core */
export function isValidTargetEnv(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i.test(value);
}
