-- Run MANUALLY, only after:
--   1. the new API has been live for a while and users have logged in (passwords upgraded on first login), and
--   2. you ran scripts/hash-legacy-passwords.mjs for users who have not logged in yet.
--
-- Check who is still on plaintext (must return no rows before continuing):
--   SELECT id, full_name FROM Users WHERE password_hash IS NULL AND COALESCE(password, '') != '';

UPDATE Users SET password = '' WHERE password_hash IS NOT NULL;
DROP TABLE IF EXISTS Tokens;
-- Legacy JSON scope column is no longer used by the API:
UPDATE Users SET synagogue_ids = NULL;
