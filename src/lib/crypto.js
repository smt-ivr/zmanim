import { PBKDF2_ITERATIONS } from '../config.js';

const encoder = new TextEncoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const toB64Url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// Format: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const expected = fromB64(parts[4]);
  const actual = await derive(password, fromB64(parts[3]), iterations);
  return bytesEqual(actual, expected);
}

export function passwordNeedsRehash(stored) {
  return Number(String(stored).split('$')[2]) !== PBKDF2_ITERATIONS;
}

function bytesEqual(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Constant-time string comparison (used only for legacy plaintext passwords during migration)
export const timingSafeEqual = (a, b) => bytesEqual(encoder.encode(a), encoder.encode(b));

export function generateToken() {
  return 'zm_' + toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
