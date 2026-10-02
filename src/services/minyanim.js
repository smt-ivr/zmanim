import { scopeClause } from '../auth/permissions.js';
import { all, batch, first, parseIdList, prepare, toBool } from '../lib/db.js';
import { validationError } from '../lib/errors.js';
import { TIME_RE } from '../lib/validate.js';

const SELECT = `
  SELECT m.id, m.synagogue_id, s.name AS synagogue_name, s.address AS synagogue_address,
         s.area_id, a.name AS area_name,
         m.location_id, l.name AS location_name,
         m.prayer_type_id, p.name AS prayer_type,
         m.season_id, se.name AS season,
         m.time_type_id, t.name AS time_type, t.is_relative,
         m.time_value, m.notes
  FROM Minyanim m
  JOIN Synagogues s ON s.id = m.synagogue_id
  LEFT JOIN Areas a ON a.id = s.area_id
  LEFT JOIN Locations l ON l.id = m.location_id
  LEFT JOIN PrayerTypes p ON p.id = m.prayer_type_id
  LEFT JOIN Seasons se ON se.id = m.season_id
  LEFT JOIN TimeTypes t ON t.id = m.time_type_id`;

export const serializeMinyan = (row) => ({ ...row, is_relative: toBool(row.is_relative) });

const FILTERS = {
  synagogue_id: 'm.synagogue_id',
  area_id: 's.area_id',
  location_id: 'm.location_id',
  prayer_type_id: 'm.prayer_type_id',
  season_id: 'm.season_id',
};

/** actor = null for the public endpoint (no scope restriction, same fields). */
export async function queryMinyanim(env, { actor = null, filters = {}, limit, offset }) {
  const where = [];
  const params = [];
  if (actor) {
    const scope = scopeClause(actor, 'm.synagogue_id');
    where.push(scope.sql);
    params.push(...scope.params);
  }
  for (const [name, column] of Object.entries(FILTERS)) {
    if (filters[name] !== null && filters[name] !== undefined) {
      where.push(`${column} = ?`);
      params.push(filters[name]);
    }
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.id LIMIT ? OFFSET ?`;
  const rows = await all(env, sql, ...params, limit, offset);
  return rows.map(serializeMinyan);
}

export async function getMinyanView(env, id) {
  const row = await first(env, `${SELECT} WHERE m.id = ?`, id);
  return row ? serializeMinyan(row) : null;
}

/**
 * Validates a complete minyan (references exist, location belongs to the synagogue,
 * time format and allowed range, time type compatible with prayer type).
 * Returns the normalized values to store.
 */
export async function validateMinyan(env, m) {
  const results = await batch(env, [
    prepare(env, `SELECT id FROM Synagogues WHERE id = ?`, m.synagogue_id),
    prepare(env, `SELECT * FROM PrayerTypes WHERE id = ?`, m.prayer_type_id),
    prepare(env, `SELECT * FROM TimeTypes WHERE id = ?`, m.time_type_id),
    prepare(env, `SELECT id FROM Seasons WHERE id = ?`, m.season_id),
    prepare(env, `SELECT id, synagogue_id FROM Locations WHERE id = ?`, m.location_id),
  ]);
  const [synagogue, prayer, timeType, season, location] = results.map((r) => r.results[0] ?? null);

  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!synagogue) err('synagogue_id', 'בית הכנסת לא קיים');
  if (!prayer) err('prayer_type_id', 'סוג התפילה לא קיים');
  if (!timeType) err('time_type_id', 'סוג הזמן לא קיים');
  if (!season) err('season_id', 'העונה לא קיימת');
  if (m.location_id !== null) {
    if (!location) err('location_id', 'המיקום לא קיים');
    else if (location.synagogue_id !== m.synagogue_id) err('location_id', 'המיקום אינו שייך לבית הכנסת שנבחר');
  }

  if (prayer && timeType) {
    const allowed = parseIdList(timeType.allowed_prayer_ids);
    if (allowed.length && !allowed.includes(prayer.id)) err('time_type_id', 'סוג הזמן אינו מתאים לתפילה שנבחרה');
  }

  let timeValue = m.time_value;
  if (timeType) {
    if (!toBool(timeType.is_relative)) {
      if (!TIME_RE.test(timeValue)) {
        err('time_value', 'פורמט שעה נדרש: HH:MM');
      } else if (prayer) {
        if (prayer.allow_update_from && timeValue < prayer.allow_update_from) {
          err('time_value', `לא ניתן לקבוע מניין זה לפני השעה ${prayer.allow_update_from}`);
        }
        if (prayer.allow_update_to && timeValue > prayer.allow_update_to) {
          err('time_value', `לא ניתן לקבוע מניין זה לאחר השעה ${prayer.allow_update_to}`);
        }
      }
    } else if (!/^[-+]?\d{1,4}$/.test(timeValue) || Math.abs(parseInt(timeValue, 10)) > 720) {
      err('time_value', 'זמן יחסי חייב להיות מספר דקות שלם (למשל 20 או -15)');
    } else {
      timeValue = String(parseInt(timeValue, 10));
    }
  }

  if (errors.length) throw validationError(errors);
  return { ...m, time_value: timeValue };
}
