import { useEffect, useState } from 'react';
import { api, errorMessage, post } from '../api';
import { addPasskey } from '../passkeys';
export function PasskeySettings() {
  const [busy, setBusy] = useState(false),
    [count, setCount] = useState<number>(),
    [message, setMessage] = useState('');
  useEffect(() => {
    let current = true;
    api<{ count: number }>('/auth/passkeys')
      .then((r) => {
        if (current) setCount(r.count);
      })
      .catch((e) => {
        if (current) setMessage(errorMessage(e));
      });
    return () => {
      current = false;
    };
  }, []);
  async function change(remove: boolean) {
    if (
      remove &&
      !window.confirm(
        'Remove all passkeys for this Fleet Checkout account? You can still sign in by email.',
      )
    )
      return;
    setBusy(true);
    setMessage('');
    try {
      if (remove) await post('/auth/passkeys/remove', {});
      else await addPasskey();
      const r = await api<{ count: number }>('/auth/passkeys');
      setCount(r.count);
      setMessage(
        remove ? 'Passkeys removed.' : 'Passkey saved. Next time, choose Sign in with a passkey.',
      );
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>Passkey sign-in</h2>
      <p>
        Choose Create a passkey, select your personal password manager (Passwords on iPhone or
        iPad), and confirm with your device’s screen lock. On a shared device, use your own phone or
        email code.
      </p>
      <div className="action-group">
        <button className="button secondary" disabled={busy} onClick={() => void change(false)}>
          Create a passkey
        </button>
        {!!count && (
          <button className="text-button" disabled={busy} onClick={() => void change(true)}>
            Remove all passkeys ({count})
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
