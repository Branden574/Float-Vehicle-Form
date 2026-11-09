import { useEffect, useState } from 'react';
import { Plus, Save, ShieldCheck, Upload, X } from 'lucide-react';
import { api, errorMessage, formatDate, humanize, miles, patch, post } from '../api';
import type { Overview, Settings, User, Vehicle } from '../types';
import { Status } from '../App';

type VehicleDraft = Omit<Vehicle, 'id'> & { id?: string };
type UserDraft = Omit<User, 'id'> & { id?: string };
const emptyUser: UserDraft = {
  email: '',
  name: '',
  department: '',
  charter: '',
  manager: '',
  role: 'staff',
  authorizedDriver: false,
  active: true,
};
export function Admin({
  settings,
  onSettings,
  onChanged,
}: {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onChanged: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null),
    [tab, setTab] = useState('vehicles'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [vehicle, setVehicle] = useState<VehicleDraft | null>(null),
    [staff, setStaff] = useState<UserDraft | null>(null),
    [reason, setReason] = useState(''),
    [replacement, setReplacement] = useState(false),
    [invitation, setInvitation] = useState('');
  const [config, setConfig] = useState(settings),
    [recipients, setRecipients] = useState(settings.notificationRecipients.join(', '));
  async function load() {
    try {
      setOverview(await api<Overview>('/admin/overview'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function newVehicle() {
    setReason('');
    setReplacement(false);
    setVehicle({
      name: '',
      make: '',
      model: '',
      year: new Date().getFullYear(),
      plate: '',
      vinLast4: '',
      site: settings.site,
      currentMileage: 0,
      status: 'available',
      photoUrl: '',
      notes: '',
      archived: false,
    });
  }
  async function saveVehicle(e: React.FormEvent) {
    e.preventDefault();
    if (!vehicle) return;
    void perform(async () => {
      const { id, ...body } = vehicle;
      if (id)
        await patch(`/admin/vehicles/${id}`, { ...body, reason, odometerReplacement: replacement });
      else await post('/admin/vehicles', body);
      setVehicle(null);
      setNotice('Vehicle record saved. Historical trip identities are unchanged.');
    });
  }
  async function saveStaff(e: React.FormEvent) {
    e.preventDefault();
    if (!staff) return;
    void perform(async () => {
      const { id, ...body } = staff;
      if (id) await patch(`/admin/users/${id}`, { ...body, reason });
      else {
        const result = await post<{ inviteToken: string }>('/admin/users', body);
        setInvitation(`${location.origin}/#invite=${result.inviteToken}`);
      }
      setStaff(null);
      setNotice('Staff access saved. Share new invitations privately with the intended employee.');
    });
  }
  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    void perform(async () => {
      const result = await patch<{ settings: Settings }>('/admin/settings', {
        ...config,
        notificationRecipients: recipients
          .split(/[\n,;]/)
          .map((s) => s.trim())
          .filter(Boolean),
        reason,
      });
      setConfig(result.settings);
      onSettings(result.settings);
      setReason('');
      setNotice('Organization settings saved.');
    });
  }
  const used = overview?.storage.bytes || 0,
    limit = overview?.storage.limitBytes || 1;
  return (
    <section className="page-enter">
      <div className="page-heading">
        <div>
          <p className="eyebrow">FLEET ADMINISTRATION</p>
          <h1>Keep things running.</h1>
          <p>Manage access, vehicle records and inspection policies.</p>
        </div>
        <ShieldCheck size={32} strokeWidth={1.4} />
      </div>
      <div className="admin-tabs" role="tablist">
        {['vehicles', 'staff', 'settings', 'notifications', 'audit'].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'selected' : ''}
            onClick={() => {
              setTab(value);
              setVehicle(null);
              setStaff(null);
              setError('');
              setReason('');
            }}
          >
            {humanize(value)}
          </button>
        ))}
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      {invitation && (
        <div className="notice warning invitation">
          <div>
            <strong>Private, one-use invitation — expires in 72 hours</strong>
            <p>
              This grants account access. Share it only with the intended employee through your
              approved channel.
            </p>
            <input
              aria-label="Private invitation link"
              readOnly
              value={invitation}
              onFocus={(e) => e.target.select()}
            />
            <button className="text-button" onClick={() => setInvitation('')}>
              Hide invitation
            </button>
          </div>
        </div>
      )}
      {!overview ? (
        <p>Loading administration…</p>
      ) : (
        <>
          {tab === 'vehicles' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Vehicle directory</h2>
                  <p>Archive vehicles to preserve their inspection history.</p>
                </div>
                <button className="button primary" onClick={newVehicle}>
                  <Plus size={18} /> Add vehicle
                </button>
              </div>
              {overview.vehicles.map((v) => (
                <div className="admin-row" key={v.id}>
                  <div>
                    <strong>
                      {v.name}
                      {v.archived ? ' · Archived' : ''}
                    </strong>
                    <p>
                      {v.year} {v.make} {v.model} · {v.plate} · {v.site}
                    </p>
                  </div>
                  <span>{miles(v.currentMileage)} mi</span>
                  <Status value={v.status} />
                  <button
                    className="button secondary compact"
                    onClick={() => {
                      const { id, ...rest } = v;
                      setVehicle({ ...rest, id });
                      setReason('');
                      setReplacement(false);
                    }}
                  >
                    Edit vehicle
                  </button>
                </div>
              ))}
              {!overview.vehicles.length && (
                <p className="empty-inline">
                  Add the first vehicle to make it available to authorized drivers.
                </p>
              )}
              {vehicle && (
                <form className="editor-panel" onSubmit={saveVehicle}>
                  <div className="section-heading">
                    <h2>{vehicle.id ? 'Edit vehicle' : 'Add vehicle'}</h2>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close vehicle editor"
                      onClick={() => setVehicle(null)}
                    >
                      <X />
                    </button>
                  </div>
                  <div className="form-grid">
                    {(
                      [
                        ['name', 'Display name'],
                        ['make', 'Make'],
                        ['model', 'Model'],
                        ['plate', 'License plate / asset ID'],
                        ['vinLast4', 'VIN last four'],
                        ['site', 'Site / location'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          required
                          maxLength={key === 'vinLast4' ? 4 : 200}
                          value={vehicle[key]}
                          onChange={(e) => setVehicle({ ...vehicle, [key]: e.target.value })}
                        />
                      </label>
                    ))}
                    <label>
                      Year
                      <input
                        type="number"
                        required
                        min={1900}
                        max={2200}
                        value={vehicle.year}
                        onChange={(e) => setVehicle({ ...vehicle, year: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      {vehicle.id ? 'Current mileage (correction)' : 'Initial accepted mileage'}
                      <input
                        type="number"
                        inputMode="numeric"
                        required
                        min={0}
                        step={1}
                        value={vehicle.currentMileage}
                        onChange={(e) =>
                          setVehicle({ ...vehicle, currentMileage: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      Availability
                      <select
                        value={vehicle.status}
                        onChange={(e) =>
                          setVehicle({ ...vehicle, status: e.target.value as Vehicle['status'] })
                        }
                      >
                        {[
                          'available',
                          'pending_review',
                          'out_of_service',
                          ...(vehicle.status === 'checked_out' ? ['checked_out'] : []),
                        ].map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Vehicle photograph URL
                      <input
                        type="text"
                        placeholder="HTTPS URL or upload below after saving"
                        value={vehicle.photoUrl}
                        onChange={(e) => setVehicle({ ...vehicle, photoUrl: e.target.value })}
                      />
                    </label>
                  </div>
                  {vehicle.id && (
                    <label className="button secondary file-button">
                      <Upload size={17} /> Upload vehicle photograph
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file)
                            void perform(async () => {
                              const form = new FormData();
                              form.append('file', file);
                              form.append('vehicleId', vehicle.id!);
                              form.append(
                                'reason',
                                reason || 'Vehicle identification photograph updated',
                              );
                              const r = await api<{ photo: { url: string } }>(
                                '/admin/vehicle-images',
                                { method: 'POST', body: form },
                              );
                              setVehicle({ ...vehicle, photoUrl: r.photo.url });
                              setNotice('Vehicle photograph stored privately.');
                            });
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  <label>
                    Vehicle notes
                    <textarea
                      value={vehicle.notes}
                      onChange={(e) => setVehicle({ ...vehicle, notes: e.target.value })}
                    />
                  </label>
                  {vehicle.id && (
                    <>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={vehicle.archived}
                          onChange={(e) => setVehicle({ ...vehicle, archived: e.target.checked })}
                        />
                        Archive vehicle (retains history)
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={replacement}
                          onChange={(e) => setReplacement(e.target.checked)}
                        />
                        This correction documents an odometer replacement
                      </label>
                      <label>
                        Reason for changes
                        <textarea
                          required
                          minLength={5}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                      <p className="fine">
                        Use a trip’s documented correction for changes to signed readings.
                        Master-record changes do not revise historical forms.
                      </p>
                    </>
                  )}
                  <button className="button primary" disabled={busy}>
                    <Save size={17} /> Save vehicle
                  </button>
                </form>
              )}
            </>
          )}
          {tab === 'staff' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Authorized staff</h2>
                  <p>Each person uses an individual account and signature.</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => {
                    setStaff({ ...emptyUser });
                    setReason('');
                    setInvitation('');
                  }}
                >
                  <Plus size={17} /> Invite staff
                </button>
              </div>
              {overview.users.map((u) => (
                <div className="admin-row" key={u.id}>
                  <div>
                    <strong>
                      {u.name}
                      {!u.active ? ' · Inactive' : ''}
                    </strong>
                    <p>
                      {u.email} · {u.department || 'No department'}
                    </p>
                  </div>
                  <span>{humanize(u.role)}</span>
                  <span className="eligibility">
                    {u.authorizedDriver ? 'Authorized driver' : 'No driver access'}
                  </span>
                  <button
                    className="button secondary compact"
                    onClick={() => {
                      setStaff(u);
                      setReason('');
                      setInvitation('');
                    }}
                  >
                    Edit access
                  </button>
                </div>
              ))}
              {staff && (
                <form className="editor-panel" onSubmit={saveStaff}>
                  <div className="section-heading">
                    <h2>{staff.id ? 'Staff access' : 'Invite a staff member'}</h2>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close staff editor"
                      onClick={() => setStaff(null)}
                    >
                      <X />
                    </button>
                  </div>
                  <div className="form-grid">
                    {(
                      [
                        ['name', 'Full name'],
                        ['email', 'Work email'],
                        ['department', 'Department'],
                        ['charter', 'Charter / school'],
                        ['manager', 'Manager'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type={key === 'email' ? 'email' : 'text'}
                          required={key === 'name' || key === 'email'}
                          value={staff[key]}
                          onChange={(e) => setStaff({ ...staff, [key]: e.target.value })}
                        />
                      </label>
                    ))}
                    <label>
                      Role
                      <select
                        value={staff.role}
                        onChange={(e) =>
                          setStaff({ ...staff, role: e.target.value as User['role'] })
                        }
                      >
                        <option value="staff">Staff</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </label>
                  </div>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={staff.authorizedDriver}
                      onChange={(e) => setStaff({ ...staff, authorizedDriver: e.target.checked })}
                    />
                    Authorized float-pool driver
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={staff.active}
                      onChange={(e) => setStaff({ ...staff, active: e.target.checked })}
                    />
                    Account active
                  </label>
                  {staff.id && (
                    <label>
                      Reason for access change
                      <textarea
                        minLength={5}
                        required
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                  )}
                  <div className="row">
                    <button disabled={busy} className="button primary">
                      {staff.id ? 'Save access' : 'Create private invitation'}
                    </button>
                    {staff.id && (
                      <button
                        type="button"
                        disabled={busy || reason.length < 5}
                        className="button secondary"
                        onClick={() =>
                          void perform(async () => {
                            const r = await post<{ inviteToken: string }>(
                              `/admin/users/${staff.id}/invite`,
                              { reason },
                            );
                            setInvitation(`${location.origin}/#invite=${r.inviteToken}`);
                            setNotice(
                              'New one-use invitation created. Active sessions for this account were revoked.',
                            );
                          })
                        }
                      >
                        Reset / renew invitation
                      </button>
                    )}
                  </div>
                </form>
              )}
            </>
          )}
          {tab === 'settings' && (
            <form onSubmit={saveSettings}>
              <div className="section-heading">
                <div>
                  <h2>Organization & policies</h2>
                  <p>Changes apply to future inspections. Signed snapshots remain intact.</p>
                </div>
              </div>
              <div className="form-grid">
                {(
                  [
                    ['appName', 'Application name'],
                    ['organizationName', 'Organization'],
                    ['site', 'Default site'],
                    ['timezone', 'Site timezone'],
                    ['logoUrl', 'Approved logo URL'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      required={key !== 'logoUrl'}
                      value={config[key]}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    />
                  </label>
                ))}
                <label>
                  Brand accent
                  <input
                    type="color"
                    value={config.accentColor}
                    onChange={(e) => setConfig({ ...config, accentColor: e.target.value })}
                  />
                </label>
                <label>
                  Representative workflow
                  <select
                    value={config.reviewMode}
                    onChange={(e) =>
                      setConfig({ ...config, reviewMode: e.target.value as Settings['reviewMode'] })
                    }
                  >
                    <option value="self_service">Self-service employee inspection</option>
                    <option value="representative">Authenticated representative review</option>
                  </select>
                </label>
                <label>
                  Flag trip increases above (miles)
                  <input
                    type="number"
                    required
                    min={1}
                    value={config.largeMileageThreshold}
                    onChange={(e) =>
                      setConfig({ ...config, largeMileageThreshold: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Session inactivity limit (minutes)
                  <input
                    type="number"
                    required
                    min={5}
                    max={120}
                    value={config.sessionMinutes}
                    onChange={(e) =>
                      setConfig({ ...config, sessionMinutes: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Photo storage budget (GiB)
                  <input
                    type="number"
                    required
                    min={0.01}
                    step={0.01}
                    value={Math.round((config.storageLimitBytes / 1024 ** 3) * 100) / 100}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        storageLimitBytes: Math.round(Number(e.target.value) * 1024 ** 3),
                      })
                    }
                  />
                </label>
                <label>
                  Evidence retention policy (days)
                  <input
                    type="number"
                    required
                    min={1}
                    value={config.retentionDays}
                    onChange={(e) =>
                      setConfig({ ...config, retentionDays: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <div className="notice neutral">
                Retention is an administrator policy, not automatic deletion. Export and back up
                evidence, review the policy with your organization, and arrange any approved
                deletion with IT. Storage is never silently cleared.
              </div>
              <h3>Photograph requirements</h3>
              <p>
                Front, rear, driver side and passenger side are always required at checkout and
                return.
              </p>
              <div className="check-grid">
                {['windshield', 'interior', 'odometer', 'receipt', 'wheels'].map((view) => (
                  <label className="check-label" key={view}>
                    <input
                      type="checkbox"
                      checked={config.requiredPhotoViews?.includes(view) || false}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          requiredPhotoViews: e.target.checked
                            ? [...(config.requiredPhotoViews || []), view]
                            : (config.requiredPhotoViews || []).filter((v) => v !== view),
                        })
                      }
                    />
                    Require {view}
                  </label>
                ))}
              </div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.allowPhotoImports}
                  onChange={(e) => setConfig({ ...config, allowPhotoImports: e.target.checked })}
                />
                Allow labeled imported photographs in addition to camera captures
              </label>
              <h3>Completed-form notifications</h3>
              <label>
                Recipient emails (comma separated)
                <textarea
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="Enter approved recipients"
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.employeeCopy}
                  onChange={(e) => setConfig({ ...config, employeeCopy: e.target.checked })}
                />
                Send an optional copy to the employee
              </label>
              <p className="fine">
                IT configures the approved mail provider on the server. No addresses are supplied by
                default. Notifications remain visible when delivery fails.
              </p>
              <label>
                Reason for configuration changes
                <textarea
                  required
                  minLength={5}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="button primary" disabled={busy}>
                <Save size={17} /> Save organization settings
              </button>
            </form>
          )}
          {tab === 'notifications' && (
            <>
              <h2>Report notifications</h2>
              <p>
                Accepted means the provider accepted the message, not that it reached an inbox.
                Unknown sends require provider review before an explicit resend.
              </p>
              {overview.notifications.map((n) => (
                <div className="notification-admin" key={n.id}>
                  <div className="row between">
                    <strong>
                      {n.stage === 'return' ? 'Checkout + check-in' : 'Checkout'} ·{' '}
                      {n.tripId.slice(0, 8)}
                    </strong>
                    <Status value={n.status} />
                  </div>
                  <p>
                    {n.recipients?.join(', ') || 'No recipients configured'} · {n.attempts} attempts
                  </p>
                  {n.error && <p className="inline-error">{n.error}</p>}
                  <p className="fine">
                    {formatDate(n.createdAt, settings.timezone)}
                    {n.acceptedAt
                      ? ` · Accepted ${formatDate(n.acceptedAt, settings.timezone)}`
                      : ''}
                  </p>
                  {!['processing', 'pending', 'awaiting_review'].includes(n.status) && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        const resend = n.status !== 'failed';
                        let reason = '';
                        if (resend) {
                          reason =
                            window.prompt(
                              'Check provider records before resending. Explain why another copy is needed:',
                            ) || '';
                          if (reason.length < 5) return;
                        }
                        void perform(async () => {
                          await post(
                            `/admin/notifications/${n.id}/retry`,
                            resend ? { resend: true, reason } : {},
                          );
                          setNotice('Notification processed. Check its current status below.');
                        });
                      }}
                    >
                      {n.status === 'failed'
                        ? 'Retry failed notification'
                        : 'Explicitly resend report'}
                    </button>
                  )}
                </div>
              ))}
              {!overview.notifications.length && (
                <p className="empty-inline">
                  No notifications yet. Each submitted checkout and return creates one report
                  notification.
                </p>
              )}
            </>
          )}
          {tab === 'audit' && (
            <>
              <h2>Administrative audit</h2>
              <p>Latest 500 changes. Complete audit history is retained in the database backup.</p>
              {overview.audit.map((a) => (
                <details className="audit-row" key={a.id}>
                  <summary>
                    <strong>{humanize(a.action)}</strong>
                    <span>
                      {a.actorName} · {formatDate(a.createdAt, settings.timezone)}
                    </span>
                  </summary>
                  <p>{a.reason}</p>
                  <div className="audit-values">
                    <div>
                      <strong>Before</strong>
                      <pre>{JSON.stringify(a.before, null, 2)}</pre>
                    </div>
                    <div>
                      <strong>After</strong>
                      <pre>{JSON.stringify(a.after, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              ))}
              {!overview.audit.length && (
                <p className="empty-inline">Administrative changes will appear here.</p>
              )}
            </>
          )}
          <div className="storage-panel">
            <div className="row between">
              <strong>Private storage</strong>
              <span>
                {(used / 1024 ** 3).toFixed(2)} / {(limit / 1024 ** 3).toFixed(1)} GiB
              </span>
            </div>
            <progress max={limit} value={Math.min(used, limit)} />
            <p>
              Database, originals, viewing copies and reports. Photo uploads stop at the configured
              budget; existing evidence is retained. Backups require separate capacity.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
