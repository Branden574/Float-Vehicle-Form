import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import diagram from '../shared/vehicle-diagram.json' with { type: 'json' };
export const diagramBounds = (returning) => ({
  x: 600,
  y: returning ? 730 : 750,
  width: 250,
  height: 390,
});
export async function buildCleanTemplate() {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-11-09T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-09T00:00:00Z'));
  const regular = await pdf.embedFont(StandardFonts.TimesRoman),
    bold = await pdf.embedFont(StandardFonts.TimesRomanBold),
    sans = await pdf.embedFont(StandardFonts.HelveticaBold);
  const original = await PDFDocument.load(
    await readFile(new URL('./templates/learn4life-original.pdf', import.meta.url)),
  );
  // Reuse only supplied brand artwork. All form rules, labels and vehicle outlines are authored here.
  const src = original.getPage(0),
    kx = src.getWidth() / 1082,
    ky = src.getHeight() / 1400;
  const logo = await pdf.embedPage(src, {
    left: 380 * kx,
    right: 700 * kx,
    bottom: src.getHeight() - 280 * ky,
    top: src.getHeight() - 45 * ky,
  });
  for (const returning of [false, true]) {
    const p = pdf.addPage([612, 792]),
      sx = 612 / (returning ? 1085 : 1082),
      sy = 792 / 1400;
    const black = rgb(0.12, 0.12, 0.12),
      gray = rgb(0.92, 0.92, 0.92);
    const line = (x, y, x2, y2, w = 0.5) =>
      p.drawLine({
        start: { x: x * sx, y: 792 - y * sy },
        end: { x: x2 * sx, y: 792 - y2 * sy },
        thickness: w,
        color: black,
      });
    const rect = (x, y, w, h, fill) =>
      p.drawRectangle({
        x: x * sx,
        y: 792 - (y + h) * sy,
        width: w * sx,
        height: h * sy,
        borderWidth: 0.5,
        borderColor: black,
        ...(fill ? { color: fill } : {}),
      });
    const text = (s, x, y, size = 20, font = regular, color = black) =>
      p.drawText(s, { x: x * sx, y: 792 - (y + size) * sy, size: size * sy, font, color });
    p.drawPage(logo, {
      x: 380 * sx,
      y: 792 - (returning ? 310 : 280) * sy,
      width: 320 * sx,
      height: 235 * sy,
    });
    const left = returning ? 80 : 88,
      right = 972,
      top = returning ? 332 : 320,
      split = returning ? 420 : 430;
    rect(left, top, right - left, 1152 - top);
    line(left, split, right, split);
    line(left, 485, right, 485);
    line(returning ? 582 : 570, top, returning ? 582 : 570, 485);
    line(returning ? 788 : 780, top, returning ? 788 : 780, 485);
    line(300, split, 300, 485);
    text('Employee Name :', left + 9, top + 2);
    if (returning) {
      text('Check-in Date:', 590, top + 2);
      text('Check In Time:', 798, top + 2);
    } else {
      text('Check-out Date & Time :', 580, top + 2, 19);
      text('Projected Return Date', 790, top + 2, 18);
      text('& Time:', 845, top + 24, 18);
    }
    text('Department :', left + 9, split + 2);
    text('Manager:', 309, split + 2);
    text('Vin ID # (Last 4 digits):', returning ? 590 : 580, split + 2, 18);
    text(
      returning ? 'Check In Rep Initials:' : 'Check Out Rep Initials',
      returning ? 798 : 790,
      split + 2,
      18,
    );
    rect(left, 485, right - left, 35, gray);
    text(returning ? 'Check In' : 'Check Out', 455, 483, 30, bold);
    const questions = returning
      ? [
          'Is the fuel tank full and receipt received?',
          'Is the vehicle’s interior clean?',
          'Did employee return the gas card?',
        ]
      : [
          'Is the employee on the float pool car authorized list?',
          'Is the fuel tank full?',
          'Is the vehicle’s interior clean?',
          'Was the gas card issued to employee along with key?',
        ];
    questions.forEach((q, i) => {
      const y = 520 + i * 24;
      line(left, y + 24, right, y + 24);
      line(returning ? 582 : 570, y, returning ? 582 : 570, y + 24);
      line(returning ? 788 : 780, y, returning ? 788 : 780, y + 24);
      text(q, left + 8, y, 19);
      rect(returning ? 591 : 578, y + 3, 19, 19);
      text('Yes', returning ? 618 : 606, y, 20);
      rect(returning ? 797 : 788, y + 3, 19, 19);
      text('No', returning ? 824 : 816, y, 20);
    });
    const oy = returning ? 610 : 630;
    rect(105, oy, 335, 102);
    text('Odometer Reading:', 118, oy + 7, 22, bold);
    rect(returning ? 112 : 118, oy + 50, 315, 40);
    for (let i = 1; i < 6; i++)
      line(
        (returning ? 112 : 118) + i * 52.5,
        oy + 50,
        (returning ? 112 : 118) + i * 52.5,
        oy + 90,
      );
    text('Windshield Condition', 610, oy + 8, 22, bold);
    rect(returning ? 664 : 666, returning ? 663 : 683, 18, 18);
    text('No Damage', 690, returning ? 660 : 680, 20);
    text('Clear', 635, returning ? 704 : 724, 20);
    text('Star', 705, returning ? 704 : 724, 20);
    text('Cracked', 765, returning ? 704 : 724, 20);
    const ly = returning ? 845 : 865;
    rect(96, ly, 345, 100);
    rect(96, ly, 345, 24, gray);
    text('Damage Legend', 167, ly - 1, 22, bold);
    line(96, ly + 51, 441, ly + 51);
    line(270, ly + 24, 270, ly + 100);
    text(':::  Chips', 105, ly + 24);
    text('x  Dent', 280, ly + 24);
    text('~  Scratch', 105, ly + 53);
    const d = diagramBounds(returning),
      scale = (d.width / diagram.width) * sx;
    for (const path of diagram.paths)
      p.drawSvgPath(path, {
        x: d.x * sx,
        y: 792 - d.y * sy,
        scale,
        borderWidth: 0.75,
        borderColor: rgb(0.28, 0.31, 0.33),
      });
    for (const [cx, cy, r] of diagram.circles)
      p.drawEllipse({
        x: d.x * sx + cx * scale,
        y: 792 - d.y * sy - cy * scale,
        xScale: r * scale,
        yScale: r * scale,
        borderWidth: 0.75,
        borderColor: rgb(0.28, 0.31, 0.33),
      });
    if (!returning) {
      const red = rgb(0.65, 0.1, 0.15);
      text('*PLEASE*', 96, 1040, 23, sans, red);
      text('Do not eat in float vehicles and make', 96, 1070, 22, sans, red);
      text('sure to remove all your belongings/', 96, 1098, 22, sans, red);
      text('garbage.', 96, 1125, 22, sans, red);
    }
    text(
      returning
        ? 'By signing this below, you acknowledge that the above mentioned information is accurate.'
        : 'By signing below, you acknowledge that the above mentioned information is accurate.',
      returning ? 200 : 190,
      1174,
      18,
    );
    if (!returning) {
      p.drawRectangle({
        x: 265 * sx,
        y: 792 - 1226 * sy,
        width: 540 * sx,
        height: 24 * sy,
        color: rgb(1, 0.93, 0.4),
      });
      text(
        'All vehicles must be returned with a full tank of gas upon check-in.',
        269,
        1203,
        18,
        bold,
      );
    }
    const ry = returning ? 1220 : 1250,
      ey = returning ? 1285 : 1315;
    text(
      returning ? 'Check In Rep Signature:' : 'Check Out Rep Signature:',
      returning ? 92 : 110,
      ry,
      19,
    );
    line(returning ? 280 : 306, ry + 20, 630, ry + 20);
    text('Date:', 650, ry, 19);
    line(704, ry + 20, 854, ry + 20);
    text('Employee Signature:', returning ? 92 : 110, ey, 19);
    line(returning ? 280 : 306, ey + 20, 630, ey + 20);
    text('Date:', 650, ey, 19);
    line(704, ey + 20, 854, ey + 20);
  }
  return Buffer.from(await pdf.save());
}
