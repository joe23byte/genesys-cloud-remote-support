import type { CreateSessionResponse, JoinResponse, SessionView } from '../../../shared/protocol';
import { getItem, removeItem, setItem } from './storage';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

const AGENT_TOKEN_KEY = 'rs.agentToken';

export const agentToken = {
  get: () => getItem(AGENT_TOKEN_KEY),
  set: (t: string) => setItem(AGENT_TOKEN_KEY, t),
  clear: () => removeItem(AGENT_TOKEN_KEY),
};

async function request<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `http_${res.status}`);
  return data as T;
}

const authed = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, agentToken.get());

export interface AgentInfo {
  id: string;
  displayName: string;
}

export interface AuditEvent {
  ts: string;
  event: string;
  actorType: string;
  actorId: string | null;
  details: Record<string, unknown> | null;
}

export interface DemoInfo {
  environment: string;
  publicBaseUrl: string;
  ice: { stunUrls: string[]; turnUrls: string[]; turnAuth: string; transportPolicy: string; turnConfigured: boolean };
  media: { maxWidth: number; maxHeight: number; maxFrameRate: number; maxBitrateKbps: number };
  inviteTtlSeconds: number;
  sessionMaxDurationMinutes: number;
  sessionIdleTimeoutMinutes: number;
  retentionDays: number;
  gcAllowedHostOrigins: string[];
  frameAncestors: string[];
  webhookEnabled: boolean;
  genesysApiEnabled: boolean;
}

export interface CreateSessionRequest {
  conversationId: string;
  source: 'genesys' | 'demo';
  gcHostOrigin?: string | null;
  gcTargetEnv?: string | null;
  customerLanguage?: 'de' | 'en' | null;
  salesforceCaseId?: string | null;
  forceRelay?: boolean;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; expiresAt: string; agent: AgentInfo }>('POST', '/auth/login', { username, password }),
  logout: () => authed<{ ok: true }>('POST', '/auth/logout'),
  me: () => authed<{ agent: AgentInfo; expiresAt: string }>('GET', '/auth/me'),
  createSession: (body: CreateSessionRequest) => authed<CreateSessionResponse>('POST', '/sessions', body),
  listSessions: (params: { conversationId?: string; active?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.conversationId) q.set('conversationId', params.conversationId);
    if (params.active) q.set('active', '1');
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return authed<{ sessions: SessionView[] }>('GET', `/sessions${qs ? `?${qs}` : ''}`);
  },
  getSession: (id: string) => authed<{ session: SessionView }>('GET', `/sessions/${encodeURIComponent(id)}`),
  updateCaseId: (id: string, salesforceCaseId: string | null) =>
    authed<{ session: SessionView }>('PATCH', `/sessions/${encodeURIComponent(id)}`, { salesforceCaseId }),
  regenerateInvite: (id: string) => authed<CreateSessionResponse>('POST', `/sessions/${encodeURIComponent(id)}/invite`),
  endSession: (id: string) => authed<{ session: SessionView }>('POST', `/sessions/${encodeURIComponent(id)}/end`),
  sessionAudit: (id: string) => authed<{ events: AuditEvent[] }>('GET', `/sessions/${encodeURIComponent(id)}/audit`),
  demoInfo: () => authed<DemoInfo>('GET', '/demo/info'),
  join: (credential: { inviteToken: string } | { code: string }) => request<JoinResponse>('POST', '/join', credential),
};
