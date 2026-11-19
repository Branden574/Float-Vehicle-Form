const HOUR = 60 * 60 * 1000;

// Share the return queue's rules: an older inspection must never hold a newer trip.
const eligible = `
  SELECT t.id, CASE WHEN t.status='active' THEN 'driver' ELSE 'reviewer' END AS kind
  FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
  WHERE (t.status='active' AND t.projected_return_at<?)
     OR (t.status='returned' AND t.returned_at<=? AND v.status='pending_review'
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.trip_id=t.id AND r.stage='return')
         AND NOT EXISTS (SELECT 1 FROM trips newer WHERE newer.vehicle_id=t.vehicle_id
                         AND newer.vehicle_mileage_version>t.vehicle_mileage_version))`;

async function recipients(store, trip, kind, settings) {
  const driver = await store.getUser(trip.employeeId);
  if (kind === 'driver') return driver?.active ? [driver.email] : [];
  const assigned = settings.returnReviewerEmails || [];
  const admins = assigned.length
    ? []
    : await store.db.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
  const addresses = assigned.length ? assigned : admins.map((r) => store.publicUser(r).email);
  const result = [];
  for (const address of new Set(addresses.map((v) => v.trim().toLowerCase()))) {
    if (
      address === driver?.email.toLowerCase() ||
      address === trip.employeeSnapshot.email?.toLowerCase()
    )
      continue;
    const account = await store.db
      .prepare('SELECT active FROM users WHERE email=?')
      .get(store.emailLookup(address));
    if (account?.active !== 0) result.push(address);
  }
  return result;
}

export async function sendTripReminders({ store, send, now = Date.now() }) {
  const stamp = new Date(now).toISOString();
  const cutoff = new Date(now - 24 * HOUR).toISOString();
  const rows = await store.db.prepare(eligible).all(stamp, cutoff);
  const settings = await store.getSettings();
  let sent = 0;
  for (const { id, kind } of rows) {
    const trip = await store.getTrip(id);
    if (!trip) continue;
    const addresses = await recipients(store, trip, kind, settings);
    for (const email of addresses) {
      const key = store.emailLookup(email);
      const claim = await store.db.transaction(async () => {
        if (
          !(await store.db
            .prepare('SELECT id FROM (' + eligible + ') due WHERE id=? AND kind=?')
            .get(stamp, cutoff, id, kind))
        )
          return false;
        if (!(await recipients(store, trip, kind, await store.getSettings())).includes(email))
          return false;
        const initial = await store.db
          .prepare(
            "INSERT OR IGNORE INTO trip_reminders(trip_id,kind,recipient_key,status,attempts,updated_at) VALUES(?,?,?,'sending',1,?)",
          )
          .run(id, kind, key, stamp);
        if (initial.changes) return true;
        const retry = await store.db
          .prepare(
            "UPDATE trip_reminders SET status='sending',attempts=attempts+1,updated_at=? WHERE trip_id=? AND kind=? AND recipient_key=? AND status='failed' AND attempts<3 AND updated_at<=?",
          )
          .run(stamp, id, kind, key, new Date(now - HOUR).toISOString());
        return !!retry.changes;
      })();
      if (!claim) continue;
      const vehicle = trip.vehicleSnapshot.name;
      const origin = process.env.PUBLIC_ORIGIN || 'https://fleetcheckout.app';
      const due = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: settings.timezone,
      }).format(new Date(trip.projectedReturnAt));
      let status = 'unknown';
      try {
        const accepted = await send({
          to: [email],
          attachments: [],
          messageId: `<fleet-reminder-${kind}-${id}-${key}@fleet.local>`,
          subject:
            kind === 'driver'
              ? `${settings.appName} | Return reminder for ${vehicle}`
              : `${settings.appName} | Return review reminder for ${vehicle}`,
          text:
            kind === 'driver'
              ? `${vehicle} was due back on ${due} (${settings.timezone}). When you return the vehicle, sign in at ${origin} and open My current checkouts to check it in.`
              : `${vehicle} has been waiting for return review for at least 24 hours. Sign in at ${origin} and open Returns awaiting your review to approve or hold the vehicle.`,
        });
        if (accepted?.accepted) {
          status = 'accepted';
          sent++;
        }
      } catch (error) {
        if (error.definiteFailure) status = 'failed';
      }
      await store.db
        .prepare(
          'UPDATE trip_reminders SET status=?,updated_at=? WHERE trip_id=? AND kind=? AND recipient_key=?',
        )
        .run(status, stamp, id, kind, key);
    }
  }
  return { sent };
}
