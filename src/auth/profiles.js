import { prepare, batch } from '../lib/db.js';
import { PERMISSION_KEYS } from './permissions.js';

/**
 * Loads users together with their role permissions, personal permissions and synagogue scope.
 * Pass a userId for a single user, or nothing for everyone.
 */
export async function loadProfiles(env, userId = null) {
  const single = userId !== null;
  const [users, scopes, perms, userPerms] = await batch(env, [
    prepare(
      env,
      `SELECT u.id, u.full_name, u.email, u.phone, u.is_admin, u.is_active, u.role_id, u.all_synagogues,
              u.created_at, u.last_login_at, r.name AS role_name
       FROM Users u LEFT JOIN Roles r ON r.id = u.role_id
       ${single ? 'WHERE u.id = ?' : ''} ORDER BY u.id`,
      ...(single ? [userId] : [])
    ),
    prepare(env, `SELECT user_id, synagogue_id FROM UserSynagogues ${single ? 'WHERE user_id = ?' : ''}`, ...(single ? [userId] : [])),
    single
      ? prepare(env, `SELECT rp.role_id, rp.permission FROM RolePermissions rp JOIN Users u ON u.role_id = rp.role_id WHERE u.id = ?`, userId)
      : prepare(env, `SELECT role_id, permission FROM RolePermissions`),
    single
      ? prepare(env, `SELECT user_id, permission FROM UserPermissions WHERE user_id = ?`, userId)
      : prepare(env, `SELECT user_id, permission FROM UserPermissions`)
  ]);

  const scopeByUser = new Map();
  for (const { user_id, synagogue_id } of scopes.results) {
    if (!scopeByUser.has(user_id)) scopeByUser.set(user_id, new Set());
    scopeByUser.get(user_id).add(synagogue_id);
  }
  const permsByRole = new Map();
  for (const { role_id, permission } of perms.results) {
    if (!permsByRole.has(role_id)) permsByRole.set(role_id, new Set());
    if (PERMISSION_KEYS.includes(permission)) permsByRole.get(role_id).add(permission);
  }
  const personalPermsByUser = new Map();
  for (const { user_id, permission } of userPerms.results) {
    if (!personalPermsByUser.has(user_id)) personalPermsByUser.set(user_id, new Set());
    if (PERMISSION_KEYS.includes(permission)) personalPermsByUser.get(user_id).add(permission);
  }

  return users.results.map((u) => {
    const superAdmin = u.is_admin === 1;
    const personalPerms = personalPermsByUser.get(u.id) ?? new Set();
    const rolePerms = permsByRole.get(u.role_id) ?? new Set();
    
    return {
      id: u.id,
      full_name: u.full_name ?? '',
      email: u.email || null,
      phone: u.phone || null,
      is_super_admin: superAdmin,
      is_active: u.is_active === 1,
      role_id: u.role_id ?? null,
      role_name: u.role_name ?? null,
      all_synagogues: superAdmin || u.all_synagogues === 1,
      synagogue_ids: scopeByUser.get(u.id) ?? new Set(),
      permissions: superAdmin ? new Set(PERMISSION_KEYS) : new Set([...rolePerms, ...personalPerms]),
      personal_permissions: personalPerms,
      created_at: u.created_at ?? null,
      last_login_at: u.last_login_at ?? null,
    };
  });
}

export async function loadProfile(env, userId) {
  const [profile] = await loadProfiles(env, userId);
  return profile ?? null;
}

// Public representation (never includes password data)
export function serializeUser(p) {
  return {
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    phone: p.phone,
    is_active: p.is_active,
    is_super_admin: p.is_super_admin,
    role: p.role_id ? { id: p.role_id, name: p.role_name } : null,
    all_synagogues: p.all_synagogues,
    synagogue_ids: [...p.synagogue_ids].sort((a, b) => a - b),
    permissions: [...p.permissions].sort(),
    personal_permissions: [...p.personal_permissions].sort(),
    created_at: p.created_at,
    last_login_at: p.last_login_at,
  };
}
