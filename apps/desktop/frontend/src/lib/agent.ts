// HTTP client for the Atlas agent.
//
// Reads NEXT_PUBLIC_AGENT_URL — in production this is the Railway-hosted
// agent, in dev it defaults to http://127.0.0.1:3001 for backwards compat.
//
// Every request carries the Supabase JWT in `Authorization: Bearer <token>`.
// On 401 we sign the user out (which kicks them back to /login via AuthGate).

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
      } catch {
        // fall through to signOut
      }
    }
    // Refresh failed (or this was already the retry) — clear session so
    // AuthGate redirects to /login.
    await signOut().catch(() => {});
    throw new UnauthorizedError(`agent ${method} ${path} → 401`);
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
// the JWT as a `?token=…` query param. Lane A's auth middleware needs to
// recognize the token query param for this route specifically.
//
// Refresh strategy: EventSource has no clean retry primitive, so on the first
// error we close the stream, force a Supabase refreshSession(), and reopen
// with the new token. If the second attempt also errors, we sign out. The
// returned object is a wrapper so callers can call `.close()` even after a
// reconnect under the hood; we don't try to expose the inner EventSource.
export async function streamCall(
  callId: string,
  onEvent: (event: SSEEventLike) => void,
): Promise<EventSource> {
  const token = await getAccessToken();
  if (!token) {
    throw new UnauthorizedError();
  }

  let current: EventSource | null = null;
  let attemptedRefresh = false;
  let closedByUser = false;

  const open = (jwt: string) => {
    const url = `${AGENT_BASE}/calls/${callId}/stream?token=${encodeURIComponent(jwt)}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch (err) {
        console.warn('[agent] failed to parse SSE event', err);
      }
    };
    es.onerror = async () => {
      if (closedByUser) return;
      // EventSource fires `onerror` on transient disconnects too — but if we
      // were going to recover via the browser's built-in reconnect, the
      // `readyState` would be CONNECTING (0). When it's CLOSED (2), it's a
      // hard failure (likely 401 auth) and we step in.
      if (es.readyState !== EventSource.CLOSED) return;
      if (attemptedRefresh) {
        console.warn('[agent] SSE failed after refresh; signing out');
        await signOut().catch(() => {});
        return;
      }
      attemptedRefresh = true;
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session?.access_token) {
          await signOut().catch(() => {});
          return;
        }
        current = open(data.session.access_token);
      } catch (err) {
        console.warn('[agent] SSE refresh-and-reopen failed', err);
        await signOut().catch(() => {});
      }
    };
    return es;
  };

  current = open(token);

  // Return a proxy EventSource-like object so the caller's existing
  // `.close()` keeps working even after we've swapped the inner instance.
  // We can't actually subclass EventSource, so we hand back the live one
  // and shim `close` via a Proxy-ish pattern.
  const proxy = new Proxy({} as EventSource, {
    get(_target, prop) {
      if (prop === 'close') {
        return () => {
          closedByUser = true;
          current?.close();
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
