// Stored viewing JPEGs reserve this strip below the entire normalized photograph.
export const PHOTO_STAMP_HEIGHT = 120;

export function drawPrintablePhoto(doc, bytes, x, y, width, height) {
  const image = doc.openImage(bytes);
  const sceneHeight = image.height - PHOTO_STAMP_HEIGHT;
  if (sceneHeight <= 0) throw new Error('Invalid stamped photo dimensions');
  const scale = Math.min(width / image.width, height / sceneHeight);
  const drawnWidth = image.width * scale;
  const drawnHeight = sceneHeight * scale;
  const left = x + (width - drawnWidth) / 2;
  const top = y + (height - drawnHeight) / 2;
  // Clip the legacy raster caption, keeping the JPEG at its original quality.
  // The report prints the caption separately in its own text layer.
  doc.save();
  try {
    doc.rect(left, top, drawnWidth, drawnHeight).clip();
    doc.image(image, left, top, { width: drawnWidth });
  } finally {
    doc.restore();
  }
}
