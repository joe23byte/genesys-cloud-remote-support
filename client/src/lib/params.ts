export interface GenesysContext {
  conversationId: string | null;
  gcHostOrigin: string | null;
  gcTargetEnv: string | null;
  language: string | null;
  demoMode: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the Genesys Cloud URL interpolation values. They only describe context;
 * authorization never depends on them. The server validates them again.
 */
export function readGenesysContext(search: string): GenesysContext {
  const p = new URLSearchParams(search);
  const conversationId = p.get('conversationId') ?? p.get('gcConversationId') ?? p.get('pcConversationId');
  const hostOrigin = p.get('gcHostOrigin');
  const targetEnv = p.get('gcTargetEnv');
  const language = p.get('language') ?? p.get('gcLangTag') ?? p.get('langTag');
  let gcHostOrigin: string | null = null;
  if (hostOrigin) {
    try {
      const u = new URL(hostOrigin);
      if (u.protocol === 'https:' || u.protocol === 'http:') gcHostOrigin = u.origin;
    } catch {
      gcHostOrigin = null;
    }
  }
  return {
    conversationId: conversationId && UUID_RE.test(conversationId) ? conversationId.toLowerCase() : null,
    gcHostOrigin,
    gcTargetEnv: targetEnv && /^[a-z0-9-]{1,64}$/i.test(targetEnv) ? targetEnv : null,
    language: language && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(language) ? language.toLowerCase() : null,
    demoMode: p.get('rsDemo') === '1',
  };
}

/** True when the raw parameter was present but unusable (helps explain misconfigured widget URLs). */
export function invalidParams(search: string, ctx: GenesysContext): string[] {
  const p = new URLSearchParams(search);
  const issues: string[] = [];
  const raw = (k: string) => p.get(k);
  if (raw('conversationId') && !ctx.conversationId) issues.push('conversationId');
  if (raw('gcHostOrigin') && !ctx.gcHostOrigin) issues.push('gcHostOrigin');
  if (raw('gcTargetEnv') && !ctx.gcTargetEnv) issues.push('gcTargetEnv');
  for (const k of ['conversationId', 'gcHostOrigin', 'gcTargetEnv']) {
    if (raw(k)?.includes('{{')) issues.push(`${k} (not interpolated)`);
  }
  return [...new Set(issues)];
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
