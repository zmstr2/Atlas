import { z } from 'zod';

export const PersonaIdSchema = z.enum(['jordan', 'mia']);
export type PersonaId = z.infer<typeof PersonaIdSchema>;

export const TranscriptSpeakerSchema = z.enum(['rep', 'persona']);
export type TranscriptSpeaker = z.infer<typeof TranscriptSpeakerSchema>;

export const TranscriptEventSchema = z.object({
  type: z.literal('transcript'),
  speaker: TranscriptSpeakerSchema,
  text: z.string(),
  itemId: z.string(),
  isFinal: z.boolean(),
  timestampMs: z.number(),
});
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export const PersonaToolCallEventSchema = z.object({
  type: z.literal('persona.tool_call'),
  name: z.string(),
  args: z.record(z.unknown()),
  callId: z.string(),
});
export type PersonaToolCallEvent = z.infer<typeof PersonaToolCallEventSchema>;

export const CoachCallEndEventSchema = z.object({
  type: z.literal('call.end'),
  reason: z.enum(['user_hangup', 'persona_hangup', 'error', 'timeout']),
});
export type CoachCallEndEvent = z.infer<typeof CoachCallEndEventSchema>;

export const CoachHelloEventSchema = z.object({
  type: z.literal('hello'),
  callId: z.string(),
  personaId: PersonaIdSchema,
});
export type CoachHelloEvent = z.infer<typeof CoachHelloEventSchema>;

export const CoachWSClientEventSchema = z.discriminatedUnion('type', [
  CoachHelloEventSchema,
  TranscriptEventSchema,
  PersonaToolCallEventSchema,
  CoachCallEndEventSchema,
]);
export type CoachWSClientEvent = z.infer<typeof CoachWSClientEventSchema>;

export const SuggestionStartEventSchema = z.object({
  type: z.literal('suggestion'),
  id: z.string(),
  content: z.string(),
  reason: z.string().optional(),
});
export type SuggestionStartEvent = z.infer<typeof SuggestionStartEventSchema>;

export const SuggestionDeltaEventSchema = z.object({
  type: z.literal('suggestion.delta'),
  id: z.string(),
  token: z.string(),
});
export type SuggestionDeltaEvent = z.infer<typeof SuggestionDeltaEventSchema>;

export const SuggestionCompleteEventSchema = z.object({
  type: z.literal('suggestion.complete'),
  id: z.string(),
  content: z.string(),
  reason: z.string().optional(),
  groundedInUtteranceIds: z.array(z.string()).optional(),
});
export type SuggestionCompleteEvent = z.infer<typeof SuggestionCompleteEventSchema>;

export const SuggestionAbortEventSchema = z.object({
  type: z.literal('suggestion.abort'),
  id: z.string(),
  category: z.string().optional(),
});
export type SuggestionAbortEvent = z.infer<typeof SuggestionAbortEventSchema>;

export const ToolEventSchema = z.object({
  type: z.literal('tool'),
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
  result: z.unknown(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

export const MemoryPatchEventSchema = z.object({
  type: z.literal('memory.patch'),
  patch: z.unknown(),
});
export type MemoryPatchEvent = z.infer<typeof MemoryPatchEventSchema>;

export const CoachVerdictEventSchema = z.object({
  type: z.literal('verdict'),
  verdict: z.unknown(),
  trainingDelta: z.unknown(),
});
export type CoachVerdictEvent = z.infer<typeof CoachVerdictEventSchema>;

export const CoachErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});
export type CoachErrorEvent = z.infer<typeof CoachErrorEventSchema>;

export const CoachWSServerEventSchema = z.discriminatedUnion('type', [
  SuggestionStartEventSchema,
  SuggestionDeltaEventSchema,
  SuggestionCompleteEventSchema,
  SuggestionAbortEventSchema,
  ToolEventSchema,
  MemoryPatchEventSchema,
  CoachVerdictEventSchema,
  CoachErrorEventSchema,
]);
export type CoachWSServerEvent = z.infer<typeof CoachWSServerEventSchema>;

export const PersonaConfigSchema = z.object({
  id: PersonaIdSchema,
  displayName: z.string(),
  voice: z.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']),
  leadId: z.string(),
  systemPrompt: z.string(),
  openingLine: z.string(),
  orbColor: z.string(),
});
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;
