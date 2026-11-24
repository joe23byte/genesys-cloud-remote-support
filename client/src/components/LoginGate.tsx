import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { agentToken, api, ApiError, type AgentInfo } from '../lib/api';
import { isPersistentStorageAvailable } from '../lib/storage';
import { Spinner } from './common';

export function LoginGate({ children, compact }: { children: (agent: AgentInfo, logout: () => void) => ReactNode; compact?: boolean }) {
  const t = useT();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agentToken.get()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then((r) => setAgent(r.agent))
      .catch(() => agentToken.clear())
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    void api.logout().catch(() => undefined);
    agentToken.clear();
    setAgent(null);
  };

  if (checking) {
    return (
      <div className="center-box">
        <Spinner /> {t('common.loading')}
      </div>
    );
  }
  if (agent) return <>{children(agent, logout)}</>;

  return (
    <div className={`login${compact ? ' login--compact' : ''}`}>
      <form
        className="card login__card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.login(username.trim(), password);
            agentToken.set(r.token);
            setPassword('');
            setAgent(r.agent);
          } catch (err) {
            const code = err instanceof ApiError ? err.code : 'network_error';
            setError(code === 'rate_limited' ? t('login.rateLimited') : code === 'invalid_credentials' ? t('login.invalid') : t('common.networkError'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="card__title">{t('login.title')}</h1>
        <p className="hint">{t('login.hint')}</p>
        <label className="field-label" htmlFor="rs-username">
          {t('login.username')}
        </label>
        <input
          id="rs-username"
          className="input"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          maxLength={64}
        />
        <label className="field-label" htmlFor="rs-password">
          {t('login.password')}
        </label>
        <input
          id="rs-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={256}
        />
        {error && (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        )}
        {!isPersistentStorageAvailable() && <div className="hint hint--warning">{t('login.storageWarning')}</div>}
        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? <Spinner small /> : null} {t('login.submit')}
        </button>
      </form>
    </div>
  );
}
