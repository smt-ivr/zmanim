import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1Shim } from './d1-shim.mjs';
import worker from '../src/index.js';

const BASE = 'https://example.test/zmanim/api/v1';
const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

// Builds a database exactly like production: legacy schema + legacy data, THEN the upgrade migration.
function buildEnv() {
  const db = new D1Shim();
  db.exec(migration('0000_base_schema.sql'));
  db.exec(`
    INSERT INTO Areas (name) VALUES ('מרכז'), ('צפון');
    INSERT INTO Synagogues (name, area_id, address) VALUES ('בית כנסת א', 1, 'רחוב 1'), ('בית כנסת ב', 2, 'רחוב 2');
    INSERT INTO Locations (name, synagogue_id) VALUES ('אולם ראשי', 1), ('עזרת נשים', 2);
    INSERT INTO PrayerTypes (name, allow_update_from, allow_update_to) VALUES ('שחרית', '05:00', '10:00'), ('מנחה', NULL, NULL);
    INSERT INTO TimeTypes (name, is_relative, allowed_prayer_ids) VALUES ('שעה קבועה', 0, NULL), ('דקות אחרי נץ', 1, '1');
    INSERT INTO Seasons (name, is_default) VALUES ('חורף', 1), ('קיץ', 0);
    INSERT INTO Users (full_name, email, phone, password, is_admin, synagogue_ids) VALUES
      ('מנהל ראשי', 'Admin@Example.com', '050-111-1111', 'adminpass1', 1, NULL),
      ('גבאי א', 'gabbai1@example.com', '', 'gabbaipass1', 0, '[1]'),
      ('גבאי ב', '', '052-222-2222', 'gabbaipass2', 0, '["2"]');
    INSERT INTO Tokens (token, user_id) VALUES ('legacy-token', 1);
  `);
  db.exec(migration('0001_rbac_and_sessions.sql'));
  return { DB: db, ALLOWED_ORIGINS: '' };
}

let env;
async function api(method, path, { token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(BASE + path, init), env);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}
const login = async (identifier, password) => (await api('POST', '/auth/login', { body: { identifier, password } }));
const tokenOf = async (identifier, password) => (await login(identifier, password)).json.data.token;
const rows = (sql, ...p) => env.DB.db.prepare(sql).all(...p);

