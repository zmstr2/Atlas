import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  PreCallBriefSchema,
  SpeakerRoleSchema,
  type Utterance,
} from '@atlas/types';
import {
  createCall,
  finalizeCall,
  listCalls,
  loadCall,
  loadCallLog,
  loadParticipants,
  saveCoachingArtifact,
  saveFollowUpEmail,
  saveVerdict,
  updateCallStatus,
  upsertParticipant,
} from '../db/sqlite';
import { getUserId } from '../auth/middleware';
import type { Context } from 'hono';
import { createSSEStream, broadcastEvent } from '../sse/handler';
import {
  createPipelineSession,
  getSession,
  processUtterance,
  registerSession,
  removeSession,
  type PipelineSession,
} from './pipeline';
import { SpeakerMap } from '../transcription/speakerMap';
import { runPostCallChain } from './postCall';

/**
 * Multi-tenant ingestion endpoint for the Atlas desktop app. Mounted under
 * /calls/*, so requireAuth has already verified a Supabase JWT and set
 * userId on the Hono context before any handler here runs.
 *
 * The Tauri Rust core POSTs finalized utterances over HTTPS to the Railway
 * agent (this process). Pipeline events flow back to the Next.js webview
 * via the SSE stream on /calls/:id/stream.
 */
export const ingestRoutes = new Hono();

// In-memory speaker maps keyed by callId. Hydrated from `participants` table
// when an existing call is reopened.
const speakerMaps = new Map<string, SpeakerMap>();

function getOrInitSpeakerMap(callId: string): SpeakerMap {
  let m = speakerMaps.get(callId);
  if (!m) {
    const stored = loadParticipants(callId);
    m = SpeakerMap.fromSnapshot(
      stored.map((p) => ({ participantId: p.participantId, role: p.role })),
    );
    speakerMaps.set(callId, m);
  }
  return m;
}

/**
 * Verify the authenticated user owns this call. Returns either a success
 * record (with the live PipelineSession if one exists, or null after a
 * cross-process restart) or a 404 Response that the handler must `return`.
 *
 * Why 404 (not 403): a 403 leaks the existence of someone else's callId,
 * which is useful to an attacker enumerating ids. 404 is indistinguishable
 * from a typo.
 */
function assertCallOwner(
  c: Context,
  callId: string,
): { session: PipelineSession | null; userId: string } | Response {
  const userId = getUserId(c);
  const session = getSession(callId);
  if (session) {
    if (session.userId !== userId) {
      return c.json({ error: 'unknown_call', callId }, 404);
    }
    return { session, userId };
  }
  // No live session — could be (a) wrong/typoed callId, (b) post-restart with
  // the DB row intact. loadCall is already userId-scoped so a cross-tenant
  // attempt returns null here.
  const row = loadCall(callId, userId);
  if (!row) {
    return c.json({ error: 'unknown_call', callId }, 404);
  }
  return { session: null, userId };
}

// ── POST /calls — start a new call ──────────────────────────────────────────

const StartCallBodySchema = z.object({
  brief: PreCallBriefSchema,
  meetingUrl: z.string().optional(),
});

ingestRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = StartCallBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_brief', detail: parsed.error.flatten() }, 400);
  }

  const userId = getUserId(c);
  const callId = nanoid();
  const brief = parsed.data.brief;
  const prospectName = brief.prospect?.name ?? brief.lead?.name ?? null;

  createCall(callId, userId, {
    script: null,
    prospectName,
    meetingUrl: parsed.data.meetingUrl ?? null,
    brief,
  });

  const session = createPipelineSession(callId, userId, brief);
  registerSession(session);
  speakerMaps.set(callId, new SpeakerMap());

  return c.json({ callId });
});

// ── POST /calls/:callId/utterance — Tauri pushes finalized utterances ──────

const UtteranceBodySchema = z.object({
  participantId: z.string(),
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  confidence: z.number().min(0).max(1).optional(),
  // Optional explicit speaker override (when the Rust side already resolved
  // the role from a calibration step). Otherwise the SpeakerMap heuristic
  // decides.
  speaker: SpeakerRoleSchema.optional(),
});

