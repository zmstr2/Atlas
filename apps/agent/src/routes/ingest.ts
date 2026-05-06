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
import { createSSEStream, broadcastEvent } from '../sse/handler';
import {
  createPipelineSession,
  getSession,
  processUtterance,
  registerSession,
  removeSession,
} from './pipeline';
import { SpeakerMap } from '../transcription/speakerMap';

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

  const callId = nanoid();
  const brief = parsed.data.brief;
  const prospectName = brief.prospect?.name ?? brief.lead?.name ?? null;

  createCall(callId, {
    script: null,
    prospectName,
    meetingUrl: parsed.data.meetingUrl ?? null,
    brief,
  });

  const session = createPipelineSession(callId, brief);
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
  const session = getSession(callId);
  if (!session) {
    return c.json({ error: 'unknown_call', callId }, 404);
  }

  finalizeCall(callId);
  broadcastEvent(callId, { type: 'call_end', callId });
  removeSession(callId);
  speakerMaps.delete(callId);

  // TODO(post-call agents): trigger verdict + coaching artifact + follow-up
  // generation here. For now they remain wired through the existing demo
  // flow; the desktop UI calls GET /calls/:id afterward to read them once
  // they've been written. Hooking the post-call chain to ingest is part of
  // Step 7 in the plan.

  return c.json({ ok: true });
});

// ── reads ──────────────────────────────────────────────────────────────────

ingestRoutes.get('/', (c) => {
  return c.json({ calls: listCalls(200) });
});

ingestRoutes.get('/:callId', (c) => {
  const callId = c.req.param('callId');
  const call = loadCall(callId);
  if (!call) return c.json({ error: 'unknown_call', callId }, 404);

  const log = loadCallLog(callId);
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

// Suppress unused-import warnings until post-call chain is wired in.
void saveVerdict;
void saveCoachingArtifact;
void saveFollowUpEmail;
void updateCallStatus;
