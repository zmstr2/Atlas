import { Redis } from '@upstash/redis';

/**
 * Abuse protection for the endpoints that spend money (OpenAI Realtime, LLM calls).
 *
 * - Same-origin check: stops other websites from using this as a free API.
 *   (curl can spoof Origin, so the daily caps below are what actually bound spend.)
 * - Per-IP and global daily caps, stored in Upstash Redis when it's configured
 *   (add the Upstash integration in the Vercel Marketplace; it sets the env vars).
 *   Without Redis, caps fall back to per-instance memory, which is fine for local
 *   dev but resets on every cold start.
 */

const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

const memCounters = new Map<string, number>();
let warned = false;

async function incr(key: string): Promise<number> {
  if (redis) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60 * 60 * 48);
    return n;
  }
  if (!warned && process.env.NODE_ENV === 'production') {
    warned = true;
    console.warn('[limits] Upstash Redis is not configured; daily caps are per-instance and reset on cold start.');
  }
  const n = (memCounters.get(key) ?? 0) + 1;
  memCounters.set(key, n);
  return n;
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type Scope = 'session' | 'turn' | 'chat';

const CAPS: Record<Scope, { ip: number; global: number }> = {
  // Each session is a billed OpenAI Realtime call.
  session: {
    ip: intFromEnv('REALTIME_IP_DAILY_CAP', 5),
    global: intFromEnv('REALTIME_DAILY_SESSION_CAP', 150),
  },
  // Each turn is a few LLM calls; a 5-minute call is roughly 40-60 turns.
  turn: {
    ip: intFromEnv('TURN_IP_DAILY_CAP', 400),
    global: intFromEnv('TURN_DAILY_CAP', 4000),
  },
  chat: {
    ip: intFromEnv('CHAT_IP_DAILY_CAP', 60),
    global: intFromEnv('CHAT_DAILY_CAP', 600),
  },
};

/** Best-effort client IP. Vercel sets x-forwarded-for to the real client address. */
export function clientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return 'unknown';
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return process.env.NODE_ENV !== 'production';
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

function deny(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status });
}

/** Returns a Response to send back if the request must be refused, or null to proceed. */
export async function guard(
  req: Request,
  scope: Scope,
  opts: { failClosed?: boolean } = {},
): Promise<Response | null> {
  if (!sameOrigin(req)) return deny(403, 'Origin not allowed', 'BAD_ORIGIN');

  const day = new Date().toISOString().slice(0, 10);
  const caps = CAPS[scope];
  try {
    const ipCount = await incr(`atlas:${scope}:${day}:ip:${clientIp(req)}`);
    if (ipCount > caps.ip) {
      return deny(429, "You've used all of today's demo calls. Try again tomorrow.", 'RATE_LIMITED');
    }
    const globalCount = await incr(`atlas:${scope}:${day}:global`);
    if (globalCount > caps.global) {
      return deny(429, 'Demo capacity reached for today. Try again tomorrow.', 'GLOBAL_LIMIT');
    }
  } catch (err) {
    console.error('[limits] counter failed', err);
    if (opts.failClosed) return deny(503, 'Demo temporarily unavailable.', 'LIMITER_DOWN');
  }
  return null;
}
