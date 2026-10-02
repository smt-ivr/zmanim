import { requirePermission, requireSynagogueAccess } from '../auth/permissions.js';
import { first, prepare } from '../lib/db.js';
import { badRequest, notFound, validationError } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { intParam, idParam, pagination, Validator } from '../lib/validate.js';
import { getMinyanView, queryMinyanim, validateMinyan } from '../services/minyanim.js';

const FIELDS = ['synagogue_id', 'location_id', 'prayer_type_id', 'season_id', 'time_type_id', 'time_value', 'notes'];

function parse(body, partial) {
  return new Validator(body, { partial })
    .int('synagogue_id', { required: true })
    .int('location_id', { nullable: true })
    .int('prayer_type_id', { required: true })
    .int('season_id', { nullable: true })
    .int('time_type_id', { required: true })
    .string('time_value', { required: true, max: 10 })
    .string('notes', { max: 500 })
    .result();
}

async function defaultSeasonId(env) {
  const row = await first(env, `SELECT id FROM Seasons WHERE is_default = 1 LIMIT 1`);
  if (!row) throw validationError([{ field: 'season_id', message: 'לא הוגדרה עונת ברירת מחדל, יש לבחור עונה' }]);
  return row.id;
}

async function getRaw(env, id) {
  const row = await first(env, `SELECT * FROM Minyanim WHERE id = ?`, id);
  if (!row) throw notFound('המניין לא נמצא');
  return row;
}

export async function list({ env, actor, url }) {
  const filters = {
    synagogue_id: intParam(url, 'synagogue_id'),
    location_id: intParam(url, 'location_id'),
    prayer_type_id: intParam(url, 'prayer_type_id'),
    season_id: intParam(url, 'season_id'),
  };
  const { limit, offset } = pagination(url);
  const data = await queryMinyanim(env, { actor, filters, limit, offset });
  return ok(data, { limit, offset, count: data.length });
}

export async function get({ env, actor, params }) {
  const view = await getMinyanView(env, idParam(params.id));
  if (!view) throw notFound('המניין לא נמצא');
  requireSynagogueAccess(actor, view.synagogue_id);
  return ok(view);
}

export async function create(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'minyanim:create');
  const d = parse(await ctx.body(), false);
  requireSynagogueAccess(actor, d.synagogue_id);

  const candidate = {
    synagogue_id: d.synagogue_id,
    location_id: d.location_id ?? null,
    prayer_type_id: d.prayer_type_id,
    season_id: d.season_id ?? (await defaultSeasonId(env)),
    time_type_id: d.time_type_id,
    time_value: d.time_value,
    notes: d.notes ?? '',
  };
  const m = await validateMinyan(env, candidate);

  const res = await prepare(
    env,
    `INSERT INTO Minyanim (synagogue_id, location_id, prayer_type_id, season_id, time_type_id, time_value, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    m.synagogue_id, m.location_id, m.prayer_type_id, m.season_id, m.time_type_id, m.time_value, m.notes
  ).run();
  return created(await getMinyanView(env, res.meta.last_row_id));
}

// PATCH: send only what changes; the result is validated as a whole.
export async function update(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'minyanim:update');
  const id = idParam(ctx.params.id);
  const current = await getRaw(env, id);
  requireSynagogueAccess(actor, current.synagogue_id); // access to the existing minyan

  const d = parse(await ctx.body(), true);
  if (Object.keys(d).length === 0) throw badRequest('לא נשלחו שדות לעדכון');
  if (d.synagogue_id !== undefined) requireSynagogueAccess(actor, d.synagogue_id); // ...and to the target synagogue

  const merged = { ...Object.fromEntries(FIELDS.map((f) => [f, current[f]])), ...d };
  if (merged.season_id === null) merged.season_id = current.season_id;
  merged.notes ??= '';
  const m = await validateMinyan(env, merged);

  await prepare(
    env,
    `UPDATE Minyanim SET synagogue_id = ?, location_id = ?, prayer_type_id = ?, season_id = ?, time_type_id = ?, time_value = ?, notes = ? WHERE id = ?`,
    m.synagogue_id, m.location_id, m.prayer_type_id, m.season_id, m.time_type_id, m.time_value, m.notes, id
  ).run();
  return ok(await getMinyanView(env, id));
}

export async function remove({ env, actor, params }) {
  requirePermission(actor, 'minyanim:delete');
  const id = idParam(params.id);
  const current = await getRaw(env, id);
  requireSynagogueAccess(actor, current.synagogue_id);
  await prepare(env, `DELETE FROM Minyanim WHERE id = ?`, id).run();
  return ok(null);
}
