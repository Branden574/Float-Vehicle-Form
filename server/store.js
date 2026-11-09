import { openEvidence } from './evidence.js';
import { openPrivacy } from './privacy.js';
import { openDatabase } from './database.js';
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
  returnReviewerEmails: [],
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

export async function openStore(dataDir = process.env.DATA_DIR || './data') {
  dataDir = path.resolve(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, 'photos'), { recursive: true, mode: 0o700 });
  const privacy = openPrivacy(dataDir);
  const db = openDatabase(dataDir);
  if (db.kind === 'sqlite') {
    await db.pragma('journal_mode = WAL');
    await db.pragma('foreign_keys = ON');
    await db.pragma('busy_timeout = 5000');
    await db.exec(
      readFileSync(fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)), 'utf8'),
    );
    await db.pragma('secure_delete = ON');
    await db.exec(
      'CREATE TABLE IF NOT EXISTS privacy_meta (id INTEGER PRIMARY KEY CHECK(id=1), key_check TEXT NOT NULL)',
    );
  }
  const keyCheck = await db.prepare('SELECT key_check FROM privacy_meta WHERE id=1').get();
  if (keyCheck && keyCheck.key_check !== privacy.fingerprint) {
    await db.close();
    throw new Error(
      'Incorrect profile encryption key. Restore the matching key; no data was changed.',
    );
  }
  if (db.kind === 'sqlite') {
    const columns = await db.prepare('PRAGMA table_info(users)').all();
    if (!columns.some((c) => c.name === 'profile_json'))
      await db.exec('ALTER TABLE users ADD COLUMN profile_json TEXT');
    let migrated = false;
    await db.transaction(async () => {
      await db.prepare('INSERT OR IGNORE INTO privacy_meta VALUES(1,?)').run(privacy.fingerprint);
      for (const r of await db.prepare('SELECT * FROM users WHERE profile_json IS NULL').all()) {
        const profile = {
          email: r.email,
          name: r.name,
          department: r.department,
          manager: r.manager,
          charter: '',
        };
        await db
          .prepare(
            "UPDATE users SET email=?,name='',department='',manager='',profile_json=? WHERE id=?",
          )
          .run(privacy.lookup(r.email), privacy.encode(profile), r.id);
        migrated = true;
      }
      for (const [table, fields] of [
        ['trips', ['checkout_json', 'return_json']],
        ['audit', ['before_json', 'after_json']],
        ['reviews', ['user_snapshot_json']],
        ['idempotency', ['response_json']],
        ['notifications', ['recipients_json']],
        ['settings', ['data_json']],
      ]) {
        for (const field of fields)
          for (const row of await db
            .prepare(
              `SELECT rowid AS row_id, ${field} AS value FROM ${table} WHERE ${field} IS NOT NULL`,
            )
            .all()) {
            if (!row.value.startsWith('enc:v1:')) {
              await db
                .prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`)
                .run(privacy.encode(JSON.parse(row.value)), row.row_id);
              migrated = true;
            }
          }
      }
    })();
    if (migrated) {
      await db.pragma('wal_checkpoint(TRUNCATE)');
      await db.exec('VACUUM');
      await db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } else {
    await db.prepare('INSERT OR IGNORE INTO privacy_meta VALUES(1,?)').run(privacy.fingerprint);
  }
  await db
    .prepare('INSERT OR IGNORE INTO settings(id,data_json) VALUES(1,?)')
    .run(privacy.encode(defaults));
  const getSettings = async () => {
    const settings = {
      ...defaults,
      ...privacy.decode(
        (await db.prepare('SELECT data_json FROM settings WHERE id=1').get()).data_json,
      ),
    };
    if (process.env.STORAGE_LIMIT_BYTES)
      settings.storageLimitBytes = Math.min(
        settings.storageLimitBytes,
        Number(process.env.STORAGE_LIMIT_BYTES),
      );
    return settings;
  };
  const publicUser = (r) =>
    r
      ? {
          id: r.id,
          ...privacy.decode(r.profile_json),
          role: r.role,
          authorizedDriver: !!r.authorized_driver,
          active: !!r.active,
        }
      : null;
  const getUser = async (id) =>
    publicUser(await db.prepare('SELECT * FROM users WHERE id=?').get(id));
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
  const getVehicle = async (id) =>
    mapVehicle(await db.prepare('SELECT * FROM vehicles WHERE id=?').get(id));
  const mapTrip = async (r) => {
    if (!r) return null;
    const c = privacy.decode(r.checkout_json),
      v = r.return_json ? privacy.decode(r.return_json) : null;
    const replacement = await db
      .prepare('SELECT * FROM odometer_replacements WHERE trip_id=?')
      .get(r.id);
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
  const getTrip = async (id) =>
    await mapTrip(await db.prepare('SELECT * FROM trips WHERE id=?').get(id));
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
  const getPhoto = async (id) =>
    mapPhoto(await db.prepare('SELECT * FROM photos WHERE id=?').get(id));
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
          recipients: privacy.decode(r.recipients_json),
          messageId: r.message_id,
        }
      : null;
  const listNotifications = async (tripId) =>
    (tripId
      ? await db
          .prepare('SELECT * FROM notifications WHERE trip_id=? ORDER BY created_at DESC')
          .all(tripId)
      : await db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all()
    ).map(mapNotification);
  const getReviews = async (tripId) =>
    (await db.prepare('SELECT * FROM reviews WHERE trip_id=? ORDER BY created_at').all(tripId)).map(
      (r) => ({
        id: r.id,
        tripId: r.trip_id,
        stage: r.stage,
        userId: r.user_id,
        initials: r.initials,
        signature: r.signature,
        decision: r.decision,
        reason: r.reason,
        createdAt: r.created_at,
        userSnapshot: privacy.decode(r.user_snapshot_json),
      }),
    );
  const getRevisions = async (tripId) =>
    (
      await db.prepare('SELECT * FROM revisions WHERE trip_id=? ORDER BY created_at').all(tripId)
    ).map((r) => ({
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
  const getTripBundle = async (id) => ({
    trip: await getTrip(id),
    photos: (
      await db
        .prepare('SELECT * FROM photos WHERE trip_id=? AND finalized=1 ORDER BY received_at')
        .all(id)
    ).map(mapPhoto),
    reviews: await getReviews(id),
    revisions: await getRevisions(id),
    notifications: await listNotifications(id),
    settings: await getSettings(),
  });
  const audit = async (actorId, action, entityType, entityId, before, after, reason) =>
    await db
      .prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        actorId,
        action,
        entityType,
        entityId,
        before == null ? null : privacy.encode(before),
        after == null ? null : privacy.encode(after),
        reason,
        now(),
      );
  const createUser = async ({
    email,
    name,
    department = '',
    charter = '',
    manager = '',
    role = 'staff',
    authorizedDriver = false,
    active = true,
    password,
    inviteToken,
  }) => {
    const id = randomUUID();
    await db
      .prepare(
        'INSERT INTO users(id,email,name,department,manager,role,authorized_driver,active,password_hash,invite_hash,invite_expires_at,created_at,profile_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        privacy.lookup(email),
        '',
        '',
        '',
        role,
        +authorizedDriver,
        +active,
        password ? passwordHash(password) : null,
        inviteToken ? hash(inviteToken) : null,
        inviteToken ? new Date(Date.now() + 72 * 3600000).toISOString() : null,
        now(),
        privacy.encode({ email: email.trim().toLowerCase(), name, department, manager, charter }),
      );
    return await getUser(id);
  };
  const updateUser = async (id, data) => {
    const { email, name, department = '', manager = '', charter = '' } = data;
    await db
      .prepare(
        'UPDATE users SET email=?,profile_json=?,role=?,authorized_driver=?,active=? WHERE id=?',
      )
      .run(
        privacy.lookup(email),
        privacy.encode({ email: email.trim().toLowerCase(), name, department, manager, charter }),
        data.role,
        +data.authorizedDriver,
        +data.active,
        id,
      );
    return await getUser(id);
  };
  const enqueueNotification = async (tripId, stage) => {
    const settings = await getSettings(),
      trip = await getTrip(tripId),
      employee = trip ? await getUser(trip.employeeId) : null,
      recipients =
        stage === 'return_review'
          ? [...settings.returnReviewerEmails].filter(
              (email) => email !== employee?.email?.toLowerCase(),
            )
          : [...settings.notificationRecipients];
    if (stage !== 'return_review' && settings.employeeCopy && trip?.employeeSnapshot.email)
      recipients.push(trip.employeeSnapshot.email);
    const id = randomUUID(),
      time = now();
    await db
      .prepare(
        'INSERT OR IGNORE INTO notifications(id,trip_id,stage,status,created_at,updated_at,recipients_json,message_id) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        tripId,
        stage,
        recipients.length ? 'pending' : 'failed',
        time,
        time,
        privacy.encode([...new Set(recipients)]),
        `<fleet-${tripId}-${stage}@fleet.local>`,
      );
    if (!recipients.length)
      await db
        .prepare(
          "UPDATE notifications SET error='No notification recipient configured' WHERE trip_id=? AND stage=? AND status='failed'",
        )
        .run(tripId, stage);
    return mapNotification(
      await db
        .prepare('SELECT * FROM notifications WHERE trip_id=? AND stage=?')
        .get(tripId, stage),
    );
  };
  return {
    db,
    dataDir,
    evidence: openEvidence(dataDir),
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
    updateUser,
    encodeJSON: privacy.encode,
    decodeJSON: privacy.decode,
    emailLookup: privacy.lookup,
    enqueueNotification,
    close: async () => await db.close(),
  };
}
