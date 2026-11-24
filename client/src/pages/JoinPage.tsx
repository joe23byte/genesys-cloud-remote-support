import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type IceConfig, type JoinResponse, type LiveSessionState, type ShareStatePayload } from '../../../shared/protocol';
import { LanguageSwitch, Spinner } from '../components/common';
import { I18nContext, resolveLang, useT, type Lang, type MessageKey } from '../i18n';
import { api, ApiError } from '../lib/api';
import { getItem, removeItem, setItem } from '../lib/storage';
import { captureScreen, CustomerPeer, isScreenShareSupported } from '../lib/webrtc/customerPeer';
import { connectSignaling, emitWithAck } from '../lib/webrtc/signalingClient';

const CUSTOMER_KEY = 'rs.customer';

type StoredCustomer = Pick<JoinResponse, 'customerToken' | 'sessionId' | 'agentDisplayName' | 'customerLanguage' | 'verificationCode'>;

function loadStored(): StoredCustomer | null {
  try {
    const raw = getItem(CUSTOMER_KEY);
    return raw ? (JSON.parse(raw) as StoredCustomer) : null;
  } catch {
    return null;
  }
}

function readInviteFragment(): { token: string | null; lang: string | null } {
  const hash = window.location.hash.replace(/^#/, '');
  const p = new URLSearchParams(hash);
  const token = p.get('t');
  const lang = p.get('lang');
  // Remove the single-use token from the address bar and history right away.
  if (hash) window.history.replaceState(null, '', window.location.pathname);
  return { token: token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null, lang };
}

// Read once per page load: the fragment is stripped immediately and must not be re-read on re-render.
const initialFragment = readInviteFragment();

export default function JoinPage() {
  const fragment = initialFragment;
  const stored = useMemo(loadStored, []);
  const [lang, setLang] = useState<Lang>(() =>
    resolveLang(fragment.lang, fragment.token ? null : stored?.customerLanguage, navigator.language),
  );
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      <JoinFlow inviteToken={fragment.token} stored={fragment.token ? null : stored} />
    </I18nContext.Provider>
  );
}

type Phase = 'entry' | 'invite' | 'joining' | 'connected' | 'ended' | 'replaced';
type ShareState = 'idle' | 'requesting' | 'sharing' | 'stopped';

const SURFACES = new Set(['monitor', 'window', 'browser', 'application']);

