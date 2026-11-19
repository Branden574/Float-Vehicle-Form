import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ReleaseNotice } from './components/ReleaseNotice';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReleaseNotice />
    <App />
  </React.StrictMode>,
);
if ('serviceWorker' in navigator && import.meta.env.PROD)
  navigator.serviceWorker.register('/sw.js').catch(() => {});
