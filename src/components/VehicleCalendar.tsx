import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarSearch,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Search,
  X,
} from 'lucide-react';
import { Temporal } from '@js-temporal/polyfill';
import { api, errorMessage, post } from '../api';
import type { Vehicle, Session } from '../types';

export type Booking = {
  id: string;
  vehicleId: string;
  vehicle: string;
  site: string;
  start: string;
  end: string;
  status: string;
  mine: boolean;
  canCancel: boolean;
  owner?: string;
  reason?: string;
  canceledBy?: string;
  canceledAt?: string;
  ongoing?: boolean;
};
type Availability = {
  id: string;
  name: string;
  site: string;
  status: string;
  currentStatus: string;
};
type Notice = { id: string; status: string; event: Booking };
export const bookingStatus: Record<string, string> = {
  available: 'Available for your selected time',
  reserved: 'Reserved',
  checked_out: 'Currently checked out',
  pending_review: 'Awaiting review',
  pending_checkout: 'Awaiting checkout approval',
  active: 'Checked out',
  returned: 'Returned',
  out_of_service: 'Out of service',
  canceled: 'Canceled',
  picked_up: 'Picked up',
  rejected: 'Checkout declined',
};
type Mode = 'Month' | 'Week' | 'Agenda';
const date = (instant: string, zone: string) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(new Date(instant));
type Occurrence = 'earlier' | 'later';
export type CalendarViewState = {
  day: string;
  mode: Mode;
  site: string;
  vehicle: string;
  start: string;
  end: string;
  pickupOccurrence: Occurrence;
  returnOccurrence: Occurrence;
};
function localChoices(value: string, zone: string) {
  if (!value) return [];
  try {
    const local = Temporal.PlainDateTime.from(value);
    const choices = (['earlier', 'later'] as const).map((disambiguation) =>
      local.toZonedDateTime(zone, { disambiguation }),
    );
    return choices.filter(
      (d, i) => d.toPlainDateTime().equals(local) && (i === 0 || !choices[0].equals(d)),
    );
  } catch {
    return [];
  }
}
function toInstant(value: string, zone: string, occurrence: Occurrence) {
  const options = localChoices(value, zone);
  if (!options.length) throw Error('Choose an existing local time.');
  return options[occurrence === 'later' ? options.length - 1 : 0]
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}
function ClockOccurrence({
  value,
  zone,
  label,
  occurrence,
  change,
}: {
  value: string;
  zone: string;
  label: string;
  occurrence: Occurrence;
  change: (value: Occurrence) => void;
}) {
  const choices = localChoices(value, zone);
  if (choices.length < 2) return null;
  return (
    <label>
      {label} clock change
      <select value={occurrence} onChange={(e) => change(e.target.value as Occurrence)}>
        <option value="earlier">First occurrence (UTC{choices[0].offset})</option>
        <option value="later">Second occurrence (UTC{choices[1].offset})</option>
      </select>
    </label>
  );
}
function savedMode(): Mode {
  try {
    const m = localStorage.getItem('fleet-calendar-view');
    if (m === 'Week' || m === 'Agenda') return m;
  } catch {
    /* System storage may be unavailable. */
  }
  return 'Month';
}
const dayStart = (day: Temporal.PlainDate, z: string) =>
  day.toZonedDateTime(z).toInstant().toString({ smallestUnit: 'millisecond' });
