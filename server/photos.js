import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hash, now } from './store.js';
import { fail, validate } from './validation.js';
import { requireAdmin, requireTripAccess } from './auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 12 },
});
const viewNames = {
  front: 'Front',
  rear: 'Rear',
  driver: 'Driver side',
  passenger: 'Passenger side',
  windshield: 'Windshield',
  interior: 'Interior',
  odometer: 'Odometer',
  receipt: 'Receipt',
  wheels: 'Wheels',
  damage: 'Damage',
  other: 'Additional photo',
};
const xml = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
function formatTime(value, timezone) {
  return value
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(new Date(value))
    : 'Not supplied';
}

export function installPhotos(app, store) {
  const { db } = store;
  const save = async (req, res, stageOverride) => {
    if (!req.file) fail(400, 'Choose or capture a photo first.');
    const body = stageOverride
      ? { ...req.body, stage: 'vehicle', view: 'other', source: 'upload', draftId: randomUUID() }
      : req.body;
    const data = validate(
      z.object({
        vehicleId: z.string().uuid(),
        stage: z.enum(['checkout', 'return', 'vehicle']),
        view: z.enum(Object.keys(viewNames)),
        draftId: z.string().uuid(),
        deviceCapturedAt: z.iso.datetime({ offset: true }).optional(),
        source: z.enum(['camera', 'upload']),
        tripId: z.string().uuid().optional(),
      }),
      body,
    );
    if (data.stage === 'vehicle' && req.user.role !== 'admin')
      fail(403, 'Only administrators can add vehicle photographs.');
    const vehicle = store.getVehicle(data.vehicleId);
    if (!vehicle || vehicle.archived) fail(404, 'Vehicle not found.');
    if (data.stage === 'checkout' && (!req.user.authorizedDriver || vehicle.status !== 'available'))
      fail(409, 'This vehicle is unavailable or you are not an authorized driver.');
    if (data.stage === 'return') {
      if (!data.tripId) fail(400, 'Return photos need the original trip.');
      const trip = requireTripAccess(store, req, data.tripId);
      if (trip.employeeId !== req.user.id)
        fail(403, 'Only the employee can upload their return evidence.');
      if (trip.status !== 'active' || trip.vehicleId !== vehicle.id)
        fail(409, 'This trip cannot receive return photographs.');
    }
    const settings = store.getSettings();
    if (data.stage !== 'vehicle' && data.source === 'upload' && !settings.allowPhotoImports)
      fail(400, 'Your site requires camera capture. Use Take photo.');
    if (data.source === 'camera' && !data.deviceCapturedAt)
      fail(400, 'Camera captures need a device-reported timestamp.');
    const digest = hash(req.file.buffer);
    const previous = db
      .prepare(
        'SELECT * FROM photos WHERE employee_id=? AND draft_id=? AND view_label=? AND sha256=? AND finalized=0',
      )
      .get(req.user.id, data.draftId, data.view, digest);
    if (previous) return res.json({ photo: store.publicPhoto(store.mapPhoto(previous)) });
    if (
      data.stage === 'return' &&
      db
        .prepare('SELECT 1 FROM photos WHERE trip_id=? AND stage=? AND sha256=? AND finalized=1')
        .get(data.tripId, 'checkout', digest)
    )
      fail(400, 'Return photos must be newly captured. This file was used at checkout.');
    let display, metadata;
    try {
      metadata = await sharp(req.file.buffer, { limitInputPixels: 45000000 }).metadata();
      if (!['jpeg', 'png', 'webp', 'heif'].includes(metadata.format))
        fail(400, 'Use a JPEG, PNG, WebP, or supported HEIC photograph.');
      if (metadata.width < 64 || metadata.height < 64)
        fail(400, 'Photo resolution is too small. Retake the photograph.');
      display = await sharp(req.file.buffer, { limitInputPixels: 45000000 })
        .rotate()
        .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#fff' })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (e) {
      if (e.status) throw e;
      fail(
        400,
        'This photo format cannot be read on this server. On iPad use Camera → Formats → Most Compatible, or upload JPEG/PNG. The original was not saved; retry with a supported file.',
      );
    }
    const receivedAt = now(),
      dims = await sharp(display).metadata(),
      width = Math.max(dims.width, 640),
      height = dims.height;
    const line1 = `${data.stage.toUpperCase()} · ${viewNames[data.view]} · ${vehicle.name}`;
    const line2 = `Device reported: ${formatTime(data.deviceCapturedAt, settings.timezone)} · ${data.source === 'camera' ? 'Camera (device reported)' : 'Uploaded file'}`;
    const line3 = `Server received: ${formatTime(receivedAt, settings.timezone)} · ${settings.timezone}`;
    const line4 = `Employee: ${req.user.name} · Photo timestamps do not verify true capture time`;
    const svg = Buffer.from(
      `<svg width="${width}" height="120"><rect width="100%" height="100%" fill="#102c33"/>${[line1, line2, line3, line4].map((l, i) => `<text x="16" y="${24 + i * 26}" fill="white" font-family="sans-serif" font-size="${width < 900 ? 12 : 16}">${xml(l.slice(0, 150))}</text>`).join('')}</svg>`,
    );
    const stamped = await sharp(display)
      .extend({
        top: 0,
        bottom: 120,
        left: 0,
        right: Math.max(0, width - dims.width),
        background: '#fff',
      })
      .composite([{ input: svg, top: height, left: 0 }])
      .jpeg({ quality: 84 })
      .toBuffer();
    const bytes = req.file.buffer.length + stamped.length;
    const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM photos').get().total;
    if (used + bytes > settings.storageLimitBytes)
      fail(
        507,
        'Photo storage is full. An administrator must increase approved capacity or export and review retention. No evidence was deleted.',
      );
    const id = randomUUID(),
      originalPath = path.join('photos', `${id}.original`),
      displayPath = path.join('photos', `${id}.jpg`);
    try {
      await writeFile(path.join(store.dataDir, originalPath), req.file.buffer, {
        mode: 0o600,
        flag: 'wx',
      });
      await writeFile(path.join(store.dataDir, displayPath), stamped, { mode: 0o600, flag: 'wx' });
      db.transaction(() => {
        // Recheck quota inside the serialized write transaction after image processing.
        if (
          db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM photos').get().total + bytes >
          settings.storageLimitBytes
        )
          fail(
            507,
            'Storage capacity was reached during upload. Ask an administrator to increase capacity.',
          );
        db.prepare(
          'INSERT INTO photos(id,employee_id,vehicle_id,trip_id,draft_id,stage,view_label,source,device_captured_at,received_at,original_path,display_path,sha256,bytes,mime_type,finalized) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          req.user.id,
          vehicle.id,
          data.tripId || null,
          data.draftId,
          data.stage,
          data.view,
          data.source,
          data.deviceCapturedAt || null,
          receivedAt,
          originalPath,
          displayPath,
          digest,
          bytes,
          metadata.format === 'jpeg'
            ? 'image/jpeg'
            : metadata.format === 'heif'
              ? 'image/heic'
              : `image/${metadata.format}`,
          data.stage === 'vehicle' ? 1 : 0,
        );
        if (data.stage === 'vehicle') {
          const before = store.getVehicle(vehicle.id);
          db.prepare('UPDATE vehicles SET photo_url=?,updated_at=? WHERE id=?').run(
            `/api/photos/${id}`,
            now(),
            vehicle.id,
          );
          store.audit(
            req.user.id,
            'vehicle_photo',
            'vehicle',
            vehicle.id,
            before,
            store.getVehicle(vehicle.id),
            String(req.body.reason || 'Administrator updated vehicle identification photograph'),
          );
        }
      }).immediate();
    } catch (e) {
      await Promise.allSettled([
        unlink(path.join(store.dataDir, originalPath)),
        unlink(path.join(store.dataDir, displayPath)),
      ]);
      throw e;
    }
    res.status(201).json({ photo: store.publicPhoto(store.getPhoto(id)) });
  };
  app.post('/api/photos', upload.single('file'), (req, res) => save(req, res));
  app.post('/api/admin/vehicle-images', requireAdmin, upload.single('file'), (req, res) =>
    save(req, res, 'vehicle'),
  );
  app.get('/api/photos/:id', (req, res) => {
    const photo = store.getPhoto(req.params.id);
    if (!photo) fail(404, 'Photo not found.');
    if (photo.stage !== 'vehicle' && req.user.role !== 'admin' && photo.employeeId !== req.user.id)
      fail(403, 'You can only view your own inspection photographs.');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.query.original === '1') {
      res.type(photo.mimeType);
      res.set(
        'Content-Disposition',
        `attachment; filename="${photo.id}-original.${photo.mimeType.split('/')[1]}"`,
      );
      res.sendFile(photo.originalPath);
    } else {
      res.type('jpeg');
      res.sendFile(photo.displayPath);
    }
  });
}

