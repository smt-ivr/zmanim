import { PASSWORD_MIN_LENGTH } from '../config.js';
import { isSubset, requirePermission, PERMISSION_KEYS } from '../auth/permissions.js';
import { loadProfile, loadProfiles, serializeUser } from '../auth/profiles.js';
import { hashPassword } from '../lib/crypto.js';
import { all, batch, first, nowIso, prepare, toFlag } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound, validationError } from '../lib/errors.js';
import { created, ok } from '../lib/http.js';
import { EMAIL_RE, PHONE_RE, Validator, idParam, normalizePhone } from '../lib/validate.js';
import { loadRole } from './roles.js';

// Fields a user may not change about themselves (prevents self-escalation and self-lockout)
const SELF_RESTRICTED = ['role_id', 'all_synagogues', 'synagogue_ids', 'is_active', 'is_super_admin', 'personal_permissions'];

// ---- authorization rules ---------------------------------------------------

function canManage(actor, target) {
  if (actor.is_super_admin) return true;
  if (target.is_super_admin) return false;
  if (!isSubset(target.permissions, actor.permissions)) return false;
  if (actor.all_synagogues) return true;
  if (target.all_synagogues) return false;
  return isSubset(target.synagogue_ids, actor.synagogue_ids);
}

function assertCanManage(actor, target) {
  if (!canManage(actor, target)) {
    throw forbidden('אין לך הרשאה לנהל משתמש זה (יש לו הרשאות או היקף גדולים משלך)', 'CANNOT_MANAGE_USER');
  }
}

