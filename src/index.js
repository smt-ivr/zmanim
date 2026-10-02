import { API_PREFIX } from './config.js';
import { authenticate } from './auth/session.js';
import { purgeExpired } from './auth/throttle.js';
import { ApiError, notFound } from './lib/errors.js';
import { errorResponse, finalize, preflight, readJson } from './lib/http.js';
import router from './routes.js';

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    let response;

    try {
      if (request.method === 'OPTIONS') return finalize(preflight(request, env), request, env, requestId);

      const url = new URL(request.url);
      if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) throw notFound('הנתיב לא קיים');
      const path = url.pathname.slice(API_PREFIX.length) || '/';

      const { route, params, allowed } = router.match(request.method, path);
      if (!route) {
        if (allowed.length) {
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'שיטת הבקשה אינה נתמכת בנתיב זה', undefined, { Allow: allowed.join(', ') });
        }
        throw notFound('הנתיב לא קיים');
      }

      const actor = route.auth ? await authenticate(env, request) : null;
      response = await route.handler({
        request,
        env,
        url,
        params,
        actor,
        requestId,
        body: () => readJson(request),
      });
    } catch (err) {
      response = errorResponse(err, requestId);
    }

    return finalize(response, request, env, requestId);
  },

  // Daily cron (see wrangler.toml)
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeExpired(env));
  },
};
