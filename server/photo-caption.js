import { fileURLToPath } from 'node:url';
import { openSync } from 'fontkit';
import { PHOTO_STAMP_HEIGHT } from './photo-layout.js';

const font = openSync(fileURLToPath(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url)));

// The image worker can run without system fonts. Give it the actual glyph outlines.
export function photoCaption(width, lines) {
  const rows = lines.map((line, index) => {
    const run = font.layout(line);
    const scale = Math.min(
      (width < 900 ? 12 : 16) / font.unitsPerEm,
      (width - 32) / run.advanceWidth,
    );
    let x = 0;
    const paths = run.glyphs.map((glyph, i) => {
      const position = run.positions[i];
      const shape = glyph.id ? glyph : font.glyphForCodePoint(63);
      const path = `<path transform="translate(${x + position.xOffset} ${position.yOffset})" d="${shape.path.toSVG()}"/>`;
      x += position.xAdvance;
      return path;
    });
    return `<g transform="translate(16 ${24 + index * 26}) scale(${scale} ${-scale})" fill="white">${paths.join('')}</g>`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PHOTO_STAMP_HEIGHT}"><rect width="100%" height="100%" fill="#102c33"/>${rows.join('')}</svg>`,
  );
}
