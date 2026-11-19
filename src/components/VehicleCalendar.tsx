import { useCallback, useEffect, useRef, useState } from 'react';
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
  available: 'Available for this period',
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
  const [mode, setMode] = useState<Mode>(
    () =>
      viewState.current?.mode ??
      (window.matchMedia('(max-width: 740px)').matches ? 'Agenda' : 'Month'),
  );
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
    setEvents(null);
    setReadError('');
    const q = new URLSearchParams({
      start: from,
      end: until,
      site,
      vehicleId: vehicle,
      canceled: String(canceled),
    });
    Promise.all([
      api<{ events: Booking[] }>('/reservations?' + q),
      api<{ events: Booking[] }>('/my-reservations'),
      api<{ notices: Notice[] }>('/reservation-inbox'),
    ])
      .then(([r, m, i]) => {
        if (active) {
          setEvents(r.events);
          setMine(m.events);
          setInbox(i.notices);
        }
      })
      .catch((e) => {
        if (active) setReadError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [from, until, site, vehicle, canceled, revision]);
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
  const eventButton = (r: Booking) => (
    <button type="button" className="booking-event" key={r.id} onClick={() => open(r)}>
      <strong>{r.vehicle}</strong>
      <small>
        {new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: zone,
        }).format(new Date(r.start))}
      </small>
      <span>
        {bookingStatus[r.status]}
        {r.ongoing ? ' · Overdue' : ''}
      </span>
    </button>
  );
  return (
    <section className="calendar-page">
      <h1>Vehicle calendar</h1>
      {success && (
        <p role="status" className="notice">
          {success}
        </p>
      )}
      <div className="calendar-filters">
        <label>
          Site
          <select
            value={site}
            onChange={(e) => {
              invalidate();
              setSite(e.target.value);
              setVehicle('');
            }}
          >
            <option value="">All sites</option>
            {[...new Set(vehicles.map((v) => v.site))].sort().map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Vehicle
          <select
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
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <h2>Check availability</h2>
      <form onSubmit={check}>
        <div className="calendar-filters">
          <label>
            Pickup · {zone}
            <input
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
            Expected return · {zone}
            <input
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
          <button className="button secondary" disabled={checking}>
            {checking ? 'Checking…' : 'Check availability'}
          </button>
        </div>
      </form>
      {result && (
        <div>
          <p>
            {date(result.start, zone)} – {date(result.end, zone)}
          </p>
          {!result.vehicles.some((v) => v.status === 'available') && (
            <p>No vehicles available for the selected dates.</p>
          )}
          {result.vehicles.map((v) => (
            <div className="booking-row" key={v.id}>
              <div>
                <strong>{v.name}</strong>
                <small>
                  {v.site} · {bookingStatus[v.status]}
                </small>
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
        </div>
      )}
      {selection && result && (
        <section data-protect-update className="booking-detail">
          <h3>Reserve {selection.name}</h3>
          <p>
            {date(result.start, zone)} – {date(result.end, zone)} · {zone}
          </p>
          <p>
            {session.user.name} · {session.user.charter}
          </p>
          <div className="action-group">
            <button disabled={busy} className="button primary" onClick={() => void save('reserve')}>
              Reserve vehicle
            </button>
            <button className="text-button" disabled={busy} onClick={() => select(null)}>
              Back
            </button>
          </div>
        </section>
      )}
      {formError && (
        <p role="alert" className="notice warning">
          {formError}
        </p>
      )}
      <h2>Fleet schedule</h2>
      <div className="calendar-controls">
        <div className="action-group">
          {(['Month', 'Week', 'Agenda'] as const).map((v) => (
            <button
              className="button secondary"
              key={v}
              aria-pressed={mode === v}
              onClick={() => setMode(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="action-group">
          <button className="text-button" onClick={() => move(-1)}>
            Previous
          </button>
          <button className="text-button" onClick={() => setDay(today.toString())}>
            Today
          </button>
          <button className="text-button" onClick={() => move(1)}>
            Next
          </button>
        </div>
      </div>
      <h3>
        {mode === 'Month'
          ? focus.toLocaleString('en-US', { month: 'long', year: 'numeric' })
          : first.toLocaleString() + ' – ' + first.add({ days: days - 1 }).toLocaleString()}
      </h3>
      <label className="booking-check">
        <input type="checkbox" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} />{' '}
        Show canceled reservations I can manage
      </label>
      <small>
        Reserved holds a time. Checked out means the vehicle is on a trip. Canceled bookings release
        the time.
      </small>
      {readError ? (
        <div role="alert">
          <p>{readError}</p>
          <button className="button secondary" onClick={refresh}>
            Retry calendar
          </button>
        </div>
      ) : !events ? (
        <p role="status">Loading calendar…</p>
      ) : (
        <>
          {events.length === 0 && <p>No bookings in this period.</p>}
          {mode === 'Agenda' ? (
            events.map((r) => (
              <div className="booking-row" key={r.id}>
                {eventButton(r)}
                <small>
                  {date(r.start, zone)} – {date(r.end, zone)} · {zone}
                </small>
              </div>
            ))
          ) : (
            <div className="calendar-grid" aria-label={mode + ' schedule'}>
              {Array.from({ length: days }, (_, i) => {
                const d = first.add({ days: i }),
                  a = dayStart(d, zone),
                  b = dayStart(d.add({ days: 1 }), zone);
                return (
                  <div className="calendar-day" key={a}>
                    <time dateTime={d.toString()}>
                      {d.toLocaleString('en-US', { weekday: 'short', day: 'numeric' })}
                    </time>
                    {events.filter((r) => r.start < b && (r.ongoing || r.end > a)).map(eventButton)}
                  </div>
                );
              })}
            </div>
          )}
          <h2>My upcoming reservations</h2>
          {!mine.length ? (
            <p>You have no upcoming reservations.</p>
          ) : (
            mine.map((r) => (
              <div key={r.id} className="booking-row">
                {eventButton(r)}
                <small>
                  {date(r.start, zone)} – {date(r.end, zone)}
                </small>
              </div>
            ))
          )}
          {inbox.length > 0 && (
            <>
              <h2>Cancellation notices</h2>
              {inbox.map((n) => (
                <div className="booking-row" key={n.id}>
                  {eventButton(n.event)}
                  <small>Email · {n.status}</small>
                  {n.status === 'failed' && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          await post('/reservation-notices/' + n.id + '/retry', {});
                          refresh();
                        } catch (e) {
                          setFormError(errorMessage(e));
                        }
                      }}
                    >
                      Retry email
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </>
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
            {date(detail.start, zone)} – {date(detail.end, zone)} · {zone}
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
function BookingDialog({ children, close }: { children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="booking-dialog"
      aria-label="Reservation details"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}