export function VehicleCalendar({
  session,
  vehicles,
  onPickup,
  viewState,
}: {
  viewState: React.MutableRefObject<CalendarViewState | undefined>;
  session: Session;
  vehicles: Vehicle[];
  onPickup: (v: Vehicle, r: Booking) => void;
}) {
  const zone = session.settings.timezone;
  const today = Temporal.Now.plainDateISO(zone);
  const [day, setDay] = useState(viewState.current?.day ?? today.toString());
  const [mode, setMode] = useState<Mode>(() => viewState.current?.mode ?? savedMode());
  const [panel, setPanel] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('fleet-calendar-view', mode);
    } catch {}
  }, [mode]);
  const [site, setSite] = useState(viewState.current?.site ?? ''),
    [vehicle, setVehicle] = useState(viewState.current?.vehicle ?? ''),
    [canceled, setCanceled] = useState(false);
  const [start, setStart] = useState(viewState.current?.start ?? ''),
    [end, setEnd] = useState(viewState.current?.end ?? ''),
    [selection, select] = useState<Availability | null>(null);
  const [pickupOccurrence, setPickupOccurrence] = useState<Occurrence>(
    viewState.current?.pickupOccurrence ?? 'earlier',
  );
  const [returnOccurrence, setReturnOccurrence] = useState<Occurrence>(
    viewState.current?.returnOccurrence ?? 'earlier',
  );
  useEffect(() => {
    viewState.current = {
      day,
      mode,
      site,
      vehicle,
      start,
      end,
      pickupOccurrence,
      returnOccurrence,
    };
  }, [viewState, day, mode, site, vehicle, start, end, pickupOccurrence, returnOccurrence]);
  const [detail, setDetail] = useState<Booking | null>(null),
    [cancel, askCancel] = useState(false),
    [reason, setReason] = useState('');
  const [result, setResult] = useState<{
    vehicles: Availability[];
    start: string;
    end: string;
  } | null>(null);
  const [events, setEvents] = useState<Booking[] | null>(null),
    [mine, setMine] = useState<Booking[]>([]),
    [inbox, setInbox] = useState<Notice[]>([]);
  const [readError, setReadError] = useState(''),
    [formError, setFormError] = useState(''),
    [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [revision, bump] = useState(0);
  const key = useRef(crypto.randomUUID()),
    attempt = useRef(0),
    lock = useRef(false);
  const loadedScope = useRef('');
  const keyboardDay = useRef<string | null>(null);
  const focus = Temporal.PlainDate.from(day),
    month = focus.with({ day: 1 });
  const first =
    mode === 'Month'
      ? month.subtract({ days: month.dayOfWeek % 7 })
      : mode === 'Week'
        ? focus.subtract({ days: focus.dayOfWeek % 7 })
        : focus;
  const days =
    mode === 'Month'
      ? 7 * Math.ceil(((month.dayOfWeek % 7) + month.daysInMonth) / 7)
      : mode === 'Week'
        ? 7
        : 30;
  const from = dayStart(first, zone),
    until = dayStart(first.add({ days }), zone);
  const scopeQuery = new URLSearchParams({
    start: from,
    end: until,
    site,
    vehicleId: vehicle,
    canceled: String(canceled),
  }).toString();
  const refresh = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const id = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    if (loadedScope.current !== scopeQuery) setEvents(null);
    setReadError('');
    Promise.all([
      api<{ events: Booking[] }>('/reservations?' + scopeQuery),
      api<{ events: Booking[] }>('/my-reservations'),
      api<{ notices: Notice[] }>('/reservation-inbox'),
    ])
      .then(([r, m, i]) => {
        if (active) {
          loadedScope.current = scopeQuery;
          setEvents(r.events);
          setMine(m.events);
          setInbox(i.notices);
        }
      })
      .catch((e) => {
        if (active) {
          setEvents(null);
          loadedScope.current = '';
          keyboardDay.current = null;
          setReadError(errorMessage(e));
        }
      });
    return () => {
      active = false;
    };
  }, [scopeQuery, revision]);
  useEffect(() => {
    if (!events || keyboardDay.current !== day || loadedScope.current !== scopeQuery) return;
    document.querySelector<HTMLButtonElement>('[data-calendar-day="' + day + '"]')?.focus();
    keyboardDay.current = null;
  }, [day, events, scopeQuery]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('reservation');
    if (!id) return;
    let alive = true;
    api<Booking>('/reservations/' + encodeURIComponent(id))
      .then((r) => {
        if (alive) setDetail(r);
      })
      .catch((e) => {
        if (alive) setFormError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  function invalidate() {
    attempt.current++;
    setChecking(false);
    setResult(null);
    select(null);
    key.current = crypto.randomUUID();
    setFormError('');
  }
  async function check(e: React.FormEvent) {
    e.preventDefault();
    invalidate();
    const seq = attempt.current;
    setChecking(true);
    try {
      let a, b;
      try {
        a = toInstant(start, zone, pickupOccurrence);
        b = toInstant(end, zone, returnOccurrence);
      } catch {
        throw Error(
          'Choose a valid pickup and return time. The clock skips some local times when daylight saving begins.',
        );
      }
      if (a <= new Date().toISOString() || b <= a)
        throw Error('Choose a future pickup and a later return.');
      const r = await api<{ vehicles: Availability[] }>(
        '/availability?' + new URLSearchParams({ start: a, end: b, site, vehicleId: vehicle }),
      );
      if (seq === attempt.current) setResult({ ...r, start: a, end: b });
    } catch (e) {
      if (seq === attempt.current) setFormError(errorMessage(e));
    } finally {
      if (seq === attempt.current) setChecking(false);
    }
  }
  const checkedStart = result?.start,
    checkedEnd = result?.end;
  const lastRefresh = useRef(revision);
  useEffect(() => {
    if (lastRefresh.current === revision) return;
    lastRefresh.current = revision;
    if (!checkedStart || !checkedEnd) return;
    let active = true;
    const q = new URLSearchParams({
      start: checkedStart,
      end: checkedEnd,
      site,
      vehicleId: vehicle,
    });
    api<{ vehicles: Availability[] }>('/availability?' + q)
      .then(({ vehicles }) => {
        if (active)
          setResult((previous) =>
            previous && previous.start === checkedStart && previous.end === checkedEnd
              ? { ...previous, vehicles }
              : previous,
          );
      })
      .catch((e) => {
        if (active) {
          setResult(null);
          setFormError(errorMessage(e));
        }
      });
    return () => {
      active = false;
    };
  }, [revision, checkedStart, checkedEnd, site, vehicle]);
  function open(r: Booking) {
    setDetail(r);
    askCancel(false);
    setReason('');
    setFormError('');
  }
  async function save(kind: 'reserve' | 'cancel') {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFormError('');
    try {
      if (kind === 'reserve' && result && selection) {
        const r = await post<Booking>('/reservations', {
          id: key.current,
          vehicleId: selection.id,
          start: result.start,
          end: result.end,
        });
        invalidate();
        setPanel(false);
        open(r);
        setDay(Temporal.Instant.from(r.start).toZonedDateTimeISO(zone).toPlainDate().toString());
        setSuccess('Reservation confirmed.');
      } else if (kind === 'cancel' && detail) {
        const r = await post<Booking>('/reservations/' + detail.id + '/cancel', { reason });
        open(r);
        invalidate();
        setSuccess('Reservation canceled. This booking no longer holds the vehicle.');
      }
      refresh();
    } catch (e) {
      setFormError(errorMessage(e));
      refresh();
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  function move(by: number) {
    setDay(
      (mode === 'Month' ? focus.add({ months: by }) : focus.add({ days: by * days })).toString(),
    );
  }
  const friendlyZone =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value || zone.replaceAll('_', ' ');
  const localDay = (instant: string) =>
    Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate();
  const interval = (a: string, b: string) =>
    localDay(a).equals(localDay(b))
      ? date(a, zone) +
        ' – ' +
        new Intl.DateTimeFormat('en-US', { timeZone: zone, timeStyle: 'short' }).format(new Date(b))
      : date(a, zone) + ' – ' + date(b, zone);
  const vehicleName = vehicles.find((v) => v.id === vehicle)?.name || 'All vehicles';
  const chosenEvents = (events || []).filter(
    (r) =>
      r.start < dayStart(focus.add({ days: 1 }), zone) &&
      (r.ongoing || r.end > dayStart(focus, zone)),
  );
  const badge = (status: string) => (
    <span className={'calendar-status cs-' + status}>{bookingStatus[status] || status}</span>
  );
  const eventButton = (r: Booking) => (
    <button type="button" className="schedule-event" key={r.id} onClick={() => open(r)}>
      <span>
        <strong>{r.vehicle}</strong>
        <span>{interval(r.start, r.end)}</span>
        <small>
          {r.site}
          {r.owner ? ' · ' + r.owner : ''}
        </small>
      </span>
      <span>
        {badge(r.status)}
        {r.ongoing && <small>Overdue</small>}
      </span>
    </button>
  );
  const dateText = (d: Temporal.PlainDate, options: Intl.DateTimeFormatOptions) =>
    d.toLocaleString('en-US', options);
  const endDay = first.add({ days: days - 1 });
  const periodText =
    mode === 'Month'
      ? dateText(focus, { month: 'long', year: 'numeric' })
      : new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).formatRange(new Date(from), new Date(dayStart(endDay, zone)));
  const byDate = new Map<string, Booking[]>();
  for (const event of events || []) {
    const key = event.start < from ? first.toString() : localDay(event.start).toString();
    const rows = byDate.get(key) || [];
    rows.push(event);
    byDate.set(key, rows);
  }
  function closePanel() {
    if (!busy) {
      setPanel(false);
      select(null);
      setFormError('');
    }
  }
  return (
    <section className="calendar-page">
      <h1>Vehicle calendar</h1>
      {success && (
        <p role="status" className="notice success">
          {success}
        </p>
      )}
      <div className="calendar-scope">
        <label>
          <span>Site</span>
          <strong>{site || 'All sites'}</strong>
          <ChevronDown aria-hidden="true" />
          <select
            aria-label="Site"
            value={site}
            onChange={(e) => {
              invalidate();
              const next = e.target.value;
              setSite(next);
              if (next && vehicles.find((v) => v.id === vehicle)?.site !== next) setVehicle('');
            }}
          >
            <option value="">All sites</option>
            {[...new Set(vehicles.map((v) => v.site))].sort().map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Vehicle</span>
          <strong>{vehicleName}</strong>
          <ChevronDown aria-hidden="true" />
          <select
            aria-label="Vehicle"
            value={vehicle}
            onChange={(e) => {
              invalidate();
              setVehicle(e.target.value);
            }}
          >
            <option value="">All vehicles</option>
            {vehicles
              .filter((v) => !site || v.site === site)
              .map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </label>
        {(site || vehicle) && (
          <button
            className="text-button"
            onClick={() => {
              invalidate();
              setSite('');
              setVehicle('');
            }}
          >
            Reset filters
          </button>
        )}
        <button
          className="button primary calendar-open"
          onClick={() => {
            setFormError('');
            setPanel(true);
          }}
        >
          <CalendarSearch size={18} /> Check availability
        </button>
      </div>
      {result && !panel && (
        <button className="checked-summary" onClick={() => setPanel(true)}>
          <Clock3 size={16} /> View results · {interval(result.start, result.end)}{' '}
          <ChevronRight size={16} />
        </button>
      )}
      {!panel && !detail && formError && (
        <p className="notice warning" role="alert">
          {formError}
        </p>
      )}
      <div className="schedule-columns">
        <div className="schedule-surface">
          <div className="schedule-period">
            <h2>{periodText}</h2>
            <div className="schedule-nav">
              <button aria-label="Previous" onClick={() => move(-1)}>
                <ChevronLeft />
              </button>
              <button onClick={() => setDay(today.toString())}>Today</button>
              <button aria-label="Next" onClick={() => move(1)}>
                <ChevronRight />
              </button>
            </div>
          </div>
          <div className="calendar-modes" role="group" aria-label="Calendar view">
            {(['Month', 'Week', 'Agenda'] as const).map((v) => (
              <button key={v} aria-pressed={mode === v} onClick={() => setMode(v)}>
                {v}
              </button>
            ))}
          </div>
          {readError ? (
            <div role="alert">
              <p>{readError}</p>
              <button className="button secondary" onClick={refresh}>
                Retry calendar
              </button>
            </div>
          ) : !events ? (
            <p role="status">Loading calendar…</p>
          ) : mode === 'Agenda' ? (
            <div className="schedule-agenda">
              {!events.length && <p>No bookings in this period.</p>}
              {[...byDate].map(([d, rows]) => (
                <section key={d}>
                  <h3>
                    {dateText(Temporal.PlainDate.from(d), {
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </h3>
                  {rows.map(eventButton)}
                </section>
              ))}
            </div>
          ) : (
            <>
              <div
                className="schedule-dates"
                aria-label={mode + ' schedule'}
                onKeyDown={(e) => {
                  if (!(e.target instanceof HTMLButtonElement)) return;
                  const delta: Record<string, number> = {
                    ArrowRight: 1,
                    ArrowLeft: -1,
                    ArrowUp: -7,
                    ArrowDown: 7,
                    Home: -(focus.dayOfWeek % 7),
                    End: 6 - (focus.dayOfWeek % 7),
                  };
                  if (!(e.key in delta)) return;
                  e.preventDefault();
                  const next = focus.add({ days: delta[e.key] }).toString();
                  keyboardDay.current = next;
                  setDay(next);
                }}
              >
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i} aria-hidden="true" className="weekday">
                    {dateText(first.add({ days: i }), { weekday: 'short' })}
                  </span>
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const d = first.add({ days: i });
                  const iso = d.toString();
                  const a = dayStart(d, zone),
                    b = dayStart(d.add({ days: 1 }), zone);
                  const count = events.filter(
                    (r) => r.start < b && (r.ongoing || r.end > a),
                  ).length;
                  return (
                    <button
                      key={iso}
                      data-calendar-day={iso}
                      tabIndex={iso === day ? 0 : -1}
                      className={
                        'calendar-date' +
                        (d.month !== focus.month && mode === 'Month' ? ' outside' : '') +
                        (iso === today.toString() ? ' calendar-today' : '')
                      }
                      aria-current={iso === today.toString() ? 'date' : undefined}
                      aria-pressed={day === iso}
                      aria-label={
                        dateText(d, { dateStyle: 'full' }) +
                        ', ' +
                        count +
                        (count === 1 ? ' booking' : ' bookings')
                      }
                      onClick={() => setDay(iso)}
                    >
                      <span>{d.day}</span>
                      <i aria-hidden="true" className={count ? 'has-booking' : ''} />
                    </button>
                  );
                })}
              </div>
              <small className="calendar-legend">
                <i /> Dates with bookings
              </small>
            </>
          )}
        </div>
        <div className="schedule-sidebar">
          {!readError && events && (
            <>
              {mode !== 'Agenda' && (
                <section className="day-details">
                  <h2>{dateText(focus, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
                  {chosenEvents.length ? (
                    chosenEvents.map(eventButton)
                  ) : (
                    <p>No bookings on this day.</p>
                  )}
                </section>
              )}
              <details className="calendar-upcoming">
                <summary>My upcoming reservations</summary>
                {mine.length ? mine.map(eventButton) : <p>You have no upcoming reservations.</p>}
              </details>
              {inbox.length > 0 && (
                <section>
                  <h2>Cancellation notices</h2>
                  {inbox.map((n) => (
                    <div key={n.id}>
                      {eventButton(n.event)}
                      <small>Email · {n.status}</small>
                      {n.status === 'failed' && (
                        <button
                          className="text-button"
                          onClick={() =>
                            void post('/reservation-notices/' + n.id + '/retry', {})
                              .then(refresh)
                              .catch((e) => setFormError(errorMessage(e)))
                          }
                        >
                          Retry email
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          <label className="booking-check">
            <input
              type="checkbox"
              checked={canceled}
              onChange={(e) => setCanceled(e.target.checked)}
            />{' '}
            Include canceled reservations
          </label>
        </div>
      </div>
      {panel && (
        <BookingDialog
          name={selection ? 'Reserve vehicle' : 'Check availability'}
          close={closePanel}
        >
          <div className="panel-heading">
            <h2>{selection ? 'Reserve vehicle' : 'Check availability'}</h2>
            <button aria-label="Close" disabled={busy} onClick={closePanel}>
              <X size={21} />
            </button>
          </div>
          {selection && result ? (
            <>
              <h3>{selection.name}</h3>
              <p>{selection.site}</p>
              <p>
                {interval(result.start, result.end)} · {friendlyZone}
              </p>
              <p>
                {session.user.name} · {session.user.charter}
              </p>
              <div className="action-group">
                <button
                  disabled={busy}
                  className="button primary"
                  onClick={() => void save('reserve')}
                >
                  Reserve vehicle
                </button>
                <button className="button secondary" disabled={busy} onClick={() => select(null)}>
                  Back to results
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="panel-scope">
                {site || 'All sites'} · {vehicleName}
              </p>
              <form onSubmit={check} className="availability-form">
                <label>
                  Pickup{' '}
                  <input
                    aria-label={'Pickup · ' + friendlyZone}
                    type="datetime-local"
                    required
                    value={start}
                    onChange={(e) => {
                      invalidate();
                      setStart(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Expected return{' '}
                  <input
                    aria-label={'Expected return · ' + friendlyZone}
                    type="datetime-local"
                    required
                    value={end}
                    onChange={(e) => {
                      invalidate();
                      setEnd(e.target.value);
                    }}
                  />
                </label>
                <ClockOccurrence
                  value={start}
                  zone={zone}
                  label="Pickup"
                  occurrence={pickupOccurrence}
                  change={(v) => {
                    invalidate();
                    setPickupOccurrence(v);
                  }}
                />
                <ClockOccurrence
                  value={end}
                  zone={zone}
                  label="Return"
                  occurrence={returnOccurrence}
                  change={(v) => {
                    invalidate();
                    setReturnOccurrence(v);
                  }}
                />
                <small>
                  <Clock3 size={15} /> Times shown in {friendlyZone}
                </small>
                <button className="button primary" disabled={checking}>
                  <Search size={18} />
                  {checking ? 'Checking…' : 'Check availability'}
                </button>
              </form>
              {result && (
                <section className="calendar-results" aria-label="Availability results">
                  <h3>Results</h3>
                  <p>
                    {interval(result.start, result.end)} · {friendlyZone}
                  </p>
                  {!result.vehicles.some((v) => v.status === 'available') && (
                    <p>
                      {result.vehicles.length
                        ? 'No vehicles available for the selected dates.'
                        : 'No vehicles match these filters.'}
                    </p>
                  )}
                  {result.vehicles.map((v) => (
                    <div className="vehicle-slot" key={v.id}>
                      <div>
                        <strong>{v.name}</strong>
                        <small>{v.site}</small>
                        {badge(v.status)}
                      </div>
                      {v.status === 'available' && session.user.authorizedDriver && (
                        <button
                          className="button secondary"
                          onClick={() => {
                            select(v);
                            key.current = crypto.randomUUID();
                            setFormError('');
                          }}
                        >
                          Select vehicle
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {formError && (
            <p role="alert" className="notice warning">
              {formError}
            </p>
          )}
        </BookingDialog>
      )}
      {detail && (
        <BookingDialog
          key={detail.id}
          close={() => {
            if (!busy) {
              setDetail(null);
              askCancel(false);
            }
          }}
        >
          <h2>{cancel ? 'Cancel reservation?' : detail.vehicle}</h2>
          <p>
            {cancel ? detail.vehicle + ' · ' : ''}
            {bookingStatus[detail.status]} · {detail.site}
          </p>
          <p>
            {interval(detail.start, detail.end)} · {friendlyZone}
          </p>
          {detail.owner && <p>Reserved by {detail.owner}</p>}
          {detail.canceledAt && (
            <p>
              Canceled {date(detail.canceledAt, zone)}
              {detail.canceledBy ? ' by ' + detail.canceledBy : ''}
              {detail.reason ? ' · ' + detail.reason : ''}
            </p>
          )}
          {formError && <p role="alert">{formError}</p>}
          {cancel ? (
            <>
              <p>Canceling releases this vehicle for the dates and times shown.</p>
              <label>
                Reason (optional)
                <textarea
                  maxLength={400}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="action-group">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => askCancel(false)}
                >
                  Keep reservation
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void save('cancel')}
                >
                  Cancel reservation
                </button>
              </div>
            </>
          ) : (
            <div className="action-group">
              {detail.canCancel && (
                <button className="button secondary" onClick={() => askCancel(true)}>
                  Cancel reservation
                </button>
              )}
              {detail.mine &&
                detail.status === 'reserved' &&
                Date.parse(detail.start) <= Date.now() &&
                Date.parse(detail.end) > Date.now() && (
                  <button
                    className="button primary"
                    onClick={() => {
                      const v = vehicles.find((v) => v.id === detail.vehicleId);
                      if (v) onPickup(v, detail);
                    }}
                  >
                    Start checkout inspection
                  </button>
                )}
              <button className="text-button" onClick={() => setDetail(null)}>
                Close
              </button>
            </div>
          )}
        </BookingDialog>
      )}
    </section>
  );
}
function BookingDialog({
  children,
  close,
  name = 'Reservation details',
}: {
  children: React.ReactNode;
  close: () => void;
  name?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  useEffect(() => {
    const title = ref.current?.querySelector('h2');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [name]);
  return (
    <dialog
      ref={ref}
      className="booking-dialog"
      aria-label={name}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}
