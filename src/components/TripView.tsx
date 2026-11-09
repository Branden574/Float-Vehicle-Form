import { DamageDiagram } from './DamageDiagram';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, RefreshCw } from 'lucide-react';
import { api, errorMessage, formatDate, humanize, miles, post, savePrivateFile } from '../api';
import type { Settings, Trip, TripDetail, User } from '../types';
import { Status } from '../App';
import { SignaturePad } from './SignaturePad';
import { viewLabels } from './PhotoCapture';

export function TripView({
  id,
  user,
  settings,
  onBack,
  onReturn,
  onChanged,
}: {
  id: string;
  user: User;
  settings: Settings;
  onBack: () => void;
  onReturn: (t: Trip) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<TripDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [downloading, setDownloading] = useState(false),
    [signature, setSignature] = useState(''),
    [initials, setInitials] = useState(''),
    [reason, setReason] = useState(''),
    [decision, setDecision] = useState('approve'),
    [field, setField] = useState('endingMileage'),
    [value, setValue] = useState(''),
    [replacement, setReplacement] = useState(false),
    [action, setAction] = useState(''),
    [oldReading, setOldReading] = useState(''),
    [newReading, setNewReading] = useState('');
  async function load() {
    try {
      setData(await api<TripDetail>(`/trips/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function download(
    event: React.MouseEvent<HTMLAnchorElement>,
    path: string,
    filename: string,
  ) {
    event.preventDefault();
    if (downloading) return;
    setDownloading(true);
    setError('');
    try {
      await savePrivateFile(path, filename);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await post(path, body);
      setAction('');
      setSignature('');
      setReason('');
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <div>{error || 'Loading inspection…'}</div>;
  const { trip, photos, reviews, revisions, notifications } = data;
  const stage = trip.status === 'pending_checkout' ? 'checkout' : 'return';
  const canReview =
    user.role === 'admin' &&
    user.id !== trip.employeeId &&
    (trip.status === 'pending_checkout' || trip.status === 'returned') &&
    !reviews.some((r) => r.stage === stage);
  const views = [
    ...new Set(['front', 'rear', 'driver', 'passenger', ...photos.map((p) => p.view)]),
  ];
  return (
    <section className="page-enter">
      <button className="text-button back-link" onClick={onBack}>
        <ArrowLeft size={17} /> Back to workspace
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRIP {trip.id.slice(0, 8).toUpperCase()}</p>
          <h1>{trip.vehicleSnapshot.name}</h1>
          <p>
            {trip.employeeSnapshot.name} · {trip.vehicleSnapshot.plate} · VIN{' '}
            {trip.vehicleSnapshot.vinLast4}
          </p>
        </div>
        <Status value={trip.status} overdue={trip.overdue} />
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="trip-detail-actions">
        <a
          className="button secondary"
          href={`/api/trips/${id}/report?stage=checkout`}
          aria-disabled={downloading}
          onClick={(e) =>
            void download(
              e,
              `/api/trips/${id}/report?stage=checkout`,
              data.reportFilenames?.checkout || `fleet-${id}-checkout.pdf`,
            )
          }
        >
          <Download size={17} /> Checkout PDF
        </a>
        {trip.returnedAt && (
          <a
            className="button secondary"
            href={`/api/trips/${id}/report?stage=return`}
            aria-disabled={downloading}
            onClick={(e) =>
              void download(
                e,
                `/api/trips/${id}/report?stage=return`,
                data.reportFilenames?.return || `fleet-${id}-return.pdf`,
              )
            }
          >
            <Download size={17} /> Both forms & photos
          </a>
        )}
        {trip.status === 'active' && trip.employeeId === user.id && (
          <button className="button primary" onClick={() => onReturn(trip)}>
            Return vehicle <ArrowRight size={18} />
          </button>
        )}
        <button className="icon-button" aria-label="Refresh trip" onClick={() => void load()}>
          <RefreshCw size={18} />
        </button>
      </div>
      {downloading && (
        <p role="status" className="fine">
          Preparing your download… Keep this page open.
        </p>
      )}
      {trip.status === 'pending_checkout' && (
        <div className="notice warning">
          Checkout inspection saved. Do not take the vehicle until an administrator approves it.
        </div>
      )}
      {trip.status === 'cancelled' && (
        <div className="notice warning">
          Checkout was declined. The vehicle was placed out of service; this is not a completed
          driving trip.
        </div>
      )}
      {trip.returnedAt && (
        <div className="notice success">
          Physical return recorded. Fleet availability is managed separately from this completed
          trip.
        </div>
      )}
      <div className="review-summary">
        <div>
          <span>Checked out</span>
          <strong>{formatDate(trip.checkoutAt, settings.timezone)}</strong>
          <small>{miles(trip.startingMileage)} miles</small>
        </div>
        <div>
          <span>Expected return</span>
          <strong>{formatDate(trip.projectedReturnAt, settings.timezone)}</strong>
          <small>{settings.timezone}</small>
        </div>
        <div>
          <span>Physical return</span>
          <strong>{formatDate(trip.returnedAt, settings.timezone)}</strong>
          <small>{miles(trip.endingMileage)} miles</small>
        </div>
        <div>
          <span>Trip mileage</span>
          <strong>{miles(trip.tripMileage)} mi</strong>
          <small>Signed original readings</small>
        </div>
      </div>
      {trip.flags.length > 0 && (
        <div className="notice warning">
          <strong>Review flags</strong>
          <ul>
            {trip.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="detail-section">
        <h2>Damage diagrams</h2>
        <div className="damage-comparison">
          {(['checkout', 'return'] as const).map((stage) => {
            const inspection =
              stage === 'checkout' ? trip.checkoutInspection : trip.returnInspection;
            return (
              <div key={stage}>
                <h3>{stage === 'checkout' ? 'Checkout' : 'Return'}</h3>
                {inspection ? (
                  <>
                    <DamageDiagram
                      damage={inspection.damage}
                      baseline={
                        stage === 'return' && inspection.damageScope === 'new'
                          ? trip.checkoutInspection.damage
                          : undefined
                      }
                      label={`${stage} saved damage`}
                    />
                    <ol>
                      {inspection.damage.map((d, i) => (
                        <li key={i}>
                          {d.type} — {d.area}
                          {d.notes ? `: ${d.notes}` : ''}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p>Awaiting return inspection.</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="detail-section">
        <h2>Condition comparison</h2>
        <p>
          Original evidence is private. Device-reported times and watermarks do not prove capture
          time.
        </p>
        <div className="comparison-heading">
          <span>CHECKOUT</span>
          <span>RETURN</span>
        </div>
        {views.map((view) => (
          <div className="comparison-row" key={view}>
            {(['checkout', 'return'] as const).map((s) => (
              <div key={s}>
                <h3>{viewLabels[view] || view}</h3>
                {photos
                  .filter((p) => p.stage === s && p.view === view)
                  .map((p) => (
                    <figure key={p.id}>
                      <a href={p.url} target="_blank" rel="noreferrer">
                        <img src={p.url} alt={`${s} ${viewLabels[view] || view}`} />
                      </a>
                      <figcaption>
                        {p.source === 'camera' ? 'Camera capture' : 'Imported upload'} ·{' '}
                        {p.id.slice(0, 8)}
                        <br />
                        Device reported: {formatDate(p.deviceCapturedAt, settings.timezone)}
                        <br />
                        Server received: {formatDate(p.receivedAt, settings.timezone)}
                        <br />
                        <a
                          href={p.originalUrl}
                          aria-disabled={downloading}
                          onClick={(e) =>
                            void download(
                              e,
                              p.originalUrl,
                              `${p.id}-original.${p.mimeType.split('/')[1]}`,
                            )
                          }
                        >
                          Download original
                        </a>
                      </figcaption>
                    </figure>
                  ))}
                {!photos.some((p) => p.stage === s && p.view === view) && (
                  <div className="missing-photo">
                    {trip.returnedAt ? 'No image for this view' : 'Awaiting return inspection'}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="detail-section">
        <h2>Signatures & representative review</h2>
        <div className="signature-records">
          {(['checkout', 'return'] as const)
            .filter((s) => s === 'checkout' || trip.returnedAt)
            .map((s) => (
              <div key={s}>
                <h3>{s === 'checkout' ? 'Checkout' : 'Check-in'} · employee</h3>
                <img
                  src={s === 'checkout' ? trip.checkoutSignature : trip.returnSignature}
                  alt={`${trip.employeeSnapshot.name} ${s} signature`}
                />
                <p>
                  {trip.employeeSnapshot.name} ·{' '}
                  {formatDate(
                    s === 'checkout' ? trip.checkoutAt : trip.returnedAt,
                    settings.timezone,
                  )}
                </p>
              </div>
            ))}
        </div>
        {reviews.map((r) => (
          <div className="review-record" key={r.id}>
            <strong>
              {humanize(r.stage)} representative · {r.initials}
            </strong>
            <p>
              {r.userSnapshot?.name} · {humanize(r.decision)} ·{' '}
              {formatDate(r.createdAt, settings.timezone)}
            </p>
            <p>{r.reason}</p>
            {r.signature && <img src={r.signature} alt="Representative signature" />}
          </div>
        ))}
        {canReview && (
          <button
            className="button primary"
            onClick={() => {
              setAction(action === 'review' ? '' : 'review');
              setSignature('');
            }}
          >
            Review {stage === 'checkout' ? 'checkout' : 'return'} as {user.name}
          </button>
        )}
        {action === 'review' && (
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(`/trips/${id}/review`, { stage, initials, signature, decision, reason });
            }}
          >
            <label>
              Your representative initials
              <input
                required
                maxLength={12}
                value={initials}
                onChange={(e) => setInitials(e.target.value)}
              />
            </label>
            <label>
              Decision
              <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="approve">Approve / release vehicle</option>
                <option value="out_of_service">
                  {stage === 'checkout'
                    ? 'Decline checkout and take out of service'
                    : 'Keep out of service'}
                </option>
              </select>
            </label>
            <label>
              Review reason
              <textarea
                required
                minLength={5}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <SignaturePad
              value={signature}
              onChange={setSignature}
              label={`${user.name} — representative signature`}
            />
            <button className="button primary" disabled={busy || !signature}>
              Save signed review
            </button>
          </form>
        )}
      </div>
      <div className="detail-section">
        <h2>Documented corrections</h2>
        {trip.odometerReplacement && (
          <div className="notice warning">
            Odometer replacement: {miles(trip.odometerReplacement.oldReading)} →{' '}
            {miles(trip.odometerReplacement.newReading)} miles. {trip.odometerReplacement.reason}
          </div>
        )}
        {user.role === 'admin' && trip.status === 'active' && !trip.odometerReplacement && (
          <details className="action-form">
            <summary>Record an odometer replacement during this trip</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate(`/trips/${id}/odometer-replacement`, {
                  oldReading: Number(oldReading),
                  newReading: Number(newReading),
                  reason,
                });
              }}
            >
              <label>
                Old odometer at replacement
                <input
                  required
                  type="number"
                  min={trip.startingMileage}
                  value={oldReading}
                  onChange={(e) => setOldReading(e.target.value)}
                />
              </label>
              <label>
                New odometer initial reading
                <input
                  required
                  type="number"
                  min={0}
                  value={newReading}
                  onChange={(e) => setNewReading(e.target.value)}
                />
              </label>
              <label>
                Required reason and documentation
                <textarea
                  required
                  minLength={5}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="button primary" disabled={busy}>
                Record replacement for employee acknowledgment
              </button>
            </form>
          </details>
        )}
        <p>
          The original signed readings remain above. Material changes require renewed employee
          acknowledgment.
        </p>
        {revisions.map((r) => (
          <article className="revision" key={r.id}>
            <strong>
              {humanize(r.field)}: {miles(r.originalValue)} → {miles(r.correctedValue)} miles
            </strong>
            <p>{r.reason}</p>
            <p>
              {formatDate(r.createdAt, settings.timezone)} ·{' '}
              {r.odometerReplacement ? 'Odometer replacement exception · ' : ''}
              {r.acknowledgedAt ? 'Acknowledged by employee' : 'Employee acknowledgment pending'}
            </p>
            {!r.acknowledgedAt && user.id === trip.employeeId && (
              <>
                <SignaturePad
                  key={r.id}
                  value={signature}
                  onChange={setSignature}
                  label="Renewed acknowledgment"
                />
                <button
                  className="button primary"
                  disabled={busy || !signature}
                  onClick={() =>
                    void mutate(`/trips/${id}/revisions/${r.id}/acknowledge`, { signature })
                  }
                >
                  Acknowledge this correction
                </button>
              </>
            )}
          </article>
        ))}
        {!revisions.length && <p className="empty-inline">No corrections recorded.</p>}
        {user.role === 'admin' && trip.returnedAt && (
          <button
            className="button secondary"
            onClick={() => setAction(action === 'correction' ? '' : 'correction')}
          >
            Document a mileage correction
          </button>
        )}
        {action === 'correction' && (
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(`/trips/${id}/corrections`, {
                field,
                value: Number(value),
                reason,
                odometerReplacement: replacement,
              });
            }}
          >
            <div className="form-grid">
              <label>
                Reading
                <select value={field} onChange={(e) => setField(e.target.value)}>
                  <option value="endingMileage">Ending mileage</option>
                  <option value="startingMileage">Starting mileage</option>
                </select>
              </label>
              <label>
                Corrected value
                <input
                  required
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            </div>
            <label>
              Required reason
              <textarea
                required
                minLength={5}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={replacement}
                onChange={(e) => setReplacement(e.target.checked)}
              />
              Documented odometer replacement exception
            </label>
            <button className="button primary" disabled={busy}>
              Request employee acknowledgment
            </button>
          </form>
        )}
      </div>
      <div className="detail-section">
        <h2>Form notifications</h2>
        {notifications.map((n) => (
          <div className="notification-row" key={n.id}>
            <span>{n.stage === 'return' ? 'Checkout + check-in' : 'Checkout'} report</span>
            <Status value={n.status} />
            <small>
              {n.error || 'Provider acceptance is separate from confirmed inbox delivery.'}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}
