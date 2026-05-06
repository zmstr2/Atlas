// HTTP client wrapping the Atlas Bun sidecar at http://127.0.0.1:3001.
// Tauri spawns the sidecar on app launch; this module is the only place in
// the frontend that knows where it lives.

import type {
  PreCallBrief,
  Suggestion,
  MeetingMemory,
  CallFactsUI,
  Verdict,
  SpeakerRole,
} from '@atlas/types';

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://127.0.0.1:3001';

async function http<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
export function streamCall(
  callId: string,
  onEvent: (event: SSEEventLike) => void,
): EventSource {
  const url = `${AGENT_BASE}/calls/${callId}/stream`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch (err) {
      console.warn('[agent] failed to parse SSE event', err);
    }
  };
  es.onerror = () => {
    // Browser auto-reconnects; nothing to do here.
  };
  return es;
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
