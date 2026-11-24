import { useContext, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { SessionStatus } from '../../../shared/protocol';
import { I18nContext, statusKey, useT, type Lang, type MessageKey } from '../i18n';
import { ApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';

const STATUS_TONE: Record<SessionStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  waiting_customer: 'neutral',
  customer_connected: 'info',
  waiting_share: 'info',
  sharing: 'success',
  interrupted: 'warning',
  share_stopped: 'neutral',
  ended: 'danger',
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const t = useT();
  return (
    <span className={`badge badge--${STATUS_TONE[status]}`} data-status={status} role="status" aria-live="polite">
      <span className="badge__dot" aria-hidden="true" />
      {t(statusKey(status))}
    </span>
  );
}

export function QrCode({ value, size = 144 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (!src) return <div className="qr qr--empty" style={{ width: size, height: size }} />;
  return <img className="qr" src={src} width={size} height={size} alt="QR code" />;
}

export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <div className="copy-field">
      <label className="field-label">{label}</label>
      <div className="copy-field__row">
        <input ref={inputRef} className="input input--mono" readOnly value={value} onFocus={(e) => e.currentTarget.select()} data-testid={testId} />
        <button type="button" className="btn btn--secondary" onClick={async () => setState(await copyText(value, inputRef.current))}>
          {state === 'copied' ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      {state === 'manual' && <div className="hint hint--warning">{t('common.copyManual')}</div>}
    </div>
  );
}

export function LanguageSwitch() {
  const { lang, setLang } = useContext(I18nContext);
  const t = useT();
  return (
    <div className="lang-switch" role="group" aria-label={t('common.language')}>
      {(['de', 'en'] as Lang[]).map((l) => (
        <button key={l} type="button" className={`lang-switch__btn${l === lang ? ' is-active' : ''}`} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner${small ? ' spinner--small' : ''}`} aria-hidden="true" />;
}

const KNOWN_ERRORS = new Set([
  'gc_host_origin_not_allowed',
  'genesys_context_required',
  'conversation_not_verified',
  'invalid_request',
  'rate_limited',
  'unauthorized',
  'session_not_found',
  'session_ended',
  'network_error',
  'demo_disabled',
  'invalid_salesforce_case_id',
]);

export function errorMessage(t: ReturnType<typeof useT>, err: unknown): string {
  const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
  if (KNOWN_ERRORS.has(code)) return t(`error.${code}` as MessageKey);
  return `${t('common.error')} (${code})`;
}
