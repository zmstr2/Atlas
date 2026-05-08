import { z } from 'zod';

// Atlas pre-call brief. Used to be tightly Artisan-shaped (avaContext +
// scoringSignals + pastInteractions); now generic for any founder running a
// real sales call. The legacy demo fixtures still ship with the old fields,
// so they're kept here as optional for backwards compatibility — new
// production briefs only need `prospect`.

const ScoringSignalSchema = z.object({
  signal: z.string(),
  weight: z.number(),
});

const PastInteractionSchema = z.object({
  type: z.enum(['email', 'meeting']),
  date: z.string(),
  summary: z.string(),
});

const LegacyAvaContextSchema = z.object({
  campaignId: z.string(),
  leadScore: z.number().min(0).max(1),
  scoringSignals: z.array(ScoringSignalSchema),
});

export const ProspectSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  company: z.string().optional(),
  companySize: z.string().optional(),
});
export type Prospect = z.infer<typeof ProspectSchema>;

export const PreCallBriefSchema = z.object({
  // Canonical prospect block. Demo fixtures use `lead` (kept as optional alias);
  // real briefs use `prospect`.
  prospect: ProspectSchema.optional(),
  lead: ProspectSchema.optional(),

  // Free-text context the founder typed before the call.
  founderContext: z.string().optional(),

  callGoal: z.string().optional(),
  suggestedQuestions: z.array(z.string()).optional(),
  productSnippets: z.array(z.string()).optional(),

  // Legacy demo-only fields. Optional so real briefs can omit them.
  avaContext: LegacyAvaContextSchema.optional(),
  pastInteractions: z.array(PastInteractionSchema).optional(),
}).refine((b) => b.prospect || b.lead, {
  message: 'brief must include either `prospect` or `lead`',
});

export type PreCallBrief = z.infer<typeof PreCallBriefSchema>;
// New canonical name; same shape.
export const ProspectBriefSchema = PreCallBriefSchema;
export type ProspectBrief = PreCallBrief;

// Convenience accessor — prefer prospect, fall back to lead, return whichever exists.
export function getProspect(brief: PreCallBrief): Prospect {
  return brief.prospect ?? brief.lead!;
}
