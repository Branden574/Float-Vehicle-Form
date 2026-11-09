const part = (value, fallback) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '') || fallback;

function localDate(value, timezone) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Date-not-recorded';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** Public download label only; immutable storage keys never contain staff names. */
export function reportFilename(trip, stage) {
  if (!['checkout', 'return'].includes(stage)) throw new Error('Invalid report stage');
  const zone = trip.checkoutSettings?.timezone || 'America/Los_Angeles';
  const base = `${part(trip.employeeSnapshot?.name, 'Employee')}_${part(trip.vehicleSnapshot?.name, 'Vehicle')}_Out-${localDate(trip.checkoutAt, zone)}`;
  return stage === 'checkout'
    ? `${base}_Checkout.pdf`
    : `${base}_In-${localDate(trip.returnedAt, zone)}_Checkout-and-Check-in.pdf`;
}
