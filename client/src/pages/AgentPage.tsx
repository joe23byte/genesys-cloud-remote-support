import { useEffect, useMemo, useState } from 'react';
import { AgentSessionPanel, storeInvite } from '../components/AgentSessionPanel';
import { errorMessage, Spinner } from '../components/common';
import { LoginGate } from '../components/LoginGate';
import { I18nContext, resolveLang, useT, type Lang } from '../i18n';
import { api, type AgentInfo } from '../lib/api';
import { invalidParams, readGenesysContext, type GenesysContext } from '../lib/params';

export default function AgentPage() {
  const ctx = useMemo(() => readGenesysContext(window.location.search), []);
  const [lang, setLang] = useState<Lang>(() => resolveLang(ctx.language, navigator.language));
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = 'Remote Support – Agent';
  }, [lang]);
  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      <div className="agent-app">
        <LoginGate compact>{(agent, logout) => <AgentWidget ctx={ctx} agent={agent} logout={logout} />}</LoginGate>
      </div>
    </I18nContext.Provider>
  );
}

const CASE_RE = /^[A-Za-z0-9._-]{0,64}$/;

function AgentWidget({ ctx, agent, logout }: { ctx: GenesysContext; agent: AgentInfo; logout: () => void }) {
  const t = useT();
  const [phase, setPhase] = useState<'checking' | 'idle' | 'active'>('checking');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState('');
  const [customerLanguage, setCustomerLanguage] = useState<'' | 'de' | 'en'>('');
  const [forceRelay, setForceRelay] = useState(false);
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => invalidParams(window.location.search, ctx), [ctx]);

  useEffect(() => {
    if (!ctx.conversationId) {
      setPhase('idle');
      return;
    }
    api
      .listSessions({ conversationId: ctx.conversationId, active: true, limit: 1 })
      .then((r) => {
        const existing = r.sessions[0];
        if (existing) {
          setSessionId(existing.sessionId);
          setNotice(t('agent.resumed'));
          setPhase('active');
        } else {
          setPhase('idle');
        }
      })
      .catch(() => setPhase('idle'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.conversationId]);

  const start = async () => {
    if (!ctx.conversationId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createSession({
        conversationId: ctx.conversationId,
        source: ctx.demoMode ? 'demo' : 'genesys',
        gcHostOrigin: ctx.gcHostOrigin,
        gcTargetEnv: ctx.gcTargetEnv,
        customerLanguage: customerLanguage || null,
        salesforceCaseId: caseId.trim() || null,
        forceRelay,
      });
      storeInvite(r.session.sessionId, r.invite);
      setSessionId(r.session.sessionId);
      setNotice(null);
      setPhase('active');
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="widget">
      <div className="widget__top">
        <span className="widget__brand">{t('appName')}</span>
        <span className="spacer" />
        <span className="widget__agent" title={agent.id}>
          {agent.displayName}
        </span>
        <button type="button" className="link-btn" onClick={logout}>
          {t('login.logout')}
        </button>
      </div>

      {issues.length > 0 && <div className="alert alert--warning alert--slim">{t('agent.invalidParams', { params: issues.join(', ') })}</div>}
      {notice && phase === 'active' && <div className="alert alert--info alert--slim">{notice}</div>}

      {phase === 'checking' && (
        <div className="center-box">
          <Spinner /> {t('common.loading')}
        </div>
      )}

      {phase === 'idle' && (
        <div className="card start">
          {!ctx.conversationId ? (
            <div className="alert alert--warning">{t('agent.noConversation')}</div>
          ) : (
            <>
              <div className="meta-row">
                <span className="meta-label">{t('agent.conversation')}</span>
                <code className="meta-value">{ctx.conversationId}</code>
              </div>
              <label className="field-label" htmlFor="rs-case">
                {t('agent.caseId')}
              </label>
              <input
                id="rs-case"
                className={`input${CASE_RE.test(caseId) ? '' : ' is-invalid'}`}
                value={caseId}
                maxLength={64}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder="500…"
              />
              {!CASE_RE.test(caseId) && <div className="hint hint--warning">{t('agent.caseIdInvalid')}</div>}
              <div className="start__row">
                <label className="field-label" htmlFor="rs-lang">
                  {t('agent.customerLanguage')}
                </label>
                <select id="rs-lang" className="input input--small" value={customerLanguage} onChange={(e) => setCustomerLanguage(e.target.value as '' | 'de' | 'en')}>
                  <option value="">{t('agent.languageAuto')}</option>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={forceRelay} onChange={(e) => setForceRelay(e.target.checked)} />
                <span>{t('agent.forceRelay')}</span>
              </label>
              {error && <div className="alert alert--danger alert--slim">{error}</div>}
              <button
                type="button"
                className="btn btn--primary btn--block btn--large"
                onClick={start}
                disabled={busy || !CASE_RE.test(caseId)}
                data-testid="start-remote-support"
              >
                {busy ? (
                  <>
                    <Spinner small /> {t('agent.starting')}
                  </>
                ) : (
                  t('agent.start')
                )}
              </button>
            </>
          )}
        </div>
      )}

      {phase === 'active' && sessionId && (
        <AgentSessionPanel
          key={sessionId}
          sessionId={sessionId}
          onClosed={() => {
            setSessionId(null);
            setNotice(null);
            setPhase('idle');
          }}
        />
      )}
    </div>
  );
}
