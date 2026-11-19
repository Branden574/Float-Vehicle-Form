import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, validate } from './validation.js';
import { now } from './store.js';

const timestamp = z.iso.datetime({ offset: true });
const period = z.object({ start: timestamp, end: timestamp });
const managerEmails = (settings) =>
  settings.reservationManagerEmails?.length
    ? settings.reservationManagerEmails
    : settings.returnReviewerEmails || [];
const isManager = (user, settings) =>
  user.role === 'admin' || managerEmails(settings).includes(user.email.toLowerCase());
const relation =
  'SELECT r.*,v.name AS vehicle_name,v.site AS site, t.status AS trip_status FROM reservations r JOIN vehicles v ON v.id=r.vehicle_id LEFT JOIN trips t ON t.id=r.trip_id';
const get = (store, id) => store.db.prepare(relation + ' WHERE r.id=?').get(id);
function range(input, future = false) {
  const data = validate(period, input);
  const start = new Date(data.start),
    end = new Date(data.end);
  if (end <= start || end - start > 366 * 86400000)
    fail(400, 'Choose a return after pickup and a period of up to one year.');
  if (future && (start.getTime() < Date.now() || end.getTime() > Date.now() + 366 * 86400000))
    fail(400, 'Choose a future pickup and a return within the next year.');
  return [start.toISOString(), end.toISOString()];
}
async function describe(store, row, user, settings) {
  const mine = row.owner_id === user.id,
    manager = isManager(user, settings),
    visible = mine || manager;
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicle: row.vehicle_name,
    site: row.site,
    start: row.starts_at,
    end: row.ends_at,
    status:
      row.status === 'picked_up'
        ? { pending_checkout: 'pending_checkout', cancelled: 'rejected', returned: 'returned' }[
            row.trip_status
          ] || 'picked_up'
        : row.status,
    mine,
    canCancel: visible && row.status === 'reserved',
    ...(visible
      ? {
          owner: (await store.getUser(row.owner_id))?.name || 'Former staff member',
          canceledAt: row.canceled_at,
          canceledBy: row.canceled_by ? (await store.getUser(row.canceled_by))?.name : null,
          reason: row.reason_json ? store.decodeJSON(row.reason_json) : null,
        }
      : {}),
  };
}
async function availability(store, start, end, site = '', vehicleId = '') {
  const { db } = store;
  const vehicles = await db
    .prepare(
      "SELECT id,name,site,status FROM vehicles WHERE archived=0 AND (?='' OR site=?) AND (?='' OR id=?) ORDER BY name",
    )
    .all(site, site, vehicleId, vehicleId);
  const slots = await db
    .prepare(
      "SELECT DISTINCT vehicle_id FROM reservations WHERE status='reserved' AND starts_at<? AND ends_at>?",
    )
    .all(end, start);
  const reserved = new Set(slots.map((r) => r.vehicle_id));
  const open = await db
    .prepare(
      "SELECT vehicle_id,checkout_at,projected_return_at,status FROM trips WHERE status IN ('active','pending_checkout')",
    )
    .all();
  const byVehicle = new Map(open.map((t) => [t.vehicle_id, t]));
  return vehicles.map((v) => {
    let state = 'available';
    const trip = byVehicle.get(v.id);
    if (v.status === 'out_of_service') state = 'out_of_service';
    else if (
      trip &&
      (Date.parse(trip.projected_return_at) <= Date.now() ||
        (Date.parse(start) < Date.parse(trip.projected_return_at) &&
          Date.parse(end) > Date.parse(trip.checkout_at)))
    )
      state = trip.status === 'active' ? 'checked_out' : 'pending_review';
    else if (!trip && v.status !== 'available') state = v.status;
    else if (reserved.has(v.id)) state = 'reserved';
    return { id: v.id, name: v.name, site: v.site, status: state, currentStatus: v.status };
  });
}
// Both booking and pickup call this inside the same serialized fleet transaction.
export async function checkReservedPickup(store, user, vehicleId, start, end, reservationId) {
  if (reservationId) {
    const r = await get(store, reservationId);
    if (!r || r.owner_id !== user.id || r.vehicle_id !== vehicleId)
      fail(403, 'Choose your own reservation for this vehicle.');
    if (r.status !== 'reserved') fail(409, 'This reservation is no longer available for pickup.');
    if (start < r.starts_at || start >= r.ends_at)
      fail(409, 'Start the inspection during the reserved pickup period.');
  }
  const conflict = await store.db
    .prepare(
      "SELECT id FROM reservations WHERE vehicle_id=? AND status='reserved' AND starts_at<? AND ends_at>? AND id<>? LIMIT 1",
    )
    .get(vehicleId, new Date(end).toISOString(), start, reservationId || '');
  if (conflict)
    fail(
      409,
      'This vehicle is reserved during the trip. Choose another vehicle or return time, or open your booking in Vehicle calendar.',
    );
}
export function installReservations(app, store) {
  const { db } = store;
  app.get('/api/availability', async (req, res) => {
    const [start, end] = range(req.query);
    res.json({
      vehicles: await availability(
        store,
        start,
        end,
        String(req.query.site || ''),
        String(req.query.vehicleId || ''),
      ),
    });
  });
  app.get('/api/reservations', async (req, res) => {
    const [start, end] = range(req.query),
      settings = await store.getSettings(),
      site = String(req.query.site || ''),
      vehicle = String(req.query.vehicleId || '');
    const canceled = req.query.canceled === 'true',
      manager = isManager(req.user, settings);
    const rows = await db
      .prepare(
        relation +
          " WHERE r.starts_at<? AND r.ends_at>? AND (?='' OR v.site=?) AND (?='' OR v.id=?) AND (r.status='reserved' OR (r.status='canceled' AND ?=1 AND (r.owner_id=? OR ?=1))) ORDER BY r.starts_at",
      )
      .all(
        end,
        start,
        site,
        site,
        vehicle,
        vehicle,
        Number(canceled),
        req.user.id,
        Number(manager),
      );
    const trips = await db
      .prepare(
        "SELECT t.id,t.vehicle_id,v.name,v.site,t.status,t.checkout_at,t.projected_return_at,t.returned_at,t.employee_id FROM trips t JOIN vehicles v ON v.id=t.vehicle_id WHERE t.checkout_at<? AND (t.status IN ('pending_checkout','active') OR (t.status='returned' AND t.returned_at>?)) AND (?='' OR v.site=?) AND (?='' OR v.id=?)",
      )
      .all(end, start, site, site, vehicle, vehicle);
    const physical = trips
      .map((t) => ({
        id: t.id,
        vehicleId: t.vehicle_id,
        vehicle: t.name,
        site: t.site,
        start: t.checkout_at,
        end: t.returned_at || new Date(t.projected_return_at).toISOString(),
        status: t.status,
        mine: t.employee_id === req.user.id,
        canCancel: false,
        ongoing: !t.returned_at && Date.parse(t.projected_return_at) <= Date.now(),
      }))
      .filter((t) => t.ongoing || t.end > start);
    const events = await Promise.all(rows.map((r) => describe(store, r, req.user, settings)));
    res.json({ events: [...events, ...physical].sort((a, b) => a.start.localeCompare(b.start)) });
  });
  app.get('/api/my-reservations', async (req, res) => {
    const settings = await store.getSettings();
    const rows = await db
      .prepare(
        relation +
          " WHERE r.owner_id=? AND r.status='reserved' AND r.ends_at>? ORDER BY r.starts_at",
      )
      .all(req.user.id, now());
    res.json({
      events: await Promise.all(rows.map((r) => describe(store, r, req.user, settings))),
    });
  });
  app.get('/api/reservations/:id', async (req, res) => {
    const r = await get(store, req.params.id),
      settings = await store.getSettings();
    if (
      !r ||
      (r.status !== 'reserved' && r.owner_id !== req.user.id && !isManager(req.user, settings))
    )
      fail(404, 'Reservation unavailable.');
    res.json(await describe(store, r, req.user, settings));
  });
  app.post('/api/reservations', async (req, res) => {
    const b = validate(period.extend({ id: z.uuid(), vehicleId: z.uuid() }).strict(), req.body);
    const [start, end] = range(b);
    const event = await db.transaction(async () => {
      const user = await store.getUser(req.user.id);
      if (!user?.active || !user.authorizedDriver)
        fail(403, 'Driver authorization is required to reserve a vehicle.');
      const existing = await get(store, b.id),
        settings = await store.getSettings();
      if (existing) {
        if (
          existing.owner_id !== user.id ||
          existing.vehicle_id !== b.vehicleId ||
          existing.starts_at !== start ||
          existing.ends_at !== end
        )
          fail(409, 'This request has already been used.');
        return describe(store, existing, user, settings);
      }
      range(b, true);
      const [v] = await availability(store, start, end, '', b.vehicleId);
      if (!v) fail(404, 'Vehicle unavailable.');
      if (v.status !== 'available')
        fail(
          409,
          'This vehicle is no longer available for that period. Choose another vehicle or time.',
        );
      await db
        .prepare(
          "INSERT INTO reservations(id,vehicle_id,owner_id,starts_at,ends_at,created_at,status) VALUES(?,?,?,?,?,?,'reserved')",
        )
        .run(b.id, b.vehicleId, user.id, start, end, now());
      return describe(store, await get(store, b.id), user, settings);
    })();
    res.status(201).json(event);
  });
  app.post('/api/reservations/:id/cancel', async (req, res) => {
    const { reason } = validate(
      z.object({ reason: z.string().trim().max(400).default('') }).strict(),
      req.body,
    );
    const event = await db.transaction(async () => {
      const r = await get(store, req.params.id),
        settings = await store.getSettings();
      if (!r) fail(404, 'Reservation unavailable.');
      if (r.owner_id !== req.user.id && !isManager(req.user, settings))
        fail(403, 'Only the owner or a fleet manager can cancel this reservation.');
      if (r.status === 'canceled') return describe(store, r, req.user, settings);
      if (r.status !== 'reserved')
        fail(409, 'This vehicle has already been checked out. Use the return process.');
      const stamp = now();
      await db
        .prepare(
          "UPDATE reservations SET status='canceled',canceled_at=?,canceled_by=?,reason_json=? WHERE id=? AND status='reserved'",
        )
        .run(stamp, req.user.id, store.encodeJSON(reason), r.id);
      const addresses = new Set(managerEmails(settings));
      if (r.owner_id !== req.user.id) {
        const owner = await store.getUser(r.owner_id);
        if (owner?.active) addresses.add(owner.email);
      }
      for (const email of addresses) {
        const key = store.emailLookup(email);
        const account = await db.prepare('SELECT active FROM users WHERE email=?').get(key);
        if (account?.active === 0) continue;
        await db
          .prepare(
            "INSERT OR IGNORE INTO reservation_notices(id,reservation_id,recipient_key,email_json,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)",
          )
          .run(randomUUID(), r.id, key, store.encodeJSON(email), stamp, stamp);
      }
      return describe(store, await get(store, r.id), req.user, settings);
    })();
    res.json(event);
  });
  app.post('/api/reservation-notices/:id/retry', async (req, res) => {
    const changed = await db
      .prepare(
        "UPDATE reservation_notices SET status='pending',attempts=0 WHERE id=? AND recipient_key=? AND status='failed'",
      )
      .run(req.params.id, store.emailLookup(req.user.email));
    if (!changed.changes) fail(409, 'Only a failed delivery addressed to you can be retried.');
    res.json({ ok: true });
  });
  app.get('/api/reservation-inbox', async (req, res) => {
    const settings = await store.getSettings(),
      key = store.emailLookup(req.user.email);
    const rows = await db
      .prepare(
        'SELECT n.id,n.reservation_id,n.status,n.created_at FROM reservation_notices n WHERE recipient_key=? ORDER BY created_at DESC LIMIT 40',
      )
      .all(key);
    const notices = [];
    for (const n of rows) {
      const r = await get(store, n.reservation_id);
      if (r && (r.owner_id === req.user.id || isManager(req.user, settings)))
        notices.push({
          id: n.id,
          status: n.status,
          event: await describe(store, r, req.user, settings),
        });
    }
    res.json({ notices });
  });
}

