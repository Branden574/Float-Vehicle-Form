import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { fail } from './validation.js';
import { now } from './store.js';

const base = '/api/auth/passkeys';
const invalid = () =>
  fail(400, 'Passkey verification did not complete. Try again or use an email code.');

export function passkeyRoutes({ app, store, publicOrigin, beginSession, limit }) {
  const { db } = store;
  // Trust deployment configuration, including isolated review and local test origins.
  const origin = new URL(
    publicOrigin ||
      (process.env.REVIEW_WORKSPACE === 'true'
        ? 'https://fleet-checkout-review.vercel.app'
        : 'https://fleetcheckout.app'),
  ).origin;
  const rpID = new URL(origin).hostname;
  async function remember(options, purpose, sessionHash = null) {
    await db.prepare('DELETE FROM passkey_challenges WHERE expires_at<=?').run(now());
    await db
      .prepare(
        'INSERT INTO passkey_challenges(challenge,purpose,expires_at,session_hash) VALUES(?,?,?,?)',
      )
      .run(options.challenge, purpose, new Date(Date.now() + 300000).toISOString(), sessionHash);
    return options;
  }
  async function verify(req, purpose, verification, params) {
    const { challenge, credential } = req.body || {};
    if (typeof challenge !== 'string' || challenge.length > 256 || !credential?.response) invalid();
    const query =
      purpose === 'register'
        ? db.prepare(
            'DELETE FROM passkey_challenges WHERE challenge=? AND purpose=? AND expires_at>? AND session_hash=?',
          )
        : db.prepare(
            'DELETE FROM passkey_challenges WHERE challenge=? AND purpose=? AND expires_at>? AND session_hash IS NULL',
          );
    const args = [challenge, purpose, now()];
    if (purpose === 'register') args.push(req.session.token_hash);
    if (!(await query.run(...args)).changes) invalid();
    try {
      const result = await verification({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        ...params,
      });
      if (result.verified) return result;
    } catch {
      /* Reject malformed responses without exposing authenticator details. */
    }
    invalid();
  }
  const fresh = (req) => {
    if (Date.parse(req.session.created_at) < Date.now() - 10 * 60000)
      fail(403, 'Sign out and sign in again before changing your passkeys.');
  };
  app.post(base + '/sign-in/options', limit, async (_req, res) => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    res.json(await remember(options, 'sign-in'));
  });
  app.post(base + '/sign-in/verify', limit, async (req, res) => {
    const id = req.body?.credential?.id;
    if (typeof id !== 'string' || id.length > 2048) invalid();
    const key = await db.prepare('SELECT * FROM passkeys WHERE id=?').get(id);
    if (
      !key ||
      req.body.credential.response?.userHandle !== Buffer.from(key.user_id).toString('base64url')
    )
      invalid();
    const { authenticationInfo } = await verify(req, 'sign-in', verifyAuthenticationResponse, {
      credential: {
        id: key.id,
        publicKey: Buffer.from(key.public_key, 'base64url'),
        counter: key.counter,
      },
    });
    const user = await store.getUser(key.user_id);
    if (
      !user?.active ||
      !(
        await db
          .prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?')
          .run(authenticationInfo.newCounter, id, key.counter)
      ).changes
    )
      invalid();
    await beginSession(req, res, user);
  });
  // Mount these only after the normal session, fleet access and CSRF middleware.
  return function mountAccountRoutes() {
    app.post(base + '/register/options', limit, async (req, res) => {
      fresh(req);
      const keys = await db.prepare('SELECT id FROM passkeys WHERE user_id=?').all(req.user.id);
      if (keys.length >= 12) fail(400, 'Remove existing passkeys before adding another.');
      const options = await generateRegistrationOptions({
        rpName: 'Fleet Checkout',
        rpID,
        userName: req.user.email,
        userDisplayName: req.user.name || req.user.email,
        userID: Buffer.from(req.user.id),
        supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: keys,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestationType: 'none',
      });
      res.json(await remember(options, 'register', req.session.token_hash));
    });
    app.post(base + '/register/verify', limit, async (req, res) => {
      fresh(req);
      const {
        registrationInfo: { credential },
      } = await verify(req, 'register', verifyRegistrationResponse, {
        supportedAlgorithmIDs: [-7, -257],
      });
      await db.transaction(async () => {
        const session = await db
          .prepare('SELECT user_id FROM sessions WHERE token_hash=?')
          .get(req.session.token_hash);
        if (session?.user_id !== req.user.id) invalid();
        const { count } = await db
          .prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?')
          .get(req.user.id);
        if (count >= 12) fail(400, 'Remove existing passkeys before adding another.');
        await db
          .prepare(
            'INSERT INTO passkeys(id,user_id,public_key,counter,created_at) VALUES(?,?,?,?,?)',
          )
          .run(
            credential.id,
            req.user.id,
            Buffer.from(credential.publicKey).toString('base64url'),
            credential.counter,
            now(),
          );
      })();
      res.json({ ok: true });
    });
    app.post(base + '/remove', async (req, res) => {
      fresh(req);
      await db.prepare('DELETE FROM passkeys WHERE user_id=?').run(req.user.id);
      res.json({ ok: true });
    });
    app.get(base, async (req, res) => {
      const { count } = await db
        .prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?')
        .get(req.user.id);
      res.json({ count });
    });
  };
}
