import { useEffect, useState } from 'react';
import { LanguageSwitch } from '../components/common';
import { I18nContext, resolveLang, useT, type Lang } from '../i18n';

export default function HomePage() {
  const [lang, setLang] = useState<Lang>(() => resolveLang(navigator.language));
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      <Home />
    </I18nContext.Provider>
  );
}

function Home() {
  const t = useT();
  return (
    <main className="public-page">
      <div className="public-page__inner">
        <div className="public-page__top">
          <span className="brand">{t('appName')}</span>
          <LanguageSwitch />
        </div>
        <div className="card">
          <h1 className="card__title">{t('home.title')}</h1>
          <p>{t('home.text')}</p>
          <div className="stack">
            <a className="btn btn--primary btn--block" href="/join">
              {t('home.customer')}
            </a>
            <a className="btn btn--secondary btn--block" href="/demo">
              {t('home.demo')}
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
