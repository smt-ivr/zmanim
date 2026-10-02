// Hashes legacy plaintext passwords for users who have not logged in since the upgrade.
//
//   wrangler d1 execute zmanim --remote --json \
//     --command "SELECT id, password FROM Users WHERE password_hash IS NULL AND COALESCE(password,'') != ''" > legacy.json
//   node scripts/hash-legacy-passwords.mjs legacy.json > hashed.sql
//   wrangler d1 execute zmanim --remote --file hashed.sql
import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/crypto.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/hash-legacy-passwords.mjs legacy.json');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(file, 'utf8'));
const rows = Array.isArray(parsed) ? parsed.flatMap((r) => r.results ?? []) : parsed.results ?? [];
const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;

for (const { id, password } of rows) {
  const hash = await hashPassword(String(password));
  console.log(`UPDATE Users SET password_hash = ${esc(hash)}, password = '' WHERE id = ${Number(id)} AND password_hash IS NULL;`);
}
