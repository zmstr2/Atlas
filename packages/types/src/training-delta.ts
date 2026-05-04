import { z } from 'zod';

export const ObjectionEntrySchema = z.object({
  timestampMs: z.number(),
  verbatim: z.string(),
  classification: z.string(),
  repResponse: z.string().nullable(),
  customerSatisfied: z.boolean().nullable(),
  avaRecommendation: z.string(),
});

export const ValuePropEntrySchema = z.object({
  prop: z.string(),
  direction: z.enum(['engaged', 'ignored']),
  avaRecommendation: z.string(),
});

export const LeadAttributeEntrySchema = z.object({
  attribute: z.string(),
  direction: z.enum(['upweight', 'downweight']),
  reason: z.string(),
});

export const SilencePatternSchema = z.object({
  avaEmphasized: z.array(z.string()),
  customerMentioned: z.array(z.string()),
  avaRecommendation: z.string(),
});

export const DecisionGeoEntrySchema = z.object({
  name: z.string(),
  role: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
  avaRecommendation: z.string(),
});

export const TrainingDeltaSchema = z.object({
  callId: z.string(),
  campaignId: z.string(),
  lead: z.object({ name: z.string(), title: z.string(), company: z.string() }),
  outcome: z.enum(['qualified', 'not_qualified', 'needs_more_info']),
  avaAlreadyHas: z.object({
    disposition: z.string(),
    aeNotes: z.string(),
    meetingBooked: z.boolean(),
  }),
  objectionLanguage: z.array(ObjectionEntrySchema),
  valuePropResonance: z.array(ValuePropEntrySchema),
  leadAttributeTruePositives: z.array(LeadAttributeEntrySchema),
  leadAttributeNoise: z.array(LeadAttributeEntrySchema),
  silencePatterns: SilencePatternSchema,
  decisionGeography: z.array(DecisionGeoEntrySchema),
  confidence: z.number().min(0).max(1),
});

export type TrainingDelta = z.infer<typeof TrainingDeltaSchema>;
