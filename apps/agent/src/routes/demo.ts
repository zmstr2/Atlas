import { Hono } from 'hono';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createSSEStream } from '../sse/handler';
import { createPipelineSession, registerSession, processUtterance, removeSession } from './pipeline';
import { createCall, finalizeCall, checkAndIncrementIpSession, getDailySpendUsd } from '../db/sqlite';
import { clearCallLog } from '../llm/wrapper';
import { ReplayTimer } from '../replay/timer';
import type { PreCallBrief, Utterance } from '@atlas/types';
import { broadcastEvent } from '../sse/handler';
import { clientIp } from '../realtime/limits';

const SCRIPTS = ['jordan', 'sarah', 'tom', 'mia'] as const;
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
  const ip = clientIp(c);
  const body = await c.req.json<{ script: Script }>();

  if (!SCRIPTS.includes(body.script)) {
    return c.json({ error: 'Invalid script' }, 400);
  }

  // Global $/day ceiling — hard cap before per-IP increment so it can't be bypassed
  const spentToday = getDailySpendUsd();
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
  createCall(callId, body.script);

  const session = createPipelineSession(callId, brief);
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
      finalizeCall(callId);
      removeSession(callId);
      clearCallLog();
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

