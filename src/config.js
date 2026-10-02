// Central configuration constants.

export const API_PREFIX = '/zmanim/api/v1';
export const MAX_BODY_BYTES = 64 * 1024;

// Sessions
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60; // update last_used_at at most every 5 min
export const MAX_SESSIONS_PER_USER = 5;

// Passwords (Cloudflare Workers caps PBKDF2 at 100,000 iterations)
export const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_MIN_LENGTH = 8;

// Login throttling
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_LOCK_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES_PER_IDENTIFIER = 5;
export const LOGIN_MAX_FAILURES_PER_IP = 30;

// Pagination
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 1000;
