import type { Context } from 'hono';
import { checkAndIncrementIpSession } from '../db/sqlite';

/**
 * Abuse protection for endpoints that spend real money (OpenAI Realtime).
 *
 * - Origin allow-list: stops other websites from using the demo as a free API.
 *   (curl can spoof Origin, so this is not a security boundary on its own;
 *   the caps below are what actually bound spend.)
 * - Per-IP and global daily session caps, persisted in SQLite so they survive
 *   restarts. Tune with REALTIME_IP_DAILY_CAP / REALTIME_DAILY_SESSION_CAP.
 */

const IS_PROD =
  process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);

export function allowedOrigins(): string[] {
  return (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const REALTIME_IP_DAILY_CAP = intFromEnv('REALTIME_IP_DAILY_CAP', 5);
export const REALTIME_DAILY_SESSION_CAP = intFromEnv('REALTIME_DAILY_SESSION_CAP', 150);

/**
 * Best-effort client IP. X-Forwarded-For is client-controlled on its left side;
 * trusted proxies append the real peer on the right, so take the LAST entry.
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return 'unknown';
}

export type LimitResult =
  | { ok: true }
  | { ok: false; status: 403 | 429; error: string; code: string };

export function checkRealtimeLimits(c: Context): LimitResult {
  const origin = c.req.header('origin');
  if (origin) {
    if (!allowedOrigins().includes(origin.replace(/\/$/, ''))) {
      return { ok: false, status: 403, error: 'Origin not allowed', code: 'BAD_ORIGIN' };
    }
  } else if (IS_PROD) {
    // Browsers always send Origin on cross-origin POSTs; a missing one in prod is a script.
    return { ok: false, status: 403, error: 'Origin required', code: 'NO_ORIGIN' };
  }

  if (!checkAndIncrementIpSession(`rt:${clientIp(c)}`, REALTIME_IP_DAILY_CAP)) {
    return {
      ok: false,
      status: 429,
      error: 'You have used all of today\'s demo calls. Try again tomorrow.',
      code: 'RATE_LIMITED',
    };
  }
  if (!checkAndIncrementIpSession('rt:__global__', REALTIME_DAILY_SESSION_CAP)) {
    return {
      ok: false,
      status: 429,
      error: 'Demo capacity reached for today. Try again tomorrow.',
      code: 'GLOBAL_LIMIT',
    };
  }
  return { ok: true };
}
