import { requirePermission, requireSynagogueAccess, scopeClause } from '../auth/permissions.js';
import { all, batch, first, prepare, toFlag, toBool } from '../lib/db.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { intParam, idParam, Validator } from '../lib/validate.js';

const SELECT = `SELECT s.*, a.name AS area_name FROM Synagogues s LEFT JOIN Areas a ON a.id = s.area_id`;

function serializeSynagogue(row) {
  return {
    ...row,
    allow_edit_name: toBool(row.allow_edit_name),
    allow_edit_area: toBool(row.allow_edit_area),
    allow_edit_address: toBool(row.allow_edit_address),
  };
}

async function getOr404(env, id) {
  const row = await first(env, `${SELECT} WHERE s.id = ?`, id);
  if (!row) throw notFound('בית הכנסת לא נמצא');
  return serializeSynagogue(row);
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
    .int('max_locations', { min: 1, max: 1000 })
    .bool('allow_edit_name')
    .bool('allow_edit_area')
    .bool('allow_edit_address')
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
  const rows = await all(env, `${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.name`, ...params);
  return ok(rows.map(serializeSynagogue));
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

  const next = {
    name: d.name,
    area_id: d.area_id ?? null,
    address: d.address ?? '',
    max_locations: d.max_locations ?? 5,
    allow_edit_name: d.allow_edit_name ?? false,
    allow_edit_area: d.allow_edit_area ?? false,
    allow_edit_address: d.allow_edit_address ?? true,
  };

  const statements = [
    prepare(
      env, 
      `INSERT INTO Synagogues (name, area_id, address, max_locations, allow_edit_name, allow_edit_area, allow_edit_address) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
      next.name, next.area_id, next.address, next.max_locations, toFlag(next.allow_edit_name), toFlag(next.allow_edit_area), toFlag(next.allow_edit_address)
    ),
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
  const isUnrestricted = actor.is_super_admin || actor.permissions.has('synagogues:unrestricted_update');

  if (!isUnrestricted) {
    if (d.name !== undefined && d.name !== current.name && current.allow_edit_name !== true) {
      throw forbidden('הגדרות בית הכנסת חוסמות עריכת שם. פנה למנהל המערכת', 'EDIT_RESTRICTED');
    }
    if (d.area_id !== undefined && d.area_id !== current.area_id && current.allow_edit_area !== true) {
      throw forbidden('הגדרות בית הכנסת חוסמות עריכת אזור. פנה למנהל המערכת', 'EDIT_RESTRICTED');
    }
    if (d.address !== undefined && d.address !== current.address && current.allow_edit_address !== true) {
      throw forbidden('הגדרות בית הכנסת חוסמות עריכת כתובת. פנה למנהל המערכת', 'EDIT_RESTRICTED');
    }
    if ('max_locations' in d || 'allow_edit_name' in d || 'allow_edit_area' in d || 'allow_edit_address' in d) {
      throw forbidden('אין לך הרשאה לשנות את הגדרות המערכת והשליטה של בית הכנסת', 'EDIT_RESTRICTED');
    }
  }

  if ('area_id' in d) await assertAreaExists(env, d.area_id);

  const next = {
    name: d.name ?? current.name,
    area_id: 'area_id' in d ? d.area_id : current.area_id,
    address: d.address ?? current.address ?? '',
    max_locations: d.max_locations ?? current.max_locations,
    allow_edit_name: 'allow_edit_name' in d ? d.allow_edit_name : current.allow_edit_name,
    allow_edit_area: 'allow_edit_area' in d ? d.allow_edit_area : current.allow_edit_area,
    allow_edit_address: 'allow_edit_address' in d ? d.allow_edit_address : current.allow_edit_address,
  };
  await prepare(
    env, 
    `UPDATE Synagogues SET name = ?, area_id = ?, address = ?, max_locations = ?, allow_edit_name = ?, allow_edit_area = ?, allow_edit_address = ? WHERE id = ?`, 
    next.name, next.area_id, next.address, next.max_locations, toFlag(next.allow_edit_name), toFlag(next.allow_edit_area), toFlag(next.allow_edit_address), id
  ).run();
  
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
