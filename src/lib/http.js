import { MAX_BODY_BYTES } from '../config.js';
import { ApiError, badRequest } from './errors.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const ok = (data = null, meta = undefined) =>
  json(meta ? { success: true, data, meta } : { success: true, data });

export const created = (data) => json({ success: true, data }, 201);

export function errorResponse(err, requestId) {
  let apiError = err;

  if (!(err instanceof ApiError)) {
    const msg = String(err?.message ?? '');
    // Safety net for race conditions that slip past explicit checks
    if (msg.includes('UNIQUE constraint failed')) {
      apiError = new ApiError(409, 'CONFLICT', 'הערך כבר קיים במערכת');
    } else if (msg.includes('FOREIGN KEY constraint failed')) {
      apiError = new ApiError(409, 'REFERENCE_CONFLICT', 'לא ניתן לבצע את הפעולה בשל קשרים לנתונים אחרים');
    } else {
      console.error(JSON.stringify({ requestId, error: msg, stack: err?.stack }));
      apiError = new ApiError(500, 'INTERNAL_ERROR', 'שגיאת שרת פנימית');
    }
  }

  const error = { code: apiError.code, message: apiError.message, request_id: requestId };
  if (apiError.details !== undefined) error.details = apiError.details;
  return json({ success: false, error }, apiError.status, apiError.headers ?? {});
}

export async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'גוף הבקשה גדול מדי');

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'גוף הבקשה גדול מדי');
  if (!text.trim()) throw badRequest('גוף הבקשה חסר');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'גוף הבקשה אינו JSON תקין');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('גוף הבקשה חייב להיות אובייקט JSON');
  }
  return parsed;
}

// ---- CORS & response hardening -------------------------------------------

function allowedOrigin(request, env) {
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length === 0) return { origin: '*', vary: false };
  const origin = request.headers.get('Origin');
  return { origin: origin && configured.includes(origin) ? origin : null, vary: true };
}

function corsHeaders(request, env) {
  const { origin, vary } = allowedOrigin(request, env);
  const h = new Headers();
  if (origin) h.set('Access-Control-Allow-Origin', origin);
  if (vary) h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

export function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export function finalize(response, request, env, requestId) {
  const headers = new Headers(response.headers);
  for (const [k, v] of corsHeaders(request, env)) headers.set(k, v);
  headers.set('X-Request-Id', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
