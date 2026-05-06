import { z } from 'zod';
import { FlowTagSchema, AnchorAxisSchema, AxisKeySchema, AxisStateSchema, BantRenderEntrySchema } from './memory';
import { SpeakerRoleSchema } from './utterance';

// ---------- Suggestion output for prospect-suggester + rep-watcher ----------

export const SuggestionPlaySchema = z.enum([
  // prospect-suggester plays
  'drill_vague',
  'quantify_pain',
  'probe_stakeholder',
  'reframe_objection',
  'surface_value_prop',
  'competitor_handle',
  'push_next_axis',
  'trial_close',
  'multi_thread',
  'anchor_next_step',
  'qualify_out',
  'correct_contradiction',
  // rep-watcher plays
  'rep_leading_question',
  'rep_feature_dump',
  'rep_premature_discount',
  'rep_missed_buying_signal',
  'rep_skipped_drill',
  'rep_defended_objection',
  'rep_off_ladder',
  'rep_no_next_step',
  'rep_pitched_outside_anchor',
  // catch-all
  'none',
]);
export type SuggestionPlay = z.infer<typeof SuggestionPlaySchema>;

export const SuggestionSchema = z.object({
  agent: z.enum(['prospect_suggester', 'rep_watcher']),
  shouldFire: z.boolean(),
  priority: z.enum(['critical', 'nudge', 'fyi']),
  play: SuggestionPlaySchema,
  axis: AnchorAxisSchema.nullable(),
  markdown: z.string(),
  reasoning: z.string(),
  groundedInUtteranceIds: z.array(z.string()),
  groundedInAnchorTurnIds: z.array(z.string()),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

// ---------- Memory patch (replaces ExtractorPatch's role) ----------

const FactPatchSchema = z.object({
  op: z.enum(['upsert']),
  key: z.string(),
  category: z.enum(['budget', 'timeline', 'tech_stack', 'team', 'process', 'competitor', 'other']),
  content: z.string(),
  confidence: z.number().min(0).max(1),
});

const ConcernPatchSchema = z.object({
  // V1: 'resolve' marks an existing concern (matched by topic) as addressed
  // when the rep substantively handles it. Render filters addressed concerns out.
  op: z.enum(['upsert', 'append', 'resolve']),
  topic: z.string(),
  verbatim: z.string(),
  severity: z.enum(['mentioned', 'pressed', 'blocking']),
});

const OpenLoopPatchSchema = z.object({
  op: z.enum(['append', 'close']),
  description: z.string(),
  owner: z.enum(['founder', 'customer']),
  closeDescription: z.string().nullable(),
});

const DecisionGeographyPatchSchema = z.object({
  op: z.enum(['upsert']),
  name: z.string(),
  role: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
});

const FlowPatchSchema = z.object({
  tag: FlowTagSchema,
  content: z.string(),
});

// Internal sub-schemas — no longer emitted by the LLM, but used by
// MemoryStore.applyPatchInternal as the legacy "extractor patch" shape.
// applyMemoryPatch now SYNTHESIZES these from evidence before applying.
const QualSignalPatchSchema = z.object({
  op: z.enum(['append']),
  direction: z.enum(['positive', 'negative']),
  meddic: z.enum(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'budget']),
  bantBucket: z.enum(['budget', 'authority', 'need', 'timeline']),
  content: z.string(),
});

const AnchorPatchSchema = z.object({
  axis: AnchorAxisSchema,
  verbatim: z.string(),
  supersedes: z.string().nullable(),
});

// Evidence: the unit of axis extraction. Replaces qualSignals + anchor + axisFlips.
// LLM emits one item per axis-relevant signal in the utterance, with a verbatim
// quote and a binary direction (HAVE vs LACK). Axis state and BANT/MEDDIC
// derivative views are computed deterministically from accumulated evidence in
// store.applyMemoryPatch — the LLM does NOT classify state. This removes the
// failure mode where a positive-pain complaint flipped to confirmed_negative
// because the model conflated negative sentiment with negative direction.
export const EvidenceSchema = z.object({
  axis: AxisKeySchema,
  // 'positive' = speaker indicates they HAVE this (a real pain, allocated
  // budget, deadline, named stakeholder).
  // 'negative' = speaker EXPLICITLY rules out the axis ("we don't track NPS",
  // "no budget", "we won't decide until 2027"). Use sparingly.
  direction: z.enum(['positive', 'negative']),
  // Minimum span (3-12 words) from the utterance proving the signal.
  verbatim: z.string(),
  // 'specific' if the quote contains a number, $, hours, %, named person/tool,
  // or date. 'mention' if the topic was raised without a concrete value.
  specificity: z.enum(['mention', 'specific']),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const MemoryPatchSchema = z.object({
  utteranceId: z.string(),
  turnId: z.string(),
  speaker: SpeakerRoleSchema,
  // Required by OpenAI strict structured outputs (every property in `required`).
  // `.nullable()` (not `.optional()`) so the LLM emits `null` to mean "nothing
  // on this axis"; consumers treat null and undefined identically via falsy.
  facts: z.array(FactPatchSchema).nullable(),
  concerns: z.array(ConcernPatchSchema).nullable(),
  openLoops: z.array(OpenLoopPatchSchema).nullable(),
  decisionGeography: z.array(DecisionGeographyPatchSchema).nullable(),
  flow: FlowPatchSchema.nullable(),
  // Replaces qualSignals + anchor + axisFlips. See EvidenceSchema above.
  evidence: z.array(EvidenceSchema).nullable(),
  // DEPRECATED on the extractor path — the panel agent owns these now. Kept on
  // the schema for back-compat with hand-built patches in tests/benches; the
  // store ignores them when present.
  bantRender: z.record(z.string(), BantRenderEntrySchema).nullable(),
  relevantFacts: z.array(z.object({
    category: z.enum(['stack', 'metric', 'trigger', 'competitor', 'commitment', 'process']),
    text: z.string(),
  })).nullable(),
});
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

// ---------- Panel patch (memory-panel agent output) ----------
// The memory-panel agent runs on a separate cadence from the extractor. It
// reads the WHOLE accumulated state (evidence, anchors, concerns,
// stakeholders, prior render) and rewrites the rep-facing memory panel.
// Output is the full panel — partial axes are interpreted as "no summary yet".
// relevantFacts is a complete re-rank, not an append.
export const PanelPatchSchema = z.object({
  bantRender: z.object({
    need: BantRenderEntrySchema,
    budget: BantRenderEntrySchema,
    authority: BantRenderEntrySchema,
    timeline: BantRenderEntrySchema,
  }),
  relevantFacts: z.array(z.object({
    category: z.enum(['stack', 'metric', 'trigger', 'competitor', 'commitment', 'process']),
    text: z.string(),
  })).max(4),
});
export type PanelPatch = z.infer<typeof PanelPatchSchema>;

// ---------- Existing ExtractorPatch (kept for backward compat with old extractor) ----------

export const ExtractorPatchSchema = z.object({
  utteranceId: z.string(),
  facts: z.array(FactPatchSchema).optional(),
  concerns: z.array(ConcernPatchSchema).optional(),
  openLoops: z.array(OpenLoopPatchSchema).optional(),
  qualSignals: z.array(QualSignalPatchSchema).optional(),
  decisionGeography: z.array(DecisionGeographyPatchSchema).optional(),
});

export type ExtractorPatch = z.infer<typeof ExtractorPatchSchema>;

export const VerdictSchema = z.object({
  outcome: z.enum(['qualified', 'not_qualified', 'needs_more_info']),
  reasoning: z.string(),
  groundedSignalIds: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export type Verdict = z.infer<typeof VerdictSchema>;
