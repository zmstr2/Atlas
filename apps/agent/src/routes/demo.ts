import { Hono } from 'hono';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createSSEStream } from '../sse/handler';
import { createPipelineSession, registerSession, processUtterance, removeSession } from './pipeline';
import { createCall, finalizeCall, checkAndIncrementIpSession, getGlobalDailySpendUsd, DEMO_USER_ID } from '../db/sqlite';
import { clearCallLog } from '../llm/wrapper';
import { runPostCallChain } from './postCall';
import { ReplayTimer } from '../replay/timer';
import type { PreCallBrief, Utterance } from '@atlas/types';
import { broadcastEvent } from '../sse/handler';

const SCRIPTS = ['jordan', 'sarah', 'tom'] as const;
type Script = typeof SCRIPTS[number];

const IP_DAILY_CAP = 20;
const GLOBAL_DAILY_SPEND_USD = 20;

// Resolve fixtures dir relative to this file's location: apps/agent/src/routes/ → ../../../fixtures
const FIXTURES_DIR = process.env.FIXTURES_DIR
  ?? path.join(import.meta.dir, '..', '..', '..', '..', 'fixtures');

async function loadFixture<T>(filename: string): Promise<T> {
  return Bun.file(path.join(FIXTURES_DIR, filename)).json();
}

export const demoRoutes = new Hono();

demoRoutes.get('/brief/:script', async (c) => {
  const script = c.req.param('script') as Script;
  if (!SCRIPTS.includes(script)) return c.json({ error: 'Invalid script' }, 400);

  try {
    const brief = await loadFixture<PreCallBrief>(`${script}-brief.json`);
    return c.json(brief);
  } catch {
    return c.json({ error: 'Brief not found' }, 404);
  }
});

demoRoutes.post('/start', async (c) => {
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
  const body = await c.req.json<{ script: Script }>();

  if (!SCRIPTS.includes(body.script)) {
    return c.json({ error: 'Invalid script' }, 400);
  }

  // Global $/day ceiling — hard cap before per-IP increment so it can't be bypassed
  const spentToday = getGlobalDailySpendUsd();
  if (spentToday >= GLOBAL_DAILY_SPEND_USD) {
    return c.json({ error: 'Demo capacity reached, try again tomorrow', code: 'GLOBAL_LIMIT' }, 429);
  }

  const allowed = checkAndIncrementIpSession(ip, IP_DAILY_CAP);
  if (!allowed) {
    return c.json({ error: 'Demo capacity reached, try again tomorrow', code: 'RATE_LIMITED' }, 429);
  }

  let transcript: Utterance[];
  let brief: PreCallBrief;
  try {
    [transcript, brief] = await Promise.all([
      loadFixture<Utterance[]>(`${body.script}-transcript.json`),
      loadFixture<PreCallBrief>(`${body.script}-brief.json`),
    ]);
  } catch {
    return c.json({ error: 'Fixture not found', script: body.script }, 404);
  }

  const callId = nanoid();
  createCall(callId, DEMO_USER_ID, { script: body.script, brief });

  const session = createPipelineSession(callId, DEMO_USER_ID, brief);
  registerSession(session);

  // speedMultiplier > 1 for testing (e.g. ?speed=50). Defensive parse: bad input → 1.
  const rawSpeed = Number(c.req.query('speed') ?? '1');
  const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.min(rawSpeed, 200) : 1;
  const timer = new ReplayTimer({
    transcript,
    speedMultiplier: speed,
    onUtterance: (utterance) => processUtterance(session, utterance),
    onEnd: () => {
      broadcastEvent(callId, { type: 'call_end', callId });
      finalizeCall(callId, DEMO_USER_ID);
      // Fire-and-forget post-call chain — verdict / coaching / follow-up
      // stream in via SSE while the user is on the coaching view. Session
      // teardown waits until the chain finishes so the agents can read
      // memory + transcript off it.
      void runPostCallChain({ callId, userId: DEMO_USER_ID, session, brief })
        .catch((err) => console.error('[demo] post-call chain failed', callId, err))
        .finally(() => {
          removeSession(callId);
          clearCallLog();
        });
    },
  });

  timer.start();

  return c.json({ callId, script: body.script });
});

demoRoutes.get('/stream/:callId', (c) => {
  const { callId } = c.req.param();
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

