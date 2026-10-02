import { LOGIN_LOCK_SECONDS, LOGIN_WINDOW_SECONDS } from '../config.js';
import { all, nowSec, prepare, batch, run } from '../lib/db.js';
import { tooManyRequests } from '../lib/errors.js';

// Throws 429 if any of the keys is currently locked out.
export async function assertNotLocked(env, keys) {
  const now = nowSec();
  const marks = keys.map(() => '?').join(',');
  const rows = await all(env, `SELECT locked_until FROM LoginAttempts WHERE key IN (${marks}) AND locked_until > ?`, ...keys, now);
  if (rows.length) {
    const until = Math.max(...rows.map((r) => r.locked_until));
    throw tooManyRequests(until - now);
  }
}

// entries: [{ key, max }]
export async function recordFailure(env, entries) {
  const now = nowSec();
  const windowStart = now - LOGIN_WINDOW_SECONDS;
  await batch(
    env,
    entries.map(({ key, max }) =>
      prepare(
        env,
        // In SQLite upserts every SET expression sees the OLD row values.
        `INSERT INTO LoginAttempts (key, failures, window_start, locked_until) VALUES (?, 1, ?, 0)
         ON CONFLICT(key) DO UPDATE SET
           failures     = CASE WHEN window_start < ? THEN 1 ELSE failures + 1 END,
           window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END,
           locked_until = CASE WHEN (CASE WHEN window_start < ? THEN 1 ELSE failures + 1 END) >= ? THEN ? ELSE locked_until END`,
        key, now,
        windowStart,
        windowStart, now,
        windowStart, max, now + LOGIN_LOCK_SECONDS
      )
    )
  );
}

export const clearFailures = (env, key) => run(env, `DELETE FROM LoginAttempts WHERE key = ?`, key);

// Called from the daily cron
export async function purgeExpired(env) {
  const now = nowSec();
  await batch(env, [
    prepare(env, `DELETE FROM Sessions WHERE expires_at <= ?`, now),
    prepare(env, `DELETE FROM LoginAttempts WHERE locked_until < ? AND window_start < ?`, now, now - LOGIN_WINDOW_SECONDS),
  ]);
}
