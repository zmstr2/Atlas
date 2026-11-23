import type { UIMessage } from 'ai';
import { ChatContextSchema, type ChatContext } from '@/lib/coach/protocol';
import { streamCoachReply } from '@/server/coach/agent';
import { guard } from '@/server/limits';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const blocked = await guard(req, 'chat');
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const ctx = ChatContextSchema.safeParse(body.context);
  if (!ctx.success) {
    return Response.json({ error: 'invalid_context', detail: ctx.error.message.slice(0, 300) }, { status: 400 });
  }
  const messages = (body.messages ?? []) as UIMessage[];

  const result = await streamCoachReply({ context: ctx.data as unknown as ChatContext, messages });
  return result.toUIMessageStreamResponse();
}
