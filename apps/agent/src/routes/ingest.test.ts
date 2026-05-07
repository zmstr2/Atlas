/**
 * Cross-tenant security tests for /calls/* mutating routes.
 *
 * The class of bug being prevented: requireAuth proves *who* is calling, but
 * the call_id in the URL is attacker-controllable. Without an explicit
 * ownership check, a logged-in userB could inject utterances into userA's
 * live call, end it, relabel speakers, or subscribe to its SSE stream and
 * read the live transcript.
 *
 * Every mutating handler must return 404 when the authenticated user does
 * not own the call. 404 (not 403) is deliberate — leaking "this id exists"
 * is useful to attackers enumerating call ids.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { SignJWT, generateKeyPair } from 'jose';
import type { PreCallBrief } from '@atlas/types';
import { __setJWKSForTesting } from './../auth/middleware';
import { app } from './../app';
import { _resetDbForTests } from './../db/sqlite';

const TEST_SUPABASE_URL = 'https://test.supabase.co';
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const USER_A = 'user-a-aaaaaaaa';
const USER_B = 'user-b-bbbbbbbb';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let prevSupabaseUrl: string | undefined;

async function signTokenFor(sub: string): Promise<string> {
  return new SignJWT({ email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setSubject(sub)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

const BRIEF: PreCallBrief = {
  lead: { name: 'Maya Chen', title: 'VP Marketing', company: 'MidCo', companySize: '50-200 employees' },
  avaContext: { campaignId: 'c-1', leadScore: 0.5, scoringSignals: [] },
  pastInteractions: [],
  callGoal: 'qualify',
  suggestedQuestions: [],
  productSnippets: [],
};

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

beforeEach(() => {
  _resetDbForTests();
});

async function createCallAs(userToken: string): Promise<string> {
  const res = await app.request('/calls', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({ brief: BRIEF }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { callId: string };
  return body.callId;
}

describe('cross-tenant access on /calls/:callId/* routes', () => {
  test('userA creates a call → userB POST /utterance returns 404', async () => {
    const tokenA = await signTokenFor(USER_A);
    const tokenB = await signTokenFor(USER_B);
    const callId = await createCallAs(tokenA);

    const res = await app.request(`/calls/${callId}/utterance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        participantId: 'p1',
        text: 'injected by attacker',
        startMs: 0,
        endMs: 1000,
        speaker: 'founder',
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_call');
  });

  test('userA owner POST /utterance succeeds', async () => {
    const tokenA = await signTokenFor(USER_A);
    const callId = await createCallAs(tokenA);

    const res = await app.request(`/calls/${callId}/utterance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        participantId: 'p1',
        text: 'hi',
        startMs: 0,
        endMs: 1000,
        speaker: 'founder',
      }),
    });
    expect(res.status).toBe(200);
  });

  test('userB PATCH /participants/:id on userA call returns 404', async () => {
    const tokenA = await signTokenFor(USER_A);
    const tokenB = await signTokenFor(USER_B);
    const callId = await createCallAs(tokenA);

    const res = await app.request(`/calls/${callId}/participants/p1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ role: 'founder' }),
    });
    expect(res.status).toBe(404);
  });

  test('userB POST /end on userA call returns 404 (and does not finalize)', async () => {
    const tokenA = await signTokenFor(USER_A);
    const tokenB = await signTokenFor(USER_B);
    const callId = await createCallAs(tokenA);

    const res = await app.request(`/calls/${callId}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(404);

    // Confirm the call is still in 'active' state for userA — the attacker's
    // /end attempt must not have finalized it.
    const own = await app.request(`/calls/${callId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { call: { status: string } };
    expect(ownBody.call.status).toBe('active');
  });

  test('userB GET /:callId/stream on userA call returns 404 (no SSE leak)', async () => {
    const tokenA = await signTokenFor(USER_A);
    const tokenB = await signTokenFor(USER_B);
    const callId = await createCallAs(tokenA);

    const res = await app.request(
      `/calls/${callId}/stream?token=${encodeURIComponent(tokenB)}`,
    );
    expect(res.status).toBe(404);
    // Critically: must NOT have started an SSE stream (Content-Type must
    // not be text/event-stream).
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  test('userA GET /:callId/stream on own call returns SSE', async () => {
    const tokenA = await signTokenFor(USER_A);
    const callId = await createCallAs(tokenA);

    const res = await app.request(
      `/calls/${callId}/stream?token=${encodeURIComponent(tokenA)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    // Don't actually drain the stream — that would block the test.
    const reader = res.body?.getReader();
    await reader?.cancel();
  });

  test('unknown callId returns 404 for any authenticated user (no enumeration leak)', async () => {
    const tokenA = await signTokenFor(USER_A);
    const res = await app.request(`/calls/does-not-exist/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(404);
  });

  test('GET /calls (list) is per-user — userA does not see userB calls', async () => {
    const tokenA = await signTokenFor(USER_A);
    const tokenB = await signTokenFor(USER_B);
    await createCallAs(tokenA);
    await createCallAs(tokenB);

    const res = await app.request('/calls', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: Array<{ id: string; user_id: string }> };
    expect(body.calls.length).toBe(1);
    expect(body.calls[0].user_id).toBe(USER_A);
  });
});

describe('SSE query-param scoping', () => {
  test('?token= is rejected on non-stream paths even when valid', async () => {
    const tokenA = await signTokenFor(USER_A);
    const callId = await createCallAs(tokenA);

    // Try the token via query param against GET /calls/:id (not /stream).
    // The middleware should NOT honor query-param tokens here.
    const res = await app.request(
      `/calls/${callId}?token=${encodeURIComponent(tokenA)}`,
    );
    expect(res.status).toBe(401);
  });
});
