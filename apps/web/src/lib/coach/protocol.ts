import { z } from 'zod';
import { PersonaIdSchema } from '@atlas/types';
import type { MeetingMemory, MemoryPatch, PanelPatch } from '@atlas/types';
import type { CallStats } from '@/lib/memory/store';
import type { HotTailEntry } from '@/lib/memory/hotTail';

/**
 * The server keeps no per-call state. The browser holds the call's memory and
 * sends a snapshot with every turn; the server streams back patches to apply.
 */
export type CallSnapshot = {
  memory: MeetingMemory;
  stats: CallStats;
  /** Last few utterances, INCLUDING the one being sent (it's appended before the request). */
  hotTail: HotTailEntry[];
};

export const TurnRequestSchema = z.object({
  callId: z.string().min(1).max(64),
  personaId: PersonaIdSchema,
  turnId: z.string().min(1).max(16),
  utterance: z.object({
    id: z.string().min(1).max(128),
    speaker: z.enum(['rep', 'customer']),
    text: z.string().min(1).max(4000),
  }),
  elapsedMs: z.number().nonnegative(),
  // Suggestions parked in the rep's tray, so the model can say which the latest turn covered.
  openSuggestions: z.array(z.object({
    id: z.string().max(128),
    say: z.string().max(400),
    topic: z.string().max(40),
  })).max(8).default([]),
  // Shape is produced by our own MemoryStore; not worth re-validating field by field.
  snapshot: z.object({
    memory: z.unknown(),
    stats: z.unknown(),
    hotTail: z.array(z.unknown()).max(10),
  }),
});
export type TurnRequest = Omit<z.infer<typeof TurnRequestSchema>, 'snapshot'> & { snapshot: CallSnapshot };

/** One JSON object per line in the /api/coach/turn response. */
export type TurnEvent =
  | {
      type: 'suggestion';
      id: string;
      /** What the rep can say next (falls back to the long-form markdown). */
      content: string;
      /** One line on why. */
      why?: string;
      kind: 'question' | 'note';
      /** Qualification axis or loop this relates to, '' when general. */
      topic: string;
      reason?: string;
      groundedInUtteranceIds?: string[];
    }
  | { type: 'covered'; ids: string[] }
  | { type: 'memory.patch'; patch: MemoryPatch }
  | { type: 'panel.patch'; patch: PanelPatch; turnId: string }
  | { type: 'error'; message: string };

/** Sent with each chat message so the server can ground the coach's reply. */
export const ChatContextSchema = z.object({
  personaId: PersonaIdSchema,
  memory: z.unknown(),
  hotTail: z.array(z.unknown()).max(10),
  suggestions: z.array(z.string().max(4000)).max(10),
});
export type ChatContext = Omit<z.infer<typeof ChatContextSchema>, 'memory' | 'hotTail'> & {
  memory: MeetingMemory;
  hotTail: HotTailEntry[];
};