export async function deliverReservationNotices(
  store,
  send,
  { provider = process.env.EMAIL_PROVIDER || 'disabled' } = {},
) {
  if (provider === 'disabled') return 0;
  const { db } = store;
  const stamp = now(),
    retry = new Date(Date.now() - 5 * 60000).toISOString(),
    windowStart = new Date(Date.now() - 23 * 3600000).toISOString();
  // A stale SMTP claim may already have been accepted. Resend can safely replay a recent key.
  await db
    .prepare(
      "UPDATE reservation_notices SET status='unknown' WHERE status='sending' AND updated_at<? AND (created_at<? OR ?<>'resend')",
    )
    .run(retry, windowStart, provider);
  const ready =
    "status='pending' OR (status='failed' AND attempts<6 AND updated_at<?) OR (status='sending' AND updated_at<? AND created_at>=? AND ?='resend')";
  const args = [retry, retry, windowStart, provider];
  const rows = await db
    .prepare('SELECT id FROM reservation_notices WHERE ' + ready + ' ORDER BY created_at LIMIT 12')
    .all(...args);
  let count = 0;
  for (const { id } of rows) {
    const mail = await db.transaction(async () => {
      const claim = await db
        .prepare(
          "UPDATE reservation_notices SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND (" +
            ready +
            ')',
        )
        .run(stamp, id, ...args);
      if (!claim.changes) return;
      const n = await db.prepare('SELECT * FROM reservation_notices WHERE id=?').get(id),
        r = await get(store, n.reservation_id),
        settings = await store.getSettings();
      if (!r) return;
      const email = store.decodeJSON(n.email_json),
        owner = await store.getUser(r.owner_id),
        actor = await store.getUser(r.canceled_by);
      const account = await db
        .prepare('SELECT active FROM users WHERE email=?')
        .get(n.recipient_key);
      if (
        account?.active === 0 ||
        (!managerEmails(settings).includes(email) && owner?.email !== email)
      ) {
        await db.prepare('DELETE FROM reservation_notices WHERE id=?').run(id);
        return;
      }
      if (n.payload_json) return store.decodeJSON(n.payload_json);
      const format = (d) =>
        new Intl.DateTimeFormat('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: settings.timezone,
        }).format(new Date(d));
      const reason = r.reason_json ? store.decodeJSON(r.reason_json) : '';
      const payload = {
        to: [email],
        attachments: [],
        messageId: '<fleet-reservation-' + id + '@fleet.local>',
        subject: 'Vehicle reservation canceled | ' + r.vehicle_name,
        text: [
          r.vehicle_name + ' · ' + r.site,
          'Reserved by ' + (owner?.name || 'Former staff member'),
          format(r.starts_at) + ' – ' + format(r.ends_at) + ' (' + settings.timezone + ')',
          'Canceled by ' + (actor?.name || 'Former staff member') + ' on ' + format(r.canceled_at),
          reason && 'Reason: ' + reason,
          'Reservation ' + r.id,
          (process.env.PUBLIC_ORIGIN || 'https://fleetcheckout.app') +
            '/?reservation=' +
            encodeURIComponent(r.id),
        ]
          .filter(Boolean)
          .join('\n'),
      };
      await db
        .prepare('UPDATE reservation_notices SET payload_json=? WHERE id=?')
        .run(store.encodeJSON(payload), id);
      return payload;
    })();
    if (!mail) continue;
    let status;
    try {
      const result = await send(mail);
      status = result?.accepted ? 'accepted' : 'unknown';
    } catch (e) {
      status = e.definiteFailure ? 'failed' : provider === 'resend' ? 'sending' : 'unknown';
    }
    await db
      .prepare(
        "UPDATE reservation_notices SET status=?,updated_at=? WHERE id=? AND status='sending' AND updated_at=?",
      )
      .run(status, now(), id, stamp);
    if (status === 'accepted') count++;
  }
  return count;
}
