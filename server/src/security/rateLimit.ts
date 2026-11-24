import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window in-memory rate limiter. Sufficient for a single-instance PoC;
 * a multi-instance deployment needs a shared store (e.g. Redis).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 50_000) this.prune();
    return { allowed: bucket.count <= this.limit, retryAfterMs: Math.max(0, bucket.resetAt - t) };
  }

  /** Checks the budget without consuming it. */
  isExhausted(key: string): boolean {
    const bucket = this.buckets.get(key);
    return !!bucket && bucket.resetAt > this.now() && bucket.count >= this.limit;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  prune(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }
}

/**
 * Client IP from a header set by the edge proxy (e.g. Cloudflare's CF-Connecting-IP).
 * Only safe when every request passes that proxy, which overwrites client-supplied values.
 */
export function headerIp(req: IncomingMessage, header: string | undefined): string | null {
  if (!header) return null;
  const raw = req.headers[header];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
  return value && isIP(value) ? value : null;
}

export function clientIp(req: Request, header?: string): string {
  return headerIp(req, header) ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimitMiddleware(
  limiter: RateLimiter,
  keyFn: (req: Request) => string,
  onLimited?: (req: Request) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = limiter.hit(keyFn(req));
    if (!result.allowed) {
      onLimited?.(req);
      res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
