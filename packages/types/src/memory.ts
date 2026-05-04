import { z } from 'zod';

export const FactSchema = z.object({
  id: z.string(),
  key: z.string(),
  category: z.enum(['budget', 'timeline', 'tech_stack', 'team', 'process', 'competitor', 'other']),
  content: z.string(),
  utteranceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  extractedAt: z.number(),
  revisions: z.array(z.object({
    previousContent: z.string(),
    overwrittenAt: z.number(),
    utteranceIds: z.array(z.string()),
  })),
});

export const ConcernSchema = z.object({
  id: z.string(),
  topic: z.string(),
  verbatim: z.string(),
  severity: z.enum(['mentioned', 'pressed', 'blocking']),
  addressed: z.boolean(),
  utteranceIds: z.array(z.string()),
});

export const OpenLoopSchema = z.object({
  id: z.string(),
  description: z.string(),
  owner: z.enum(['rep', 'customer']),
  status: z.enum(['open', 'addressed']),
});

export const QualSignalSchema = z.object({
  id: z.string(),
  direction: z.enum(['positive', 'negative']),
  meddic: z.enum(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'budget']),
  bantBucket: z.enum(['budget', 'authority', 'need', 'timeline']),
  content: z.string(),
  utteranceIds: z.array(z.string()),
});

export const DecisionActorSchema = z.object({
  name: z.string(),
  role: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
  utteranceIds: z.array(z.string()),
});

export const SilenceTopicSchema = z.object({
  topic: z.string(),
  emphasizedByAva: z.boolean(),
  customerMentioned: z.boolean(),
});

// ---------- NEW: Flow / Anchors / Scorecard ----------

export const FlowTagSchema = z.enum([
  'R-Q', 'R-VP', 'R-OBJ-RESP', 'R-NS', 'R-MISTAKE',
  'P-PAIN', 'P-METRIC', 'P-OBJ', 'P-STAKE', 'P-BUY', 'P-COMP', 'P-NEG', 'P-DQ',
  'OTHER',
]);
export type FlowTag = z.infer<typeof FlowTagSchema>;

export const FlowEntrySchema = z.object({
  turnId: z.string(),
  speaker: z.enum(['rep', 'customer']),
  tag: FlowTagSchema,
  content: z.string(),
  utteranceIds: z.array(z.string()),
});
export type FlowEntry = z.infer<typeof FlowEntrySchema>;

export const AnchorAxisSchema = z.enum([
  'need', 'budget', 'authority', 'timeline', 'metric',
  'champion', 'consequence', 'competitor', 'stakeholder',
]);
export type AnchorAxis = z.infer<typeof AnchorAxisSchema>;

export const VerbatimAnchorSchema = z.object({
  turnId: z.string(),
  axis: AnchorAxisSchema,
  verbatim: z.string(),
  utteranceIds: z.array(z.string()),
  // V2: supersession — when an anchor on the same axis updates this one,
  // supersededBy records the newer anchor's turnId. Render filters out anchors
  // with supersededBy set so the suggester only sees current-state anchors.
  supersededBy: z.string().optional(),
});
export type VerbatimAnchor = z.infer<typeof VerbatimAnchorSchema>;

export const AxisStateSchema = z.enum([
  'unknown', 'vague', 'soft', 'partial', 'firm', 'confirmed', 'confirmed_negative',
]);
export type AxisState = z.infer<typeof AxisStateSchema>;

export const BantSchema = z.object({
  need: AxisStateSchema,
  budget: AxisStateSchema,
  authority: AxisStateSchema,
  timeline: AxisStateSchema,
});

export const MeddicSchema = z.object({
  metrics: AxisStateSchema,
  economicBuyer: AxisStateSchema,
  decisionCriteria: AxisStateSchema,
  decisionProcess: AxisStateSchema,
  identifyPain: AxisStateSchema,
  champion: AxisStateSchema,
});

export const AxisKeySchema = z.enum([
  'need', 'budget', 'authority', 'timeline',
  'metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess', 'identifyPain', 'champion',
]);
export type AxisKey = z.infer<typeof AxisKeySchema>;

export const QualScorecardSchema = z.object({
  bant: BantSchema,
  meddic: MeddicSchema,
  pushQueue: z.array(AxisKeySchema),
  hardDisqualify: z.boolean(),
  softDisqualifySignals: z.array(z.string()),
  talkRatio: z.object({
    repWords: z.number(),
    prospectWords: z.number(),
  }),
  turnsSinceLastRepQuestion: z.number(),
  turnsSinceLastNextStepProposal: z.number(),
  callMinute: z.number(),
});
export type QualScorecard = z.infer<typeof QualScorecardSchema>;

export const BantRenderEntrySchema = z.object({
  headline: z.string().nullable(),
  detail: z.string().nullable(),
});
export type BantRenderEntry = z.infer<typeof BantRenderEntrySchema>;

export const RelevantFactSchema = z.object({
  id: z.string(),
  category: z.enum(['stack', 'metric', 'trigger', 'competitor', 'commitment', 'process']),
  text: z.string(),
  turnId: z.string(),
});
export type RelevantFact = z.infer<typeof RelevantFactSchema>;

export const MeetingMemorySchema = z.object({
  facts: z.array(FactSchema),
  concerns: z.array(ConcernSchema),
  openLoops: z.array(OpenLoopSchema),
  qualSignals: z.array(QualSignalSchema),
  decisionGeography: z.array(DecisionActorSchema),
  silenceTopics: z.array(SilenceTopicSchema),
  narrative: z.string(),
  flow: z.array(FlowEntrySchema),
  verbatimAnchors: z.array(VerbatimAnchorSchema),
  scorecard: QualScorecardSchema,
  // Agent-written render text for each BANT axis (rewritten each extraction)
  bantRender: z.record(z.string(), BantRenderEntrySchema),
  // Top relevant facts extracted from the call (max 4 shown)
  relevantFacts: z.array(RelevantFactSchema),
});

export type Fact = z.infer<typeof FactSchema>;
export type Concern = z.infer<typeof ConcernSchema>;
export type OpenLoop = z.infer<typeof OpenLoopSchema>;
export type QualSignal = z.infer<typeof QualSignalSchema>;
export type DecisionActor = z.infer<typeof DecisionActorSchema>;
export type SilenceTopic = z.infer<typeof SilenceTopicSchema>;
export type MeetingMemory = z.infer<typeof MeetingMemorySchema>;

export function emptyMeetingMemoryExtras() {
  return {
    bantRender: {} as Record<string, BantRenderEntry>,
    relevantFacts: [] as RelevantFact[],
  };
}

export function emptyScorecard(): QualScorecard {
  return {
    bant: { need: 'unknown', budget: 'unknown', authority: 'unknown', timeline: 'unknown' },
    meddic: {
      metrics: 'unknown', economicBuyer: 'unknown', decisionCriteria: 'unknown',
      decisionProcess: 'unknown', identifyPain: 'unknown', champion: 'unknown',
    },
    pushQueue: ['need', 'budget', 'authority', 'timeline', 'champion', 'metrics', 'economicBuyer', 'decisionProcess', 'decisionCriteria'],
    hardDisqualify: false,
    softDisqualifySignals: [],
    talkRatio: { repWords: 0, prospectWords: 0 },
    turnsSinceLastRepQuestion: 0,
    turnsSinceLastNextStepProposal: 0,
    callMinute: 0,
  };
}
