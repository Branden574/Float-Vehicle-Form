import { randomBytes } from 'node:crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { hash, now, passwordHash, passwordMatches } from './store.js';
import { fail, validate } from './validation.js';
import { z } from 'zod';

export function installAuth(
  app,
  store,
  {
    secureCookies = process.env.NODE_ENV === 'production',
    publicOrigin = process.env.PUBLIC_ORIGIN,
  } = {},
) {
  const { db } = store;
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' };
  const publicSettings = () => {
    const { notificationRecipients, ...s } = store.getSettings();
    return s;
  };
  const response = (user, csrfToken) => ({
    user,
    csrfToken,
    settings: user.role === 'admin' ? store.getSettings() : publicSettings(),
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
        if (origin !== expected)
          return next(
            Object.assign(new Error('This request did not originate from this app.'), {
              status: 403,
            }),
          );
      }
      if (req.get('Sec-Fetch-Site') === 'cross-site')
        return next(
          Object.assign(new Error('Cross-site requests are not accepted.'), { status: 403 }),
        );
    }
    next();
  });
  app.get('/api/public-settings', (req, res) =>
    res.json({
      appName: store.getSettings().appName,
      organizationName: store.getSettings().organizationName,
      logoUrl: store.getSettings().logoUrl,
      accentColor: store.getSettings().accentColor,
    }),
  );
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });
  const accountLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip)}:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : 'invalid'}`,
    message: {
      error: 'Too many unsuccessful sign-in attempts for this account. Try again in 15 minutes.',
    },
  });
  app.post('/api/auth/login', loginLimit, accountLimit, (req, res) => {
    const data = validate(
      z.object({ email: z.email().max(254), password: z.string().max(200) }),
      req.body,
    );
    const r = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(data.email.trim());
    // Equal-cost derivation for unknown accounts avoids a cheap account-enumeration timing signal.
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const matches = passwordMatches(data.password, r?.password_hash || dummy);
    if (!r?.active || !matches)
      fail(401, 'Email or password is incorrect, or the account is inactive.');
    if (req.cookies.fleet_session)
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.fleet_session));
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex'),
      time = now(),
      expires = new Date(Date.now() + 8 * 3600000).toISOString();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(
      hash(token),
      r.id,
      csrf,
      time,
      time,
      expires,
    );
    res.cookie('fleet_session', token, cookieOptions).json(response(store.publicUser(r), csrf));
  });
  app.post('/api/auth/accept-invite', loginLimit, (req, res) => {
    const { token, password } = validate(
      z.object({
        token: z.string().min(32).max(200),
        password: z.string().min(12, 'Use at least 12 characters.').max(200),
      }),
      req.body,
    );
    const user = db
      .prepare('SELECT * FROM users WHERE invite_hash=? AND invite_expires_at>? AND active=1')
      .get(hash(token), now());
    if (!user)
      fail(
        400,
        'This invitation is invalid or expired. Ask an administrator for a new invitation.',
      );
    db.prepare(
      'UPDATE users SET password_hash=?,invite_hash=NULL,invite_expires_at=NULL WHERE id=?',
    ).run(passwordHash(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    store.audit(
      user.id,
      'accept_invite',
      'user',
      user.id,
      null,
      { accepted: true },
      'Individual account activated by invite holder',
    );
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    const token = req.cookies.fleet_session;
    if (!token)
      return next(Object.assign(new Error('Please sign in to continue.'), { status: 401 }));
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash(token));
    const user = session ? store.getUser(session.user_id) : null;
    if (
      !session ||
      !user?.active ||
      Date.parse(session.expires_at) < Date.now() ||
      Date.parse(session.last_seen_at) < Date.now() - store.getSettings().sessionMinutes * 60000
    ) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
      res.clearCookie('fleet_session', cookieOptions);
      return next(
        Object.assign(
          new Error('Your session expired. Sign in again; unsent forms were not submitted.'),
          { status: 401 },
        ),
      );
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('X-CSRF-Token') !== session.csrf_token
    )
      return next(
        Object.assign(new Error('Your session security token is missing. Refresh and try again.'), {
          status: 403,
        }),
      );
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(now(), hash(token));
    req.user = user;
    req.session = session;
    next();
  });
  app.get('/api/auth/me', (req, res) => res.json(response(req.user, req.session.csrf_token)));
  app.post('/api/auth/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.clearCookie('fleet_session', cookieOptions);
    res.set('Clear-Site-Data', '"cache", "storage"');
    res.status(204).end();
  });
  return { publicSettings };
}
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin')
    return next(Object.assign(new Error('Administrator access is required.'), { status: 403 }));
  next();
}
export function requireTripAccess(store, req, id) {
  const trip = store.getTrip(id);
  if (!trip) fail(404, 'Trip not found.');
  if (req.user.role !== 'admin' && trip.employeeId !== req.user.id)
    fail(403, 'You can only access your own trips.');
  return trip;
}
