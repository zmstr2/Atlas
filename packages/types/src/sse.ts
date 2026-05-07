import { z } from 'zod';
import { UtteranceSchema } from './utterance';
import { MeetingMemorySchema } from './memory';
import { VerdictSchema, SuggestionSchema } from './agents';
import { CallFactsUISchema } from './ui';

export const UtteranceEventSchema = z.object({
  type: z.literal('utterance'),
  utterance: UtteranceSchema,
});

export const MemoryDiffEventSchema = z.object({
  type: z.literal('memory_diff'),
  snapshot: MeetingMemorySchema,
  utteranceId: z.string(),
});

export const PulseEventSchema = z.object({
  type: z.literal('pulse'),
  utteranceId: z.string(),
});

export const VerdictEventSchema = z.object({
  type: z.literal('verdict'),
  verdict: VerdictSchema,
  callId: z.string(),
});

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  code: z.string().optional(),
});

export const CallEndEventSchema = z.object({
  type: z.literal('call_end'),
  callId: z.string(),
});

// NEW
export const SuggestionEventSchema = z.object({
  type: z.literal('suggestion'),
  utteranceId: z.string(),
  suggestion: SuggestionSchema,
});

export const MemoryPatchAppliedEventSchema = z.object({
  type: z.literal('memory_patch_applied'),
  utteranceId: z.string(),
  turnId: z.string(),
});

export const FactsUiDeltaEventSchema = z.object({
  type: z.literal('facts_ui_delta'),
  ui: CallFactsUISchema,
});

// Post-call chain events. Emitted by `runPostCallChain` after the call ends —
// the frontend redirects to the coaching view immediately and these stream
// in as each agent finishes.
export const CoachingReadyEventSchema = z.object({
  type: z.literal('coaching_ready'),
  callId: z.string(),
  // Loose shape for now — frontend renders it dynamically while the coaching
  // artifact schema is still iterating.
  artifact: z.record(z.string(), z.unknown()),
});

export const FollowupReadyEventSchema = z.object({
  type: z.literal('followup_ready'),
  callId: z.string(),
  email: z.string(),
});

export const PostCallFailedEventSchema = z.object({
  type: z.literal('post_call_failed'),
  callId: z.string(),
  step: z.enum(['verdict', 'coaching', 'followup']),
  message: z.string(),
});

export const SSEEventSchema = z.discriminatedUnion('type', [
  UtteranceEventSchema,
  MemoryDiffEventSchema,
  PulseEventSchema,
  VerdictEventSchema,
  ErrorEventSchema,
  CallEndEventSchema,
  SuggestionEventSchema,
  MemoryPatchAppliedEventSchema,
  FactsUiDeltaEventSchema,
  CoachingReadyEventSchema,
  FollowupReadyEventSchema,
  PostCallFailedEventSchema,
]);

export type SSEEvent = z.infer<typeof SSEEventSchema>;
export type UtteranceEvent = z.infer<typeof UtteranceEventSchema>;
export type MemoryDiffEvent = z.infer<typeof MemoryDiffEventSchema>;
export type PulseEvent = z.infer<typeof PulseEventSchema>;
export type VerdictEvent = z.infer<typeof VerdictEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type CallEndEvent = z.infer<typeof CallEndEventSchema>;
export type SuggestionEvent = z.infer<typeof SuggestionEventSchema>;
export type MemoryPatchAppliedEvent = z.infer<typeof MemoryPatchAppliedEventSchema>;
export type FactsUiDeltaEvent = z.infer<typeof FactsUiDeltaEventSchema>;
export type CoachingReadyEvent = z.infer<typeof CoachingReadyEventSchema>;
export type FollowupReadyEvent = z.infer<typeof FollowupReadyEventSchema>;
export type PostCallFailedEvent = z.infer<typeof PostCallFailedEventSchema>;
