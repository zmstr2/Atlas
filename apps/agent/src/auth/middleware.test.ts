import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { requireAuth, getUserId, __setJWKSForTesting } from './middleware';

type AuthVars = { Variables: { userId: string; userEmail: string | undefined } };

const TEST_SUPABASE_URL = 'https://test.supabase.co';
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const TEST_USER_ID = 'user-abc-123';
const TEST_EMAIL = 'user@example.com';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let prevSupabaseUrl: string | undefined;

async function signToken(opts: {
  sub?: string | null;
  email?: string;
  iss?: string;
  expSecondsFromNow?: number;
} = {}): Promise<string> {
  const sub = opts.sub === null ? undefined : (opts.sub ?? TEST_USER_ID);
  const builder = new SignJWT({
    ...(opts.email !== undefined ? { email: opts.email } : { email: TEST_EMAIL }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? TEST_ISSUER)
    .setExpirationTime(
      Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 3600)
    );
  if (sub) builder.setSubject(sub);
  return builder.sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;

  // Sanity-check: ensure exportJWK works with the public key (jose path).
  await exportJWK(publicKey);

  // JWKS resolver override that always returns our test public key.
  __setJWKSForTesting(async () => publicKey);

  prevSupabaseUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;
});

afterAll(() => {
  __setJWKSForTesting(null);
  if (prevSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = prevSupabaseUrl;
});

function buildApp() {
  const app = new Hono<AuthVars>();
  app.use('/protected/*', requireAuth());
  app.get('/protected/me', (c) => {
    const userId = getUserId(c);
    const email = c.get('userEmail');
    return c.json({ userId, email });
  });
  app.get('/protected/calls/:id/stream', (c) => {
    const userId = getUserId(c);
    return c.json({ userId, streamed: true });
  });
  app.get('/protected/calls/:id', (c) => {
    const userId = getUserId(c);
    return c.json({ userId });
  });
  return app;
}

describe('requireAuth middleware', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp();
  });

  test('valid JWT attaches userId and email to context', async () => {
    const token = await signToken();
    const res = await app.request('/protected/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.email).toBe(TEST_EMAIL);
  });

  test('missing Authorization header → 401 missing_token', async () => {
    const res = await app.request('/protected/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'missing_token' });
  });

  test('non-Bearer scheme → 401 malformed', async () => {
    const res = await app.request('/protected/me', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'malformed' });
  });

  test('malformed token (not 3 parts) → 401 malformed', async () => {
    const res = await app.request('/protected/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'malformed' });
  });

  test('expired token → 401 expired', async () => {
    const token = await signToken({ expSecondsFromNow: -60 });
    const res = await app.request('/protected/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'expired' });
  });

  test('valid signature, wrong issuer → 401 invalid_issuer', async () => {
    const token = await signToken({ iss: 'https://attacker.example/auth/v1' });
    const res = await app.request('/protected/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'invalid_issuer' });
  });
});

describe('SSE token query-param fallback', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp();
  });

  test('valid ?token= on /stream path → userId attached', async () => {
    const token = await signToken();
    const res = await app.request(`/protected/calls/foo/stream?token=${token}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.streamed).toBe(true);
  });

  test('expired ?token= on /stream path → 401 expired', async () => {
    const token = await signToken({ expSecondsFromNow: -60 });
    const res = await app.request(`/protected/calls/foo/stream?token=${token}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'expired' });
  });

  test('?token= on non-/stream path → 401 missing_token (not accepted)', async () => {
    const token = await signToken();
    const res = await app.request(`/protected/calls/foo?token=${token}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'missing_token' });
  });

  test('/stream path without any token → 401 missing_token', async () => {
    const res = await app.request('/protected/calls/foo/stream');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'missing_token' });
  });

  test('malformed ?token= on /stream path → 401 malformed', async () => {
    const res = await app.request('/protected/calls/foo/stream?token=not-a-jwt');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'malformed' });
  });

  test('header takes precedence when both header and query token present', async () => {
    const headerToken = await signToken({ sub: 'header-user' });
    const queryToken = await signToken({ sub: 'query-user' });
    const res = await app.request(
      `/protected/calls/foo/stream?token=${queryToken}`,
      { headers: { authorization: `Bearer ${headerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('header-user');
  });
});

describe('getUserId helper', () => {
  test('throws when called without requireAuth running', async () => {
    const app = new Hono();
    let threw = false;
    app.get('/no-auth', (c) => {
      try {
        getUserId(c);
      } catch {
        threw = true;
      }
      return c.text(threw ? 'threw' : 'no-throw');
    });
    const res = await app.request('/no-auth');
    expect(await res.text()).toBe('threw');
  });
});
