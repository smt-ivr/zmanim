import { batch, prepare } from '../lib/db.js';
import { ok } from '../lib/http.js';
import { LOOKUPS, serializeLookup } from './lookups.js';

// One call that gives the UI everything it needs to render forms and dropdowns.
export async function get({ env }) {
  const keys = ['prayer-types', 'time-types', 'seasons', 'areas'];
  const results = await batch(env, keys.map((k) => prepare(env, `SELECT * FROM ${LOOKUPS[k].table} ORDER BY id`)));
  const [prayer_types, time_types, seasons, areas] = results.map((res, i) =>
    res.results.map((row) => serializeLookup(LOOKUPS[keys[i]], row))
  );
  return ok({ prayer_types, time_types, seasons, areas });
}
