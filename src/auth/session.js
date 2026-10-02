import {
  MAX_SESSIONS_PER_USER,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SESSION_TTL_SECONDS,
} from '../config.js';
import { generateToken, sha256Hex } from '../lib/crypto.js';
import { batch, first, nowSec, prepare, run } from '../lib/db.js';
import { unauthorized } from '../lib/errors.js';
import { loadProfile } from './profiles.js';

export async function createSession(env, request, userId) {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const now = nowSec();
  const expiresAt = now + SESSION_TTL_SECONDS;

  await batch(env, [
    prepare(env, `DELETE FROM Sessions WHERE user_id = ? AND expires_at <= ?`, userId, now),
    // keep only the (MAX - 1) most recently used sessions, then add the new one
    prepare(
      env,
      `DELETE FROM Sessions WHERE user_id = ? AND id NOT IN
         (SELECT id FROM Sessions WHERE user_id = ? ORDER BY last_used_at DESC, id DESC LIMIT ?)`,
      userId,
      userId,
      MAX_SESSIONS_PER_USER - 1
    ),
    prepare(
      env,
      `INSERT INTO Sessions (user_id, token_hash, created_at, expires_at, last_used_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId,
      tokenHash,
      now,
      expiresAt,
      now,
      (request.headers.get('User-Agent') || '').slice(0, 255),
      request.headers.get('CF-Connecting-IP') || ''
    ),
  ]);

  return { token, expires_at: expiresAt };
}

// Resolves the Bearer token to a full actor profile or throws 401.
export async function authenticate(env, request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!match) throw unauthorized();

  const session = await first(
    env,
    `SELECT id, user_id, expires_at, last_used_at FROM Sessions WHERE token_hash = ?`,
    await sha256Hex(match[1])
  );
  const now = nowSec();
  if (!session || session.expires_at <= now) {
    throw unauthorized('ההתחברות פגה, יש להתחבר מחדש', 'SESSION_EXPIRED');
  }

  const profile = await loadProfile(env, session.user_id);
  if (!profile || !profile.is_active) throw unauthorized('החשבון אינו פעיל', 'ACCOUNT_DISABLED');

  if (now - session.last_used_at > SESSION_TOUCH_INTERVAL_SECONDS) {
    await run(env, `UPDATE Sessions SET last_used_at = ? WHERE id = ?`, now, session.id);
  }
  return { ...profile, session_id: session.id };
}
