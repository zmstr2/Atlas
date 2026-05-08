import { z } from 'zod';

export const SpeakerRoleSchema = z.enum([
  'founder',
  'customer',
  'colleague',
  'other',
  'unknown',
]);
export type SpeakerRole = z.infer<typeof SpeakerRoleSchema>;

export const UtteranceSchema = z.object({
  id: z.string(),
  speaker: SpeakerRoleSchema,
  // Local diarizer's stable speaker label (e.g. "speaker_0"). Optional because
  // demo fixtures don't have one — speaker is set directly there.
  participantId: z.string().optional(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  confidence: z.number().min(0).max(1).default(1),
  derivedFromLowConfidence: z.boolean().default(false),
});

export type Utterance = z.infer<typeof UtteranceSchema>;