export function validatePhotos(store, { ids, employeeId, vehicleId, stage, draftId, tripId }) {
  if (!Array.isArray(ids) || ids.length < 4 || ids.length > 30 || new Set(ids).size !== ids.length)
    fail(400, 'Provide four required views and at most 30 distinct photographs.');
  const photos = ids.map((id) => store.getPhoto(id));
  if (
    photos.some(
      (p) =>
        !p ||
        p.employeeId !== employeeId ||
        p.vehicleId !== vehicleId ||
        p.stage !== stage ||
        p.draftId !== draftId ||
        p.finalized ||
        (stage === 'return' && p.tripId !== tripId),
    )
  )
    fail(
      400,
      'A photo does not belong to this employee, vehicle, or inspection draft. Upload it again.',
    );
  const required = [
    ...new Set(['front', 'rear', 'driver', 'passenger', ...store.getSettings().requiredPhotoViews]),
  ];
  if (required.some((view) => !photos.some((p) => p.view === view)))
    fail(
      400,
      `Successfully upload all required views: ${required.map((x) => viewNames[x]).join(', ')}.`,
    );
  if (new Set(photos.map((p) => p.sha256)).size !== photos.length)
    fail(
      400,
      'Each photograph must be a separate view. The same image cannot fill multiple slots.',
    );
  if (stage === 'return') {
    const checkout = new Set(
      store.db
        .prepare("SELECT sha256 FROM photos WHERE trip_id=? AND stage='checkout' AND finalized=1")
        .all(tripId)
        .map((x) => x.sha256),
    );
    if (photos.some((p) => checkout.has(p.sha256)))
      fail(400, 'Return evidence must not reuse checkout photographs.');
  }
  return photos;
}
