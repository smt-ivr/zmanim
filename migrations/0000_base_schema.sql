-- Base ("legacy") schema, reconstructed from the original code.
-- Every statement is IF NOT EXISTS, so on your existing database this migration changes nothing.
-- On a brand-new database it creates the tables that 0001 then upgrades.

CREATE TABLE IF NOT EXISTS Areas (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Synagogues (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  area_id INTEGER REFERENCES Areas(id),
  address TEXT
);

CREATE TABLE IF NOT EXISTS Locations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  synagogue_id INTEGER NOT NULL REFERENCES Synagogues(id)
);

CREATE TABLE IF NOT EXISTS PrayerTypes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  allow_update_from TEXT,
  allow_update_to   TEXT
);

CREATE TABLE IF NOT EXISTS TimeTypes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  is_relative        INTEGER NOT NULL DEFAULT 0,
  allowed_prayer_ids TEXT
);

CREATE TABLE IF NOT EXISTS Seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Minyanim (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synagogue_id   INTEGER NOT NULL REFERENCES Synagogues(id),
  location_id    INTEGER REFERENCES Locations(id),
  prayer_type_id INTEGER NOT NULL REFERENCES PrayerTypes(id),
  season_id      INTEGER NOT NULL REFERENCES Seasons(id),
  time_type_id   INTEGER NOT NULL REFERENCES TimeTypes(id),
  time_value     TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT,
  email         TEXT,
  phone         TEXT,
  password      TEXT,                       -- legacy plaintext, superseded by password_hash (see 0001)
  is_admin      INTEGER NOT NULL DEFAULT 0, -- now means "super admin"
  synagogue_ids TEXT                        -- legacy JSON array, superseded by UserSynagogues
);

CREATE TABLE IF NOT EXISTS Tokens (          -- legacy plaintext tokens, superseded by Sessions
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