function JoinFlow({ inviteToken, stored }: { inviteToken: string | null; stored: StoredCustomer | null }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>(stored ? 'connected' : inviteToken ? 'invite' : 'entry');
  const [joinInfo, setJoinInfo] = useState<StoredCustomer | null>(stored);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSessionState | null>(null);
  const [iceConfig, setIceConfig] = useState<IceConfig | null>(null);
  const [socketOnline, setSocketOnline] = useState(false);
  const [consent, setConsent] = useState(false);
  const [share, setShare] = useState<ShareState>('idle');
  const [pcState, setPcState] = useState<RTCPeerConnectionState | 'idle'>('idle');
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<CustomerPeer | null>(null);
  const liveRef = useRef<LiveSessionState | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const supported = isScreenShareSupported();

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    document.title = share === 'sharing' ? `● ${t('join.shared')} – ${t('appName')}` : `${t('appName')}`;
  }, [share, t]);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = preview;
  }, [preview]);

  const announceStopped = () => {
    const socket = socketRef.current;
    if (socket) void emitWithAck(socket, SOCKET_EVENTS.shareState, { state: 'stopped' } satisfies ShareStatePayload);
    setShare('stopped');
    setPreview(null);
  };

  useEffect(() => {
    if (!joinInfo) return;
    let disposed = false;
    const socket = connectSignaling('customer', joinInfo.customerToken);
    socketRef.current = socket;

    const terminate = (next: Phase) => {
      peerRef.current?.stopSharing();
      removeItem(CUSTOMER_KEY);
      setPreview(null);
      setShare('idle');
      setPhase(next);
      socket.io.opts.reconnection = false;
      socket.disconnect();
    };

    socket.on('connect', async () => {
      const r = await emitWithAck<{ state: LiveSessionState; iceConfig: IceConfig; agentDisplayName: string }>(socket, SOCKET_EVENTS.customerAttach);
      if (disposed) return;
      if (!r.ok || !r.data) {
        terminate('ended');
        return;
      }
      setSocketOnline(true);
      setLive(r.data.state);
      setIceConfig(r.data.iceConfig);
      if (!peerRef.current) {
        peerRef.current = new CustomerPeer(socket, r.data.iceConfig, {
          onConnectionState: (st) => !disposed && setPcState(st),
          onShareEnded: () => !disposed && announceStopped(),
          onLog: () => undefined,
          onStats: () => undefined,
        });
      } else {
        peerRef.current.setIceConfig(r.data.iceConfig);
      }
      const peer = peerRef.current;
      if (peer.isSharing) {
        // Signaling reconnected while the screen is still shared: tell the server again.
        const st = peer.trackSettings;
        await emitWithAck(socket, SOCKET_EVENTS.shareState, {
          state: 'started',
          displaySurface: SURFACES.has(String(st?.displaySurface)) ? (st?.displaySurface as ShareStatePayload['displaySurface']) : 'unknown',
        } satisfies ShareStatePayload);
      }
    });
    socket.on(SOCKET_EVENTS.sessionState, (state: LiveSessionState) => !disposed && setLive(state));
    socket.on(SOCKET_EVENTS.sessionEnded, () => !disposed && terminate('ended'));
    socket.on(SOCKET_EVENTS.replaced, () => !disposed && terminate('replaced'));
    socket.on('disconnect', () => !disposed && setSocketOnline(false));
    socket.on('connect_error', (err) => {
      if (disposed) return;
      if (err.message === 'unauthorized') terminate('ended');
    });

    return () => {
      disposed = true;
      peerRef.current?.dispose();
      peerRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinInfo]);

  const join = async (credential: { inviteToken: string } | { code: string }) => {
    setPhase('joining');
    setError(null);
    try {
      const r = await api.join(credential);
      const info: StoredCustomer = {
        customerToken: r.customerToken,
        sessionId: r.sessionId,
        agentDisplayName: r.agentDisplayName,
        customerLanguage: r.customerLanguage,
        verificationCode: r.verificationCode,
      };
      setItem(CUSTOMER_KEY, JSON.stringify(info));
      setJoinInfo(info);
      setPhase('connected');
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'network_error';
      const key: MessageKey =
        c === 'invite_expired' ? 'join.expired' : c === 'rate_limited' ? 'join.rateLimited' : c === 'network_error' ? 'common.networkError' : 'join.invalid';
      setError(t(key));
      setPhase('inviteToken' in credential ? 'invite' : 'entry');
    }
  };

  /** Click handler: getDisplayMedia() is called synchronously to keep the user activation. */
  const onShareClick = () => {
    const socket = socketRef.current;
    const peer = peerRef.current;
    if (!consent || !socket || !peer || !iceConfig) return;
    let capture: Promise<MediaStream>;
    try {
      capture = captureScreen(iceConfig.media);
    } catch {
      setError(t('join.unsupported'));
      return;
    }
    // Same tick, same socket: the server receives the consent before any offer.
    void emitWithAck(socket, SOCKET_EVENTS.customerConsent);
    setShare('requesting');
    setError(null);
    capture
      .then(async (stream) => {
        peer.attachStream(stream);
        const st = peer.trackSettings;
        const r = await emitWithAck(socket, SOCKET_EVENTS.shareState, {
          state: 'started',
          displaySurface: SURFACES.has(String(st?.displaySurface)) ? (st?.displaySurface as ShareStatePayload['displaySurface']) : 'unknown',
          width: st?.width ? Math.round(st.width) : undefined,
          height: st?.height ? Math.round(st.height) : undefined,
        } satisfies ShareStatePayload);
        if (!r.ok) {
          peer.stopSharing();
          setShare('idle');
          setError(`${t('common.error')} (${r.error})`);
          return;
        }
        setShare('sharing');
        setPreview(stream);
        if (liveRef.current?.agentOnline) peer.negotiate(false);
      })
      .catch((err: DOMException) => {
        setShare((s) => (s === 'requesting' ? 'idle' : s));
        if (err?.name === 'NotAllowedError') setError(/system/i.test(err.message) ? t('join.deniedSystem') : t('join.denied'));
        else setError(`${t('join.denied')} (${err?.name ?? 'Error'})`);
      });
  };

  const onStopClick = () => {
    peerRef.current?.stopSharing();
    announceStopped();
  };

  const agentName = joinInfo?.agentDisplayName ?? '';
  const sharing = share === 'sharing';

  return (
    <main className={`public-page join${sharing ? ' join--sharing' : ''}`}>
      {sharing && (
        <div className="share-banner" role="alert" data-testid="sharing-banner">
          <span className="share-banner__dot" aria-hidden="true" />
          <span className="share-banner__text">{t('join.sharingBanner', { agent: agentName })}</span>
          <button type="button" className="btn btn--light" onClick={onStopClick} data-testid="stop-sharing">
            {t('join.stop')}
          </button>
        </div>
      )}
      <div className="public-page__inner">
        <div className="public-page__top">
          <span className="brand">{t('appName')}</span>
          <LanguageSwitch />
        </div>

        <div className="card">
          <h1 className="card__title">{t('join.title')}</h1>

          {phase === 'entry' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (/^\d{6}$/.test(code)) void join({ code });
              }}
            >
              <p>{t('join.enterCode')}</p>
              <label className="field-label" htmlFor="rs-code">
                {t('join.code')}
              </label>
              <input
                id="rs-code"
                className="input input--code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                data-testid="code-input"
              />
              {error && (
                <div className="alert alert--danger" role="alert">
                  {error}
                </div>
              )}
              <button type="submit" className="btn btn--primary btn--block btn--large" disabled={!/^\d{6}$/.test(code)} data-testid="code-submit">
                {t('join.continue')}
              </button>
            </form>
          )}

          {phase === 'invite' && inviteToken && (
            <>
              <p>{t('join.intro')}</p>
              {error && (
                <div className="alert alert--danger" role="alert">
                  {error}
                </div>
              )}
              <button type="button" className="btn btn--primary btn--block btn--large" onClick={() => void join({ inviteToken })} data-testid="join-invite">
                {t('join.joinInvite')}
              </button>
            </>
          )}

          {phase === 'joining' && (
            <div className="center-box">
              <Spinner /> {t('join.joining')}
            </div>
          )}

          {phase === 'connected' && (
            <>
              <div className="join__people">
                <div>
                  <div className="field-label">{t('join.agent')}</div>
                  <div className="join__agent" data-testid="agent-name">
                    {agentName}
                  </div>
                </div>
                {joinInfo?.verificationCode && (
                  <div className="join__verify" title={t('join.verificationHint')}>
                    <div className="field-label">{t('join.verification')}</div>
                    <div className="verification__code" data-testid="customer-verification">
                      {live?.verificationCode ?? joinInfo.verificationCode}
                    </div>
                  </div>
                )}
              </div>
              {!socketOnline && <div className="alert alert--warning alert--slim">{t('join.reconnecting')}</div>}

              {!sharing && (
                <>
                  {share === 'stopped' && <div className="alert alert--info">{t('join.stopped')}</div>}
                  <h2 className="section-title">{t('join.whatTitle')}</h2>
                  <ul className="explain">
                    <li>{t('join.what1')}</li>
                    <li>{t('join.what2')}</li>
                    <li>{t('join.what3')}</li>
                    <li>{t('join.what4')}</li>
                    <li>{t('join.what5')}</li>
                  </ul>
                  {!supported ? (
                    <div className="alert alert--danger" data-testid="unsupported">
                      {t('join.unsupported')}
                    </div>
                  ) : (
                    <>
                      <label className="checkbox checkbox--consent">
                        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="consent" />
                        <span>{t('join.consent')}</span>
                      </label>
                      {error && (
                        <div className="alert alert--danger" role="alert">
                          {error}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn btn--primary btn--block btn--large"
                        disabled={!consent || !iceConfig || !socketOnline || share === 'requesting'}
                        onClick={onShareClick}
                        data-testid="share-screen"
                      >
                        {share === 'requesting' ? <Spinner small /> : null} {share === 'stopped' ? t('join.shareAgain') : t('join.share')}
                      </button>
                    </>
                  )}
                </>
              )}

              {sharing && (
                <div className="join__live">
                  <div className="meta-row">
                    <span className="meta-label">{t('join.connection')}</span>
                    <span className={`conn conn--${pcState}`} data-testid="customer-connection">
                      {t(`join.conn.${pcState}` as MessageKey)}
                    </span>
                  </div>
                  {live && !live.agentOnline && <div className="hint">{t('join.waitingAgent')}</div>}
                  <div className="field-label">{t('join.preview')}</div>
                  <video ref={previewRef} className="join__preview" autoPlay muted playsInline />
                  <button type="button" className="btn btn--danger btn--block btn--large" onClick={onStopClick}>
                    {t('join.stop')}
                  </button>
                </div>
              )}
            </>
          )}

          {phase === 'ended' && (
            <div className="alert alert--info" data-testid="customer-ended">
              {t('join.ended')}
            </div>
          )}
          {phase === 'replaced' && <div className="alert alert--warning">{t('join.replaced')}</div>}
        </div>
        <p className="privacy">{t('join.privacy')}</p>
      </div>
    </main>
  );
}
