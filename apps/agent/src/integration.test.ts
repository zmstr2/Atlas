/**
 * Integration tests for the Hono app's auth boundary.
 *
 * REGRESSION GUARD (Tier 2 from eng review): the auth middleware applies to
 * `/calls/*` ONLY. The web demo (`/demo`), persona practice realtime route
 * (`/realtime/session`), the chat route (`/chat`), and `/health` must STAY
 * public. If a future change accidentally adds a global `app.use('*',
 * requireAuth())`, both the public demo and desktop login will silently
 * break. These tests fail loudly when that happens.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SignJWT, generateKeyPair } from 'jose';
import { __setJWKSForTesting } from './auth/middleware';
import { app } from './app';

const TEST_SUPABASE_URL = 'https://test.supabase.co';
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const TEST_USER_ID = 'integration-user';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let prevSupabaseUrl: string | undefined;

async function signToken(): Promise<string> {
  return new SignJWT({ email: 'i@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setSubject(TEST_USER_ID)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
  __setJWKSForTesting(async () => publicKey);
  prevSupabaseUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;
});

afterAll(() => {
  __setJWKSForTesting(null);
  if (prevSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = prevSupabaseUrl;
});

describe('public routes stay unauthenticated', () => {
  test('GET /health → 200 with no Authorization header', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.costAttributionFailures).toBe('number');
  });

  test('GET /demo/brief/jordan → not 401 with no Authorization header', async () => {
    // May be 200 (fixture present) or 404 (fixture missing in test env);
    // contract is: NOT 401 from auth middleware.
    const res = await app.request('/demo/brief/jordan');
    expect(res.status).not.toBe(401);
  });

  test('POST /realtime/session → not 401 with no Authorization header', async () => {
    // May return 400 (bad body), 500 (no OPENAI_API_KEY in test env), etc.
    // The contract: it does NOT return 401 from auth middleware.
    const res = await app.request('/realtime/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });

  test('POST /chat → not 401 with no Authorization header', async () => {
    // May return 400/500 depending on body and env; the contract is no 401.
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });
});

describe('protected routes require auth', () => {
  test('GET /calls without auth → 401 missing_token', async () => {
    const res = await app.request('/calls');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('missing_token');
  });

  test('POST /calls without auth → 401', async () => {
    const res = await app.request('/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test('GET /calls/foo without auth → 401', async () => {
    const res = await app.request('/calls/foo');
    expect(res.status).toBe(401);
  });

  test('GET /calls/foo/stream with valid ?token= → not 401 (auth passes)', async () => {
    const token = await signToken();
    const res = await app.request(`/calls/foo/stream?token=${token}`);
    // Route may 404 (call doesn't exist) or 200; the contract is no 401.
    expect(res.status).not.toBe(401);
  });

  test('GET /calls/foo/stream without token → 401 missing_token', async () => {
    const res = await app.request('/calls/foo/stream');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('missing_token');
  });
});
