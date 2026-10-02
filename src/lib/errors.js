// Typed API errors. Anything thrown that is not an ApiError becomes a generic 500.

export class ApiError extends Error {
  constructor(status, code, message, details = undefined, headers = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const badRequest = (message = 'בקשה לא תקינה', details) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const validationError = (details) =>
  new ApiError(400, 'VALIDATION_ERROR', 'הנתונים שנשלחו אינם תקינים', details);

export const unauthorized = (message = 'נדרשת התחברות', code = 'UNAUTHORIZED') =>
  new ApiError(401, code, message);

export const forbidden = (message = 'אין לך הרשאה לבצע פעולה זו', code = 'FORBIDDEN', details) =>
  new ApiError(403, code, message, details);

export const notFound = (message = 'המשאב המבוקש לא נמצא') =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message, code = 'CONFLICT', details) =>
  new ApiError(409, code, message, details);

export const tooManyRequests = (retryAfterSeconds) =>
  new ApiError(429, 'TOO_MANY_REQUESTS', 'יותר מדי ניסיונות. נסה שוב מאוחר יותר', undefined, {
    'Retry-After': String(retryAfterSeconds),
  });
