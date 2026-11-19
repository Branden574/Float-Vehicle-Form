import { useEffect, useState } from 'react';
export function ReleaseNotice() {
  const [latest, setLatest] = useState('');
  const [later, setLater] = useState('');
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let stopped = false;
    async function check() {
      if (document.hidden || !navigator.onLine) return;
      try {
        const response = await fetch('/release.json', { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) return;
        const { release } = await response.json();
        if (stopped || typeof release !== 'string') return;
        setLatest(release === __FLEET_RELEASE__ ? '' : release);
        if (release === __FLEET_RELEASE__) {
          const key = 'fleet-workspace-release';
          const previous = localStorage.getItem(key);
          if (previous && previous !== release) setUpdated(true);
          localStorage.setItem(key, release);
        }
      } catch {
        /* Offline sessions continue using their current version. */
      }
    }
    void check();
    const tick = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(tick);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  const [notice, setNotice] = useState('');
  if (!latest && updated)
    return (
      <aside className="release-banner" aria-label="App update">
        <p role="status">Fleet Checkout is running the latest update.</p>
        <button className="text-button" onClick={() => setUpdated(false)}>
          Got it
        </button>
      </aside>
    );
  if (!latest || latest === later) return null;
  return (
    <aside className="release-banner" aria-label="App update">
      <div role="status">
        <strong>Fleet Checkout has been updated.</strong>
        <p>{notice || 'Refresh when you’re ready to use the latest version.'}</p>
      </div>
      <div className="action-group">
        <button
          className="button secondary"
          onClick={() => {
            if (document.querySelector('.workflow,[data-protect-update]')) {
              setNotice('Finish or leave the open form first. Your current screen will stay open.');
              return;
            }
            if (
              document.querySelector('form') &&
              !window.confirm('Refresh Fleet Checkout? Unsaved form entries will be cleared.')
            )
              return;
            window.location.reload();
          }}
        >
          Refresh now
        </button>
        <button className="text-button" onClick={() => setLater(latest)}>
          Later
        </button>
      </div>
    </aside>
  );
}
