import { notFound, validationError } from './errors.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^\+?\d{7,15}$/;
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const normalizePhone = (s) => String(s).replace(/[\s\-().]/g, '');
export const normalizeEmail = (s) => String(s).trim().toLowerCase();

/**
 * Collects all field errors and throws one VALIDATION_ERROR.
 * In `partial` mode (PATCH) absent fields are skipped instead of "required".
 * Only fields that were explicitly declared are copied to the result (no mass assignment).
 */
export class Validator {
  constructor(body, { partial = false } = {}) {
    this.body = body;
    this.partial = partial;
    this.errors = [];
    this.values = {};
  }

  #fail(field, message) {
    this.errors.push({ field, message });
  }

  #read(key, required) {
    const present = Object.prototype.hasOwnProperty.call(this.body, key) && this.body[key] !== undefined;
    if (!present) {
      if (required && !this.partial) this.#fail(key, 'שדה חובה');
      return { present: false };
    }
    return { present: true, raw: this.body[key] };
  }

  string(key, { required = false, min = 0, max = 255, trim = true, nullable = false, lowercase = false, transform, pattern, patternMessage } = {}) {
    const r = this.#read(key, required);
    if (!r.present) return this;
    let v = r.raw;
    if (v === null) {
      if (nullable) this.values[key] = null;
      else this.#fail(key, 'שדה חובה');
      return this;
    }
    if (typeof v !== 'string') {
      this.#fail(key, 'חייב להיות טקסט');
      return this;
    }
    if (trim) v = v.trim();
    if (lowercase) v = v.toLowerCase();
    if (transform) v = transform(v);

    if (v.length === 0) {
      if (nullable) this.values[key] = null;
      else if (required) this.#fail(key, 'שדה חובה');
      else this.values[key] = '';
      return this;
    }
    if (v.length < min) this.#fail(key, `קצר מדי (מינימום ${min} תווים)`);
    else if (v.length > max) this.#fail(key, `ארוך מדי (מקסימום ${max} תווים)`);
    else if (pattern && !pattern.test(v)) this.#fail(key, patternMessage ?? 'פורמט לא תקין');
    else this.values[key] = v;
    return this;
  }

  int(key, { required = false, min = -Infinity, max = Infinity, nullable = false } = {}) {
    const r = this.#read(key, required);
    if (!r.present) return this;
    let v = r.raw;
    if (v === null || v === '') {
      if (nullable) this.values[key] = null;
      else this.#fail(key, 'שדה חובה');
      return this;
    }
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = Number(v.trim());
    if (!Number.isInteger(v)) this.#fail(key, 'חייב להיות מספר שלם');
    else if (v < min || v > max) this.#fail(key, 'ערך מחוץ לטווח המותר');
    else this.values[key] = v;
    return this;
  }

  bool(key, { required = false } = {}) {
    const r = this.#read(key, required);
    if (!r.present) return this;
    const v = r.raw;
    if (v === true || v === 1 || v === '1' || v === 'true') this.values[key] = true;
    else if (v === false || v === 0 || v === '0' || v === 'false') this.values[key] = false;
    else this.#fail(key, 'חייב להיות true או false');
    return this;
  }

  intArray(key, { required = false, nullable = false, max = 500 } = {}) {
    const r = this.#read(key, required);
    if (!r.present) return this;
    const v = r.raw;
    if (v === null && nullable) {
      this.values[key] = [];
      return this;
    }
    if (!Array.isArray(v) || v.length > max) {
      this.#fail(key, 'חייב להיות מערך של מספרים שלמים');
      return this;
    }
    const nums = v.map((x) => (typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x.trim()) : x));
    if (!nums.every((n) => Number.isInteger(n) && n > 0)) {
      this.#fail(key, 'חייב להכיל מספרים שלמים חיוביים בלבד');
      return this;
    }
    this.values[key] = [...new Set(nums)];
    return this;
  }

  stringArray(key, { required = false, allowed } = {}) {
    const r = this.#read(key, required);
    if (!r.present) return this;
    const v = r.raw;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      this.#fail(key, 'חייב להיות מערך של מחרוזות');
      return this;
    }
    const unknown = allowed ? v.filter((x) => !allowed.includes(x)) : [];
    if (unknown.length) this.#fail(key, `ערכים לא מוכרים: ${unknown.join(', ')}`);
    else this.values[key] = [...new Set(v)];
    return this;
  }

  result() {
    if (this.errors.length) throw validationError(this.errors);
    return this.values;
  }
}

// ---- Query-string and path helpers ---------------------------------------

export function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw validationError([{ field: name, message: 'חייב להיות מספר שלם' }]);
  return Number(raw);
}

export function pagination(url) {
  const limit = intParam(url, 'limit') ?? DEFAULT_PAGE_SIZE;
  const offset = intParam(url, 'offset') ?? 0;
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw validationError([{ field: 'limit', message: `חייב להיות בין 1 ל-${MAX_PAGE_SIZE}` }]);
  }
  return { limit, offset };
}

// Path id like /users/:id — non-numeric ids simply do not exist
export function idParam(raw) {
  if (!/^\d+$/.test(String(raw))) throw notFound();
  return Number(raw);
}
