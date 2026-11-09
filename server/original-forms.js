import diagram from '../shared/vehicle-diagram.json' with { type: 'json' };
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { buildCleanTemplate, diagramBounds } from './clean-template.js';
import { createHash } from 'node:crypto';

// Rebuilt form retains the original layout without scan artifacts.
export const templateBytes = await buildCleanTemplate();
export const templateHash = createHash('sha256').update(templateBytes).digest('hex');
const BLUE = rgb(0.04, 0.18, 0.48);
const AREAS = {
  front: [720, 790],
  rear: [720, 1100],
  driver: [625, 885],
  passenger: [790, 885],
  roof: [720, 940],
  interior: [720, 990],
  windshield: [720, 840],
  wheels: [625, 1025],
};

export async function originalForms({ trip, reviews, zone, stage, appendix }) {
  const output = await PDFDocument.create();
  const source = await PDFDocument.load(templateBytes);
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const count = 2;
  for (let index = 0; index < count; index++) {
    const returning = index === 1,
      kind = returning ? 'return' : 'checkout';
    const page = output.addPage([612, 792]);
    const original = await output.embedPage(source.getPage(index));
    page.drawPage(original, { x: 0, y: 0, width: 612, height: 792 });
    if (returning && stage === 'checkout') {
      // Include the back at checkout without fabricating answers, mileage or signatures.
      page.drawText('NOT YET RETURNED - Complete this form at vehicle check-in', {
        x: 50,
        y: 22,
        size: 9,
        font: bold,
        color: BLUE,
      });
      page.drawText(`Trip ${trip.id} | Check-in pending | 2`, {
        x: 50,
        y: 10,
        size: 7,
        font,
        color: BLUE,
      });
      continue;
    }
    const sx = 612 / (returning ? 1085 : 1082),
      sy = 792 / 1400;
    // Scanned form has no AcroFields. Overlay completed values without replacing its artwork.
    const clean = (v) =>
      String(v ?? '')
        .replace(/[\r\n]+/g, ' ')
        .split('')
        .map((c) => {
          try {
            font.encodeText(c);
            return c;
          } catch {
            return '?';
          }
        })
        .join('');
    const box = (v, x, y, w, h = 28, size = 18, color = BLUE) => {
      let value = clean(v),
        points = size * sy;
      while (font.widthOfTextAtSize(value, points) > w * sx && points > 7) points -= 0.25;
      if (font.widthOfTextAtSize(value, points) > w * sx) {
        while (value.length && font.widthOfTextAtSize(value + '...', points) > w * sx)
          value = value.slice(0, -1);
        value += '...'; // Full unabridged values remain in the supporting detail pages.
      }
      page.drawText(value, {
        x: x * sx,
        y: 792 - (y + h) * sy + (h * sy - points) / 2,
        size: points,
        font,
        color,
      });
    };
    const date = (v) =>
      v
        ? new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
          }).format(new Date(v))
        : '';
    const time = (v) =>
      v
        ? new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(v))
        : '';
    const check = (x, y) => {
      page.drawLine({
        start: { x: (x + 3) * sx, y: 792 - (y + 10) * sy },
        end: { x: (x + 8) * sx, y: 792 - (y + 16) * sy },
        thickness: 1.4,
        color: BLUE,
      });
      page.drawLine({
        start: { x: (x + 8) * sx, y: 792 - (y + 16) * sy },
        end: { x: (x + 17) * sx, y: 792 - (y + 3) * sy },
        thickness: 1.4,
        color: BLUE,
      });
    };
    const inspection = returning ? trip.returnInspection : trip.checkoutInspection;
    const signedAt = returning ? trip.returnedAt : trip.checkoutAt;
    const review = reviews.find((r) => r.stage === kind);
    box(trip.employeeSnapshot.name, 100, returning ? 365 : 355, 460, 42, 22);
    if (returning) {
      box(date(signedAt), 595, 366, 180, 32);
      box(time(signedAt), 800, 366, 165, 32);
    } else {
      box(date(signedAt), 580, 357, 188);
      box(time(signedAt), 580, 387, 188);
      box(date(trip.projectedReturnAt), 792, 366, 168);
      box(time(trip.projectedReturnAt), 792, 397, 168);
    }
    box(
      trip.employeeSnapshot.charter || trip.employeeSnapshot.department,
      100,
      returning ? 450 : 453,
      185,
    );
    box(trip.employeeSnapshot.manager, 310, returning ? 450 : 453, 255);
    box(trip.vehicleSnapshot.vinLast4, returning ? 595 : 580, returning ? 450 : 453, 180);
    const mode = returning ? trip.returnReviewMode : trip.checkoutReviewMode;
    const needsReview =
      mode === 'representative' || (!returning && trip.status === 'pending_checkout');
    box(review?.initials || (needsReview ? 'Pending' : 'N/A'), 800, returning ? 450 : 453, 160);
    const answers = returning
      ? [
          inspection.fuelFull && inspection.receiptReceived,
          inspection.interiorClean,
          inspection.gasCard,
        ]
      : [
          trip.employeeSnapshot.authorizedDriver,
          inspection.fuelFull,
          inspection.interiorClean,
          inspection.gasCard,
        ];
    answers.forEach((value, row) =>
      check(
        value ? (returning ? 591 : 578) : returning ? 797 : 788,
        (returning ? 524 : 522) + row * 24,
      ),
    );
    const mileage = String(returning ? trip.endingMileage : trip.startingMileage).padStart(6, ' ');
    if (mileage.length <= 6)
      [...mileage].forEach((digit, i) =>
        box(digit, (returning ? 127 : 133) + i * 52.5, returning ? 665 : 685, 35, 27, 23),
      );
    else box(mileage, 120, returning ? 665 : 685, 295, 27, 22);
    if (inspection.windshield === 'clear') check(returning ? 664 : 666, returning ? 663 : 683);
    else {
      const x = inspection.windshield === 'star' ? 705 : 765;
      page.drawEllipse({
        x: (x + 20) * sx,
        y: 792 - (returning ? 718 : 738) * sy,
        xScale: 32 * sx,
        yScale: 15 * sy,
        borderColor: BLUE,
        borderWidth: 1.2,
      });
    }
    box(
      inspection.damage.length
        ? returning && inspection.damageScope === 'new'
          ? 'New damage recorded - see N marks.'
          : 'Damage recorded - see numbered details.'
        : returning && inspection.damageScope === 'new'
          ? 'No new body damage reported.'
          : 'No body damage reported.',
      105,
      returning ? 755 : 767,
      440,
      30,
      16,
    );

    const separate = returning && inspection.damageScope === 'new';
    if (separate) box('C: checkout damage   N: new return damage', 105, 800, 440, 26, 15);
    const entries = [
      ...(separate
        ? trip.checkoutInspection.damage.map((damage, i) => ({ damage, i, existing: true }))
        : []),
      ...inspection.damage.map((damage, i) => ({ damage, i, existing: false })),
    ];
    const seenAreas = new Set();
    entries.forEach(({ damage, i, existing }) => {
      const color = existing ? rgb(0.59, 0.34, 0.07) : BLUE;
      const label = `${existing ? 'C' : separate ? 'N' : ''}${i + 1}`;
      if (damage.position) {
        const d = diagramBounds(returning);
        const x = (d.x + damage.position.x * d.width) * sx;
        const scale = (d.width / diagram.width) * sx;
        const y = 792 - d.y * sy - damage.position.y * diagram.height * scale;
        page.drawSvgPath(diagram.marks[damage.type], {
          x,
          y,
          scale,
          borderWidth: 2,
          borderColor: color,
        });
        page.drawText(label, {
          x: x + 11 * scale,
          y: y + 9 * scale,
          font: bold,
          size: 13 * scale,
          color,
        });
        return;
      }
      if (seenAreas.has(`${existing}:${damage.area}`)) return;
      seenAreas.add(`${existing}:${damage.area}`);
      const extra =
        entries.filter(
          (e) => e.existing === existing && !e.damage.position && e.damage.area === damage.area,
        ).length - 1;
      const [x, y] = AREAS[damage.area] || [720, 940];
      // Only an area was recorded, never claim a precise point of impact.
      box(
        `${label}: ${damage.type === 'dent' ? 'x' : damage.type === 'scratch' ? '~' : '... '}${extra ? ` (+${extra})` : ''}`,
        x,
        y - (returning ? 20 : 0),
        90,
        20,
        15,
        color,
      );
    });
    const sig = async (data, x, y, w, h) => {
      if (!data) return;
      const image = await output.embedPng(Buffer.from(data.split(',')[1], 'base64'));
      const scale = Math.min((w * sx) / image.width, (h * sy) / image.height);
      page.drawImage(image, {
        x: x * sx,
        y: 792 - (y + h) * sy,
        width: image.width * scale,
        height: image.height * scale,
      });
    };
    await sig(
      returning ? trip.returnSignature : trip.checkoutSignature,
      returning ? 285 : 305,
      returning ? 1249 : 1284,
      320,
      49,
    );
    box(date(signedAt), returning ? 714 : 717, returning ? 1273 : 1306, 145, 26, 16);
    if (review) {
      await sig(review.signature, returning ? 285 : 310, returning ? 1200 : 1230, 315, 34);
      box(date(review.createdAt), returning ? 704 : 710, returning ? 1210 : 1242, 145, 26, 16);
    } else
      box(
        needsReview ? 'Pending representative review' : 'N/A - self-service',
        returning ? 285 : 310,
        returning ? 1200 : 1235,
        310,
        25,
        15,
      );
    page.drawText(
      `Trip ${trip.id} | ${kind === 'return' ? 'Check-in' : 'Checkout'} | ${index + 1}`,
      { x: 50, y: 10, size: 7, font: bold, color: BLUE },
    );
  }
  const extra = await PDFDocument.load(appendix);
  for (const p of await output.copyPages(extra, extra.getPageIndices())) output.addPage(p);
  output.setTitle(`Learn4Life completed forms | ${trip.id}`);
  output.setSubject(
    'Original checkout/check-in forms with supporting records and inspection photographs',
  );
  return Buffer.from(await output.save());
}
