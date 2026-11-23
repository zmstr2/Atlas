import { TurnRequestSchema, type TurnEvent, type TurnRequest } from '@/lib/coach/protocol';
import { runTurn } from '@/server/coach/turn';
import { guard } from '@/server/limits';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const blocked = await guard(req, 'turn');
  if (blocked) return blocked;

  const parsed = TurnRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', detail: parsed.error.message.slice(0, 300) }, { status: 400 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: TurnEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
        } catch {
          /* client went away */
        }
      };
      try {
        await runTurn(parsed.data as unknown as TurnRequest, emit);
      } catch (err) {
        console.error('[coach turn]', err);
        emit({ type: 'error', message: err instanceof Error ? err.message : 'turn_failed' });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
