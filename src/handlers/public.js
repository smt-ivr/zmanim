import { all, first } from '../lib/db.js';
import { json, ok } from '../lib/http.js';
import { intParam, pagination } from '../lib/validate.js';
import { queryMinyanim } from '../services/minyanim.js';

const CACHE = { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' };

export async function health({ env }) {
  await first(env, 'SELECT 1 AS ok');
  return ok({ status: 'ok' });
}

export async function minyanim({ env, url }) {
  const filters = {
    synagogue_id: intParam(url, 'synagogue_id'),
    area_id: intParam(url, 'area_id'),
    prayer_type_id: intParam(url, 'prayer_type_id'),
    season_id: intParam(url, 'season_id'),
  };
  const { limit, offset } = pagination(url);
  const data = await queryMinyanim(env, { filters, limit, offset });
  return json({ success: true, data, meta: { limit, offset, count: data.length } }, 200, CACHE);
}

export async function synagogues({ env, url }) {
  const areaId = intParam(url, 'area_id');
  const rows = await all(
    env,
    `SELECT s.id, s.name, s.address, s.area_id, a.name AS area_name
     FROM Synagogues s LEFT JOIN Areas a ON a.id = s.area_id
     ${areaId !== null ? 'WHERE s.area_id = ?' : ''} ORDER BY s.name`,
    ...(areaId !== null ? [areaId] : [])
  );
  return json({ success: true, data: rows }, 200, CACHE);
}
