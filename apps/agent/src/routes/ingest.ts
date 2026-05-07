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
  DEMO_USER_ID,
} from '../db/sqlite';
import type { Context } from 'hono';

/**
 * Pull the authenticated userId off the Hono context. Lane A's auth middleware
 * sets `c.set('userId', payload.sub)` for /calls/* requests. Falls back to
 * DEMO_USER_ID if (a) middleware wasn't applied (dev) or (b) the test bench
 * runs these handlers directly without an auth wrapper.
 */
function getUserIdLoose(c: Context): string {
  return (c.get('userId') as string | undefined) ?? DEMO_USER_ID;
}
import { createSSEStream, broadcastEvent } from '../sse/handler';
import {
  createPipelineSession,
  getSession,
  processUtterance,
  registerSession,
  removeSession,
} from './pipeline';
import { SpeakerMap } from '../transcription/speakerMap';
import { runPostCallChain } from './postCall';

/**
 * Local ingestion endpoint for the desktop app. The Tauri Rust core POSTs
 * each finalized utterance from its on-device transcription pipeline to
 * /calls/:callId/utterance; the Atlas pipeline runs in this same Bun
 * sidecar process and emits SSE back to the Next.js frontend.
 *
 * No auth — sidecar binds to 127.0.0.1 only and is spawned by Tauri.
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

  const userId = getUserIdLoose(c);
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

  const session = getSession(callId);
  if (!session) {
    return c.json({ error: 'unknown_call', callId }, 404);
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

  // Fire and forget — the pipeline emits SSE downstream.
  void processUtterance(session, utterance).catch((err) =>
    console.error('[ingest] processUtterance failed', err),
  );

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
  const userId = getUserIdLoose(c);
  const session = getSession(callId);
  if (!session) {
    return c.json({ error: 'unknown_call', callId }, 404);
  }

  finalizeCall(callId, userId);
  broadcastEvent(callId, { type: 'call_end', callId });

  // Fire-and-forget post-call chain. The frontend redirects to the coaching
  // view immediately; verdict / coaching / follow-up artifacts stream in via
  // SSE as each agent finishes. Session + speaker map are cleaned up only
  // after the chain finishes — the chain reads memory/transcript off the
  // session.
  void runPostCallChain({ callId, userId, session, brief: session.brief })
    .catch((err) => console.error('[ingest] post-call chain failed', callId, err))
    .finally(() => {
      removeSession(callId);
      speakerMaps.delete(callId);
    });

  return c.json({ ok: true });
});

// ── reads ──────────────────────────────────────────────────────────────────

ingestRoutes.get('/', (c) => {
  return c.json({ calls: listCalls(getUserIdLoose(c), 200) });
});

ingestRoutes.get('/:callId', (c) => {
  const callId = c.req.param('callId');
  const userId = getUserIdLoose(c);
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

// SSE stream — same protocol as the demo.
ingestRoutes.get('/:callId/stream', (c) => {
  const callId = c.req.param('callId');
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
