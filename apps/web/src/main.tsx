import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/base.css';
import './styles/watch.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// Offline shell: only in production builds, so dev never serves a stale bundle.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
