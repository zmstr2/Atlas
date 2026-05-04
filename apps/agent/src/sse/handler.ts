import type { SSEEvent, MeetingMemory } from '@atlas/types';

type Subscriber = (event: SSEEvent) => void;

const HEARTBEAT_INTERVAL_MS = 5000;

class CallSession {
  subscribers: Set<Subscriber> = new Set();
  memory: MeetingMemory | null = null;
  ended = false;
}

const sessions = new Map<string, CallSession>();

export function getOrCreateSession(callId: string): CallSession {
  if (!sessions.has(callId)) {
    sessions.set(callId, new CallSession());
  }
  return sessions.get(callId)!;
}

export function updateSessionMemory(callId: string, memory: MeetingMemory) {
  const session = sessions.get(callId);
  if (session) session.memory = memory;
}

export function broadcastEvent(callId: string, event: SSEEvent) {
  const session = sessions.get(callId);
  if (!session) return;
  for (const sub of session.subscribers) sub(event);
}

export function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createSSEStream(callId: string): ReadableStream {
  const session = getOrCreateSession(callId);

  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      // Snapshot replay on (re)connect
      if (session.memory) {
        const snap: SSEEvent = {
          type: 'memory_diff',
          snapshot: session.memory,
          utteranceId: '__snapshot__',
        };
        controller.enqueue(enc.encode(formatSSE(snap)));
      }

      if (session.ended) {
        controller.close();
        return;
      }

      let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        }
      }, HEARTBEAT_INTERVAL_MS);

      const sub: Subscriber = (event) => {
        try {
          controller.enqueue(enc.encode(formatSSE(event)));
          if (event.type === 'call_end') {
            session.ended = true;
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            controller.close();
          }
        } catch {
          session.subscribers.delete(sub);
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        }
      };

      session.subscribers.add(sub);
    },
    cancel() {
      // subscriber + heartbeat cleanup handled inside start() via catch blocks
    },
  });
}