ingestRoutes.post('/:callId/utterance', async (c) => {
  const callId = c.req.param('callId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UtteranceBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_utterance', detail: parsed.error.flatten() }, 400);
  }

  const ownership = assertCallOwner(c, callId);
  if (ownership instanceof Response) return ownership;
  const { session } = ownership;
  if (!session) {
    // Call exists in DB but has no live session (agent restarted mid-call).
    // We don't try to rehydrate transcripts/memory here — surface a 409 so
    // the desktop client can recover (end the call cleanly, restart fresh).
    return c.json({ error: 'session_not_active', callId }, 409);
  }

  const speakerMap = getOrInitSpeakerMap(callId);
  const role = parsed.data.speaker ?? speakerMap.getRole(parsed.data.participantId);
  if (parsed.data.speaker) {
    // Honor explicit override and persist it.
    speakerMap.setRole(parsed.data.participantId, parsed.data.speaker);
  }

  // Persist participant on first sight.
  upsertParticipant({
    callId,
    participantId: parsed.data.participantId,
    role,
  });

  const utterance: Utterance = {
    id: nanoid(),
    speaker: role,
    participantId: parsed.data.participantId,
    text: parsed.data.text,
    startMs: parsed.data.startMs,
    endMs: parsed.data.endMs,
    confidence: parsed.data.confidence ?? 1,
    derivedFromLowConfidence: false,
  };

  // Fire and forget — the pipeline emits SSE downstream. On failure we both
  // log AND surface an SSE error so the desktop UI can show "agents failed
  // for this turn" instead of silently missing coaching.
  void processUtterance(session, utterance).catch((err) => {
    console.error('[ingest] processUtterance failed', callId, err);
    broadcastEvent(callId, {
      type: 'error',
      code: 'pipeline_failure',
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return c.json({ utteranceId: utterance.id, role });
});

// ── PATCH /calls/:callId/participants/:participantId — relabel speaker ─────

const RelabelBodySchema = z.object({
  role: SpeakerRoleSchema,
  displayName: z.string().optional(),
});

ingestRoutes.patch('/:callId/participants/:participantId', async (c) => {
  const callId = c.req.param('callId');
  const participantId = c.req.param('participantId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = RelabelBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  }

  const ownership = assertCallOwner(c, callId);
  if (ownership instanceof Response) return ownership;

  getOrInitSpeakerMap(callId).setRole(participantId, parsed.data.role);
  upsertParticipant({
    callId,
    participantId,
    role: parsed.data.role,
    displayName: parsed.data.displayName ?? null,
  });

  return c.json({ ok: true });
});

// ── POST /calls/:callId/end — call finished ────────────────────────────────

ingestRoutes.post('/:callId/end', async (c) => {
  const callId = c.req.param('callId');
  const ownership = assertCallOwner(c, callId);
  if (ownership instanceof Response) return ownership;
  const { session, userId } = ownership;
  if (!session) {
    // Call row exists but session was lost on agent restart. Mark the row
    // ended so the user can see it in their list, but we have no in-memory
    // memory/transcript to feed the post-call chain.
    finalizeCall(callId, userId);
    broadcastEvent(callId, { type: 'call_end', callId });
    return c.json({ ok: true, postCall: 'skipped_no_session' });
  }

  finalizeCall(callId, userId);
  broadcastEvent(callId, { type: 'call_end', callId });

  // Fire-and-forget post-call chain. The frontend redirects to the coaching
  // view immediately; verdict / coaching / follow-up artifacts stream in via
  // SSE as each agent finishes. Session + speaker map are cleaned up only
  // after the chain finishes — the chain reads memory/transcript off the
  // session.
  void runPostCallChain({ callId, userId, session, brief: session.brief })
    .catch((err) => {
      console.error('[ingest] post-call chain failed', callId, err);
      broadcastEvent(callId, {
        type: 'post_call_failed',
        callId,
        step: 'chain',
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      removeSession(callId);
      speakerMaps.delete(callId);
    });

  return c.json({ ok: true });
});

// ── reads ──────────────────────────────────────────────────────────────────

ingestRoutes.get('/', (c) => {
  return c.json({ calls: listCalls(getUserId(c), 200) });
});

ingestRoutes.get('/:callId', (c) => {
  const callId = c.req.param('callId');
  const userId = getUserId(c);
  const call = loadCall(callId, userId);
  if (!call) return c.json({ error: 'unknown_call', callId }, 404);

  const log = loadCallLog(callId, userId);
  const participants = loadParticipants(callId);

  return c.json({
    call: {
      ...call,
      brief_json: call.brief_json ? JSON.parse(call.brief_json) : null,
      verdict: call.verdict ? JSON.parse(call.verdict) : null,
      coaching_artifact: call.coaching_artifact ? JSON.parse(call.coaching_artifact) : null,
    },
    participants,
    utterances: log.utterances,
    suggestions: log.suggestions,
  });
});

// SSE stream — same protocol as the demo. Ownership-checked: a user can only
// subscribe to their own calls. Without this check any logged-in user could
// subscribe to any callId and exfiltrate live transcript + suggestions.
ingestRoutes.get('/:callId/stream', (c) => {
  const callId = c.req.param('callId');
  const ownership = assertCallOwner(c, callId);
  if (ownership instanceof Response) return ownership;

  const stream = createSSEStream(callId);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// `updateCallStatus` is exported for future use (failed-call recovery), keep
// the import alive for now.
void updateCallStatus;
void saveVerdict;
void saveCoachingArtifact;
void saveFollowUpEmail;
