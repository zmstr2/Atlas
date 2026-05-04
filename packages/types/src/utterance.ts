import { z } from 'zod';

export const UtteranceSchema = z.object({
  id: z.string(),
  speaker: z.enum(['rep', 'customer']),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  confidence: z.number().min(0).max(1).default(1),
  derivedFromLowConfidence: z.boolean().default(false),
});

export type Utterance = z.infer<typeof UtteranceSchema>;
