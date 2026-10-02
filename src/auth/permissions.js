import { forbidden } from '../lib/errors.js';

// Catalog of every permission the system knows. Roles are just named sets of these keys.
// Reading data inside your own scope needs no permission; these control changes.
export const PERMISSIONS = Object.freeze({
  'synagogues:create': { group: 'בתי כנסת', label: 'יצירת בתי כנסת' },
  'synagogues:update': { group: 'בתי כנסת', label: 'עריכת פרטי בית כנסת' },
  'synagogues:unrestricted_update': { group: 'בתי כנסת', label: 'עריכת שדות מוגבלים בבתי כנסת ועקיפת הגדרות (שם, אזור, מיקומים)' },
  'synagogues:delete': { group: 'בתי כנסת', label: 'מחיקת בתי כנסת' },
  'locations:create': { group: 'מיקומים', label: 'יצירת מיקומים' },
  'locations:update': { group: 'מיקומים', label: 'עריכת מיקומים' },
  'locations:delete': { group: 'מיקומים', label: 'מחיקת מיקומים' },
  'minyanim:create': { group: 'מניינים', label: 'יצירת מניינים' },
  'minyanim:update': { group: 'מניינים', label: 'עריכת מניינים' },
  'minyanim:delete': { group: 'מניינים', label: 'מחיקת מניינים' },
  'users:read': { group: 'משתמשים', label: 'צפייה במשתמשים' },
  'users:create': { group: 'משתמשים', label: 'יצירת משתמשים' },
  'users:update': { group: 'משתמשים', label: 'עריכת משתמשים' },
  'users:delete': { group: 'משתמשים', label: 'מחיקת משתמשים' },
  'roles:manage': { group: 'מערכת', label: 'ניהול תפקידים והרשאות' },
  'settings:manage': { group: 'מערכת', label: 'ניהול הגדרות בסיס (אזורים, סוגי תפילה, עונות...)' },
});

export const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

export const can = (actor, permission) => actor.permissions.has(permission);
export const canAny = (actor, permissions) => permissions.some((p) => actor.permissions.has(p));

export function requirePermission(actor, permission) {
  if (!can(actor, permission)) {
    throw forbidden(`חסרה הרשאה: ${PERMISSIONS[permission]?.label ?? permission}`, 'MISSING_PERMISSION', { permission });
  }
}

export const canAccessSynagogue = (actor, synagogueId) =>
  actor.all_synagogues || actor.synagogue_ids.has(Number(synagogueId));

export function requireSynagogueAccess(actor, synagogueId) {
  if (!canAccessSynagogue(actor, synagogueId)) {
    throw forbidden('אין לך גישה לבית כנסת זה', 'SYNAGOGUE_ACCESS_DENIED', { synagogue_id: Number(synagogueId) });
  }
}

// SQL fragment limiting rows to the actor's synagogues (subquery => no bound-parameter explosion)
export function scopeClause(actor, column) {
  if (actor.all_synagogues) return { sql: '1 = 1', params: [] };
  return { sql: `${column} IN (SELECT synagogue_id FROM UserSynagogues WHERE user_id = ?)`, params: [actor.id] };
}

export function isSubset(subset, superset) {
  for (const item of subset) if (!superset.has(item)) return false;
  return true;
}
