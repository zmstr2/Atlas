import { z } from 'zod';
import { AxisStateSchema, RelevantFactSchema } from './memory';

export const AxisCardSchema = z.object({
  state: AxisStateSchema,
  headline: z.string().nullable(),
  detail: z.string().nullable(),
  anchorTurnId: z.string().nullable(),
});
export type AxisCard = z.infer<typeof AxisCardSchema>;

export const StakeholderCardSchema = z.object({
  name: z.string(),
  role: z.string(),
  sentiment: z.enum(['unknown', 'positive', 'neutral', 'negative']),
  role_hint: z.enum(['champion_candidate', 'economic_buyer_candidate', 'blocker', 'other']),
  anchorTurnId: z.string().nullable(),
});
export type StakeholderCard = z.infer<typeof StakeholderCardSchema>;

export const CallFactsUISchema = z.object({
  bant: z.object({
    need: AxisCardSchema,
    budget: AxisCardSchema,
    authority: AxisCardSchema,
    timeline: AxisCardSchema,
  }),
  meddic: z.object({
    metrics: AxisCardSchema,
    economicBuyer: AxisCardSchema,
    decisionCriteria: AxisCardSchema,
    decisionProcess: AxisCardSchema,
    identifyPain: AxisCardSchema,
    champion: AxisCardSchema,
  }),
  stakeholders: z.array(StakeholderCardSchema),
  openLoops: z.array(z.object({
    id: z.string(),
    description: z.string(),
    owner: z.enum(['rep', 'customer']),
  })),
  anchors: z.array(z.object({
    axis: z.string(),
    verbatim: z.string(),
    turnId: z.string(),
  })),
  pushNext: z.object({
    axis: z.string(),
    humanPrompt: z.string(),
  }).nullable(),
  disqualifiers: z.object({
    hard: z.boolean(),
    softCount: z.number(),
    soft: z.array(z.string()),
  }),
  stage: z.object({
    callMinute: z.number(),
    talkRatio: z.object({
      rep: z.number(),
      prospect: z.number(),
    }),
    turnsSinceLastRepQuestion: z.number(),
    turnsSinceLastNextStepProposal: z.number(),
  }),
  relevantFacts: z.array(RelevantFactSchema),
});
export type CallFactsUI = z.infer<typeof CallFactsUISchema>;
export { RelevantFactSchema };
export type { RelevantFact } from './memory';
