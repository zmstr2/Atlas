// HTTP client for the Atlas agent.
//
// Reads NEXT_PUBLIC_AGENT_URL — in production this is the Railway-hosted
// agent, in dev it defaults to http://127.0.0.1:3001 for backwards compat.
//
// Every request carries the Supabase JWT in `Authorization: Bearer <token>`.
// On 401 we sign the user out (which kicks them back to /login via AuthGate).
// On 503 with code=jwks_unreachable we throw AuthBackendUnreachableError so
// callers can show a transient banner instead of forcing a sign-out.

import type {
  PreCallBrief,
  Suggestion,
  MeetingMemory,
  CallFactsUI,
  Verdict,
  SpeakerRole,
} from '@atlas/types';
import { getAccessToken, signOut, supabase } from './supabase';

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://127.0.0.1:3001';

export class UnauthorizedError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Thrown when the agent reports the auth backend (Supabase JWKS) is
 * unreachable. Distinct from UnauthorizedError because this isn't the user's
 * fault — they should NOT be signed out, they should retry.
 */
export class AuthBackendUnreachableError extends Error {
  constructor(message = 'Atlas auth backend temporarily unavailable') {
    super(message);
    this.name = 'AuthBackendUnreachableError';
  }
}

async function http<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  _retried = false,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new UnauthorizedError();
  }
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // First 401 — try one refresh + retry before giving up. Covers the case
    // where Supabase's auto-refresh hasn't fired yet but the agent's already
    // rejecting an expired JWT.
    if (!_retried) {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (!error && data.session?.access_token) {
          return http<T>(method, path, body, true);
        }
      } catch (err) {
        console.warn('[agent] refreshSession threw before retry', err);
      }
    }
    // Refresh failed (or this was already the retry) — clear session so
    // AuthGate redirects to /login.
    await signOut().catch((e) =>
      console.error('[agent] signOut failed during 401 recovery', e),
    );
    throw new UnauthorizedError(`agent ${method} ${path} → 401`);
  }
  if (res.status === 503) {
    // Could be jwks_unreachable from the auth middleware — that one is NOT
    // the user's fault, don't sign out. Surface as a separate error so call
    // sites can show a "try again in a minute" banner.
    const body503 = await res.clone().json().catch(() => ({}));
    if (body503?.code === 'jwks_unreachable') {
      throw new AuthBackendUnreachableError();
    }
    // Other 503s fall through to the generic non-ok path below.
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`agent ${method} ${path} → ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── calls ───────────────────────────────────────────────────────────────────

export type CallSummary = {
  id: string;
  script: string | null;
  prospect_name: string | null;
  status: 'active' | 'ended' | 'failed';
  started_at: number;
  ended_at: number | null;
};

export type CallDetail = {
  call: {
    id: string;
    script: string | null;
    prospect_name: string | null;
    meeting_url: string | null;
    brief_json: PreCallBrief | null;
    status: 'active' | 'ended' | 'failed';
    started_at: number;
    ended_at: number | null;
    verdict: Verdict | null;
    coaching_artifact: unknown | null;
    follow_up_email: string | null;
    verdict_status: string | null;
    coaching_status: string | null;
    followup_status: string | null;
  };
  participants: Array<{ participantId: string; displayName: string | null; role: SpeakerRole }>;
  utterances: Array<{
    id: string;
    participant_id: string | null;
    speaker: SpeakerRole;
    text: string;
    start_ms: number;
    end_ms: number;
    created_at: number;
  }>;
  suggestions: Array<{
    id: number;
    utterance_id: string;
    agent: 'prospect_suggester' | 'rep_watcher';
    should_fire: number;
    suppressed: number;
    priority: 'critical' | 'nudge' | 'fyi';
    play: string;
    markdown: string;
    reasoning: string;
    created_at: number;
  }>;
};

export async function startCall(
  brief: PreCallBrief,
  meetingUrl?: string,
): Promise<{ callId: string }> {
  return http('POST', '/calls', { brief, meetingUrl });
}

export async function endCall(callId: string): Promise<void> {
  await http('POST', `/calls/${callId}/end`);
}

export async function listCalls(): Promise<{ calls: CallSummary[] }> {
  return http('GET', '/calls');
}

export async function getCall(callId: string): Promise<CallDetail> {
  return http('GET', `/calls/${callId}`);
}

export async function relabelParticipant(
  callId: string,
  participantId: string,
  role: SpeakerRole,
  displayName?: string,
): Promise<void> {
  await http('PATCH', `/calls/${callId}/participants/${participantId}`, {
    role,
    displayName,
  });
}

// SSE stream — subscribe to live pipeline events.
//
// EventSource doesn't support custom headers in browsers/webviews, so we pass
// the JWT as a `?token=…` query param. The auth middleware accepts the query
// param ONLY for /calls/:id/stream paths (regex-scoped).
//
// Recovery strategy: EventSource has no way to read HTTP status, so on a
// hard close we probe /calls/:id over HTTP to disambiguate cases. The probe
// uses the same http() helper above, which already maps:
//   401 → UnauthorizedError (after one refresh+retry)
//   503 jwks_unreachable → AuthBackendUnreachableError
// We reopen on transient failures and signOut only on real auth failure.
//
// Backoff for jwks_unreachable: 5s → 30s → 2min, capped at 2min.
export async function streamCall(
  callId: string,
  onEvent: (event: SSEEventLike) => void,
): Promise<EventSource> {
  const token = await getAccessToken();
  if (!token) {
    throw new UnauthorizedError();
  }

  let current: EventSource | null = null;
  let closedByUser = false;
  let jwksRetryDelayMs = 5_000;
  let jwksRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Listener registrations made via the proxy. Replayed on every reopen so
  // listeners survive the EventSource swap.
  const listeners = new Set<{ type: string; handler: EventListener }>();

  const open = (jwt: string): EventSource => {
    const url = `${AGENT_BASE}/calls/${callId}/stream?token=${encodeURIComponent(jwt)}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch (err) {
        console.warn('[agent] failed to parse SSE event', err);
      }
    };
    // Replay any previously-registered listeners onto the new EventSource.
    for (const { type, handler } of listeners) {
      es.addEventListener(type, handler);
    }
    es.onerror = () => {
      if (closedByUser) return;
      // EventSource fires `onerror` on transient disconnects too — but if
      // the browser were going to recover via its built-in reconnect, the
      // `readyState` would still be CONNECTING (0). When it's CLOSED (2),
      // the browser has given up and we step in.
      if (es.readyState !== EventSource.CLOSED) return;
      void recover();
    };
    return es;
  };

  const recover = async () => {
    if (closedByUser) return;
    // Probe HTTP to learn what kind of failure we're recovering from. The
    // http() helper does the refresh+retry on 401 internally, so by the
    // time it throws UnauthorizedError there's nothing more we can do.
    try {
      await getCall(callId);
      // Probe succeeded — connection lost was a transient network blip,
      // not auth. Reset jwks backoff and reopen.
      jwksRetryDelayMs = 5_000;
      const fresh = await getAccessToken();
      if (fresh) current = open(fresh);
      return;
    } catch (err) {
      if (err instanceof AuthBackendUnreachableError) {
        // JWKS down. Don't sign out. Tell the UI, schedule retry.
        onEvent({
          type: 'error',
          code: 'auth_unreachable',
          message: 'Atlas auth backend reconnecting',
        });
        if (jwksRetryTimer) clearTimeout(jwksRetryTimer);
        jwksRetryTimer = setTimeout(() => {
          void recover();
        }, jwksRetryDelayMs);
        // Backoff: 5s → 30s → 2min, capped.
        jwksRetryDelayMs = Math.min(jwksRetryDelayMs * 6, 120_000);
        return;
      }
      if (err instanceof UnauthorizedError) {
        // Real auth failure (refresh already attempted by http()).
        await signOut().catch((e) =>
          console.error('[agent] signOut failed during SSE recovery', e),
        );
        return;
      }
      // Other errors — could be network down, agent down. Reopen with the
      // same token; EventSource's own reconnect loop will keep trying.
      console.warn('[agent] SSE probe failed unexpectedly, reopening', err);
      const fresh = await getAccessToken();
      if (fresh) current = open(fresh);
    }
  };

  current = open(token);

  // Return a proxy EventSource-like object so the caller's existing
  // `.close()` keeps working even after we've swapped the inner instance.
  // addEventListener/removeEventListener are tracked in the `listeners` set
  // and replayed on every reopen.
  const proxy = new Proxy({} as EventSource, {
    get(_target, prop) {
      if (prop === 'close') {
        return () => {
          closedByUser = true;
          if (jwksRetryTimer) clearTimeout(jwksRetryTimer);
          current?.close();
        };
      }
      if (prop === 'addEventListener') {
        return (type: string, handler: EventListener) => {
          listeners.add({ type, handler });
          current?.addEventListener(type, handler);
        };
      }
      if (prop === 'removeEventListener') {
        return (type: string, handler: EventListener) => {
          // Remove all entries that match this (type, handler) pair.
          for (const entry of listeners) {
            if (entry.type === type && entry.handler === handler) {
              listeners.delete(entry);
            }
          }
          current?.removeEventListener(type, handler);
        };
      }
      // @ts-expect-error — passthrough to whichever instance is current
      const value = current?.[prop];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, prop, value) {
      if (current) {
        // @ts-expect-error — passthrough setter (e.g. onmessage override)
        current[prop] = value;
      }
      return true;
    },
  });
  return proxy;
}

// SSE event shape — mirrors packages/types/src/sse.ts but kept local so the
// frontend doesn't need to import zod.
export type SSEEventLike =
  | { type: 'utterance'; utterance: { id: string; speaker: SpeakerRole; text: string; startMs: number; endMs: number } }
  | { type: 'memory_diff'; snapshot: MeetingMemory; utteranceId: string }
  | { type: 'pulse'; utteranceId: string }
  | { type: 'memory_patch_applied'; utteranceId: string; turnId: string }
  | { type: 'facts_ui_delta'; ui: CallFactsUI }
  | { type: 'suggestion'; utteranceId: string; suggestion: Suggestion }
  | { type: 'call_end'; callId: string }
  | { type: 'verdict'; verdict: Verdict; callId: string }
  | { type: 'error'; message: string; code?: string };

// ── Tauri bridge — drained by the Rust core for "the user clicked End Call" ──
// Exposed for the call view. Tauri's window.__TAURI_INTERNALS__ check is the
// canonical way to detect we're inside the desktop shell vs a regular browser
// (next dev), so we can no-op gracefully in storybook/dev.

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
