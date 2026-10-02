// Thin helpers around D1. All SQL in this project uses bound parameters;
// the only interpolated fragments are constants defined in code.

export const nowIso = () => new Date().toISOString();
export const nowSec = () => Math.floor(Date.now() / 1000);

export const prepare = (env, sql, ...params) => env.DB.prepare(sql).bind(...params);
export const first = (env, sql, ...params) => prepare(env, sql, ...params).first();
export const run = (env, sql, ...params) => prepare(env, sql, ...params).run();
export const batch = (env, statements) => env.DB.batch(statements);

export async function all(env, sql, ...params) {
  const { results } = await prepare(env, sql, ...params).all();
  return results ?? [];
}

export const toBool = (v) => v === 1 || v === true || v === '1';
export const toFlag = (b) => (b ? 1 : 0);

// Tolerant parser for id lists stored as JSON ("[1,2]") or CSV ("1,2")
export function parseIdList(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  let values;
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = String(raw).split(',');
  }
  return [...new Set(values.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
}