// Validates that the actor may hand out the requested role / scope / flags
async function assertCanAssign(env, actor, { role_id, all_synagogues, synagogue_ids, is_super_admin, personal_permissions }) {
  if (is_super_admin === true && !actor.is_super_admin) {
    throw forbidden('רק מנהל ראשי יכול למנות מנהל ראשי', 'CANNOT_ASSIGN');
  }
  if (role_id !== undefined && role_id !== null) {
    const role = await loadRole(env, role_id);
    if (!role) throw validationError([{ field: 'role_id', message: 'התפקיד לא קיים' }]);
    if (!actor.is_super_admin && !isSubset(role.permissions, actor.permissions)) {
      throw forbidden('אינך יכול להקצות תפקיד שכולל הרשאות שאין לך', 'CANNOT_ASSIGN');
    }
  }
  if (personal_permissions !== undefined) {
    if (!actor.is_super_admin && !isSubset(new Set(personal_permissions), actor.permissions)) {
      throw forbidden('אינך יכול להקצות הרשאות אישיות שאין לך', 'CANNOT_ASSIGN');
    }
  }
  if (all_synagogues === true && !actor.all_synagogues) {
    throw forbidden('אינך יכול להעניק גישה לכל בתי הכנסת', 'CANNOT_ASSIGN');
  }
  if (synagogue_ids !== undefined) {
    if (!actor.all_synagogues && !isSubset(new Set(synagogue_ids), actor.synagogue_ids)) {
      throw forbidden('אינך יכול להקצות בתי כנסת שאין לך גישה אליהם', 'CANNOT_ASSIGN');
    }
    if (synagogue_ids.length) {
      const found = await first(
        env,
        `SELECT COUNT(*) AS c FROM Synagogues WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(synagogue_ids)
      );
      if (found.c !== synagogue_ids.length) {
        throw validationError([{ field: 'synagogue_ids', message: 'חלק מבתי הכנסת לא קיימים' }]);
      }
    }
  }
}

async function assertAnotherSuperAdmin(env, excludeId) {
  const row = await first(env, `SELECT COUNT(*) AS c FROM Users WHERE is_admin = 1 AND is_active = 1 AND id != ?`, excludeId);
  if (row.c === 0) throw conflict('חייב להישאר לפחות מנהל ראשי פעיל אחד', 'LAST_SUPER_ADMIN');
}

async function assertIdentifiersFree(env, email, phone, excludeId = 0) {
  const rows = await all(
    env,
    `SELECT email, phone FROM Users WHERE id != ? AND ((? != '' AND email = ?) OR (? != '' AND phone = ?))`,
    excludeId, email, email, phone, phone
  );
  if (rows.length) {
    const details = [];
    if (email && rows.some((r) => r.email === email)) details.push({ field: 'email', message: 'האימייל כבר בשימוש' });
    if (phone && rows.some((r) => r.phone === phone)) details.push({ field: 'phone', message: 'הטלפון כבר בשימוש' });
    throw conflict('האימייל או הטלפון כבר בשימוש', 'DUPLICATE_IDENTIFIER', details);
  }
}

async function getProfileOr404(env, id) {
  const profile = await loadProfile(env, id);
  if (!profile) throw notFound('המשתמש לא נמצא');
  return profile;
}

function parseUser(body, partial) {
  const v = new Validator(body, { partial })
    .string('full_name', { required: true, max: 100 })
    .string('email', { max: 150, nullable: true, lowercase: true, pattern: EMAIL_RE, patternMessage: 'כתובת אימייל לא תקינה' })
    .string('phone', { max: 20, nullable: true, transform: normalizePhone, pattern: PHONE_RE, patternMessage: 'מספר טלפון לא תקין' })
    .string('password', { required: !partial, min: PASSWORD_MIN_LENGTH, max: 200, trim: false })
    .int('role_id', { nullable: true })
    .bool('all_synagogues')
    .intArray('synagogue_ids')
    .stringArray('personal_permissions', { allowed: PERMISSION_KEYS })
    .bool('is_active')
    .bool('is_super_admin');
  return v.result();
}

// ---- handlers --------------------------------------------------------------

export async function list({ env, actor }) {
  requirePermission(actor, 'users:read');
  const profiles = await loadProfiles(env);
  const visible = profiles.filter((p) => p.id === actor.id || canManage(actor, p));
  return ok(visible.map(serializeUser));
}

export async function get({ env, actor, params }) {
  requirePermission(actor, 'users:read');
  const target = await getProfileOr404(env, idParam(params.id));
  if (target.id !== actor.id) assertCanManage(actor, target);
  return ok(serializeUser(target));
}

export async function create(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'users:create');
  const d = parseUser(await ctx.body(), false);

  const email = d.email ?? '';
  const phone = d.phone ?? '';
  if (!email && !phone) throw validationError([{ field: 'email', message: 'יש להזין אימייל או טלפון' }]);

  await assertCanAssign(env, actor, d);
  await assertIdentifiersFree(env, email, phone);

  const now = nowIso();
  const synagogueIds = d.synagogue_ids ?? [];
  const personalPerms = d.personal_permissions ?? [];
  
  const results = await batch(env, [
    prepare(
      env,
      `INSERT INTO Users (full_name, email, phone, password, password_hash, is_admin, role_id, all_synagogues, is_active, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
      d.full_name, email, phone, await hashPassword(d.password),
      toFlag(d.is_super_admin === true), d.role_id ?? null, toFlag(d.all_synagogues === true), toFlag(d.is_active !== false), now, now
    ),
    prepare(env, `INSERT INTO UserSynagogues (user_id, synagogue_id) SELECT last_insert_rowid(), value FROM json_each(?)`, JSON.stringify(synagogueIds)),
    prepare(env, `INSERT INTO UserPermissions (user_id, permission) SELECT last_insert_rowid(), value FROM json_each(?)`, JSON.stringify(personalPerms)),
  ]);
  return created(serializeUser(await getProfileOr404(env, results[0].meta.last_row_id)));
}

export async function update(ctx) {
  const { env, actor } = ctx;
  requirePermission(actor, 'users:update');
  const id = idParam(ctx.params.id);
  const target = await getProfileOr404(env, id);
  const body = await ctx.body();

  const isSelf = target.id === actor.id;
  if (isSelf) {
    if (SELF_RESTRICTED.some((key) => key in body)) {
      throw forbidden('לא ניתן לשנות את התפקיד, ההיקף, ההרשאות האישיות או הסטטוס של עצמך', 'CANNOT_MODIFY_SELF');
    }
  } else {
    assertCanManage(actor, target);
  }

  const d = parseUser(body, true);
  if (Object.keys(d).length === 0) throw badRequest('לא נשלחו שדות לעדכון');
  await assertCanAssign(env, actor, d);

  const email = 'email' in d ? d.email ?? '' : target.email ?? '';
  const phone = 'phone' in d ? d.phone ?? '' : target.phone ?? '';
  if (!email && !phone) throw validationError([{ field: 'email', message: 'יש להשאיר אימייל או טלפון' }]);
  if ('email' in d || 'phone' in d) await assertIdentifiersFree(env, email, phone, id);

  if (target.is_super_admin && (d.is_super_admin === false || d.is_active === false)) {
    await assertAnotherSuperAdmin(env, id);
  }

  const sets = [];
  const params = [];
  const set = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if ('full_name' in d) set('full_name', d.full_name);
  if ('email' in d) set('email', email);
  if ('phone' in d) set('phone', phone);
  if ('is_super_admin' in d) set('is_admin', toFlag(d.is_super_admin));
  if ('role_id' in d) set('role_id', d.role_id);
  if ('all_synagogues' in d) set('all_synagogues', toFlag(d.all_synagogues));
  if ('is_active' in d) set('is_active', toFlag(d.is_active));
  if (d.password) {
    set('password_hash', await hashPassword(d.password));
    set('password', '');
  }
  set('updated_at', nowIso());

  const statements = [prepare(env, `UPDATE Users SET ${sets.join(', ')} WHERE id = ?`, ...params, id)];
  if ('synagogue_ids' in d) {
    statements.push(
      prepare(env, `DELETE FROM UserSynagogues WHERE user_id = ?`, id),
      prepare(env, `INSERT INTO UserSynagogues (user_id, synagogue_id) SELECT ?, value FROM json_each(?)`, id, JSON.stringify(d.synagogue_ids))
    );
  }
  if ('personal_permissions' in d) {
    statements.push(
      prepare(env, `DELETE FROM UserPermissions WHERE user_id = ?`, id),
      prepare(env, `INSERT INTO UserPermissions (user_id, permission) SELECT ?, value FROM json_each(?)`, id, JSON.stringify(d.personal_permissions))
    );
  }
  // new password or deactivation => sign the user out everywhere (except the current device when editing yourself)
  if (d.password || d.is_active === false) {
    statements.push(prepare(env, `DELETE FROM Sessions WHERE user_id = ? AND id != ?`, id, isSelf ? actor.session_id : 0));
  }
  await batch(env, statements);

  return ok(serializeUser(await getProfileOr404(env, id)));
}

export async function remove({ env, actor, params }) {
  requirePermission(actor, 'users:delete');
  const id = idParam(params.id);
  const target = await getProfileOr404(env, id);
  if (target.id === actor.id) throw forbidden('לא ניתן למחוק את המשתמש של עצמך', 'CANNOT_MODIFY_SELF');
  assertCanManage(actor, target);
  if (target.is_super_admin) await assertAnotherSuperAdmin(env, id);

  await batch(env, [
    prepare(env, `DELETE FROM Sessions WHERE user_id = ?`, id),
    prepare(env, `DELETE FROM UserSynagogues WHERE user_id = ?`, id),
    prepare(env, `DELETE FROM UserPermissions WHERE user_id = ?`, id),
    prepare(env, `DELETE FROM Users WHERE id = ?`, id),
  ]);
  return ok(null);
}
