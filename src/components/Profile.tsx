import { useState } from 'react';
import { patch, post, errorMessage, clearPrivateState } from '../api';
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
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
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
      <p>
        <a href="/privacy">Privacy policy</a> · <a href="/support">Support</a>
      </p>
      <section className="notice" aria-label="Delete account">
        <h2>Delete your account</h2>
        <p>
          Permanently remove your profile, signed forms, photos, gas receipts and generated reports.
          You will be signed out immediately. Cloud cleanup, including recoverable backups, finishes
          within 7 days. Copies already emailed or downloaded must be removed by their recipients.
        </p>
        <p>
          Return any checked-out vehicle first. If you delete while a vehicle is out, it will be
          held for inspection. Administrators should appoint a replacement before deleting their
          account.
        </p>
        {!deleting ? (
          <button className="button secondary" onClick={() => setDeleting(true)}>
            Delete my account…
          </button>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                const result = await post<{ receipt: string }>('/auth/delete-account', {
                  confirmation,
                });
                clearPrivateState();
                window.location.replace('/deletion-status#' + result.receipt);
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            <p>
              This cannot be undone. If prompted, sign out and sign in again to verify your
              identity.
            </p>
            <label>
              Type DELETE to confirm
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="profile-actions">
              <button className="button primary" disabled={busy || confirmation !== 'DELETE'}>
                {busy ? 'Requesting deletion…' : 'Permanently delete my account'}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                  setConfirmation('');
                }}
              >
                Keep my account
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
