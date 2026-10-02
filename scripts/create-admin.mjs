// Usage: node scripts/create-admin.mjs "Full Name" "email@example.com" "0501234567" "StrongPassword" > admin.sql
//        wrangler d1 execute zmanim --remote --file admin.sql
// Leave email or phone as "" if unused (at least one is required).
import { hashPassword } from '../src/lib/crypto.js';

const [, , fullName, email = '', phone = '', password] = process.argv;
if (!fullName || !password || (!email && !phone)) {
  console.error('Usage: node scripts/create-admin.mjs "Full Name" "email" "phone" "password"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const normPhone = phone.replace(/[\s\-().]/g, '');

console.log(
  `INSERT INTO Users (full_name, email, phone, password, password_hash, is_admin, all_synagogues, is_active, created_at, updated_at) VALUES (` +
    [esc(fullName), esc(email.trim().toLowerCase()), esc(normPhone), esc(''), esc(await hashPassword(password)), 1, 1, 1, esc(now), esc(now)].join(', ') +
    ');'
);
