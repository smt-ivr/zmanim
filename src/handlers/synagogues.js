import { requirePermission, requireSynagogueAccess, scopeClause } from '../auth/permissions.js';
import { all, batch, first, prepare } from '../lib/db.js';
import { conflict, notFound, validationError } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { intParam, idParam, Validator } from '../lib/validate.js';

const SELECT = `SELECT s.*, a.name AS area_name FROM Synagogues s LEFT JOIN Areas a ON a.id = s.area_id`;

async function getOr404(env, id) {
  const row = await first(env, `${SELECT} WHERE s.id = ?`, id);
  if (!row) throw notFound('בית הכנסת לא נמצא');
  return row;
}

async function assertAreaExists(env, areaId) {
  if (areaId === null || areaId === undefined) return;
  if (!(await first(env, `SELECT id FROM Areas WHERE id = ?`, areaId))) {
    throw validationError([{ field: 'area_id', message: 'האזור לא קיים' }]);
  }
}

function validate(body, partial) {
  return new Validator(body, { partial })
    .string('name', { required: true, max: 120 })
    .int('area_id', { nullable: true })
    .string('address', { max: 250 })
    .result();
}

export async function list({ env, actor, url }) {
  const scope = scopeClause(actor, 's.id');
  const where = [scope.sql];
  const params = [...scope.params];
  const areaId = intParam(url, 'area_id');
  if (areaId !== null) {
    where.push('s.area_id = ?');
    params.push(areaId);
  }
  return ok(await all(env, `${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.name`, ...params));
}

export async function get({ env, actor, params }) {
  const row = await getOr404(env, idParam(params.id));
  requireSynagogueAccess(actor, row.id);
  return ok(row);
}

export async function create(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'synagogues:create');
  const d = validate(await ctx.body(), false);
  await assertAreaExists(env, d.area_id);

  const statements = [
    prepare(env, `INSERT INTO Synagogues (name, area_id, address) VALUES (?, ?, ?)`, d.name, d.area_id ?? null, d.address ?? ''),
  ];
  // A creator with limited scope automatically gets access to what they create
  if (!actor.all_synagogues) {
    statements.push(prepare(env, `INSERT INTO UserSynagogues (user_id, synagogue_id) VALUES (?, last_insert_rowid())`, actor.id));
  }
  const results = await batch(env, statements);
  return created(await getOr404(env, results[0].meta.last_row_id));
}

export async function update(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'synagogues:update');
  const id = idParam(ctx.params.id);
  const current = await getOr404(env, id);
  requireSynagogueAccess(actor, id);

  const d = validate(await ctx.body(), true);
  if ('area_id' in d) await assertAreaExists(env, d.area_id);

  const next = {
    name: d.name ?? current.name,
    area_id: 'area_id' in d ? d.area_id : current.area_id,
    address: d.address ?? current.address ?? '',
  };
  await prepare(env, `UPDATE Synagogues SET name = ?, area_id = ?, address = ? WHERE id = ?`, next.name, next.area_id, next.address, id).run();
  return ok(await getOr404(env, id));
}

export async function remove({ env, actor, params, url }) {
  requirePermission(actor, 'synagogues:delete');
  const id = idParam(params.id);
  await getOr404(env, id);
  requireSynagogueAccess(actor, id);

  const counts = await first(
    env,
    `SELECT (SELECT COUNT(*) FROM Locations WHERE synagogue_id = ?) AS locations,
            (SELECT COUNT(*) FROM Minyanim WHERE synagogue_id = ?) AS minyanim`,
    id,
    id
  );
  if ((counts.locations > 0 || counts.minyanim > 0) && url.searchParams.get('cascade') !== 'true') {
    throw conflict('לבית הכנסת יש מיקומים ומניינים. להוספת הפרמטר ?cascade=true יימחק גם התוכן שלו', 'HAS_DEPENDENTS', counts);
  }

  // children first, all in one atomic batch
  await batch(env, [
    prepare(env, `DELETE FROM Minyanim WHERE synagogue_id = ?`, id),
    prepare(env, `DELETE FROM Locations WHERE synagogue_id = ?`, id),
    prepare(env, `DELETE FROM UserSynagogues WHERE synagogue_id = ?`, id),
    prepare(env, `DELETE FROM Synagogues WHERE id = ?`, id),
  ]);
  return ok(null);
}
