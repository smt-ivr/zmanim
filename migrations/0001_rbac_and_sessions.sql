-- Upgrades the legacy schema to: hashed passwords, hashed sessions, roles & permissions,
-- normalized user<->synagogue scope, login throttling. Purely additive: no legacy column or table is dropped.

-- ---------------------------------------------------------------- Roles & permissions
CREATE TABLE Roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE,                 -- stable id for built-in roles, NULL for custom roles
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  is_system   INTEGER NOT NULL DEFAULT 0,  -- built-in roles cannot be deleted or renamed
  created_at  TEXT
);

CREATE TABLE RolePermissions (
  role_id    INTEGER NOT NULL REFERENCES Roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) WITHOUT ROWID;

-- Built-in roles
INSERT INTO Roles (slug, name, description, is_system, created_at) VALUES
  ('gabbai',    'גבאי',       'ניהול בית הכנסת (או בתי הכנסת) המשויכים אליו בלבד', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_admin', 'מנהל משנה',  'ניהול רחב יותר, כולל ניהול גבאים. הרשאות והיקף נקבעים על ידי המנהל הראשי', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO RolePermissions (role_id, permission)
SELECT r.id, p.value FROM Roles r, json_each('["synagogues:update","locations:create","locations:update","locations:delete","minyanim:create","minyanim:update","minyanim:delete"]') p
WHERE r.slug = 'gabbai';

INSERT INTO RolePermissions (role_id, permission)
SELECT r.id, p.value FROM Roles r, json_each('["synagogues:create","synagogues:update","locations:create","locations:update","locations:delete","minyanim:create","minyanim:update","minyanim:delete","users:read","users:create","users:update"]') p
WHERE r.slug = 'sub_admin';

-- ---------------------------------------------------------------- Users upgrade (additive)
ALTER TABLE Users ADD COLUMN password_hash   TEXT;
ALTER TABLE Users ADD COLUMN role_id         INTEGER REFERENCES Roles(id);
ALTER TABLE Users ADD COLUMN all_synagogues  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE Users ADD COLUMN is_active       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE Users ADD COLUMN created_at      TEXT;
ALTER TABLE Users ADD COLUMN updated_at      TEXT;
ALTER TABLE Users ADD COLUMN last_login_at   TEXT;

-- Normalize identifiers so login lookups are exact matches
UPDATE Users SET email = lower(trim(email)) WHERE email IS NOT NULL;
UPDATE Users SET phone = replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', '') WHERE phone IS NOT NULL;
UPDATE Users SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at IS NULL;

-- Empty strings (legacy "no value") are ignored by these partial unique indexes
CREATE UNIQUE INDEX idx_users_email_unique ON Users(email) WHERE email IS NOT NULL AND email != '';
CREATE UNIQUE INDEX idx_users_phone_unique ON Users(phone) WHERE phone IS NOT NULL AND phone != '';

-- ---------------------------------------------------------------- User <-> synagogue scope
CREATE TABLE UserSynagogues (
  user_id      INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  synagogue_id INTEGER NOT NULL REFERENCES Synagogues(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, synagogue_id)
) WITHOUT ROWID;
CREATE INDEX idx_user_synagogues_synagogue ON UserSynagogues(synagogue_id);

-- Legacy non-admin users become "gabbai" with the synagogues from their old JSON column
UPDATE Users SET role_id = (SELECT id FROM Roles WHERE slug = 'gabbai')
WHERE COALESCE(is_admin, 0) != 1 AND role_id IS NULL;

INSERT OR IGNORE INTO UserSynagogues (user_id, synagogue_id)
SELECT u.id, CAST(j.value AS INTEGER)
FROM Users u, json_each(CASE WHEN json_valid(u.synagogue_ids) = 1 THEN u.synagogue_ids ELSE '[]' END) j
WHERE COALESCE(u.is_admin, 0) != 1
  AND j.type IN ('integer', 'text')
  AND EXISTS (SELECT 1 FROM Synagogues s WHERE s.id = CAST(j.value AS INTEGER));

-- ---------------------------------------------------------------- Sessions (hashed tokens)
CREATE TABLE Sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 of the bearer token; the token itself is never stored
  created_at   INTEGER NOT NULL,       -- unix seconds
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX idx_sessions_user    ON Sessions(user_id);
CREATE INDEX idx_sessions_expires ON Sessions(expires_at);

-- ---------------------------------------------------------------- Login throttling
CREATE TABLE LoginAttempts (
  key          TEXT PRIMARY KEY,       -- "id:<identifier>" or "ip:<address>"
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- Indexes on existing tables
CREATE INDEX IF NOT EXISTS idx_synagogues_area      ON Synagogues(area_id);
CREATE INDEX IF NOT EXISTS idx_locations_synagogue  ON Locations(synagogue_id);
CREATE INDEX IF NOT EXISTS idx_minyanim_synagogue   ON Minyanim(synagogue_id);
CREATE INDEX IF NOT EXISTS idx_minyanim_location    ON Minyanim(location_id);
CREATE INDEX IF NOT EXISTS idx_minyanim_prayer      ON Minyanim(prayer_type_id);
CREATE INDEX IF NOT EXISTS idx_minyanim_time_type   ON Minyanim(time_type_id);
CREATE INDEX IF NOT EXISTS idx_minyanim_season      ON Minyanim(season_id);
