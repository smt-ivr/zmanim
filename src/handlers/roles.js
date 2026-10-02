import { PERMISSIONS, PERMISSION_KEYS, canAny, isSubset, requirePermission } from '../auth/permissions.js';
import { all, batch, first, nowIso, prepare } from '../lib/db.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { Validator, idParam } from '../lib/validate.js';

export const permissionCatalog = () =>
  ok(PERMISSION_KEYS.map((key) => ({ key, group: PERMISSIONS[key].group, label: PERMISSIONS[key].label })));

// ---- shared helpers (also used by users.js) --------------------------------

export async function loadRole(env, id) {
  const [roleRes, permsRes, countRes] = await batch(env, [
    prepare(env, `SELECT id, slug, name, description, is_system, created_at FROM Roles WHERE id = ?`, id),
    prepare(env, `SELECT permission FROM RolePermissions WHERE role_id = ?`, id),
    prepare(env, `SELECT COUNT(*) AS c FROM Users WHERE role_id = ?`, id),
  ]);
  const role = roleRes.results[0];
  if (!role) return null;
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    is_system: role.is_system === 1,
    permissions: new Set(permsRes.results.map((r) => r.permission).filter((p) => PERMISSION_KEYS.includes(p))),
    user_count: countRes.results[0].c,
  };
}

const serialize = (role, actor) => ({
  id: role.id,
  slug: role.slug,
  name: role.name,
  description: role.description,
  is_system: role.is_system,
  permissions: [...role.permissions].sort(),
  user_count: role.user_count,
  // may the current user assign this role to others?
  assignable: isSubset(role.permissions, actor.permissions),
});

async function getOr404(env, id) {
  const role = await loadRole(env, id);
  if (!role) throw notFound('התפקיד לא נמצא');
  return role;
}

// Non-super-admins can only manage roles made entirely of permissions they hold themselves
function assertCanEditPermissions(actor, ...permissionSets) {
  if (actor.is_super_admin) return;
  for (const set of permissionSets) {
    if (!isSubset(set, actor.permissions)) {
      throw forbidden('אינך יכול לנהל תפקיד שכולל הרשאות שאין לך', 'ROLE_ESCALATION');
    }
  }
}

async function assertNameFree(env, name, excludeId = 0) {
  if (await first(env, `SELECT id FROM Roles WHERE name = ? AND id != ?`, name, excludeId)) {
    throw conflict('כבר קיים תפקיד בשם זה', 'DUPLICATE_ROLE_NAME');
  }
}

// ---- handlers --------------------------------------------------------------

export async function list({ env, actor }) {
  if (!canAny(actor, ['roles:manage', 'users:read', 'users:create', 'users:update'])) {
    requirePermission(actor, 'roles:manage');
  }
  const ids = await all(env, `SELECT id FROM Roles ORDER BY is_system DESC, name`);
  const roles = await Promise.all(ids.map((r) => loadRole(env, r.id)));
  return ok(roles.map((r) => serialize(r, actor)));
}

export async function get({ env, actor, params }) {
  if (!canAny(actor, ['roles:manage', 'users:read', 'users:create', 'users:update'])) {
    requirePermission(actor, 'roles:manage');
  }
  return ok(serialize(await getOr404(env, idParam(params.id)), actor));
}

export async function create(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'roles:manage');
  const d = new Validator(await ctx.body())
    .string('name', { required: true, max: 60 })
    .string('description', { max: 250 })
    .stringArray('permissions', { required: true, allowed: PERMISSION_KEYS })
    .result();

  assertCanEditPermissions(actor, new Set(d.permissions));
  await assertNameFree(env, d.name);

  const results = await batch(env, [
    prepare(env, `INSERT INTO Roles (slug, name, description, is_system, created_at) VALUES (NULL, ?, ?, 0, ?)`, d.name, d.description ?? '', nowIso()),
    ...d.permissions.map((p) => prepare(env, `INSERT INTO RolePermissions (role_id, permission) VALUES (last_insert_rowid(), ?)`, p)),
  ]);
  return created(serialize(await getOr404(env, results[0].meta.last_row_id), actor));
}

export async function update(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'roles:manage');
  const id = idParam(ctx.params.id);
  const role = await getOr404(env, id);
  if (role.is_system && !actor.is_super_admin) {
    throw forbidden('רק המנהל הראשי יכול לערוך תפקידי מערכת', 'SYSTEM_ROLE');
  }

  const d = new Validator(await ctx.body(), { partial: true })
    .string('name', { required: true, max: 60 })
    .string('description', { max: 250 })
    .stringArray('permissions', { allowed: PERMISSION_KEYS })
    .result();

  if (d.name !== undefined && d.name !== role.name) {
    if (role.is_system) throw conflict('לא ניתן לשנות את שם תפקיד המערכת', 'SYSTEM_ROLE');
    await assertNameFree(env, d.name, id);
  }
  assertCanEditPermissions(actor, role.permissions, ...(d.permissions ? [new Set(d.permissions)] : []));

  const statements = [
    prepare(env, `UPDATE Roles SET name = ?, description = ? WHERE id = ?`, d.name ?? role.name, d.description ?? role.description, id),
  ];
  if (d.permissions) {
    statements.push(prepare(env, `DELETE FROM RolePermissions WHERE role_id = ?`, id));
    for (const p of d.permissions) statements.push(prepare(env, `INSERT INTO RolePermissions (role_id, permission) VALUES (?, ?)`, id, p));
  }
  await batch(env, statements);
  return ok(serialize(await getOr404(env, id), actor));
}

export async function remove({ env, actor, params }) {
  requirePermission(actor, 'roles:manage');
  const id = idParam(params.id);
  const role = await getOr404(env, id);
  if (role.is_system) throw conflict('לא ניתן למחוק תפקיד מערכת', 'SYSTEM_ROLE');
  assertCanEditPermissions(actor, role.permissions);
  if (role.user_count > 0) {
    throw conflict('לא ניתן למחוק תפקיד שמשויכים אליו משתמשים', 'IN_USE', { users: role.user_count });
  }
  await prepare(env, `DELETE FROM Roles WHERE id = ?`, id).run(); // RolePermissions cascade
  return ok(null);
}
