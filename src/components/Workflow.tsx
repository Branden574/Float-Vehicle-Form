import { DamageDiagram } from './DamageDiagram';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Plus,
  Trash2,
} from 'lucide-react';
import { ApiError, errorMessage, formatDate, miles, post } from '../api';
import type { Inspection, Photo, Settings, Trip, User, Vehicle } from '../types';
import { PhotoCapture, requiredViews, viewLabels } from './PhotoCapture';
import { SignaturePad } from './SignaturePad';
const steps = ['Trip details', 'Inspection', 'Photographs', 'Review & sign'];
const areas = ['front', 'rear', 'driver', 'passenger', 'roof', 'interior', 'windshield', 'wheels'];
export function Workflow({
  vehicle,
  trip,
  user,
  settings,
  onClose,
  onComplete,
}: {
  vehicle: Vehicle;
  trip?: Trip;
  user: User;
  settings: Settings;
  onClose: () => void;
  onComplete: (trip: Trip) => void;
}) {
  const returning = !!trip;
  const stage = returning ? 'return' : 'checkout';
  const required = [...new Set([...requiredViews, ...(settings.requiredPhotoViews || [])])];
  const [step, setStep] = useState(0);
  const [draftId] = useState(() => crypto.randomUUID());
  const [due, setDue] = useState('');
  const [mileage, setMileage] = useState(returning ? '' : String(vehicle.currentMileage));
  const [confirmed, setConfirmed] = useState(false);
  const [inspection, setInspection] = useState<Partial<Inspection>>({
    damage: [],
    notes: '',
    ...(returning ? { damageScope: 'new' as const } : {}),
  });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [signature, setSignature] = useState('');
  const [ack, setAck] = useState({
    accurate: false,
    noEating: false,
    removeBelongings: false,
    fullTank: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [discrepancy, setDiscrepancy] = useState(false);
  const [observed, setObserved] = useState('');
  const [discrepancyReason, setDiscrepancyReason] = useState('');
  const submission = useRef<{ key: string; body: unknown } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const employee = trip?.employeeSnapshot || user;
  const start = trip?.startingMileage ?? vehicle.currentMileage;
  const odometer = trip?.odometerReplacement;
  const minimum = odometer?.newReading ?? start;
  const distance = odometer
    ? odometer.oldReading - start + Number(mileage) - odometer.newReading
    : Number(mileage) - start;
  const [replacementAcknowledged, setReplacementAcknowledged] = useState(false);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  function validateStep(index: number) {
    if (index === 0) {
      if (!Number.isSafeInteger(Number(mileage)) || Number(mileage) < 0 || mileage === '')
        return 'Enter a valid whole-number odometer reading.';
      if (returning && Number(mileage) < minimum)
        return 'Ending mileage cannot be below starting mileage. Contact an administrator for an odometer replacement.';
      if (!returning && !confirmed)
        return 'Compare the displayed mileage with the dashboard and confirm it.';
      if (!returning && (!due || new Date(due) <= new Date()))
        return 'Choose a projected return time in the future.';
    }
    if (index === 1) {
      const checks = returning
        ? ['fuelFull', 'interiorClean', 'gasCard', 'receiptReceived', 'keyReturned']
        : ['fuelFull', 'interiorClean', 'gasCard'];
      if (checks.some((key) => typeof inspection[key as keyof Inspection] !== 'boolean'))
        return 'Answer each inspection question with Yes or No.';
      if (!inspection.windshield) return 'Select the windshield condition.';
    }
    if (index === 2 && required.some((view) => !photos.some((photo) => photo.view === view)))
      return 'Store all required photographs before continuing.';
    return '';
  }
  function next() {
    const issue = validateStep(step);
    if (issue) {
      setError(issue);
      return;
    }
    setError('');
    setStep(step + 1);
  }
  async function submit() {
    if (!submission.current) {
      for (let i = 0; i < 3; i++) {
        const issue = validateStep(i);
        if (issue) {
          setStep(i);
          setError(issue);
          return;
        }
      }
      if (!Object.values(ack).every(Boolean)) {
        setError('Read and accept all acknowledgments.');
        return;
      }
      if (odometer && !replacementAcknowledged) {
        setError('Acknowledge the documented odometer replacement.');
        return;
      }
      if (!signature) {
        setError('Add your signature before submitting.');
        return;
      }
      submission.current = {
        key: crypto.randomUUID(),
        body: {
          ...(returning ? {} : { vehicleId: vehicle.id }),
          draftId,
          ...(returning
            ? {
                endingMileage: Number(mileage),
                ...(odometer
                  ? {
                      odometerReplacementId: odometer.id,
                      odometerReplacementAcknowledged: replacementAcknowledged,
                    }
                  : {}),
              }
            : {
                startingMileage: Number(mileage),
                mileageConfirmed: confirmed,
                projectedReturnAt: new Date(due).toISOString(),
              }),
          inspection,
          photoIds: photos.map((photo) => photo.id),
          signature,
          acknowledgments: ack,
        },
      };
    }
    setBusy(true);
    setError('');
    try {
      const result = await post<{ trip: Trip }>(
        returning ? `/trips/${trip.id}/return` : '/trips/checkout',
        submission.current.body,
        { 'Idempotency-Key': submission.current.key },
      );
      onComplete(result.trip);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status > 0 && error.status < 500) {
        submission.current = null;
        setUncertain(false);
      } else setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  async function reportDiscrepancy() {
    if (
      !observed ||
      !Number.isSafeInteger(Number(observed)) ||
      Number(observed) < 0 ||
      !discrepancyReason.trim()
    ) {
      setError('Enter the actual mileage and a reason for review.');
      return;
    }
    setBusy(true);
    try {
      await post(`/vehicles/${vehicle.id}/discrepancy`, {
        observedMileage: Number(observed),
        reason: discrepancyReason,
      });
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function answer(key: keyof Inspection, value: boolean) {
    setInspection((current) => ({ ...current, [key]: value }));
  }
  const checkQuestions: [keyof Inspection, string][] = [
    ['fuelFull', 'Is the fuel tank full?'],
    ['interiorClean', 'Is the interior clean?'],
    ['gasCard', returning ? 'Was the gas card returned?' : 'Was the gas card issued with the key?'],
    ...(returning
      ? ([
          ['receiptReceived', 'Was the fuel receipt received?'],
          ['keyReturned', 'Were the keys returned?'],
        ] as [keyof Inspection, string][])
      : []),
  ];
  return (
    <section className="workflow page-enter">
      <button
        className="text-button back-link"
        disabled={busy}
        onClick={() => {
          if (
            window.confirm(
              'Leave this draft? Unsigned details will be cleared. No checkout or return has been completed.',
            )
          )
            onClose();
        }}
      >
        <ArrowLeft size={17} /> Back to fleet
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{returning ? 'Linked vehicle return' : 'Vehicle checkout'}</p>
          <h1>{returning ? 'Return vehicle' : 'Ready for the road'}</h1>
          <p>
            {vehicle.name} <span className="dot">·</span> {vehicle.plate}{' '}
            <span className="dot">·</span> VIN •••• {vehicle.vinLast4}
          </p>
        </div>
        <span className="draft-label">Draft — not submitted</span>
      </div>
      <ol className="stepper" aria-label="Inspection progress">
        {steps.map((label, index) => (
          <li
            key={label}
            className={step === index ? 'current' : step > index ? 'done' : ''}
            aria-current={step === index ? 'step' : undefined}
          >
            <span>{step > index ? <Check size={17} /> : index + 1}</span>
            <b>{label}</b>
          </li>
        ))}
      </ol>
      <div className="workflow-layout">
        <div className="workflow-main">
          <h2 ref={heading} tabIndex={-1}>
            {steps[step]}
          </h2>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {uncertain && (
            <div className="notice warning">
              The response was interrupted. The server may have saved your submission. Use Retry
              submission to check the same request safely; do not start another inspection.
            </div>
          )}
          <fieldset disabled={busy || uncertain} className="plain-fieldset">
            <div hidden={step !== 0}>
              <div className="identity-strip">
                <div>
                  <span>Employee</span>
                  <strong>{employee.name}</strong>
                </div>
                <div>
                  <span>Department</span>
                  <strong>{employee.department || 'Not set'}</strong>
                </div>
                <div>
                  <span>Charter / school</span>
                  <strong>{employee.charter || 'Not recorded'}</strong>
                </div>
                <div>
                  <span>Email</span>
                  <strong>{employee.email}</strong>
                </div>
                <div>
                  <span>Manager</span>
                  <strong>{employee.manager || 'Not set'}</strong>
                </div>
              </div>
              {returning ? (
                <div className="notice neutral">
                  Checked out {formatDate(trip.checkoutAt, settings.timezone)}. Starting mileage and
                  employee details are linked to the original inspection.
                </div>
              ) : (
                <p className="eligibility">
                  <CheckCircle2 size={18} />
                  {user.authorizedDriver
                    ? 'Authorized float-pool driver'
                    : 'Driver authorization required — contact an administrator'}
                </p>
              )}
              <div className="form-grid">
                <label>
                  {returning ? 'Ending odometer reading' : 'Starting odometer reading'}
                  <div className="input-unit">
                    <input
                      aria-label={
                        returning ? 'Ending odometer reading' : 'Starting odometer reading'
                      }
                      type="number"
                      inputMode="numeric"
                      min={returning ? minimum : 0}
                      step="1"
                      value={mileage}
                      readOnly={!returning}
                      onChange={(event) => setMileage(event.target.value)}
                    />
                    <span>miles</span>
                  </div>
                  <small>
                    {returning
                      ? `Starting mileage: ${miles(start)} mi`
                      : 'Latest accepted reading, supplied by the server.'}
                  </small>
                </label>
                {!returning && (
                  <label>
                    Projected return date and time
                    <input
                      type="datetime-local"
                      aria-label="Projected return date and time"
                      value={due}
                      onChange={(event) => setDue(event.target.value)}
                    />
                    <small>Enter this iPad’s local time. Reports use {settings.timezone}.</small>
                  </label>
                )}
              </div>
              {!returning && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>I compared the dashboard odometer and confirm {miles(start)} miles.</span>
                  </label>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setDiscrepancy(!discrepancy)}
                  >
                    The dashboard reading is different
                  </button>
                  {discrepancy && (
                    <div className="discrepancy-panel">
                      <h3>Request a mileage review</h3>
                      <p>The vehicle will be held for an administrator to verify the reading.</p>
                      <label>
                        Actual dashboard mileage
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          value={observed}
                          onChange={(event) => setObserved(event.target.value)}
                        />
                      </label>
                      <label>
                        Reason / what you observed
                        <textarea
                          value={discrepancyReason}
                          onChange={(event) => setDiscrepancyReason(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={reportDiscrepancy}
                      >
                        Submit discrepancy and hold vehicle
                      </button>
                    </div>
                  )}
                </>
              )}
              {returning && mileage !== '' && Number(mileage) >= minimum && (
                <div className="trip-total">
                  <span>Total trip mileage</span>
                  <strong>
                    {miles(distance)} <small>mi</small>
                  </strong>
                </div>
              )}
            </div>
            <div hidden={step !== 1}>
              <p className="section-intro">
                {returning
                  ? 'Walk around the vehicle and compare it with checkout. Add only new or worsening damage.'
                  : 'Walk around the vehicle and record what you see. Report existing damage as well as new concerns.'}
              </p>
              <div className="inspection-questions">
                {checkQuestions.map(([key, label]) => (
                  <div className="question" key={key}>
                    <span>{label}</span>
                    <div className="yes-no" role="group" aria-label={label}>
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          type="button"
                          className={inspection[key] === value ? 'selected' : ''}
                          aria-pressed={inspection[key] === value}
                          onClick={() => answer(key, value)}
                        >
                          {value ? 'Yes' : 'No'}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <label>
                Windshield condition
                <select
                  value={inspection.windshield || ''}
                  onChange={(event) =>
                    setInspection((current) => ({
                      ...current,
                      windshield: event.target.value as Inspection['windshield'],
                    }))
                  }
                >
                  <option value="" disabled>
                    Select condition
                  </option>
                  <option value="clear">Clear / no damage</option>
                  <option value="star">Star damage</option>
                  <option value="cracked">Cracked</option>
                </select>
              </label>
              <div className="section-heading">
                <div>
                  <h3>{returning ? 'New damage at return' : 'Damage record'}</h3>
                  <p>
                    {returning
                      ? 'Checkout marks remain as a reference. Add only new damage, including a new mark if an existing area has worsened.'
                      : 'Tap the diagram to mark chips, dents or scratches.'}
                  </p>
                </div>
                <button
                  className="button secondary compact"
                  type="button"
                  onClick={() =>
                    setInspection((current) => ({
                      ...current,
                      damage: [
                        ...(current.damage || []),
                        { area: 'front', type: 'chip', notes: '' },
                      ],
                    }))
                  }
                  disabled={(inspection.damage?.length || 0) >= 40}
                >
                  <Plus size={17} /> Add damage
                </button>
              </div>
              <DamageDiagram
                damage={inspection.damage || []}
                baseline={returning ? trip?.checkoutInspection.damage : undefined}
                onChange={(damage) => setInspection((current) => ({ ...current, damage }))}
              />
              {trip && (
                <details>
                  <summary>Compare checkout marks</summary>
                  <DamageDiagram
                    damage={trip.checkoutInspection.damage}
                    label="Checkout damage reference"
                  />
                </details>
              )}
              {!inspection.damage?.length && (
                <p className="empty-inline">No damage marked. Add any damage you observe.</p>
              )}
              {inspection.damage?.map((damage, index) => (
                <div key={index} className="damage-row">
                  <strong>Mark {index + 1}</strong>
                  <label>
                    Area
                    <select
                      value={damage.area}
                      onChange={(event) =>
                        setInspection((current) => ({
                          ...current,
                          damage: current.damage!.map((item, i) =>
                            i === index ? { ...item, area: event.target.value } : item,
                          ),
                        }))
                      }
                    >
                      {areas.map((area) => (
                        <option value={area} key={area}>
                          {viewLabels[area] || area[0].toUpperCase() + area.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Type
                    <select
                      value={damage.type}
                      onChange={(event) =>
                        setInspection((current) => ({
                          ...current,
                          damage: current.damage!.map((item, i) =>
                            i === index
                              ? { ...item, type: event.target.value as 'chip' | 'dent' | 'scratch' }
                              : item,
                          ),
                        }))
                      }
                    >
                      <option value="chip">Chip</option>
                      <option value="dent">Dent</option>
                      <option value="scratch">Scratch</option>
                    </select>
                  </label>
                  <label className="damage-notes">
                    Notes
                    <input
                      placeholder="Location and size"
                      value={damage.notes}
                      onChange={(event) =>
                        setInspection((current) => ({
                          ...current,
                          damage: current.damage!.map((item, i) =>
                            i === index ? { ...item, notes: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove damage ${index + 1}`}
                    onClick={() =>
                      setInspection((current) => ({
                        ...current,
                        damage: current.damage!.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
              <label>
                Inspection notes
                <textarea
                  rows={3}
                  placeholder="Fuel, cleaning, missing items, maintenance or other concerns"
                  value={inspection.notes}
                  onChange={(event) =>
                    setInspection((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </label>
            </div>
            <div hidden={step !== 2}>
              <PhotoCapture
                vehicleId={vehicle.id}
                tripId={trip?.id}
                stage={stage}
                draftId={draftId}
                settings={settings}
                onChange={setPhotos}
              />
            </div>
            <div hidden={step !== 3}>
              <div className="review-summary">
                <div>
                  <span>Vehicle</span>
                  <strong>{vehicle.name}</strong>
                  <small>
                    {vehicle.plate} · VIN {vehicle.vinLast4}
                  </small>
                </div>
                <div>
                  <span>{returning ? 'Trip mileage' : 'Starting mileage'}</span>
                  <strong>{miles(returning ? distance : start)} mi</strong>
                  <small>
                    {returning
                      ? `${miles(start)} → ${miles(Number(mileage))}`
                      : 'Dashboard reading confirmed'}
                  </small>
                </div>
                <div>
                  <span>Photographs</span>
                  <strong>{photos.length} stored</strong>
                  <small>{required.length} required views</small>
                </div>
                <div>
                  <span>{returning ? 'Return time' : 'Projected return'}</span>
                  <strong>
                    {returning
                      ? 'Recorded on submission'
                      : due
                        ? formatDate(new Date(due).toISOString(), settings.timezone)
                        : '—'}
                  </strong>
                  <small>{settings.timezone}</small>
                </div>
              </div>
              <div className="review-inspection">
                {checkQuestions.map(([key, label]) => (
                  <div key={key}>
                    <span>{label}</span>
                    <strong>{inspection[key] ? 'Yes' : 'No'}</strong>
                  </div>
                ))}
                <div>
                  <span>Windshield</span>
                  <strong>{inspection.windshield}</strong>
                </div>
                <div>
                  <span>Damage markings</span>
                  <strong>{inspection.damage?.length || 0}</strong>
                </div>
              </div>
              <DamageDiagram
                damage={inspection.damage || []}
                baseline={returning ? trip?.checkoutInspection.damage : undefined}
                label="Review damage marks"
              />
              {inspection.notes && <p className="notice neutral">{inspection.notes}</p>}
              <div className="notice neutral">
                <ClipboardCheck size={20} />
                <div>
                  {settings.reviewMode === 'representative' ? (
                    <>
                      <strong>Representative review required</strong>
                      <p>
                        An administrator signs with their own account.{' '}
                        {returning
                          ? 'Your physical return is recorded now; availability is decided after review.'
                          : 'Do not take the vehicle until the representative approves checkout.'}
                      </p>
                    </>
                  ) : (
                    <>
                      <strong>Self-service inspection</strong>
                      <p>
                        Representative initials and signature are recorded as not applicable for
                        this workflow.
                      </p>
                    </>
                  )}
                </div>
              </div>
              <h3>Acknowledgments</h3>
              {(
                [
                  ['accurate', 'The information I provided is accurate.'],
                  ['noEating', 'I will not eat in float vehicles.'],
                  [
                    'removeBelongings',
                    'I will remove all belongings and garbage before returning the vehicle.',
                  ],
                  [
                    'fullTank',
                    'I understand that vehicles must be returned with a full fuel tank.',
                  ],
                ] as const
              ).map(([key, label]) => (
                <label className="check-label" key={key}>
                  <input
                    type="checkbox"
                    checked={ack[key]}
                    onChange={(event) =>
                      setAck((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              <>
                {odometer && (
                  <div className="notice warning">
                    <strong>Odometer replacement</strong>
                    <p>
                      Old reading: {miles(odometer.oldReading)} mi. New starting reading:{' '}
                      {miles(odometer.newReading)} mi. {odometer.reason}
                    </p>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={replacementAcknowledged}
                        onChange={(e) => setReplacementAcknowledged(e.target.checked)}
                      />
                      I acknowledge these replacement readings and the adjusted trip calculation.
                    </label>
                  </div>
                )}
              </>
              <SignaturePad
                value={signature}
                onChange={setSignature}
                label={`${employee.name} — employee signature`}
              />
              <p className="fine">
                Signature date and submission time are recorded by the server. Your inspection
                remains a draft until the server confirms it.
              </p>
            </div>
          </fieldset>
          <div className="workflow-actions">
            {step > 0 ? (
              <button
                type="button"
                className="button secondary"
                disabled={busy || uncertain}
                onClick={() => {
                  setError('');
                  setStep(step - 1);
                }}
              >
                <ArrowLeft size={17} /> Back
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button type="button" className="button primary" onClick={next}>
                Continue <ArrowRight size={18} />
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy || (!returning && !user.authorizedDriver)}
                onClick={submit}
              >
                {busy
                  ? 'Confirming with server…'
                  : uncertain
                    ? 'Retry submission'
                    : returning
                      ? 'Submit vehicle return'
                      : 'Submit checkout'}
                <Check size={18} />
              </button>
            )}
          </div>
        </div>
        <aside className="workflow-aside">
          <div className="aside-title">INSPECTION NOTES</div>
          <h3>
            A few moments.
            <br />A clear record.
          </h3>
          <ol>
            <li>Confirm the exact vehicle and dashboard mileage.</li>
            <li>Inspect every side, including existing damage.</li>
            <li>Store all four required photos.</li>
            <li>Sign and wait for confirmation.</li>
          </ol>
          <div className="aside-bottom">
            <span className="small-dot" /> Your draft stays in this open session.
          </div>
          <p className="fine">
            Keep this page open during connection problems. Reloading, signing out or session expiry
            clears unfinished form details. Background syncing is not used.
          </p>
        </aside>
      </div>
    </section>
  );
}
