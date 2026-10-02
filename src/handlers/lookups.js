import { requirePermission } from '../auth/permissions.js';
import { all, batch, first, nowIso, parseIdList, prepare, toBool, toFlag } from '../lib/db.js';
import { conflict, notFound } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { TIME_RE, Validator, idParam } from '../lib/validate.js';

/**
 * Reference tables are managed through one declarative config.
 * Table/column names come ONLY from this config (never from user input).
 *
 * If your tables have extra columns that the UI edits, add them under `fields` — one line each.
 * Extra columns are always returned on reads (SELECT *), they just are not writable until declared.
 */
export const LOOKUPS = {
  areas: {
    path: '/areas',
    table: 'Areas',
    label: 'האזור',
    fields: { name: { type: 'string', required: true, max: 100 } },
    usedBy: [{ table: 'Synagogues', column: 'area_id', label: 'בתי כנסת' }],
  },
  'prayer-types': {
    path: '/prayer-types',
    table: 'PrayerTypes',
    label: 'סוג התפילה',
    fields: {
      name: { type: 'string', required: true, max: 100 },
      allow_update_from: { type: 'time' },
      allow_update_to: { type: 'time' },
    },
    usedBy: [{ table: 'Minyanim', column: 'prayer_type_id', label: 'מניינים' }],
  },
  'time-types': {
    path: '/time-types',
    table: 'TimeTypes',
    label: 'סוג הזמן',
    fields: {
      name: { type: 'string', required: true, max: 100 },
      is_relative: { type: 'bool' },
      allowed_prayer_ids: { type: 'idlist' },
    },
    usedBy: [{ table: 'Minyanim', column: 'time_type_id', label: 'מניינים' }],
  },
  seasons: {
    path: '/seasons',
    table: 'Seasons',
    label: 'העונה',
    fields: {
      name: { type: 'string', required: true, max: 100 },
      is_default: { type: 'bool' },
    },
    exclusiveFlag: 'is_default', // at most one row may have this flag, and it cannot be unset directly
    usedBy: [{ table: 'Minyanim', column: 'season_id', label: 'מניינים' }],
  },
};

// DB row -> API shape (booleans and id lists become real JSON types)
export function serializeLookup(config, row) {
  const out = { ...row };
  for (const [key, spec] of Object.entries(config.fields)) {
    if (!(key in out)) continue;
    if (spec.type === 'bool') out[key] = toBool(out[key]);
    if (spec.type === 'idlist') out[key] = parseIdList(out[key]);
  }
  return out;
}

function validate(config, body, partial) {
  const v = new Validator(body, { partial });
  for (const [key, spec] of Object.entries(config.fields)) {
    if (spec.type === 'string') v.string(key, { required: spec.required, max: spec.max ?? 100 });
    if (spec.type === 'time') v.string(key, { nullable: true, pattern: TIME_RE, patternMessage: 'פורמט שעה נדרש: HH:MM' });
    if (spec.type === 'bool') v.bool(key);
    if (spec.type === 'idlist') v.intArray(key, { nullable: true });
  }
  return v.result();
}

// API values -> DB values
function toDb(config, values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const type = config.fields[key].type;
    if (type === 'bool') out[key] = toFlag(value);
    else if (type === 'idlist') out[key] = value.length ? JSON.stringify(value) : null;
    else out[key] = value;
  }
  return out;
}

async function getRow(env, config, id) {
  const row = await first(env, `SELECT * FROM ${config.table} WHERE id = ?`, id);
  if (!row) throw notFound(`${config.label} לא נמצא`);
  return row;
}

function makeHandlers(config) {
  const flag = config.exclusiveFlag;

  return {
    async list({ env }) {
      const rows = await all(env, `SELECT * FROM ${config.table} ORDER BY id`);
      return ok(rows.map((r) => serializeLookup(config, r)));
    },

    async create(ctx) {
      requirePermission(ctx.actor, 'settings:manage');
      const values = toDb(config, validate(config, await ctx.body(), false));
      const keys = Object.keys(values);
      const insert = prepare(
        ctx.env,
        `INSERT INTO ${config.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        ...Object.values(values)
      );
      const statements = flag && values[flag] === 1 ? [prepare(ctx.env, `UPDATE ${config.table} SET ${flag} = 0`), insert] : [insert];
      const results = await batch(ctx.env, statements);
      const id = results[results.length - 1].meta.last_row_id;
      return created(serializeLookup(config, await getRow(ctx.env, config, id)));
    },

    async update(ctx) {
      requirePermission(ctx.actor, 'settings:manage');
      const id = idParam(ctx.params.id);
      const current = await getRow(ctx.env, config, id);
      const values = toDb(config, validate(config, await ctx.body(), true));
      const keys = Object.keys(values);
      if (keys.length === 0) return ok(serializeLookup(config, current));

      if (flag && values[flag] === 0 && current[flag] === 1) {
        throw conflict('לא ניתן לבטל ברירת מחדל ישירות. יש להגדיר רשומה אחרת כברירת מחדל', 'DEFAULT_REQUIRED');
      }
      const update = prepare(
        ctx.env,
        `UPDATE ${config.table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        ...Object.values(values),
        id
      );
      const statements = flag && values[flag] === 1 ? [prepare(ctx.env, `UPDATE ${config.table} SET ${flag} = 0 WHERE id != ?`, id), update] : [update];
      await batch(ctx.env, statements);
      return ok(serializeLookup(config, await getRow(ctx.env, config, id)));
    },

    async remove(ctx) {
      requirePermission(ctx.actor, 'settings:manage');
      const id = idParam(ctx.params.id);
      const current = await getRow(ctx.env, config, id);
      if (flag && current[flag] === 1) {
        throw conflict('לא ניתן למחוק את רשומת ברירת המחדל', 'DEFAULT_REQUIRED');
      }

      const usage = {};
      for (const { table, column, label } of config.usedBy) {
        const row = await first(ctx.env, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, id);
        if (row.c > 0) usage[label] = row.c;
      }
      if (Object.keys(usage).length) {
        throw conflict(`לא ניתן למחוק: ${config.label} בשימוש`, 'IN_USE', usage);
      }

      await prepare(ctx.env, `DELETE FROM ${config.table} WHERE id = ?`, id).run();
      return ok(null);
    },
  };
}

export function registerLookupRoutes(router) {
  for (const config of Object.values(LOOKUPS)) {
    const h = makeHandlers(config);
    router.get(config.path, h.list);
    router.post(config.path, h.create);
    router.patch(`${config.path}/:id`, h.update);
    router.delete(`${config.path}/:id`, h.remove);
  }
}
