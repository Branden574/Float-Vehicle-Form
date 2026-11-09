import { z } from 'zod';
import sharp from 'sharp';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};
export const nonempty = z.string().trim().min(1).max(200);
export const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Please give a reason of at least 5 characters.')
  .max(2000);
export const mileageSchema = z.number().int().min(0).max(9999999);
export const safeImageUrl = z
  .string()
  .max(2000)
  .refine(
    (v) =>
      !v ||
      /^\/api\/(photos|admin\/vehicle-images)\/[a-f0-9-]+(?:\?original=1)?$/.test(v) ||
      /^https:\/\//.test(v),
    'Use an HTTPS image URL or a private uploaded image.',
  );
export const inspectionSchema = z
  .object({
    fuelFull: z.boolean(),
    interiorClean: z.boolean(),
    gasCard: z.boolean(),
    receiptReceived: z.boolean().optional(),
    keyReturned: z.boolean().optional(),
    windshield: z.enum(['clear', 'star', 'cracked']),
    damageScope: z.enum(['all', 'new']).optional(),
    damage: z
      .array(
        z.object({
          area: z.enum([
            'front',
            'rear',
            'driver',
            'passenger',
            'roof',
            'interior',
            'windshield',
            'wheels',
          ]),
          type: z.enum(['chip', 'dent', 'scratch']),
          notes: z.string().max(1000).default(''),
          position: z
            .object({
              x: z.number().finite().min(0).max(1),
              y: z.number().finite().min(0).max(1),
              diagram: z.literal('vehicle-v1'),
            })
            .strict()
            .optional(),
        }),
      )
      .max(40),
    notes: z.string().max(4000).default(''),
  })
  .strict();
export const vehicleSchema = z.object({
  name: nonempty,
  make: nonempty,
  model: nonempty,
  year: z.number().int().min(1900).max(2200),
  plate: nonempty,
  vinLast4: z.string().regex(/^[A-Za-z0-9]{4}$/, 'VIN needs exactly four letters or digits.'),
  site: nonempty,
  currentMileage: mileageSchema,
  status: z.enum(['available', 'pending_review', 'out_of_service']).default('available'),
  photoUrl: safeImageUrl.default(''),
  notes: z.string().max(4000).default(''),
  archived: z.boolean().default(false),
});
export const userSchema = z.object({
  email: z.email().max(254),
  name: nonempty,
  department: z.string().max(200).default(''),
  charter: z.string().max(200).default(''),
  manager: z.string().max(200).default(''),
  role: z.enum(['staff', 'admin']).default('staff'),
  authorizedDriver: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const settingsSchema = z.object({
  appName: nonempty,
  organizationName: nonempty,
  site: nonempty,
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid IANA timezone.'),
  accentColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  logoUrl: safeImageUrl,
  notificationRecipients: z.array(z.email().max(254)).max(20),
  employeeCopy: z.boolean(),
  reviewMode: z.enum(['self_service', 'representative']),
  allowPhotoImports: z.boolean(),
  largeMileageThreshold: z.number().int().min(1).max(1000000),
  storageLimitBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(Number.MAX_SAFE_INTEGER),
  retentionDays: z.number().int().min(1).max(36500),
  sessionMinutes: z.number().int().min(5).max(120),
  requiredPhotoViews: z
    .array(
      z.enum([
        'front',
        'rear',
        'driver',
        'passenger',
        'windshield',
        'interior',
        'odometer',
        'receipt',
        'wheels',
        'damage',
        'other',
      ]),
    )
    .optional(),
});
export function validate(schema, value) {
  const p = schema.safeParse(value);
  if (!p.success)
    fail(400, p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return p.data;
}
export async function validateSignature(value) {
  if (
    typeof value !== 'string' ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ||
    value.length > 400000
  )
    fail(400, 'Draw a signature before submitting.');
  try {
    const buffer = Buffer.from(value.split(',')[1], 'base64'),
      image = sharp(buffer, { limitInputPixels: 2000000 });
    const meta = await image.metadata();
    if (meta.format !== 'png' || meta.width < 50 || meta.height < 20)
      fail(400, 'Signature image is too small.');
    const stats = await image.stats();
    if (stats.channels.every((c) => c.stdev < 0.5))
      fail(400, 'A blank signature cannot be submitted.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, 'Signature could not be read. Please sign again.');
  }
  return value;
}
export function checkAcknowledgments(v, stage) {
  const fields =
    stage === 'checkout'
      ? ['accurate', 'noEating', 'removeBelongings', 'fullTank']
      : ['accurate', 'removeBelongings', 'fullTank'];
  if (!v || fields.some((f) => v[f] !== true))
    fail(400, 'Please accept all acknowledgments before signing.');
  return Object.fromEntries(fields.map((f) => [f, true]));
}
export function inspectionFlags(i) {
  const flags = [];
  if (!i.fuelFull) flags.push('Fuel tank not full');
  if (!i.interiorClean) flags.push('Interior needs cleaning');
  if (!i.gasCard) flags.push('Gas card missing');
  if (i.receiptReceived === false) flags.push('Fuel receipt missing');
  if (i.keyReturned === false) flags.push('Key not returned');
  if (i.windshield !== 'clear') flags.push(`Windshield: ${i.windshield}`);
  if (i.damage.length) flags.push('Damage recorded');
  if (i.notes.trim()) flags.push('Inspection notes require review');
  return flags;
}
