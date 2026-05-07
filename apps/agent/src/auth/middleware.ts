import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify, createRemoteJWKSet, errors as joseErrors, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Hono variables set by requireAuth on success.
 */
export type AuthVariables = {
  userId: string;
  userEmail: string | undefined;
};

type UnauthorizedCode =
  | 'missing_token'
  | 'malformed'
  | 'expired'
  | 'invalid_signature'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'invalid_token'
  | 'server_misconfigured';

/**
 * Test-only hook: replace the JWKS resolver. When set, requireAuth uses this
 * instead of the cached remote JWKS. Production code never calls this.
 */
let jwksOverride: JWTVerifyGetKey | null = null;
export function __setJWKSForTesting(jwks: JWTVerifyGetKey | null): void {
  jwksOverride = jwks;
}

let cachedJWKS: JWTVerifyGetKey | null = null;
let cachedJWKSUrl: string | null = null;

function getJWKS(supabaseUrl: string): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride;
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  if (cachedJWKS && cachedJWKSUrl === url) return cachedJWKS;
  cachedJWKS = createRemoteJWKSet(new URL(url), {
    cooldownDuration: 60_000,
    cacheMaxAge: 60 * 60 * 1000, // 1hr
  });
  cachedJWKSUrl = url;
  return cachedJWKS;
}

function unauthorized(c: Context, code: UnauthorizedCode) {
  return c.json({ error: 'unauthorized', code }, 401);
}

/**
 * Hono middleware that verifies a Supabase JWT from the Authorization header.
 *
 * On success: c.set('userId', sub) and c.set('userEmail', email).
 * On failure: returns 401 with {error:'unauthorized', code:<reason>}.
 *
 * Verification uses Supabase's JWKS endpoint (jose caches it for 1hr).
 */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      return unauthorized(c, 'server_misconfigured');
    }

    const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!authHeader) return unauthorized(c, 'missing_token');

    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) return unauthorized(c, 'malformed');
    const token = match[1].trim();
    if (!token) return unauthorized(c, 'missing_token');

    // Quick structural check: JWT has 3 dot-separated parts.
    if (token.split('.').length !== 3) return unauthorized(c, 'malformed');

    const expectedIssuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, getJWKS(supabaseUrl), {
        issuer: expectedIssuer,
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return unauthorized(c, 'expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        const claim = (err as joseErrors.JWTClaimValidationFailed).claim;
        if (claim === 'iss') return unauthorized(c, 'invalid_issuer');
        if (claim === 'aud') return unauthorized(c, 'invalid_audience');
        return unauthorized(c, 'invalid_token');
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        return unauthorized(c, 'invalid_signature');
      }
      if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
        return unauthorized(c, 'malformed');
      }
      return unauthorized(c, 'invalid_token');
    }

    const sub = payload.sub;
    if (!sub || typeof sub !== 'string') return unauthorized(c, 'invalid_token');

    const email = typeof payload.email === 'string' ? payload.email : undefined;

    c.set('userId', sub);
    c.set('userEmail', email);

    await next();
  };
}

/**
 * Typed accessor for the authenticated user id. Throws if requireAuth has
 * not run (or has not attached a userId) — call only inside protected routes.
 */
export function getUserId(c: Context): string {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    throw new Error('getUserId() called without requireAuth() — no userId on context');
  }
  return userId;
}

/**
 * Typed accessor for the authenticated user email (may be undefined even when
 * authenticated, since email is not a guaranteed JWT claim).
 */
export function getUserEmail(c: Context): string | undefined {
  return c.get('userEmail') as string | undefined;
}
