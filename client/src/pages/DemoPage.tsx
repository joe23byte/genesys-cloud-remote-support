import { useCallback, useEffect, useState } from 'react';
import type { SessionView } from '../../../shared/protocol';
import { AgentSessionPanel, storeInvite } from '../components/AgentSessionPanel';
import { errorMessage, LanguageSwitch, Spinner, StatusBadge } from '../components/common';
import { LoginGate } from '../components/LoginGate';
import { I18nContext, resolveLang, useT, type Lang } from '../i18n';
import { api, type AgentInfo, type AuditEvent, type DemoInfo } from '../lib/api';
import { formatDuration, uuid } from '../lib/params';

export default function DemoPage() {
  const [lang, setLang] = useState<Lang>(() => resolveLang(navigator.language));
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = 'Remote Support – Demo';
  }, [lang]);
  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      <div className="demo-app">
        <LoginGate>{(agent, logout) => <Demo agent={agent} logout={logout} />}</LoginGate>
      </div>
    </I18nContext.Provider>
  );
}

interface Panel {
  key: string;
  sessionId: string;
  conversationId: string;
  inviteUrl: string;
  index: number;
}

const IFRAME_SANDBOX = 'allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads';

function Demo({ agent, logout }: { agent: AgentInfo; logout: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [conversationId, setConversationId] = useState(uuid);
  const [customerLanguage, setCustomerLanguage] = useState<'' | 'de' | 'en'>('');
  const [forceRelay, setForceRelay] = useState(false);
  const [caseId, setCaseId] = useState('');
  const [panels, setPanels] = useState<Panel[]>([]);
  const [counter, setCounter] = useState(1);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [audit, setAudit] = useState<{ sessionId: string; events: AuditEvent[] } | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .listSessions({ limit: 20 })
      .then((r) => setSessions(r.sessions))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .demoInfo()
      .then(setInfo)
      .catch((err) => setError(errorMessage(t, err)));
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createSession({
        conversationId,
        source: 'demo',
        customerLanguage: customerLanguage || null,
        salesforceCaseId: caseId.trim() || null,
        forceRelay,
      });
      storeInvite(r.session.sessionId, r.invite);
      setPanels((p) => [...p, { key: r.session.sessionId, sessionId: r.session.sessionId, conversationId, inviteUrl: r.invite.url, index: counter }]);
      setCounter((c) => c + 1);
      setConversationId(uuid());
      setCaseId('');
      refresh();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const showAudit = async (sessionId: string) => {
    try {
      const r = await api.sessionAudit(sessionId);
      setAudit({ sessionId, events: r.events });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  };

  const openIframeTest = () => {
    const params = new URLSearchParams({ conversationId: uuid(), gcTargetEnv: 'demo', language: navigator.language, rsDemo: '1' });
    setIframeUrl(`/agent?${params.toString()}`);
  };

  return (
    <main className="demo">
      <header className="demo__header">
        <div>
          <h1 className="demo__title">{t('demo.title')}</h1>
          <p className="hint">{t('demo.subtitle')}</p>
        </div>
        <div className="demo__user">
          <LanguageSwitch />
          <span>{agent.displayName}</span>
          <button type="button" className="link-btn" onClick={logout}>
            {t('login.logout')}
          </button>
        </div>
      </header>

      {error && <div className="alert alert--danger">{error}</div>}

      <section className="demo__controls card">
        <div className="demo__form">
          <div className="demo__field demo__field--wide">
            <label className="field-label" htmlFor="demo-conv">
              {t('demo.conversationId')}
            </label>
            <div className="copy-field__row">
              <input id="demo-conv" className="input input--mono" value={conversationId} onChange={(e) => setConversationId(e.target.value.trim())} data-testid="demo-conversation-id" />
              <button type="button" className="btn btn--secondary" onClick={() => setConversationId(uuid())}>
                {t('demo.generate')}
              </button>
            </div>
          </div>
          <div className="demo__field">
            <label className="field-label" htmlFor="demo-case">
              {t('agent.caseId')}
            </label>
            <input id="demo-case" className="input" value={caseId} maxLength={64} onChange={(e) => setCaseId(e.target.value)} />
          </div>
          <div className="demo__field">
            <label className="field-label" htmlFor="demo-lang">
              {t('agent.customerLanguage')}
            </label>
            <select id="demo-lang" className="input" value={customerLanguage} onChange={(e) => setCustomerLanguage(e.target.value as '' | 'de' | 'en')}>
              <option value="">{t('agent.languageAuto')}</option>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
        <div className="demo__actions">
          <label className="checkbox">
            <input type="checkbox" checked={forceRelay} onChange={(e) => setForceRelay(e.target.checked)} disabled={!info?.ice.turnConfigured} />
            <span>
              {t('agent.forceRelay')}
              {info && !info.ice.turnConfigured ? ' – TURN_URLS not configured' : ''}
            </span>
          </label>
          <span className="spacer" />
          <button type="button" className="btn btn--secondary" onClick={openIframeTest}>
            {t('demo.embedTest')}
          </button>
          <button type="button" className="btn btn--primary" onClick={start} disabled={busy} data-testid="demo-start">
            {busy ? <Spinner small /> : null} {t('demo.startSession')}
          </button>
        </div>
      </section>

      {iframeUrl && (
        <section className="card demo__iframe">
          <div className="demo__iframe-bar">
            <code>{iframeUrl}</code>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setIframeUrl(null)}>
              {t('demo.close')}
            </button>
          </div>
          <p className="hint">
            sandbox="{IFRAME_SANDBOX}" · allow="clipboard-write; fullscreen"
          </p>
          <iframe title="Interaction widget test" src={iframeUrl} sandbox={IFRAME_SANDBOX} allow="clipboard-write; fullscreen" className="demo__iframe-frame" />
        </section>
      )}

      <section className="demo__panels">
        {panels.map((p) => (
          <div className="card demo__panel" key={p.key}>
            <div className="demo__panel-head">
              <strong>Session #{p.index}</strong>
              <span className="spacer" />
              <button type="button" className="btn btn--secondary btn--small" onClick={() => window.open(p.inviteUrl, '_blank', 'noopener,noreferrer')} data-testid="open-customer">
                {t('demo.openCustomer')}
              </button>
            </div>
            <AgentSessionPanel
              sessionId={p.sessionId}
              variant="demo"
              title={p.conversationId.slice(0, 8)}
              onClosed={() => {
                setPanels((all) => all.filter((x) => x.key !== p.key));
                refresh();
              }}
            />
          </div>
        ))}
      </section>

      <section className="card">
        <div className="demo__panel-head">
          <h2 className="section-title">{t('demo.sessions')}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--small" onClick={refresh}>
            {t('demo.refresh')}
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="hint">{t('demo.noSessions')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="session-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Conversation ID</th>
                  <th>Agent</th>
                  <th>Case</th>
                  <th>Start</th>
                  <th>{t('agent.duration')}</th>
                  <th>Consent</th>
                  <th>ICE</th>
                  <th>End reason</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.sessionId}>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td>
                      <code>{s.conversationId}</code>
                    </td>
                    <td>{s.agentId}</td>
                    <td>{s.salesforceCaseId ?? '–'}</td>
                    <td>{new Date(s.startedAt).toLocaleTimeString()}</td>
                    <td>{s.durationSeconds !== null ? formatDuration(s.durationSeconds) : '–'}</td>
                    <td>{s.consentAt ? new Date(s.consentAt).toLocaleTimeString() : '–'}</td>
                    <td>{s.iceCandidateType ?? '–'}</td>
                    <td>{s.endReason ?? '–'}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => void showAudit(s.sessionId)}>
                        {t('demo.audit')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit && (
          <div className="audit">
            <div className="demo__panel-head">
              <strong>
                {t('demo.audit')} · {audit.sessionId}
              </strong>
              <span className="spacer" />
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setAudit(null)}>
                {t('demo.close')}
              </button>
            </div>
            <ul className="audit__list">
              {audit.events.map((e, i) => (
                <li key={i}>
                  <span className="debug__ts">{new Date(e.ts).toLocaleTimeString()}</span> <strong>{e.event}</strong> <span className="hint">{e.actorType}{e.actorId ? `:${e.actorId}` : ''}</span>{' '}
                  {e.details && <code>{JSON.stringify(e.details)}</code>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {info && (
        <details className="card">
          <summary className="section-title">{t('demo.config')}</summary>
          <pre className="config-dump">{JSON.stringify(info, null, 2)}</pre>
        </details>
      )}
    </main>
  );
}
