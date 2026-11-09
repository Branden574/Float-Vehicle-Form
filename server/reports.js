import PDFDocument from 'pdfkit';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { inspectionFlags } from './validation.js';

const INK = '#1e302c';
const GREEN = '#17664e';
const MUTED = '#586b65';
const names = {
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
  other: 'Additional view',
};
const yesNo = (value) => (value === true ? 'Yes' : value === false ? 'No' : 'Not recorded');

function timestamp(value, timezone) {
  if (!value) return 'Not recorded';
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'long',
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

/** An immutable content-addressed copy is retained for each report revision. */
export async function createReport({ store, tripId, stage = 'return' }) {
  const bundle = store.getTripBundle(tripId);
  if (!bundle.trip) throw new Error('Trip not found');
  if (!['checkout', 'return'].includes(stage)) throw new Error('Invalid report stage');
  if (stage === 'return' && !bundle.trip.returnedAt)
    throw new Error('Return has not been completed');
  const { trip, photos, reviews, revisions } = bundle;
  const settings = trip.checkoutSettings || bundle.settings;
  const reportData = {
    version: 1,
    stage,
    trip,
    settings,
    photos: photos
      .filter((p) => stage === 'return' || p.stage === 'checkout')
      .map(({ originalPath, displayPath, ...photo }) => photo),
    reviews: reviews.filter((r) => stage === 'return' || r.stage === 'checkout'),
    revisions,
  };
  const digest = createHash('sha256').update(JSON.stringify(reportData)).digest('hex');
  const directory = path.join(store.dataDir, 'reports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${trip.id}-${stage}-${digest}.pdf`);
  try {
    return await readFile(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 42,
    bufferPages: true,
    autoFirstPage: false,
    info: {
      Title: `${settings.appName} | ${trip.id}`,
      Author: settings.organizationName,
      Subject: `${stage === 'return' ? 'Checkout and check-in' : 'Checkout'} inspection record`,
    },
  });
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const zone = settings.timezone || 'America/Los_Angeles';
  const width = 528;
  let y = 0;
  const page = (title) => {
    doc.addPage();
    doc.rect(0, 0, 612, 8).fill(GREEN);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(GREEN)
      .text(settings.organizationName || 'Fleet operations', 42, 31, { width });
    doc.font('Helvetica-Bold').fontSize(24).fillColor(INK).text(title, 42, 54, { width });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Trip ${trip.id}`, 42, 85, { width });
    doc.moveTo(42, 107).lineTo(570, 107).strokeColor('#cbd5ce').stroke();
    y = 124;
  };
  const ensure = (amount) => {
    if (y + amount > 710) page('Inspection record · continued');
  };
  const text = (value, options = {}) => {
    const string = String(value ?? 'Not recorded');
    const size = options.size || 10;
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    const height = doc.heightOfString(string, { width, lineGap: 3 });
    ensure(height + 9);
    doc.fillColor(options.color || INK).text(string, 42, y, { width, lineGap: 3 });
    y += height + 9;
  };
  const heading = (value) => {
    ensure(40);
    y += 5;
    text(value, { bold: true, size: 13, color: GREEN });
  };
  const pair = (label, value) => text(`${label}: ${value ?? 'Not recorded'}`);
  const signature = (label, data, signedAt, signer) => {
    ensure(112);
    text(`${label} — ${signer || 'Not recorded'}`, { bold: true });
    if (data?.startsWith('data:image/png;base64,')) {
      const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
      try {
        doc.image(bytes, 46, y, { fit: [360, 55] });
      } catch {
        text('Signature image could not be rendered. Original record retained.');
      }
      y += 58;
    } else {
      text('Not signed');
    }
    pair('Signed', timestamp(signedAt, zone));
  };

  for (const inspectionStage of stage === 'return' ? ['checkout', 'return'] : ['checkout']) {
    const returning = inspectionStage === 'return';
    const inspection = returning ? trip.returnInspection : trip.checkoutInspection;
    const employee = trip.employeeSnapshot;
    const vehicle = trip.vehicleSnapshot;
    page(returning ? 'Vehicle check-in' : 'Vehicle checkout');
    if (!returning && trip.status === 'cancelled') {
      text(
        'Checkout declined by the representative. This record does not represent a completed driving trip.',
        { bold: true },
      );
    }
    pair('Employee', `${employee.name} · ${employee.email}`);
    pair(
      'Department / manager',
      `${employee.department || 'Not recorded'} / ${employee.manager || 'Not recorded'}`,
    );
    pair('Vehicle', `${vehicle.name} · ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    pair('Plate / asset ID', vehicle.plate);
    pair('VIN last four / site', `${vehicle.vinLast4} / ${vehicle.site}`);
    pair('Checkout', timestamp(trip.checkoutAt, zone));
    pair('Projected return', timestamp(trip.projectedReturnAt, zone));
    if (returning) pair('Physical return', timestamp(trip.returnedAt, zone));
    pair('Authorized float-pool driver at checkout', yesNo(employee.authorizedDriver));
    heading('Mileage');
    pair(
      'Starting odometer (confirmed by employee)',
      `${trip.startingMileage.toLocaleString()} miles`,
    );
    if (returning) {
      pair('Ending odometer', `${trip.endingMileage.toLocaleString()} miles`);
      if (trip.odometerReplacement) {
        const replacement = trip.odometerReplacement;
        pair(
          'Documented odometer replacement',
          `${replacement.oldReading} old reading / ${replacement.newReading} new reading`,
        );
        pair('Replacement reason', replacement.reason);
        pair(
          'Recorded by administrator',
          `${store.getUser(replacement.userId)?.name || replacement.userId} · ${timestamp(replacement.createdAt, zone)}`,
        );
        pair(
          'Trip mileage',
          `(${replacement.oldReading} - ${trip.startingMileage}) + (${trip.endingMileage} - ${replacement.newReading}) = ${trip.tripMileage} miles`,
        );
        text('Employee explicitly acknowledged this replacement in the signed return.');
      } else
        pair(
          'Trip mileage',
          `${trip.endingMileage} - ${trip.startingMileage} = ${trip.tripMileage.toLocaleString()} miles`,
        );
    }
    heading('Condition inspection');
    pair('Fuel tank full', yesNo(inspection.fuelFull));
    if (returning) pair('Fuel receipt received', yesNo(inspection.receiptReceived));
    pair('Interior clean', yesNo(inspection.interiorClean));
    pair(returning ? 'Gas card returned' : 'Gas card issued with key', yesNo(inspection.gasCard));
    if (returning) pair('Key returned', yesNo(inspection.keyReturned));
    pair(
      'Windshield',
      { clear: 'Clear / no damage', star: 'Star damage', cracked: 'Cracked' }[
        inspection.windshield
      ],
    );
    heading('Damage markings and notes');
    if (!inspection.damage?.length) text('No chips, dents or scratches marked.');
    for (const damage of inspection.damage || [])
      text(
        `${names[damage.area] || damage.area} · ${damage.type}: ${damage.notes || 'No additional note'}`,
      );
    text(inspection.notes || 'No additional inspection notes.');
    const stageFlags = inspectionFlags(inspection);
    if (returning) {
      for (const flag of trip.flags.filter((flag) => /mileage|odometer/i.test(flag))) {
        if (!stageFlags.includes(flag)) stageFlags.push(flag);
      }
    }
    if (stageFlags.length) pair('Review flags for this inspection', stageFlags.join('; '));
    heading('Acknowledgments and signatures');
    const acks = returning ? trip.returnAcknowledgments : trip.checkoutAcknowledgments;
    text(
      `Employee confirmed accurate information: ${yesNo(acks?.accurate)}. Remove all belongings and garbage: ${yesNo(acks?.removeBelongings)}. Return with a full fuel tank: ${yesNo(acks?.fullTank)}.${returning ? '' : ` No eating in float vehicles: ${yesNo(acks?.noEating)}.`}`,
    );
    signature(
      'Employee signature',
      returning ? trip.returnSignature : trip.checkoutSignature,
      returning ? trip.returnedAt : trip.checkoutAt,
      employee.name,
    );
    const review = reviews.find((r) => r.stage === inspectionStage);
    if (review) {
      pair(
        'Representative initials / decision',
        `${review.initials} / ${review.decision.replaceAll('_', ' ')}`,
      );
      pair('Representative review note', review.reason);
      signature(
        'Representative signature',
        review.signature,
        review.createdAt,
        review.userSnapshot.name,
      );
    } else {
      const mode = returning ? trip.returnReviewMode : trip.checkoutReviewMode;
      text(
        mode === 'representative'
          ? 'Representative initials and signature: pending authenticated administrator review. No representative approval is implied.'
          : 'Representative initials and signature: not applicable under the configured self-service workflow. No one signed on a representative’s behalf.',
      );
    }
    text(
      'Signed readings and identities above are the submitted historical record. Any later correction is shown separately in the revision appendix.',
      { size: 9, color: MUTED },
    );
  }

  if (revisions.length) {
    page('Documented corrections');
    text(
      'These revisions do not overwrite the original signed form. A pending acknowledgment means the employee has not yet accepted the correction.',
    );
    for (const revision of revisions) {
      heading(`${revision.field === 'endingMileage' ? 'Ending' : 'Starting'} odometer correction`);
      pair('Original / corrected', `${revision.originalValue} / ${revision.correctedValue} miles`);
      pair('Reason', revision.reason);
      pair(
        'Recorded by',
        `${store.getUser(revision.userId)?.name || revision.userId} · ${timestamp(revision.createdAt, zone)}`,
      );
      pair('Odometer replacement exception', yesNo(revision.odometerReplacement));
      pair('Updated current vehicle mileage', yesNo(revision.affectsCurrent));
      if (revision.acknowledgedAt)
        signature(
          'Employee renewed acknowledgment',
          revision.acknowledgmentSignature,
          revision.acknowledgedAt,
          trip.employeeSnapshot.name,
        );
      else text('Renewed employee acknowledgment: pending', { bold: true });
    }
  }

  const relevantPhotos = photos.filter((p) => stage === 'return' || p.stage === 'checkout');
  for (let index = 0; index < relevantPhotos.length; index++) {
    const photo = relevantPhotos[index];
    if (index % 2 === 0) {
      page('Condition photo appendix');
      text(
        `Times shown in ${zone}. Device-reported times and camera labels are not proof of the true capture time. Original image bytes are stored privately.`,
        { size: 9, color: MUTED },
      );
    }
    heading(
      `${photo.stage === 'checkout' ? 'Checkout' : 'Return'} · ${names[photo.view] || photo.view} · ${photo.source === 'camera' ? 'Camera capture' : 'Imported upload'}`,
    );
    try {
      await access(photo.displayPath);
      doc.image(photo.displayPath, 42, y, { fit: [width, 180], align: 'center', valign: 'center' });
    } catch {
      text(
        'Photo viewing copy is unavailable. Contact an administrator; the record references the original photo below.',
      );
    }
    y += 186;
    text(
      `Device reported: ${timestamp(photo.deviceCapturedAt, zone)}\nServer received: ${timestamp(photo.receivedAt, zone)}\nPhoto ${photo.id}`,
      { size: 8, color: MUTED },
    );
  }
  if (!relevantPhotos.length) {
    heading('Photo evidence');
    text('No finalized photos found. This report requires administrator attention.');
  }

  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index++) {
    doc.switchToPage(index);
    // Footer is within the printable margin to avoid PDFKit creating an extra page.
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${settings.appName} · Private staff record`, 42, 731, {
        width: 430,
        lineBreak: false,
      });
    doc.text(`${index + 1} / ${pages.count}`, 510, 731, {
      width: 60,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.end();
  const result = await finished;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, result, { mode: 0o600 });
  try {
    // Publish once without replacing a report another request already saved.
    await link(temporary, filename);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary);
  }
  return readFile(filename);
}
