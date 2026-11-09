import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CarFront,
  ChevronRight,
  ClipboardList,
  Clock3,
  LayoutGrid,
  LogOut,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  api,
  clearPrivateState,
  errorMessage,
  formatDate,
  humanize,
  miles,
  post,
  setCsrf,
} from './api';
import type { Session, Trip, Vehicle } from './types';
import { Workflow } from './components/Workflow';
import { TripView } from './components/TripView';
import { Admin } from './components/Admin';

type Page = 'fleet' | 'trips' | 'admin';
export function Status({ value, overdue = false }: { value: string; overdue?: boolean }) {
  return (
    <span className={`status ${overdue ? 'overdue' : value}`}>
      <i />
      {overdue ? 'Overdue' : humanize(value)}
    </span>
  );
}

function Login({ onSession, message }: { onSession: (s: Session) => void; message: string }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState({
    appName: 'Learn4Life Fleet Checkout',
    organizationName: 'Learn4Life',
    logoUrl: '',
  });
  const [token, setToken] = useState(() =>
    location.hash.startsWith('#invite=') ? location.hash.slice(8) : '',
  );
  useEffect(() => {
    api<typeof branding>('/public-settings')
      .then(setBranding)
      .catch(() => {});
    if (token) history.replaceState(null, '', location.pathname);
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (token) {
        await post('/auth/accept-invite', { token, password });
        setToken('');
        setPassword('');
        setError('Account activated. Sign in with your invited email and new password.');
      } else {
        const session = await post<Session>('/auth/login', { email, password });
        localStorage.removeItem('fleet-signout-pending');
        onSession(session);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <a className="brand" href="/" aria-label={branding.appName}>
          <>
            {branding.logoUrl ? (
              <img className="brand-logo" src={branding.logoUrl} alt="" />
            ) : (
              <span className="brand-mark">
                L4L<span>↗</span>
              </span>
            )}
          </>
          <span>
            {branding.organizationName}
            <small>FLEET OPERATIONS</small>
          </span>
        </a>
        <div className="login-title">
          <span className="eyebrow">SHARED VEHICLES. A CLEAR RECORD.</span>
          <h1>
            Every trip,
            <br />
            accounted for.
          </h1>
          <p>Check out a vehicle, record its condition, and return with everything in one place.</p>
          <div className="road-art" aria-hidden="true">
            <span className="road-line" />
            <CarFront size={104} strokeWidth={1} />
            <span className="road-caption">
              CHECK OUT <span>→</span> INSPECT <span>→</span> RETURN
            </span>
          </div>
        </div>
        <span className="login-foot">Built for the people who keep things moving.</span>
      </section>
      <section className="login-panel">
        <div className="login-form">
          <div className="lock-icon">
            <ShieldCheck size={26} />
          </div>
          <p className="eyebrow">STAFF ACCESS</p>
          <h2>{token ? 'Set your password' : 'Welcome back'}</h2>
          <p>
            {token
              ? 'Your individual invitation is valid for 72 hours.'
              : 'Sign in with your invited staff account.'}
          </p>
          {message && <div className="notice neutral">{message}</div>}
          {error && (
            <div className="notice warning" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={submit}>
            {!token && (
              <label>
                Work email
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
            <label>
              {token ? 'Create password' : 'Password'}
              <input
                type="password"
                name="password"
                minLength={token ? 12 : 1}
                autoComplete={token ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button disabled={busy} className="button primary wide" type="submit">
              {busy ? 'Please wait…' : token ? 'Activate account' : 'Sign in'}
              <ArrowRight size={18} />
            </button>
          </form>
          <p className="fine">
            {token
              ? 'Use at least 12 characters.'
              : 'Need access or a password reset? Ask your fleet administrator for an individual invitation.'}
          </p>
          <div className="shared-note">
            <ShieldCheck size={19} />
            <p>
              Using a shared iPad?
              <br />
              <strong>Sign out when you finish.</strong> Unfinished forms are cleared when your
              session ends.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [page, setPage] = useState<Page>('fleet'),
    [vehicles, setVehicles] = useState<Vehicle[]>([]),
    [trips, setTrips] = useState<Trip[]>([]),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const [workflow, setWorkflow] = useState<{ vehicle: Vehicle; trip?: Trip } | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [online, setOnline] = useState(navigator.onLine),
    [busy, setBusy] = useState(false);
  const activity = useRef(Date.now());
  function erase(note: string) {
    setSession(null);
    setWorkflow(null);
    setDetail(null);
    setTrips([]);
    setVehicles([]);
    setSearch('');
    setMessage(note);
    clearPrivateState();
  }
  function accept(s: Session) {
    setCsrf(s.csrfToken);
    setSession(s);
    setMessage('');
    activity.current = Date.now();
    document.title = s.settings.appName;
    document.documentElement.style.setProperty('--accent', s.settings.accentColor);
  }
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const [v, t] = await Promise.all([
        api<{ vehicles: Vehicle[] }>('/vehicles'),
        api<{ trips: Trip[] }>('/trips'),
      ]);
      setVehicles(v.vehicles);
      setTrips(t.trips);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    (async () => {
      try {
        const s = await api<Session>('/auth/me');
        setCsrf(s.csrfToken);
        if (localStorage.getItem('fleet-signout-pending')) {
          await post('/auth/logout', {});
          localStorage.removeItem('fleet-signout-pending');
        } else accept(s);
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (session) void refresh();
  }, [session?.user.id]);
  useEffect(() => {
    const expire = () =>
      erase('Your session expired. Sign in again. Unsubmitted form details were cleared.');
    const network = () => setOnline(navigator.onLine);
    window.addEventListener('session-expired', expire);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    return () => {
      window.removeEventListener('session-expired', expire);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const active = () => {
      activity.current = Date.now();
    };
    const check = () => {
      if (Date.now() - activity.current > session.settings.sessionMinutes * 60000)
        void signOut('Your session ended after inactivity. Please sign in again.');
    };
    const visible = () => {
      if (document.visibilityState === 'visible') {
        check();
        api<Session>('/auth/me').catch(() => {});
      }
    };
    const restore = (e: PageTransitionEvent) => {
      if (e.persisted) location.reload();
    };
    document.addEventListener('pointerdown', active);
    document.addEventListener('keydown', active);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restore);
    const timer = setInterval(check, 10000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', active);
      document.removeEventListener('keydown', active);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', restore);
    };
  }, [session]);
  async function signOut(note = 'You are signed out. This iPad is ready for the next person.') {
    localStorage.setItem('fleet-signout-pending', '1');
    const request = post('/auth/logout', {});
    erase('Local details cleared. Confirming server sign-out…');
    try {
      await request;
      localStorage.removeItem('fleet-signout-pending');
      setMessage(note);
    } catch {
      setMessage(
        'Local details cleared. Connect to the network before handing over this iPad; server sign-out is pending.',
      );
    }
  }
  function navigate(next: Page) {
    if (workflow && !window.confirm('Leave and clear this unfinished inspection?')) return;
    setWorkflow(null);
    setDetail(null);
    setPage(next);
    setSearch('');
    setFilter('all');
    void refresh();
  }
  if (loading)
    return (
      <div className="loading-screen">
        <CarFront size={35} />
        <p>Opening fleet workspace…</p>
      </div>
    );
  if (!session) return <Login onSession={accept} message={message} />;
  const { user, settings } = session;
  const available = vehicles.filter((v) => v.status === 'available').length;
  const active = trips.filter((t) => t.status === 'active' || t.status === 'pending_checkout');
  const filtered = vehicles.filter(
    (v) =>
      (filter === 'all' || v.status === filter) &&
      [v.name, v.make, v.model, v.plate, v.vinLast4, v.site]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const history = trips.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'overdue' && t.overdue) ||
        t.status === filter ||
        (filter === 'flagged' && t.flags.length > 0)) &&
      [
        t.id,
        t.vehicleSnapshot.name,
        t.vehicleSnapshot.plate,
        t.employeeSnapshot.name,
        t.checkoutAt,
        t.status,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('fleet');
          }}
        >
          <>
            {settings.logoUrl ? (
              <img className="brand-logo" src={settings.logoUrl} alt="" />
            ) : (
              <span className="brand-mark">
                L4L<span>↗</span>
              </span>
            )}
          </>
          <span>
            {settings.organizationName}
            <small>FLEET CHECKOUT</small>
          </span>
        </a>
        <div className="site-label">
          <span className="small-dot" />
          {settings.site}
        </div>
        <nav aria-label="Main navigation">
          {(
            [
              ['fleet', LayoutGrid, 'Vehicle fleet'],
              ['trips', ClipboardList, 'Trip history'],
              ...(user.role === 'admin' ? [['admin', Settings2, 'Administration']] : []),
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key as string}
              className={page === key ? 'nav-link selected' : 'nav-link'}
              onClick={() => navigate(key as Page)}
            >
              <Icon size={20} />
              <span>{label as string}</span>
              {key === 'fleet' && <b>{vehicles.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-help">
          <ShieldCheck size={24} />
          <strong>Your account. Your signature.</strong>
          <p>Inspection records are linked to the person signed in.</p>
          <button
            className="text-button"
            onClick={() => {
              setDetail(null);
              setWorkflow(null);
              setPage('trips');
              setFilter('active');
            }}
          >
            View your active trips <ArrowRight size={14} />
          </button>
        </div>
        <div className="user-profile">
          <span className="avatar">
            {user.name
              .split(' ')
              .map((s) => s[0])
              .slice(0, 2)
              .join('')}
          </span>
          <div>
            <strong>{user.name}</strong>
            <small>{humanize(user.role)}</small>
          </div>
          <button className="icon-button" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut size={19} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>{settings.appName}</span>
          <div>
            <span className={`connection ${online ? '' : 'offline'}`}>
              <i />
              {online ? 'Connected' : 'Offline — drafts only'}
            </span>
            <button
              className="icon-button"
              aria-label="Refresh fleet"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw size={17} className={busy ? 'spin' : ''} />
            </button>
            <button
              className="mobile-signout icon-button"
              aria-label="Sign out of shared iPad"
              onClick={() => void signOut()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main className="workspace">
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="notice success" role="status">
              {message}
              <button className="text-button" onClick={() => setMessage('')}>
                Dismiss
              </button>
            </div>
          )}
          {!online && (
            <div className="notice warning">
              Keep this page open. Reconnect and explicitly retry uploads or submissions. Checkout
              and return need server confirmation.
            </div>
          )}
          {workflow ? (
            <Workflow
              {...workflow}
              user={user}
              settings={settings}
              onClose={() => {
                setWorkflow(null);
                void refresh();
              }}
              onComplete={(trip) => {
                setWorkflow(null);
                setDetail(trip.id);
                setMessage(
                  trip.status === 'returned'
                    ? 'Return recorded. Vehicle availability is shown separately.'
                    : trip.status === 'pending_checkout'
                      ? 'Inspection saved. Wait for representative approval before taking the vehicle.'
                      : 'Checkout confirmed. Your vehicle is ready to use.',
                );
                void refresh();
              }}
            />
          ) : detail ? (
            <TripView
              id={detail}
              user={user}
              settings={settings}
              onBack={() => setDetail(null)}
              onReturn={(trip) => {
                setWorkflow({ vehicle: trip.vehicleSnapshot, trip });
                setDetail(null);
              }}
              onChanged={() => void refresh()}
            />
          ) : page === 'admin' && user.role === 'admin' ? (
            <Admin
              settings={settings}
              onSettings={(settings) => accept({ ...session, settings })}
              onChanged={() => void refresh()}
            />
          ) : page === 'fleet' ? (
            <section className="page-enter">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">FLEET WORKSPACE</p>
                  <h1>Find your next vehicle.</h1>
                  <p>Select the exact vehicle, then complete a quick inspection.</p>
                </div>
                <span className="today">
                  {new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    weekday: 'short',
                    timeZone: settings.timezone,
                  }).format(new Date())}
                </span>
              </div>
              <div className="fleet-metrics">
                <div>
                  <span>Ready to go</span>
                  <strong>
                    {available}
                    <small>available vehicles</small>
                  </strong>
                </div>
                <div>
                  <span>On the road</span>
                  <strong>
                    {vehicles.filter((v) => v.status === 'checked_out').length}
                    <small>checked out</small>
                  </strong>
                </div>
                <div>
                  <span>Needs attention</span>
                  <strong>
                    {
                      vehicles.filter((v) =>
                        ['pending_review', 'out_of_service'].includes(v.status),
                      ).length
                    }
                    <small>held for review</small>
                  </strong>
                </div>
              </div>
              {active.some((t) => t.employeeId === user.id) && (
                <div className="active-banner">
                  <Clock3 size={25} />
                  <div>
                    <strong>You have an open checkout</strong>
                    <p>Return the vehicle through its original trip record.</p>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => setDetail(active.find((t) => t.employeeId === user.id)!.id)}
                  >
                    Open my trip <ArrowRight size={16} />
                  </button>
                </div>
              )}
              <div className="list-toolbar">
                <div className="segmented" aria-label="Vehicle availability filter">
                  {[
                    ['all', 'All vehicles'],
                    ['available', 'Available'],
                    ['pending_review', 'Needs review'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setFilter(value)}
                      className={filter === value ? 'selected' : ''}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="search-input">
                  <Search size={18} />
                  <input
                    placeholder="Search vehicle, plate or site"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search vehicles"
                  />
                </label>
              </div>
              <div className="list-heading">
                <span>VEHICLE / LOCATION</span>
                <span>ODOMETER</span>
                <span>AVAILABILITY</span>
                <span />
              </div>
              {!filtered.length ? (
                <div className="empty-state">
                  <CarFront size={48} strokeWidth={1} />
                  <h2>{vehicles.length ? 'No vehicles match' : 'Your fleet starts here'}</h2>
                  <p>
                    {vehicles.length
                      ? 'Try another search or availability filter.'
                      : 'An administrator can add vehicles, photographs and accepted odometer readings.'}
                  </p>
                  {user.role === 'admin' && !vehicles.length && (
                    <button className="button primary" onClick={() => navigate('admin')}>
                      Add your first vehicle <ArrowRight size={18} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="vehicle-list">
                  {filtered.map((v) => (
                    <article key={v.id} className="vehicle-row">
                      <div className="vehicle-identity">
                        <div className="vehicle-image">
                          {v.photoUrl ? (
                            <img src={v.photoUrl} alt={v.name} />
                          ) : (
                            <CarFront size={54} strokeWidth={1} />
                          )}
                        </div>
                        <div>
                          <span className="vehicle-site">{v.site}</span>
                          <h2>{v.name}</h2>
                          <p>
                            {v.year} {v.make} {v.model}
                          </p>
                          <small>
                            {v.plate} <span>·</span> VIN •••• {v.vinLast4}
                          </small>
                        </div>
                      </div>
                      <div className="vehicle-mileage">
                        <strong>{miles(v.currentMileage)}</strong>
                        <span>miles</span>
                      </div>
                      <Status value={v.status} />
                      <button
                        className="button secondary"
                        disabled={v.status !== 'available' || !user.authorizedDriver || !online}
                        onClick={() => setWorkflow({ vehicle: v })}
                      >
                        Check out <ArrowRight size={17} />
                      </button>
                    </article>
                  ))}
                </div>
              )}
              {!user.authorizedDriver && (
                <div className="notice neutral">
                  <ShieldCheck size={20} />
                  Your account can view the fleet. Ask an administrator to authorize you as a driver
                  before checkout.
                </div>
              )}
              <div className="list-footer">
                <span>{filtered.length} vehicles shown</span>
                <span>Always verify the plate and VIN before checkout.</span>
              </div>
            </section>
          ) : (
            <section className="page-enter">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">INSPECTION RECORDS</p>
                  <h1>Trip history</h1>
                  <p>
                    {user.role === 'admin'
                      ? 'All fleet trips and signed inspections.'
                      : 'Your checkouts, linked returns and completed forms.'}
                  </p>
                </div>
                {user.role === 'admin' && (
                  <a className="button secondary" href="/api/admin/export.csv">
                    Export CSV
                  </a>
                )}
              </div>
              <div className="list-toolbar">
                <select
                  aria-label="Trip status"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  {[
                    'all',
                    'active',
                    'pending_checkout',
                    'returned',
                    'overdue',
                    'flagged',
                    'cancelled',
                  ].map((s) => (
                    <option value={s} key={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </select>
                <label className="search-input">
                  <Search size={18} />
                  <input
                    aria-label="Search trip history"
                    placeholder="Search vehicle, employee, date (YYYY-MM-DD)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="trip-list">
                {history.map((t) => (
                  <button className="trip-row" key={t.id} onClick={() => setDetail(t.id)}>
                    <span className="trip-icon">
                      <CarFront size={24} />
                    </span>
                    <div>
                      <strong>{t.vehicleSnapshot.name}</strong>
                      <p>
                        {t.employeeSnapshot.name} · {formatDate(t.checkoutAt, settings.timezone)}
                      </p>
                      <small>{t.id.slice(0, 8)}</small>
                    </div>
                    <span>
                      {t.tripMileage === null || t.tripMileage === undefined
                        ? `${miles(t.startingMileage)} mi start`
                        : `${miles(t.tripMileage)} mi trip`}
                    </span>
                    <Status value={t.status} overdue={t.overdue} />
                    {t.flags.length > 0 && (
                      <TriangleAlert size={19} aria-label="Flagged inspection" />
                    )}
                    <ChevronRight size={20} />
                  </button>
                ))}
                {!history.length && (
                  <div className="empty-state">
                    <ClipboardList size={42} />
                    <h2>No trips to show</h2>
                    <p>Completed and active checkouts will appear here.</p>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
        <footer className="workspace-footer">
          <span>{settings.organizationName} · Fleet operations</span>
          <span>
            Private staff workspace <ShieldCheck size={13} />
          </span>
        </footer>
      </div>
    </div>
  );
}
