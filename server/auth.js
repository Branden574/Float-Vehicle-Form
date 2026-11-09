import { createEmailSender } from './notifications.js';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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
    sendSignInCode,
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
  db.exec(
    `CREATE TABLE IF NOT EXISTS login_codes (id TEXT PRIMARY KEY,email_lookup TEXT NOT NULL,email_json TEXT NOT NULL,code_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS login_code_email ON login_codes(email_lookup,created_at);`,
  );
  const beginSession = (req, res, user) => {
    if (req.cookies.fleet_session)
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.fleet_session));
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex'),
      time = now(),
      expires = new Date(Date.now() + 8 * 3600000).toISOString();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(
      hash(token),
      user.id,
      csrf,
      time,
      time,
      expires,
    );
    res.cookie('fleet_session', token, cookieOptions).json(response(user, csrf));
  };
  const codeLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many code requests. Try again in 15 minutes.' },
  });
  app.post('/api/auth/request-code', codeLimit, async (req, res) => {
    const { email } = validate(z.object({ email: z.email().max(254) }).strict(), req.body);
    if (
      !sendSignInCode &&
      (!process.env.EMAIL_PROVIDER || process.env.EMAIL_PROVIDER === 'disabled')
    )
      fail(
        503,
        'Email sign-in is not configured yet. Your administrator must connect the approved sender. Existing users can use password sign-in for now.',
      );
    const lookup = store.emailLookup(email),
      time = now();
    db.prepare('DELETE FROM login_codes WHERE created_at<?').run(
      new Date(Date.now() - 86400000).toISOString(),
    );
    const recent = db
      .prepare(
        'SELECT created_at FROM login_codes WHERE email_lookup=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(lookup);
    if (recent && Date.parse(recent.created_at) > Date.now() - 60000)
      fail(429, 'Wait one minute before requesting another code.');
    const id = randomBytes(24).toString('hex'),
      code = String(randomInt(1000000)).padStart(6, '0');
    db.transaction(() => {
      db.prepare('DELETE FROM login_codes WHERE email_lookup=?').run(lookup);
      db.prepare('INSERT INTO login_codes VALUES(?,?,?,?,?,?,0)').run(
        id,
        lookup,
        store.encodeJSON(email.toLowerCase()),
        store.emailLookup('code:' + id + ':' + code),
        time,
        new Date(Date.now() + 600000).toISOString(),
      );
    })();
    try {
      await (sendSignInCode || createEmailSender())({
        to: [email],
        subject: 'Your Learn4Life sign-in code',
        text: `Your sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
        messageId: `<login-${id}@fleet.local>`,
        attachments: [],
      });
    } catch {
      db.prepare('DELETE FROM login_codes WHERE id=?').run(id);
      fail(
        503,
        'The sign-in email could not be sent. Contact your administrator or try again later.',
      );
    }
    res.json({ challengeId: id, expiresInSeconds: 600 });
  });
  app.post('/api/auth/verify-code', loginLimit, (req, res) => {
    const { challengeId, code } = validate(
      z
        .object({
          challengeId: z.string().regex(/^[a-f0-9]{48}$/),
          code: z.string().regex(/^\d{6}$/),
        })
        .strict(),
      req.body,
    );
    // Count failed guesses outside the consuming transaction so errors cannot roll them back.
    const r = db.prepare('SELECT * FROM login_codes WHERE id=?').get(challengeId);
    if (!r || r.attempts >= 5 || Date.parse(r.expires_at) < Date.now())
      fail(401, 'Code is incorrect or expired. Request a new code.');
    db.prepare('UPDATE login_codes SET attempts=attempts+1 WHERE id=?').run(challengeId);
    if (
      !timingSafeEqual(
        Buffer.from(r.code_hash, 'hex'),
        Buffer.from(store.emailLookup('code:' + challengeId + ':' + code), 'hex'),
      )
    )
      fail(401, 'Code is incorrect or expired. Request a new code.');
    const user = db.transaction(() => {
      if (db.prepare('DELETE FROM login_codes WHERE id=?').run(challengeId).changes !== 1)
        fail(401, 'Code was already used.');
      const existing = db.prepare('SELECT * FROM users WHERE email=?').get(r.email_lookup);
      if (existing && !existing.active)
        fail(401, 'Sign-in is unavailable. Contact your administrator.');
      const user = existing
        ? store.publicUser(existing)
        : store.createUser({
            email: store.decodeJSON(r.email_json),
            name: '',
            role: 'staff',
            authorizedDriver: false,
          });
      db.prepare('UPDATE users SET invite_hash=NULL,invite_expires_at=NULL WHERE id=?').run(
        user.id,
      );
      store.audit(
        user.id,
        'email_code_signin',
        'user',
        user.id,
        null,
        { verified: true },
        'One-time email code verified',
      );
      return user;
    })();
    beginSession(req, res, user);
  });
  app.post('/api/auth/login', loginLimit, accountLimit, (req, res) => {
    const data = validate(
      z.object({ email: z.email().max(254), password: z.string().max(200) }),
      req.body,
    );
    const r = db
      .prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE')
      .get(store.emailLookup(data.email));
    // Equal-cost derivation for unknown accounts avoids a cheap account-enumeration timing signal.
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const matches = passwordMatches(data.password, r?.password_hash || dummy);
    if (!r?.active || !matches)
      fail(401, 'Email or password is incorrect, or the account is inactive.');
    beginSession(req, res, store.publicUser(r));
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
  app.patch('/api/auth/profile', (req, res) => {
    const data = validate(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          email: z.email().max(254),
          charter: z.string().trim().min(1).max(200),
          department: z.string().trim().max(200).default(''),
          manager: z.string().trim().min(1).max(200),
        })
        .strict(),
      req.body,
    );
    if (data.email.toLowerCase() !== req.user.email.toLowerCase())
      fail(400, 'Use your invited sign-in email. Ask an administrator to change it.');
    const user = db.transaction(() => {
      const updated = store.updateUser(req.user.id, {
        ...req.user,
        ...data,
        department: data.department || data.charter,
      });
      store.audit(
        req.user.id,
        'update_own_profile',
        'user',
        req.user.id,
        req.user,
        updated,
        'Employee saved their own profile',
      );
      return updated;
    })();
    res.json(response(user, req.session.csrf_token));
  });
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
