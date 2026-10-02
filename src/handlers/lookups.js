import { requirePermission, requireSynagogueAccess, scopeClause } from '../auth/permissions.js';
import { all, batch, first, prepare } from '../lib/db.js';
import { notFound, conflict, validationError } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { intParam, idParam, Validator } from '../lib/validate.js';

const SELECT = `SELECT l.*, s.name AS synagogue_name FROM Locations l JOIN Synagogues s ON s.id = l.synagogue_id`;

async function getOr404(env, id) {
  const row = await first(env, `${SELECT} WHERE l.id = ?`, id);
  if (!row) throw notFound('המיקום לא נמצא');
  return row;
}

export async function list({ env, actor, url }) {
  const scope = scopeClause(actor, 'l.synagogue_id');
  const where = [scope.sql];
  const params = [...scope.params];
  const synagogueId = intParam(url, 'synagogue_id');
  if (synagogueId !== null) {
    where.push('l.synagogue_id = ?');
    params.push(synagogueId);
  }
  return ok(await all(env, `${SELECT} WHERE ${where.join(' AND ')} ORDER BY l.name`, ...params));
}

export async function get({ env, actor, params }) {
  const row = await getOr404(env, idParam(params.id));
  requireSynagogueAccess(actor, row.synagogue_id);
  return ok(row);
}

export async function create(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'locations:create');
  const d = new Validator(await ctx.body())
    .int('synagogue_id', { required: true })
    .string('name', { required: true, max: 120 })
    .result();

  const syn = await first(env, `SELECT id, max_locations FROM Synagogues WHERE id = ?`, d.synagogue_id);
  if (!syn) {
    throw validationError([{ field: 'synagogue_id', message: 'בית הכנסת לא קיים' }]);
  }
  requireSynagogueAccess(actor, d.synagogue_id);

  const counts = await first(env, `SELECT COUNT(*) AS c FROM Locations WHERE synagogue_id = ?`, d.synagogue_id);
  if (counts.c >= syn.max_locations) {
    throw conflict(`לא ניתן להוסיף יותר מ-${syn.max_locations} מיקומים לבית כנסת זה`, 'MAX_LOCATIONS_REACHED');
  }

  const res = await prepare(env, `INSERT INTO Locations (name, synagogue_id) VALUES (?, ?)`, d.name, d.synagogue_id).run();
  return created(await getOr404(env, res.meta.last_row_id));
}

// A location's synagogue is immutable: minyanim reference it. Only the name can change.
export async function update(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'locations:update');
  const id = idParam(ctx.params.id);
  const current = await getOr404(env, id);
  requireSynagogueAccess(actor, current.synagogue_id);

  const d = new Validator(await ctx.body(), { partial: true }).string('name', { required: true, max: 120 }).result();
  if (d.name !== undefined) await prepare(env, `UPDATE Locations SET name = ? WHERE id = ?`, d.name, id).run();
  return ok(await getOr404(env, id));
}

export async function remove({ env, actor, params }) {
  requirePermission(actor, 'locations:delete');
  const id = idParam(params.id);
  const current = await getOr404(env, id);
  requireSynagogueAccess(actor, current.synagogue_id);

  // minyanim keep existing, they just lose their specific location
  await batch(env, [
    prepare(env, `UPDATE Minyanim SET location_id = NULL WHERE location_id = ?`, id),
    prepare(env, `DELETE FROM Locations WHERE id = ?`, id),
  ]);
  return ok(null);
}
