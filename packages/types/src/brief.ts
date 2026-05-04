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
});

export type PreCallBrief = z.infer<typeof PreCallBriefSchema>;