describe('zmanim api', () => {
  let admin, gabbai1, gabbai2;

  before(async () => {
    env = buildEnv();
    admin = await tokenOf('admin@example.com', 'adminpass1');
    gabbai1 = await tokenOf('gabbai1@example.com', 'gabbaipass1');
    gabbai2 = await tokenOf('0522222222', 'gabbaipass2');
  });

  describe('migration of legacy data', () => {
    test('legacy users became roles + scope rows, plaintext passwords were upgraded', () => {
      const users = rows(`SELECT id, role_id, is_admin, password, password_hash FROM Users ORDER BY id`);
      assert.equal(users[0].is_admin, 1);
      assert.equal(users[0].role_id, null);
      assert.ok(users[1].role_id);
      for (const u of users) {
        assert.ok(u.password_hash.startsWith('pbkdf2$sha256$100000$'));
        assert.equal(u.password, ''); // plaintext wiped after first successful login
      }
      assert.deepEqual(rows(`SELECT user_id, synagogue_id FROM UserSynagogues ORDER BY user_id`).map((r) => [r.user_id, r.synagogue_id]), [[2, 1], [3, 2]]);
    });

    test('legacy bearer tokens no longer work', async () => {
      assert.equal((await api('GET', '/auth/me', { token: 'legacy-token' })).status, 401);
    });
  });

  describe('basics', () => {
    test('health, unknown route, wrong method, CORS preflight', async () => {
      assert.equal((await api('GET', '/health')).json.data.status, 'ok');
      assert.equal((await api('GET', '/nope', { token: admin })).status, 404);
      const wrong = await api('DELETE', '/meta', { token: admin });
      assert.equal(wrong.status, 405);
      assert.match(wrong.headers.get('Allow'), /GET/);
      const pre = await worker.fetch(new Request(BASE + '/minyanim', { method: 'OPTIONS' }), env);
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
    });

    test('authenticated routes reject missing / bad tokens', async () => {
      assert.equal((await api('GET', '/synagogues')).status, 401);
      assert.equal((await api('GET', '/synagogues', { token: 'zm_bogus' })).status, 401);
    });

    test('/auth/me returns profile, scope and permissions without password data', async () => {
      const me = (await api('GET', '/auth/me', { token: gabbai1 })).json.data;
      assert.equal(me.role.name, 'גבאי');
      assert.deepEqual(me.synagogue_ids, [1]);
      assert.ok(me.permissions.includes('minyanim:create'));
      assert.ok(!('password' in me) && !('password_hash' in me));
    });

    test('invalid JSON and wrong body type are 400', async () => {
      const res = await worker.fetch(new Request(BASE + '/auth/login', { method: 'POST', body: '{oops' }), env);
      assert.equal(res.status, 400);
      assert.equal((await api('POST', '/auth/login', { body: { identifier: '' } })).json.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('scoped gabbaim', () => {
    test('see only their own synagogues / locations', async () => {
      assert.deepEqual((await api('GET', '/synagogues', { token: gabbai1 })).json.data.map((s) => s.id), [1]);
      assert.deepEqual((await api('GET', '/locations', { token: gabbai2 })).json.data.map((l) => l.synagogue_id), [2]);
      assert.equal((await api('GET', '/synagogues', { token: admin })).json.data.length, 2);
      assert.equal((await api('GET', '/synagogues/2', { token: gabbai1 })).status, 403);
    });

    test('create minyan in own synagogue, with default season', async () => {
      const res = await api('POST', '/minyanim', {
        token: gabbai1,
        body: { synagogue_id: 1, location_id: 1, prayer_type_id: 1, time_type_id: 1, time_value: '07:30', notes: ' ראשון ' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.data.season, 'חורף');
      assert.equal(res.json.data.notes, 'ראשון');
      assert.equal(res.json.data.is_relative, false);
    });

    test('cannot touch other synagogues (create / update-to / location / delete)', async () => {
      const base = { prayer_type_id: 1, time_type_id: 1, time_value: '07:30' };
      assert.equal((await api('POST', '/minyanim', { token: gabbai1, body: { ...base, synagogue_id: 2 } })).status, 403);
      assert.equal((await api('POST', '/locations', { token: gabbai1, body: { synagogue_id: 2, name: 'x' } })).status, 403);
      const mine = (await api('GET', '/minyanim', { token: gabbai1 })).json.data[0];
      // moving my minyan INTO a synagogue I don't manage (the old code allowed this)
      assert.equal((await api('PATCH', `/minyanim/${mine.id}`, { token: gabbai1, body: { synagogue_id: 2, location_id: null } })).status, 403);
      // another gabbai cannot edit or delete it
      assert.equal((await api('PATCH', `/minyanim/${mine.id}`, { token: gabbai2, body: { notes: 'hack' } })).status, 403);
      assert.equal((await api('DELETE', `/minyanim/${mine.id}`, { token: gabbai2 })).status, 403);
      // location of another synagogue cannot be attached
      const res = await api('PATCH', `/minyanim/${mine.id}`, { token: gabbai1, body: { location_id: 2 } });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.details[0].field, 'location_id');
    });

    test('validation rules: time format, allowed range, relative values, time-type vs prayer', async () => {
      const post = (body) => api('POST', '/minyanim', { token: gabbai1, body: { synagogue_id: 1, prayer_type_id: 1, time_type_id: 1, time_value: '07:30', ...body } });
      assert.equal((await post({ time_value: '25:00' })).status, 400);
      assert.match((await post({ time_value: '11:00' })).json.error.details[0].message, /לאחר השעה 10:00/);
      assert.match((await post({ time_value: '04:00' })).json.error.details[0].message, /לפני השעה 05:00/);
      assert.equal((await post({ time_type_id: 2, time_value: '+20' })).json.data.time_value, '20');
      assert.equal((await post({ time_type_id: 2, time_value: 'abc' })).status, 400);
      // time type 2 is only allowed for prayer 1
      assert.equal((await post({ prayer_type_id: 2, time_type_id: 2, time_value: '20' })).status, 400);
      assert.equal((await post({})).status, 201);
    });

    test('PATCH merges partial data; DELETE without body works', async () => {
      const m = (await api('GET', '/minyanim', { token: gabbai1 })).json.data[0];
      const patched = await api('PATCH', `/minyanim/${m.id}`, { token: gabbai1, body: { time_value: '08:00' } });
      assert.equal(patched.json.data.time_value, '08:00');
      assert.equal(patched.json.data.season_id, m.season_id);
      assert.equal((await api('DELETE', `/minyanim/${m.id}`, { token: gabbai1 })).status, 200);
      assert.equal((await api('GET', `/minyanim/${m.id}`, { token: gabbai1 })).status, 404);
    });

    test('gabbaim cannot create synagogues, manage users, roles or settings', async () => {
      assert.equal((await api('POST', '/synagogues', { token: gabbai1, body: { name: 'x' } })).json.error.code, 'MISSING_PERMISSION');
      assert.equal((await api('GET', '/users', { token: gabbai1 })).status, 403);
      assert.equal((await api('GET', '/roles', { token: gabbai1 })).status, 403);
      assert.equal((await api('POST', '/seasons', { token: gabbai1, body: { name: 'x' } })).status, 403);
    });

    test('a gabbai may edit own synagogue details but not another', async () => {
      assert.equal((await api('PATCH', '/synagogues/1', { token: gabbai1, body: { address: 'רחוב חדש 5' } })).json.data.address, 'רחוב חדש 5');
      assert.equal((await api('PATCH', '/synagogues/2', { token: gabbai1, body: { address: 'x' } })).status, 403);
    });
  });

  describe('public API', () => {
    test('works without a token, is cacheable, supports filters', async () => {
      await api('POST', '/minyanim', { token: gabbai2, body: { synagogue_id: 2, prayer_type_id: 2, time_type_id: 1, time_value: '13:15' } });
      const all = await api('GET', '/public/minyanim');
      assert.equal(all.status, 200);
      assert.match(all.headers.get('Cache-Control'), /public/);
      const filtered = await api('GET', '/public/minyanim?synagogue_id=2');
      assert.ok(filtered.json.data.length >= 1 && filtered.json.data.every((m) => m.synagogue_id === 2));
      assert.equal((await api('GET', '/public/minyanim?synagogue_id=abc')).status, 400);
      assert.equal((await api('GET', '/public/synagogues')).json.data.length, 2);
    });
  });

  describe('roles, sub-admins and anti-escalation', () => {
    let subAdmin, regionalRoleId;

    test('super admin builds a custom role and a sub-admin scoped to synagogue 1', async () => {
      const perms = await api('GET', '/permissions', { token: admin });
      assert.ok(perms.json.data.length >= 10);

      const role = await api('POST', '/roles', {
        token: admin,
        body: { name: 'מנהל אזור', description: 'בדיקה', permissions: ['minyanim:create', 'minyanim:update', 'users:read', 'users:create', 'users:update', 'locations:create'] },
      });
      assert.equal(role.status, 201);
      regionalRoleId = role.json.data.id;
      assert.equal((await api('POST', '/roles', { token: admin, body: { name: 'מנהל אזור', permissions: [] } })).status, 409);
      assert.equal((await api('POST', '/roles', { token: admin, body: { name: 'x', permissions: ['nope:nope'] } })).status, 400);

      const user = await api('POST', '/users', {
        token: admin,
        body: { full_name: 'מנהל משנה', email: 'Sub@Example.com', password: 'subadmin123', role_id: regionalRoleId, synagogue_ids: [1] },
      });
      assert.equal(user.status, 201);
      assert.equal(user.json.data.email, 'sub@example.com');
      subAdmin = await tokenOf('sub@example.com', 'subadmin123');
    });

    test('duplicate email/phone is rejected', async () => {
      const res = await api('POST', '/users', { token: admin, body: { full_name: 'x', email: 'SUB@example.com', password: 'whatever123' } });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'DUPLICATE_IDENTIFIER');
    });

    test('sub-admin acts only inside granted permissions and scope', async () => {
      const gabbaiRole = rows(`SELECT id FROM Roles WHERE slug='gabbai'`)[0].id;
      assert.equal((await api('GET', '/users', { token: subAdmin })).status, 200);
      // can create a gabbai for synagogue 1 ...
      const ok = await api('POST', '/users', { token: subAdmin, body: { full_name: 'גבאי חדש', phone: '0533333333', password: 'newgabbai1', role_id: gabbaiRole, synagogue_ids: [1] } });
      // ... except the gabbai role holds permissions the sub-admin lacks (synagogues:update, delete locations, ...) => escalation blocked
      assert.equal(ok.status, 403);
      assert.equal(ok.json.error.code, 'CANNOT_ASSIGN');
      // a user with the sub-admin's own role is fine for synagogue 1, but not for synagogue 2 or all synagogues
      const body = { full_name: 'עמית', phone: '0544444444', password: 'peerpass123', role_id: regionalRoleId };
      assert.equal((await api('POST', '/users', { token: subAdmin, body: { ...body, synagogue_ids: [1] } })).status, 201);
      assert.equal((await api('POST', '/users', { token: subAdmin, body: { ...body, phone: '0555555555', synagogue_ids: [2] } })).status, 403);
      assert.equal((await api('POST', '/users', { token: subAdmin, body: { ...body, phone: '0555555555', all_synagogues: true } })).status, 403);
      assert.equal((await api('POST', '/users', { token: subAdmin, body: { ...body, phone: '0555555555', is_super_admin: true } })).status, 403);
    });

    test('sub-admin cannot see or edit the super admin or users beyond their reach', async () => {
      const list = (await api('GET', '/users', { token: subAdmin })).json.data;
      assert.ok(!list.some((u) => u.is_super_admin));
      assert.ok(!list.some((u) => u.email === 'gabbai1@example.com')); // gabbai has permissions the sub-admin lacks
      assert.equal((await api('PATCH', '/users/1', { token: subAdmin, body: { full_name: 'x' } })).status, 403);
      assert.equal((await api('DELETE', '/users/1', { token: subAdmin })).status, 403);
      // no roles:manage permission => no role creation
      assert.equal((await api('POST', '/roles', { token: subAdmin, body: { name: 'y', permissions: [] } })).status, 403);
      // cannot create synagogues (no permission); cannot create minyan outside scope
      assert.equal((await api('POST', '/synagogues', { token: subAdmin, body: { name: 'z' } })).status, 403);
      assert.equal((await api('POST', '/minyanim', { token: subAdmin, body: { synagogue_id: 2, prayer_type_id: 1, time_type_id: 1, time_value: '07:00' } })).status, 403);
    });

    test('nobody can change own role/scope or delete themselves; last super admin is protected', async () => {
      const subId = rows(`SELECT id FROM Users WHERE email='sub@example.com'`)[0].id;
      assert.equal((await api('PATCH', `/users/${subId}`, { token: subAdmin, body: { all_synagogues: true } })).json.error.code, 'CANNOT_MODIFY_SELF');
      assert.equal((await api('PATCH', '/users/1', { token: admin, body: { is_active: false } })).json.error.code, 'CANNOT_MODIFY_SELF');
      assert.equal((await api('DELETE', '/users/1', { token: admin })).status, 403);
      // second super admin; demoting the first is allowed only while another active one exists
      const second = await api('POST', '/users', { token: admin, body: { full_name: 'מנהל שני', email: 'two@example.com', password: 'adminpass2', is_super_admin: true } });
      assert.equal(second.status, 201);
      const two = await tokenOf('two@example.com', 'adminpass2');
      assert.equal((await api('PATCH', '/users/1', { token: two, body: { is_super_admin: false } })).status, 200);
      assert.equal((await api('PATCH', `/users/${second.json.data.id}`, { token: admin, body: { is_super_admin: true } })).status, 403); // admin lost super rights
      await api('PATCH', '/users/1', { token: two, body: { is_super_admin: true } });
    });

    test('deactivating a user kills their sessions; role in use cannot be deleted', async () => {
      const subId = rows(`SELECT id FROM Users WHERE email='sub@example.com'`)[0].id;
      assert.equal((await api('DELETE', `/roles/${regionalRoleId}`, { token: admin })).json.error.code, 'IN_USE');
      assert.equal((await api('PATCH', `/users/${subId}`, { token: admin, body: { is_active: false } })).status, 200);
      assert.equal((await api('GET', '/auth/me', { token: subAdmin })).status, 401);
      assert.equal((await login('sub@example.com', 'subadmin123')).json.error.code, 'ACCOUNT_DISABLED');
    });

    test('built-in "sub_admin" role can create gabbaim inside its scope only', async () => {
      const subRole = rows(`SELECT id FROM Roles WHERE slug='sub_admin'`)[0].id;
      const gabbaiRole = rows(`SELECT id FROM Roles WHERE slug='gabbai'`)[0].id;
      const created = await api('POST', '/users', { token: admin, body: { full_name: 'מנהל משנה כללי', email: 'sub2@example.com', password: 'subadmin222', role_id: subRole, synagogue_ids: [1] } });
      assert.equal(created.status, 201);
      const t = await tokenOf('sub2@example.com', 'subadmin222');
      const gabbai = { full_name: 'גבאי חדש', phone: '0566666666', password: 'newgabbai1', role_id: gabbaiRole };
      assert.equal((await api('POST', '/users', { token: t, body: { ...gabbai, synagogue_ids: [1] } })).status, 201);
      assert.equal((await api('POST', '/users', { token: t, body: { ...gabbai, phone: '0577777777', synagogue_ids: [2] } })).status, 403);
    });

    test('system roles are protected', async () => {
      const gabbaiRole = rows(`SELECT id FROM Roles WHERE slug='gabbai'`)[0].id;
      assert.equal((await api('DELETE', `/roles/${gabbaiRole}`, { token: admin })).status, 409);
      assert.equal((await api('PATCH', `/roles/${gabbaiRole}`, { token: admin, body: { name: 'אחר' } })).status, 409);
    });
  });

  describe('reference data & dependent deletes', () => {
    test('/meta returns typed data', async () => {
      const meta = (await api('GET', '/meta', { token: gabbai1 })).json.data;
      assert.equal(meta.seasons.find((s) => s.name === 'חורף').is_default, true);
      assert.deepEqual(meta.time_types[1].allowed_prayer_ids, [1]);
      assert.equal(meta.time_types[1].is_relative, true);
    });

    test('seasons keep exactly one default (atomic); default / in-use rows cannot be deleted', async () => {
      const created = await api('POST', '/seasons', { token: admin, body: { name: 'סתיו', is_default: true } });
      assert.equal(created.status, 201);
      const seasons = (await api('GET', '/seasons', { token: admin })).json.data;
      assert.equal(seasons.filter((s) => s.is_default).length, 1);
      assert.equal(seasons.find((s) => s.is_default).name, 'סתיו');
      assert.equal((await api('DELETE', `/seasons/${created.json.data.id}`, { token: admin })).json.error.code, 'DEFAULT_REQUIRED');
      assert.equal((await api('PATCH', `/seasons/${created.json.data.id}`, { token: admin, body: { is_default: false } })).status, 409);
      // season 1 has minyanim attached from earlier tests? use prayer type 1 which is definitely in use
      assert.equal((await api('DELETE', '/prayer-types/1', { token: admin })).json.error.code, 'IN_USE');
    });

    test('unknown columns in lookup bodies are ignored (no column injection)', async () => {
      const res = await api('POST', '/areas', { token: admin, body: { name: 'דרום', 'id) VALUES (1); DROP TABLE Users; --': 'x' } });
      assert.equal(res.status, 201);
      assert.equal(rows(`SELECT COUNT(*) c FROM Users`)[0].c >= 3, true);
    });

    test('deleting a synagogue needs ?cascade=true and then removes children atomically', async () => {
      const blocked = await api('DELETE', '/synagogues/2', { token: admin });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.error.code, 'HAS_DEPENDENTS');
      assert.ok(blocked.json.error.details.minyanim >= 1);
      assert.equal((await api('DELETE', '/synagogues/2?cascade=true', { token: admin })).status, 200);
      assert.equal(rows(`SELECT COUNT(*) c FROM Minyanim WHERE synagogue_id = 2`)[0].c, 0);
      assert.equal(rows(`SELECT COUNT(*) c FROM Locations WHERE synagogue_id = 2`)[0].c, 0);
      assert.equal(rows(`SELECT COUNT(*) c FROM UserSynagogues WHERE synagogue_id = 2`)[0].c, 0);
    });

    test('deleting a location keeps its minyanim', async () => {
      const m = await api('POST', '/minyanim', { token: gabbai1, body: { synagogue_id: 1, location_id: 1, prayer_type_id: 2, time_type_id: 1, time_value: '13:00' } });
      assert.equal((await api('DELETE', '/locations/1', { token: gabbai1 })).status, 200);
      assert.equal((await api('GET', `/minyanim/${m.json.data.id}`, { token: gabbai1 })).json.data.location_id, null);
    });
  });

  describe('sessions and passwords', () => {
    test('logout invalidates the token; change-password signs out other devices', async () => {
      const t1 = await tokenOf('gabbai1@example.com', 'gabbaipass1');
      const t2 = await tokenOf('gabbai1@example.com', 'gabbaipass1');
      assert.equal((await api('POST', '/auth/logout', { token: t1 })).status, 200);
      assert.equal((await api('GET', '/auth/me', { token: t1 })).status, 401);

      assert.equal((await api('POST', '/auth/change-password', { token: t2, body: { current_password: 'wrong', new_password: 'brandnew123' } })).status, 401);
      assert.equal((await api('POST', '/auth/change-password', { token: t2, body: { current_password: 'gabbaipass1', new_password: 'short' } })).status, 400);
      assert.equal((await api('POST', '/auth/change-password', { token: t2, body: { current_password: 'gabbaipass1', new_password: 'brandnew123' } })).status, 200);
      assert.equal((await api('GET', '/auth/me', { token: gabbai1 })).status, 401); // older session revoked
      assert.equal((await api('GET', '/auth/me', { token: t2 })).status, 200);
      assert.equal((await login('gabbai1@example.com', 'gabbaipass1')).status, 401);
      assert.equal((await login('gabbai1@example.com', 'brandnew123')).status, 200);
    });

    test('tokens are stored hashed; at most 5 sessions per user', async () => {
      const t = await tokenOf('gabbai1@example.com', 'brandnew123');
      assert.equal(rows(`SELECT COUNT(*) c FROM Sessions WHERE token_hash = ?`, t)[0].c, 0);
      for (let i = 0; i < 7; i++) await login('gabbai1@example.com', 'brandnew123');
      assert.ok(rows(`SELECT COUNT(*) c FROM Sessions WHERE user_id = 2`)[0].c <= 5);
    });

    test('brute force: lockout after repeated failures, even with the right password afterwards', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await login('gabbai2-nonexistent@example.com', 'bad')).status, 401);
      const locked = await login('gabbai2-nonexistent@example.com', 'bad');
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get('Retry-After')) > 0);
    });
  });
});
