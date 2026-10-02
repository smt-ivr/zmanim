import {
  LOGIN_MAX_FAILURES_PER_IDENTIFIER,
  LOGIN_MAX_FAILURES_PER_IP,
  PASSWORD_MIN_LENGTH,
} from '../config.js';
import { loadProfile, serializeUser } from '../auth/profiles.js';
import { createSession } from '../auth/session.js';
import { assertNotLocked, clearFailures, recordFailure } from '../auth/throttle.js';
import { hashPassword, passwordNeedsRehash, timingSafeEqual, verifyPassword } from '../lib/crypto.js';
import { first, nowIso, run } from '../lib/db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { ok } from '../lib/http.js';
import { normalizeEmail, normalizePhone, Validator } from '../lib/validate.js';

let dummyHash;
// Burns the same CPU as a real check so response time does not reveal whether a user exists
async function dummyVerify(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export async function login(ctx) {
  const { env, request } = ctx;
  const v = new Validator(await ctx.body());
  v.string('identifier', { required: true, max: 120 });
  v.string('password', { required: true, max: 200, trim: false });
  const { identifier, password } = v.result();

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const idKey = `id:${identifier.toLowerCase()}`;
  const ipKey = `ip:${ip}`;
  await assertNotLocked(env, [idKey, ipKey]);

  const isEmail = identifier.includes('@');
  const user = await first(
    env,
    `SELECT id, password, password_hash, is_active FROM Users WHERE ${isEmail ? 'email' : 'phone'} = ? LIMIT 1`,
    isEmail ? normalizeEmail(identifier) : normalizePhone(identifier)
  );

  let valid = false;
  let upgradeLegacy = false;
  if (user?.password_hash) {
    valid = await verifyPassword(password, user.password_hash);
  } else if (user?.password) {
    // Legacy plaintext account: verify once, then upgrade to a hash transparently.
    valid = timingSafeEqual(password, user.password);
    upgradeLegacy = valid;
  } else {
    await dummyVerify(password);
  }

  if (!valid) {
    await recordFailure(env, [
      { key: idKey, max: LOGIN_MAX_FAILURES_PER_IDENTIFIER },
      { key: ipKey, max: LOGIN_MAX_FAILURES_PER_IP },
    ]);
    throw unauthorized('פרטי ההתחברות שגויים', 'INVALID_CREDENTIALS');
  }
  if (user.is_active !== 1) throw forbidden('החשבון מושבת. יש לפנות למנהל המערכת', 'ACCOUNT_DISABLED');

  await clearFailures(env, idKey);

  const now = nowIso();
  if (upgradeLegacy || passwordNeedsRehash(user.password_hash ?? '')) {
    await run(env, `UPDATE Users SET password_hash = ?, password = '', updated_at = ? WHERE id = ?`, await hashPassword(password), now, user.id);
  }
  await run(env, `UPDATE Users SET last_login_at = ? WHERE id = ?`, now, user.id);

  const session = await createSession(env, request, user.id);
  return ok({
    token: session.token,
    token_type: 'Bearer',
    expires_at: new Date(session.expires_at * 1000).toISOString(),
    user: serializeUser(await loadProfile(env, user.id)),
  });
}

export async function logout({ env, actor }) {
  await run(env, `DELETE FROM Sessions WHERE id = ?`, actor.session_id);
  return ok(null);
}

export async function logoutAll({ env, actor }) {
  await run(env, `DELETE FROM Sessions WHERE user_id = ?`, actor.id);
  return ok(null);
}

export const me = ({ actor }) => ok(serializeUser(actor));

export async function changePassword(ctx) {
  const { env, actor } = ctx;
  const v = new Validator(await ctx.body());
  v.string('current_password', { required: true, max: 200, trim: false });
  v.string('new_password', { required: true, min: PASSWORD_MIN_LENGTH, max: 200, trim: false });
  const { current_password, new_password } = v.result();

  const row = await first(env, `SELECT password_hash FROM Users WHERE id = ?`, actor.id);
  if (!row?.password_hash || !(await verifyPassword(current_password, row.password_hash))) {
    throw unauthorized('הסיסמה הנוכחית שגויה', 'INVALID_CREDENTIALS');
  }

  await run(env, `UPDATE Users SET password_hash = ?, updated_at = ? WHERE id = ?`, await hashPassword(new_password), nowIso(), actor.id);
  // sign out every other device
  await run(env, `DELETE FROM Sessions WHERE user_id = ? AND id != ?`, actor.id, actor.session_id);
  return ok(null);
}
