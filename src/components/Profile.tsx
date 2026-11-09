import { useState } from 'react';
import { patch, errorMessage } from '../api';
import type { Session } from '../types';
export function Profile({
  session,
  onSaved,
  onCancel,
  onSignOut,
}: {
  session: Session;
  onSaved: (s: Session) => void;
  onCancel?: () => void;
  onSignOut: () => void;
}) {
  const [form, setForm] = useState({
    name: session.user.name,
    email: session.user.email,
    charter: session.user.charter || '',
    department: session.user.department || '',
    manager: session.user.manager || '',
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className="profile-page">
      <p className="eyebrow">Your fleet profile</p>
      <h1>{session.user.charter ? 'Your saved details' : 'Welcome. Tell us about you.'}</h1>
      <p>
        These details will prefill your future checkouts. Signed past trips keep their original
        details.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onSaved(await patch<Session>('/auth/profile', form));
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {(
          [
            ['name', 'Full name'],
            ['email', 'Work email'],
            ['charter', 'Charter / school'],
            ['department', 'Department (optional)'],
            ['manager', 'Manager'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type={key === 'email' ? 'email' : 'text'}
              required={key !== 'department'}
              maxLength={key === 'email' ? 254 : 200}
              readOnly={key === 'email'}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              autoComplete={key === 'name' ? 'name' : key === 'email' ? 'email' : 'off'}
            />
          </label>
        ))}
        <p className="fine">
          Your saved profile is encrypted on the server. Your sign-in email is managed by your fleet
          administrator.
        </p>
        <div className="profile-actions">
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save my details'}
          </button>
          {onCancel && (
            <button className="button secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="button secondary" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </form>
    </main>
  );
}
