import { Hono } from 'hono';
import type { UIMessage } from 'ai';
import { getCoachState } from '../coach/state';
import { streamCoachReply } from '../coach/agent';

export const chatRoutes = new Hono();

chatRoutes.post('/', async (c) => {
  const callId = c.req.header('x-call-id');
  if (!callId) {
    return c.json({ error: 'missing_call_id', detail: 'X-Call-Id header required' }, 400);
  }
  const state = getCoachState(callId);
  if (!state) {
    return c.json({ error: 'unknown_call', callId }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const messages = (body.messages ?? []) as UIMessage[];

  const result = await streamCoachReply({ state, messages });
  return result.toUIMessageStreamResponse();
});
