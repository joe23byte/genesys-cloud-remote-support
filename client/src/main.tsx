import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const AgentPage = lazy(() => import('./pages/AgentPage'));
const JoinPage = lazy(() => import('./pages/JoinPage'));
const DemoPage = lazy(() => import('./pages/DemoPage'));
const HomePage = lazy(() => import('./pages/HomePage'));

function pageFor(pathname: string) {
  if (pathname.startsWith('/agent')) return <AgentPage />;
  if (pathname.startsWith('/join')) return <JoinPage />;
  if (pathname.startsWith('/demo')) return <DemoPage />;
  return <HomePage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="page-loading">…</div>}>{pageFor(window.location.pathname)}</Suspense>
  </StrictMode>,
);
