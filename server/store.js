import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const now = () => new Date().toISOString();
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const defaults = {
  appName: 'Learn4Life Fleet Checkout',
  organizationName: 'Learn4Life',
  site: 'Main site',
  timezone: 'America/Los_Angeles',
  accentColor: '#126b61',
  logoUrl: '',
  notificationRecipients: [],
  employeeCopy: false,
  reviewMode: 'self_service',
  allowPhotoImports: true,
  largeMileageThreshold: 500,
  storageLimitBytes: 50 * 1024 ** 3,
  retentionDays: 1095,
  sessionMinutes: 15,
  requiredPhotoViews: ['front', 'rear', 'driver', 'passenger'],
};

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, encoded) {
  if (!encoded || typeof password !== 'string') return false;
  const [salt, value] = encoded.split(':');
  const expected = Buffer.from(value, 'hex'),
    actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function openStore(dataDir = process.env.DATA_DIR || './data') {
  dataDir = path.resolve(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, 'photos'), { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'fleet.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(
    readFileSync(fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)), 'utf8'),
  );
  db.prepare('INSERT OR IGNORE INTO settings(id,data_json) VALUES(1,?)').run(
    JSON.stringify(defaults),
  );
  const getSettings = () => ({
    ...defaults,
    ...JSON.parse(db.prepare('SELECT data_json FROM settings WHERE id=1').get().data_json),
  });
  const publicUser = (r) =>
    r
      ? {
          id: r.id,
          email: r.email,
          name: r.name,
          department: r.department,
          manager: r.manager,
          role: r.role,
          authorizedDriver: !!r.authorized_driver,
          active: !!r.active,
        }
      : null;
  const getUser = (id) => publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  const mapVehicle = (r) =>
    r
      ? {
          id: r.id,
          name: r.name,
          make: r.make,
          model: r.model,
          year: r.year,
          plate: r.plate,
          vinLast4: r.vin_last4,
          site: r.site,
          currentMileage: r.current_mileage,
          status: r.status,
          photoUrl: r.photo_url,
          notes: r.notes,
          archived: !!r.archived,
          mileageVersion: r.mileage_version,
        }
      : null;
  const getVehicle = (id) => mapVehicle(db.prepare('SELECT * FROM vehicles WHERE id=?').get(id));
  const mapTrip = (r) => {
    if (!r) return null;
    const c = JSON.parse(r.checkout_json),
      v = r.return_json ? JSON.parse(r.return_json) : null;
    const replacement = db.prepare('SELECT * FROM odometer_replacements WHERE trip_id=?').get(r.id);
    const odometerReplacement = replacement
      ? {
          id: replacement.id,
          oldReading: replacement.old_reading,
          newReading: replacement.new_reading,
          reason: replacement.reason,
          userId: replacement.user_id,
          createdAt: replacement.created_at,
        }
      : null;
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      employeeId: r.employee_id,
      status: r.status,
      checkoutAt: r.checkout_at,
      projectedReturnAt: r.projected_return_at,
      returnedAt: r.returned_at,
      startingMileage: r.starting_mileage,
      endingMileage: r.ending_mileage,
      tripMileage:
        r.ending_mileage === null
          ? null
          : odometerReplacement
            ? odometerReplacement.oldReading -
              r.starting_mileage +
              r.ending_mileage -
              odometerReplacement.newReading
            : r.ending_mileage - r.starting_mileage,
      odometerReplacement,
      employeeSnapshot: c.employee,
      vehicleSnapshot: c.vehicle,
      checkoutInspection: c.inspection,
      returnInspection: v?.inspection || null,
      checkoutSignature: c.signature,
      returnSignature: v?.signature || null,
      checkoutAcknowledgments: c.acknowledgments,
      returnAcknowledgments: v?.acknowledgments || null,
      checkoutReviewMode: c.reviewMode,
      returnReviewMode: v?.reviewMode || null,
      checkoutSettings: c.settings,
      returnSettings: v?.settings || null,
      flags: JSON.parse(r.flags_json),
      overdue: r.status === 'active' && Date.parse(r.projected_return_at) < Date.now(),
    };
  };
  const getTrip = (id) => mapTrip(db.prepare('SELECT * FROM trips WHERE id=?').get(id));
  const mapPhoto = (r) =>
    r
      ? {
          id: r.id,
          employeeId: r.employee_id,
          vehicleId: r.vehicle_id,
          tripId: r.trip_id,
          draftId: r.draft_id,
          stage: r.stage,
          view: r.view_label,
          source: r.source,
          deviceCapturedAt: r.device_captured_at,
          receivedAt: r.received_at,
          bytes: r.bytes,
          mimeType: r.mime_type,
          sha256: r.sha256,
          finalized: !!r.finalized,
          url: `/api/photos/${r.id}`,
          originalUrl: `/api/photos/${r.id}?original=1`,
          originalPath: path.join(dataDir, r.original_path),
          displayPath: path.join(dataDir, r.display_path),
        }
      : null;
  const getPhoto = (id) => mapPhoto(db.prepare('SELECT * FROM photos WHERE id=?').get(id));
  const publicPhoto = (photo) => {
    if (!photo) return null;
    const { originalPath, displayPath, sha256, ...rest } = photo;
    return rest;
  };
  const mapNotification = (r) =>
    r
      ? {
          id: r.id,
          tripId: r.trip_id,
          stage: r.stage,
          status: r.status,
          attempts: r.attempts,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          error: r.error,
          providerId: r.provider_id,
          acceptedAt: r.accepted_at,
          deliveredAt: r.delivered_at,
          recipients: JSON.parse(r.recipients_json),
          messageId: r.message_id,
        }
      : null;
  const listNotifications = (tripId) =>
    (tripId
      ? db
          .prepare('SELECT * FROM notifications WHERE trip_id=? ORDER BY created_at DESC')
          .all(tripId)
      : db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all()
    ).map(mapNotification);
  const getReviews = (tripId) =>
    db
      .prepare('SELECT * FROM reviews WHERE trip_id=? ORDER BY created_at')
      .all(tripId)
      .map((r) => ({
        id: r.id,
        tripId: r.trip_id,
        stage: r.stage,
        userId: r.user_id,
        initials: r.initials,
        signature: r.signature,
        decision: r.decision,
        reason: r.reason,
        createdAt: r.created_at,
        userSnapshot: JSON.parse(r.user_snapshot_json),
      }));
  const getRevisions = (tripId) =>
    db
      .prepare('SELECT * FROM revisions WHERE trip_id=? ORDER BY created_at')
      .all(tripId)
      .map((r) => ({
        id: r.id,
        tripId: r.trip_id,
        field: r.field,
        originalValue: r.original_value,
        correctedValue: r.corrected_value,
        reason: r.reason,
        userId: r.user_id,
        createdAt: r.created_at,
        odometerReplacement: !!r.odometer_replacement,
        acknowledgedAt: r.acknowledged_at,
        acknowledgedBy: r.acknowledged_by,
        acknowledgmentSignature: r.acknowledgment_signature,
        affectsCurrent: !!r.affects_current,
      }));
  const getTripBundle = (id) => ({
    trip: getTrip(id),
    photos: db
      .prepare('SELECT * FROM photos WHERE trip_id=? AND finalized=1 ORDER BY received_at')
      .all(id)
      .map(mapPhoto),
    reviews: getReviews(id),
    revisions: getRevisions(id),
    notifications: listNotifications(id),
    settings: getSettings(),
  });
  const audit = (actorId, action, entityType, entityId, before, after, reason) =>
    db
      .prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        actorId,
        action,
        entityType,
        entityId,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        reason,
        now(),
      );
  const createUser = ({
    email,
    name,
    department = '',
    manager = '',
    role = 'staff',
    authorizedDriver = false,
    active = true,
    password,
    inviteToken,
  }) => {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO users(id,email,name,department,manager,role,authorized_driver,active,password_hash,invite_hash,invite_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      email.trim().toLowerCase(),
      name,
      department,
      manager,
      role,
      +authorizedDriver,
      +active,
      password ? passwordHash(password) : null,
      inviteToken ? hash(inviteToken) : null,
      inviteToken ? new Date(Date.now() + 72 * 3600000).toISOString() : null,
      now(),
    );
    return getUser(id);
  };
  const enqueueNotification = (tripId, stage) => {
    const settings = getSettings(),
      trip = getTrip(tripId),
      recipients = [...settings.notificationRecipients];
    if (settings.employeeCopy && trip?.employeeSnapshot.email)
      recipients.push(trip.employeeSnapshot.email);
    const id = randomUUID(),
      time = now();
    db.prepare(
      'INSERT OR IGNORE INTO notifications(id,trip_id,stage,status,created_at,updated_at,recipients_json,message_id) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      id,
      tripId,
      stage,
      recipients.length ? 'pending' : 'failed',
      time,
      time,
      JSON.stringify([...new Set(recipients)]),
      `<fleet-${tripId}-${stage}@fleet.local>`,
    );
    if (!recipients.length)
      db.prepare(
        "UPDATE notifications SET error='No notification recipient configured' WHERE trip_id=? AND stage=? AND status='failed'",
      ).run(tripId, stage);
    return mapNotification(
      db.prepare('SELECT * FROM notifications WHERE trip_id=? AND stage=?').get(tripId, stage),
    );
  };
  return {
    db,
    dataDir,
    getSettings,
    publicUser,
    getUser,
    mapVehicle,
    getVehicle,
    mapTrip,
    getTrip,
    mapPhoto,
    getPhoto,
    publicPhoto,
    mapNotification,
    listNotifications,
    getReviews,
    getRevisions,
    getTripBundle,
    audit,
    createUser,
    enqueueNotification,
    close: () => db.close(),
  };
}
