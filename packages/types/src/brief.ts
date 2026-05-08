import { z } from 'zod';

export const PreCallBriefSchema = z.object({
  lead: z.object({
    name: z.string(),
    title: z.string(),
    company: z.string(),
    companySize: z.string(),
  }),
  avaContext: z.object({
    campaignId: z.string(),
    leadScore: z.number().min(0).max(1),
    scoringSignals: z.array(z.object({
      signal: z.string(),
      weight: z.number(),
    })),
  }),
  pastInteractions: z.array(z.object({
    type: z.enum(['email', 'meeting']),
    date: z.string(),
    summary: z.string(),
  })),
  callGoal: z.string(),
  suggestedQuestions: z.array(z.string()),
  productSnippets: z.array(z.string()),
  // Optional ICP tuning block. When present, the suggester uses these fields
  // to adapt thresholds, signal definitions, and what "good next step" means
  // for this specific deal shape — rather than applying a generic mid-market
  // baseline. See SUGGESTER_SYSTEM_V3 for how the agent reads each field.
  icp: z.object({
    dealShape: z.string(),                  // e.g. "$500K SAFE for ~7% equity, fixed terms"
    cycleLength: z.string(),                // e.g. "<2 weeks (interview to decision)"
    buyerPersona: z.string(),               // e.g. "Pre-seed/seed startup founder, often technical"
    decisionMakerCount: z.string(),         // e.g. "1-2 cofounders"
    competitiveLandscape: z.string(),       // e.g. "Other accelerators, seed VCs direct, going alone"
    valueFrame: z.string(),                 // what the buyer is actually buying
    buyingSignals: z.array(z.string()),     // persona-specific signals to weight
    objectionRoots: z.array(z.string()),    // persona-specific objection categories
    goodNextStep: z.string(),               // what specificity looks like for this ICP
  }).optional(),
});

export type PreCallBrief = z.infer<typeof PreCallBriefSchema>;
