/**
 * Types and constants shared between server and browser.
 * This file must stay free of Node.js and DOM specific imports.
 */

export const SESSION_STATUSES = [
  'waiting_customer',
  'customer_connected',
  'waiting_share',
  'sharing',
  'interrupted',
  'share_stopped',
  'ended',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const END_REASONS = [
  'agent_ended',
  'max_duration',
  'idle_timeout',
  'invite_expired',
] as const;

export type EndReason = (typeof END_REASONS)[number];

export type SessionSource = 'genesys' | 'demo';

export type CustomerLanguage = 'de' | 'en';

/** Session metadata as exposed to the owning agent. Never contains tokens. */
export interface SessionView {
  sessionId: string;
  conversationId: string;
  agentId: string;
  agentDisplayName: string;
  salesforceCaseId: string | null;
  source: SessionSource;
  gcHostOrigin: string | null;
  gcTargetEnv: string | null;
  genesysVerified: boolean | null;
  customerLanguage: CustomerLanguage | null;
  forceRelay: boolean;
  status: SessionStatus;
  connectionStatus: string | null;
  iceCandidateType: string | null;
  createdAt: string;
  startedAt: string;
  customerJoinedAt: string | null;
  consentAt: string | null;
  shareStartedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  endReason: EndReason | null;
  inviteExpiresAt: string | null;
  inviteUsed: boolean;
  verificationCode: string | null;
  maxEndsAt: string;
}

export interface InviteView {
  url: string;
  code: string;
  expiresAt: string;
}

export interface CreateSessionResponse {
  session: SessionView;
  invite: InviteView;
}

export interface JoinResponse {
  customerToken: string;
  sessionId: string;
  agentDisplayName: string;
  customerLanguage: CustomerLanguage | null;
  verificationCode: string;
}

export interface IceConfig {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  iceTransportPolicy: 'all' | 'relay';
  /** Recommended sender limits; the customer browser applies them. */
  media: { maxWidth: number; maxHeight: number; maxFrameRate: number; maxBitrateKbps: number };
}

/** Live state broadcast to both peers of a session. */
export interface LiveSessionState {
  sessionId: string;
  status: SessionStatus;
  agentOnline: boolean;
  customerOnline: boolean;
  customerJoined: boolean;
  /** An unused, unexpired invitation (link + code) exists. */
  invitePending: boolean;
  consentGiven: boolean;
  shareActive: boolean;
  mediaConnected: boolean;
  verificationCode: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type SignalKind = 'offer' | 'answer' | 'candidate' | 'end-of-candidates';

export interface SignalMessage {
  /** Identifies one RTCPeerConnection generation so stale signals can be dropped. */
  pcId: string;
  kind: SignalKind;
  sdp?: string;
  candidate?: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
}

export interface ShareStatePayload {
  state: 'started' | 'stopped';
  displaySurface?: string;
  width?: number;
  height?: number;
}

export interface MediaStatePayload {
  state: 'connected' | 'interrupted' | 'failed';
  candidateType?: string;
}

export interface RequestOfferPayload {
  iceRestart: boolean;
}

export type Ack<T = undefined> = (response: { ok: true; data?: T } | { ok: false; error: string }) => void;

export const SOCKET_EVENTS = {
  agentAttach: 'agent:attach',
  customerAttach: 'customer:attach',
  customerConsent: 'customer:consent',
  shareState: 'customer:share-state',
  mediaState: 'agent:media-state',
  requestOffer: 'agent:request-offer',
  signal: 'signal',
  sessionState: 'session:state',
  sessionEnded: 'session:ended',
  replaced: 'session:replaced',
  iceConfig: 'session:ice-config',
} as const;

export const LIMITS = {
  maxSdpLength: 64 * 1024,
  maxCandidateLength: 2048,
  salesforceCaseIdMax: 64,
} as const;

export const SESSION_CODE_LENGTH = 6;
