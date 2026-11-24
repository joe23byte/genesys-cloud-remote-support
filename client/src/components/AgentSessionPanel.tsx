import { useEffect, useState } from 'react';
import type { InviteView, SessionStatus, SessionView } from '../../../shared/protocol';
import { useAgentSession } from '../hooks/useAgentSession';
import { useT } from '../i18n';
import { api } from '../lib/api';
import { formatDuration } from '../lib/params';
import { getItem, removeItem, setItem } from '../lib/storage';
import { CopyField, errorMessage, QrCode, Spinner, StatusBadge } from './common';
import { DebugPanel } from './DebugPanel';
import { VideoViewer } from './VideoViewer';

const inviteKey = (sessionId: string) => `rs.invite.${sessionId}`;

export function storeInvite(sessionId: string, invite: InviteView) {
  setItem(inviteKey(sessionId), JSON.stringify(invite));
}

function loadInvite(sessionId: string): InviteView | null {
  try {
    const raw = getItem(inviteKey(sessionId));
    return raw ? (JSON.parse(raw) as InviteView) : null;
  } catch {
    return null;
  }
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const CASE_RE = /^[A-Za-z0-9._-]{0,64}$/;

export function AgentSessionPanel({
  sessionId,
  onClosed,
  variant = 'widget',
  title,
}: {
  sessionId: string;
  onClosed?: () => void;
  variant?: 'widget' | 'demo';
  title?: string;
}) {
  const t = useT();
  const s = useAgentSession(sessionId);
  const now = useNow();
  const [invite, setInvite] = useState<InviteView | null>(() => loadInvite(sessionId));
  const [inviteOpen, setInviteOpen] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(variant === 'demo');
  const [caseDraft, setCaseDraft] = useState<string | null>(null);

  const session: SessionView | null = s.session;
  const ended = s.socketState === 'ended' || s.live?.status === 'ended';
  let status: SessionStatus = ended ? 'ended' : (s.live?.status ?? session?.status ?? 'waiting_customer');
  if (!ended && status === 'sharing' && (s.pcState === 'disconnected' || s.pcState === 'failed')) status = 'interrupted';
  if (!ended && status === 'sharing' && !s.stream) status = 'waiting_share';

  // Collapse the invitation once the customer has joined; it can be reopened.
  const customerJoined = !!s.live?.customerJoined;
  useEffect(() => {
    if (customerJoined) setInviteOpen(false);
  }, [customerJoined]);

  useEffect(() => {
    if (ended) removeItem(inviteKey(sessionId));
  }, [ended, sessionId]);

  const startedAt = session ? Date.parse(session.startedAt) : now;
  const endedAt = s.live?.endedAt ? Date.parse(s.live.endedAt) : null;
  const duration = Math.round(((ended ? (endedAt ?? now) : now) - startedAt) / 1000);
  const inviteRemaining = invite ? Math.round((Date.parse(invite.expiresAt) - now) / 1000) : 0;
  const invitePending = !!s.live?.invitePending;
  const inviteUsed = customerJoined && !invitePending;

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.regenerateInvite(sessionId);
      storeInvite(sessionId, r.invite);
      setInvite(r.invite);
      s.setSession(r.session);
      setInviteOpen(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const endSession = async () => {
    setBusy(true);
    try {
      await api.endSession(sessionId);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
      setConfirmEnd(false);
    }
  };

  const saveCase = async () => {
    if (caseDraft === null || !CASE_RE.test(caseDraft)) return;
    try {
      const r = await api.updateCaseId(sessionId, caseDraft.trim() || null);
      s.setSession(r.session);
      setCaseDraft(null);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  };

  const overlayKey = (() => {
    if (ended) return 'overlay.ended' as const;
    if (status === 'interrupted') return 'overlay.interrupted' as const;
    if (s.stream) return null;
    switch (status) {
      case 'waiting_customer':
        return 'overlay.waiting_customer' as const;
      case 'customer_connected':
        return 'overlay.customer_connected' as const;
      case 'waiting_share':
        return s.live?.shareActive ? ('overlay.connecting' as const) : ('overlay.waiting_share' as const);
      case 'share_stopped':
        return 'overlay.share_stopped' as const;
      default:
        return 'overlay.connecting' as const;
    }
  })();

  if (s.socketState === 'unauthorized') {
    return <div className="alert alert--danger">{t('error.unauthorized')}</div>;
  }
  if (s.socketState === 'error') {
    return (
      <div className="alert alert--danger">
        {t('agent.sessionError')} {s.error ? `(${s.error})` : ''}
      </div>
    );
  }

  const joinUrl = invite ? new URL(invite.url).origin + '/join' : '';

  return (
    <section className={`session session--${variant}`} data-testid="agent-session" data-session-id={sessionId} data-status={status}>
      <header className="session__bar">
        <StatusBadge status={status} />
        <span className="session__duration" title={t('agent.duration')} data-testid="session-duration">
          {formatDuration(duration)}
        </span>
        {title && <span className="session__title">{title}</span>}
        <span className="spacer" />
        {!ended &&
          (confirmEnd ? (
            <span className="btn-group">
              <button type="button" className="btn btn--danger btn--small" onClick={endSession} disabled={busy} data-testid="confirm-end">
                {t('agent.endConfirm')}
              </button>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setConfirmEnd(false)}>
                {t('common.cancel')}
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--danger-outline btn--small" onClick={() => setConfirmEnd(true)} data-testid="end-session">
              {t('agent.end')}
            </button>
          ))}
        {ended && onClosed && (
          <button type="button" className="btn btn--primary btn--small" onClick={onClosed}>
            {variant === 'demo' ? t('demo.close') : t('agent.startAnother')}
          </button>
        )}
      </header>

      {s.socketState === 'reconnecting' && !ended && <div className="alert alert--warning alert--slim">{t('agent.reconnecting')}</div>}
      {s.socketState === 'replaced' && <div className="alert alert--warning alert--slim">{t('agent.replaced')}</div>}
      {error && <div className="alert alert--danger alert--slim">{error}</div>}

      {!ended && s.live?.verificationCode && customerJoined && (
        <div className="verification" title={t('agent.verificationHint')}>
          <span className="verification__label">{t('agent.verification')}</span>
          <span className="verification__code" data-testid="agent-verification">
            {s.live.verificationCode}
          </span>
          <span className="hint">{t('agent.verificationHint')}</span>
        </div>
      )}

      {!ended && (
        <div className="invite">
          <button type="button" className="invite__toggle" onClick={() => setInviteOpen((o) => !o)} aria-expanded={inviteOpen}>
            {t('agent.invite')}
            {inviteUsed ? ` · ${t('agent.inviteUsed')}` : ''}
            <span className="invite__chevron">{inviteOpen ? '▾' : '▸'}</span>
          </button>
          {inviteOpen && (
            <div className="invite__body">
              {invite && inviteRemaining > 0 && invitePending ? (
                <div className="invite__grid">
                  <div className="invite__main">
                    <div className="field-label">{t('agent.sessionCode')}</div>
                    <div className="code" data-testid="session-code">
                      {invite.code.slice(0, 3)} {invite.code.slice(3)}
                    </div>
                    <div className="hint">{t('agent.codeHint', { url: joinUrl })}</div>
                    <CopyField value={invite.url} label={t('agent.inviteLink')} testId="invite-url" />
                    <div className="hint">{t('agent.expiresIn', { time: formatDuration(inviteRemaining) })}</div>
                  </div>
                  <QrCode value={invite.url} size={120} />
                </div>
              ) : (
                <div className="hint">{inviteUsed ? t('agent.inviteUsed') : invite ? t('agent.expired') : ''}</div>
              )}
              <button type="button" className="btn btn--secondary btn--small" onClick={regenerate} disabled={busy} data-testid="new-invite">
                {busy ? <Spinner small /> : null} {t('agent.newInvite')}
              </button>
            </div>
          )}
        </div>
      )}

      <VideoViewer
        stream={ended ? null : s.stream}
        overlayTone={status === 'interrupted' ? 'warning' : 'info'}
        overlay={
          overlayKey ? (
            <>
              {!ended && status !== 'share_stopped' && <Spinner />}
              <span>{t(overlayKey)}</span>
            </>
          ) : null
        }
      />

      <footer className="session__meta">
        <div className="meta-row">
          <span className="meta-label">{t('agent.conversation')}</span>
          <code className="meta-value" data-testid="conversation-id">
            {session?.conversationId ?? '…'}
          </code>
        </div>
        <div className="meta-row">
          <span className="meta-label">Salesforce Case</span>
          {caseDraft === null ? (
            <button type="button" className="link-btn" onClick={() => setCaseDraft(session?.salesforceCaseId ?? '')} disabled={!session}>
              {session?.salesforceCaseId || '—'} ✎
            </button>
          ) : (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveCase();
              }}
            >
              <input
                className={`input input--small${CASE_RE.test(caseDraft) ? '' : ' is-invalid'}`}
                value={caseDraft}
                maxLength={64}
                autoFocus
                onChange={(e) => setCaseDraft(e.target.value)}
                aria-label={t('agent.caseId')}
              />
              <button type="submit" className="btn btn--secondary btn--small" disabled={!CASE_RE.test(caseDraft)}>
                {t('common.save')}
              </button>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setCaseDraft(null)}>
                {t('common.cancel')}
              </button>
            </form>
          )}
        </div>
        <button type="button" className="link-btn" onClick={() => setDebugOpen((o) => !o)} aria-expanded={debugOpen}>
          {t('agent.debug')} {debugOpen ? '▾' : '▸'}
        </button>
        {debugOpen && <DebugPanel stats={s.stats} pcState={s.pcState} socketState={s.socketState} iceConfig={s.iceConfig} live={s.live} log={s.log} />}
      </footer>
    </section>
  );
}
