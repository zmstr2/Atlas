/**
 * Trigger detector — first stage of the split suggester architecture (Wave 3.1).
 *
 * Asks the model ONE question: did the latest utterance open a structural door
 * (PROSPECT) or break a structural move (REP)? Outputs a compact, deterministic
 * signal type that a code-level mapper converts to a play. The markdown is
 * written by a separate, tightly-scoped second call.
 *
 * Decoupling motivation: the current single-call suggester asks the model to
 * decide shouldFire + lens + play + priority + markdown + axis simultaneously,
 * and the eval surfaced specific failure modes (empty markdown on fire, wrong
 * play label for correct intent, conservative shouldFire despite reasoning that
 * argues for firing). Splitting lets each call be smaller and more focused.
 *
 * Status: PROTOTYPE. Not wired into the live pipeline. Used by the
 * eval-split-architecture script to benchmark vs the current suggester.
 */

import { z } from 'zod';
import type { Utterance, MeetingMemory, PreCallBrief } from '@atlas/types';
import type { HotTailEntry } from '../memory/hotTail';
import { llmGenerateObject } from '../llm/wrapper';
import { renderMemoryMarkdown } from '../memory/render';
import { detectAnchorContradictions } from '../memory/anchors';
import type { RecentSuggestionEntry } from './suggester';

// Compact signal types covering the existing play taxonomy in 12 buckets.
// Mapped to plays deterministically by signalToPlay() below.
export const SignalTypeSchema = z.enum([
  'pain_vague',         // qualitative pain, no number/owner/workflow
  'pain_quantified',    // number/time/dollar tied to pain, consequence unexplored
  'objection_first',    // explicit objection, first time
  'objection_repeat',   // same concern raised 2+ times
  'champion_behavior',  // buyer offers to escalate / share / introduce
  'stakeholder_named',  // new stakeholder with role surfaced
  'commitment_phrase',  // "let's do that", "send the contract"
  'anchor_violation',   // rep contradicted a prior anchor
  'rep_feature_dump',   // ≥3 feature claims with no pain tether
  'rep_skipped_drill',  // metric named, rep moved past without anchoring
  'rep_defended',       // objection raised, rep responded without LAER+Confirm
  'rep_no_next_step',   // vague forward step from rep
  'none',
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

// Detector output: top-K signal candidates with confidence scores (Test 1).
// Single-label classification was too conservative — when the model recognized
// a coaching moment but couldn't commit to one specific pattern, it defaulted
// to "none". Multi-label lets the model express partial matches across
// several patterns; code picks the highest-confidence candidate.
export const SignalCandidateSchema = z.object({
  type: SignalTypeSchema,
  // 0.0 to 1.0. The model self-rates how cleanly this signal matches the
  // latest utterance. Code thresholds on this to decide whether to fire.
  confidence: z.number().min(0).max(1),
});

export const TriggerOutputSchema = z.object({
  // Up to 3 candidates, ordered by descending confidence. The first non-"none"
  // candidate above the confidence threshold fires. If all candidates are
  // "none" or below threshold, the turn stays silent.
  signalCandidates: z.array(SignalCandidateSchema).default([{ type: 'none', confidence: 1.0 }]),
  evidenceUtteranceIds: z.array(z.coerce.string()).default([]),
  evidenceQuote: z.string().default(''),
  reasoning: z.string().default(''),
});
export type TriggerOutput = z.infer<typeof TriggerOutputSchema>;

// Confidence threshold for firing. Tuned: 0.5 is the floor — below this the
// model is genuinely unsure and the cost of an over-fire outweighs the catch.
// 0.4-0.6 is the sensitivity range to test.
export const SIGNAL_FIRE_THRESHOLD = 0.5;

// Helper for the eval / pipeline: pick the highest-confidence non-"none"
// candidate above threshold, else return "none". This is the deterministic
// shouldFire/play decision that replaces the model's binary judgment.
export function pickSignal(candidates: Array<{ type: SignalType; confidence: number }>): { type: SignalType; confidence: number } {
  // Candidates may not be sorted; sort by confidence descending.
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  for (const c of sorted) {
    if (c.type !== 'none' && c.confidence >= SIGNAL_FIRE_THRESHOLD) return c;
  }
  return { type: 'none', confidence: 1.0 };
}

// Signal taxonomy split by speaker. The LATEST speaker determines which set
// of signals can fire. This eliminates two recurring failures:
//   - commitment_phrase fired on REP turn ("I'll send something") → should be rep_no_next_step
//   - commitment_phrase fired on prospect pleasantry ("I'll look for your email") → silent
const PROSPECT_SIGNAL_BLOCK = `# PROSPECT-side signal types (the LATEST speaker is the buyer)

## Decision tree — apply in this order, first match wins
1. Does the latest utterance state a pain without ANY number / owner / workflow / time?
   → pain_vague
   Example: "It's really messy and won't scale" → pain_vague
   Example: "Honestly the whole follow-up situation is painful" → pain_vague

2. Does the latest utterance contain a number/time/$/% tied to a pain, BUT no downstream cost named?
   → pain_quantified
   Example: "Rachel spends three to four hours a day on manual follow-ups" → pain_quantified
   Example: "We missed Q1 — fifteen target, eight actual" → pain_quantified

3. Does the latest utterance contain a concern the buyer has now raised 2+ times? (CHECK the LOAD-BEARING CONCERNS block)
   → objection_repeat
   Example: load-bearing topic "icp_uncertainty" was raised again → objection_repeat

4. Does the latest utterance contain a NEW explicit objection or skepticism?
   → objection_first
   Example: "We don't actually know our ICP well enough yet" → objection_first
   Example: "I'm skeptical — we've tried tools before and they didn't work" → objection_first

5. Did the buyer offer to escalate / share with a decision-maker / champion the deal?
   → champion_behavior
   Example: "If you had a case study I could show Tyler, that might move things up" → champion_behavior

6. Did the buyer name a NEW stakeholder with a specific role (not already known)?
   → stakeholder_named
   Example: "Rachel would actually be managing the tool day-to-day" → stakeholder_named
   COUNTER-EXAMPLE: "My CEO Tyler handed this to me" in a self-intro is NOT stakeholder_named — Tyler is context, not a new actor being introduced for the deal.

7. Did the buyer use an EXPLICIT commitment phrase (real verb of commitment, future-tense ownership)?
   → commitment_phrase
   Example: "Yeah, let's get it on the calendar" → commitment_phrase
   Example: "Send me the contract" → commitment_phrase
   COUNTER-EXAMPLE: "I'll look for your email" is a pleasantry, NOT commitment → none
   COUNTER-EXAMPLE: "Sounds good" is acknowledgment, NOT commitment → none

8. Otherwise → none`;

const REP_SIGNAL_BLOCK = `# REP-side signal types (the LATEST speaker is the sales rep)

## Decision tree — apply in this order, first match wins
1. Does the latest rep utterance contradict a memory anchor? (CHECK the CONTRADICTIONS DETECTED block)
   → anchor_violation
   Example: rep offers $5K pricing when anchor records $10K already discussed → anchor_violation

2. Did the latest rep utterance contain 3+ product/feature claims with NO tie to a specific pain the buyer named?
   → rep_feature_dump
   Example: "We have AI sequences, native HubSpot sync, automatic follow-up, and 3x pipeline lift" with no link to a stated pain → rep_feature_dump
   Example: "Onboarding program, success manager, analytics dashboard, conversation intelligence, performance benchmarking" → rep_feature_dump
   NOTE: 1 feature in response to a buyer's explicit question is NOT a feature dump.

3. Was the PRIOR PROSPECT turn an objection or skepticism, and the rep responded by pitching/defending without Acknowledge + Confirm?
   → rep_defended
   Example: prospect: "we don't know our ICP" → rep: "Ava can help with that — the AI learns..." → rep_defended (no Acknowledge step)
   Test: look at the prior prospect turn. If it raised a concern, did the rep ACKNOWLEDGE the concern before responding? If not → rep_defended.

4. Did the PRIOR PROSPECT turn drop a number/metric, and the rep moved past it without anchoring or translating to cost?
   → rep_skipped_drill
   Example: prospect: "3-4 hours/day on follow-ups" → rep: "What was the trigger for this call?" → rep_skipped_drill (rep pivoted)
   Test: was there a number in the prior turn? Did the rep quantify cost/impact?

5. Did the rep use vague forward-step language without specifying date/owner/agenda?
   → rep_no_next_step
   Example: "I'll circle back in Q3" → rep_no_next_step
   Example: "I'll send something over" with no specifics → rep_no_next_step
   Example: "I'll send the case study by Friday and book 15 min next Tuesday" is SPECIFIC → none

6. Otherwise → none`;

export const TRIGGER_DETECTOR_SYSTEM = `You are Atlas's signal detector. After each utterance, return UP TO 3 candidate signal types ranked by confidence. You do NOT write coaching text — that happens in a separate call. You do NOT decide whether to fire — that's deterministic from confidence thresholds applied to your output. Your job is classification with calibrated uncertainty.

# Mode (decided by latest speaker, supplied in user prompt)
PROSPECT MODE: did the buyer just open a door the rep would plausibly miss?
REP MODE: did the rep just skip or break the obvious move from the prior prospect turn?

The user prompt will tell you which mode you're in and which signal types are eligible.

# Multi-candidate output
For each turn, return signalCandidates as an array of up to 3 entries, ordered by descending confidence. Each entry is {type, confidence}.

- If you see a clear, unambiguous match → emit one candidate at confidence ≥ 0.8.
- If you see partial evidence for multiple patterns → emit each at its true confidence (e.g. 0.6 for the most likely, 0.4 for the runner-up).
- If you're genuinely unsure but there's some coaching-worthy moment → still emit your best guess at 0.4-0.5 rather than defaulting to "none". Code will decide whether to fire.
- If nothing applies → emit a single candidate {type: "none", confidence: 1.0}.

Confidence calibration: 0.9 = "I'd bet on this", 0.7 = "likely this", 0.5 = "plausible", 0.3 = "weak hint", 0.1 = "barely there". Don't compress everything into the 0.7-0.9 band.

# Hard rules
1. Default to a single {type: "none", confidence: 1.0} candidate when nothing fits.
2. "Could have been sharper" is not a signal. Wait for a clear miss.
3. Tyler mentioning the CEO in a self-intro is NOT stakeholder_named — they're context-setting, not naming a new actor.
4. Output reasoning ≤2 sentences. Don't write coaching text.
5. signalCandidates MUST be sorted by descending confidence.

# Output
- signalCandidates: array of up to 3 {type, confidence} entries, sorted by confidence desc
- evidenceUtteranceIds: utterance IDs the top candidate is grounded in
- evidenceQuote: the exact verbatim span from the latest utterance proving the top candidate (5-15 words)
- reasoning: one or two sentences naming the top signal and the delta`;

// Exported for the user prompt builder
export { PROSPECT_SIGNAL_BLOCK, REP_SIGNAL_BLOCK };

export function buildTriggerPrompt(opts: {
  utterance: Utterance;
  hotTail: HotTailEntry[];
  prevMemory: MeetingMemory;
  brief: PreCallBrief;
  recentSuggestions: RecentSuggestionEntry[];
}): string {
  const { utterance, hotTail, prevMemory, brief, recentSuggestions } = opts;

  const memoryMarkdown = renderMemoryMarkdown({
    memory: prevMemory, hotTail,
    leadName: brief.lead.name, callGoal: brief.callGoal,
  });

  const priorOpposite = [...hotTail].reverse().find((h) => h.speaker !== utterance.speaker);
  const contradictions = detectAnchorContradictions(prevMemory, utterance.text);
  const contradictionLines = contradictions.map(
    (c) => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`
  );

  const activeConcerns = prevMemory.concerns.filter((c) => !c.addressed);
  const topicCounts = new Map<string, number>();
  for (const c of activeConcerns) {
    topicCounts.set(c.topic, (topicCounts.get(c.topic) ?? 0) + Math.max(1, c.utteranceIds.length));
  }
  const loadBearingTopics = [...topicCounts.entries()]
    .filter(([, n]) => n >= 2).map(([t]) => t);

  const recentLines = recentSuggestions.length === 0
    ? '(none yet)'
    : recentSuggestions.slice(-5)
        .map((r) => `- t${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.play}]`).join('\n');

  const speakerLabel = utterance.speaker === 'customer' ? 'PROSPECT' : 'REP';
  const modeLabel = utterance.speaker === 'customer' ? 'PROSPECT MODE' : 'REP MODE';
  // Fix 2: only show signal types eligible for the current speaker. Eliminates
  // the trial_close-on-rep-turn and trial_close-on-pleasantry over-fire pattern.
  const signalBlock = utterance.speaker === 'customer' ? PROSPECT_SIGNAL_BLOCK : REP_SIGNAL_BLOCK;

  // Fix 4 (attempted, reverted): added a CALL-END SIGNAL DETECTED hint via regex
  // to catch rep_no_next_step at call wrap-up. Bench showed it over-eagered the
  // model into firing rep_no_next_step on cases that were actually fine (-0.30
  // avg, -1 recall, -1 precision vs Fix 3 baseline). The signal description in
  // the REP_SIGNAL_BLOCK decision tree already covers this case adequately.

  return `# CALL CONTEXT
${memoryMarkdown}

# IMMEDIATE PRIOR ${utterance.speaker === 'customer' ? 'REP' : 'PROSPECT'} UTTERANCE
${priorOpposite ? `[${priorOpposite.id}] ${priorOpposite.speaker.toUpperCase()}: ${priorOpposite.text}` : '(none)'}

# NEW ${speakerLabel} UTTERANCE — you are in ${modeLabel}
[${utterance.id}] ${speakerLabel}: ${utterance.text}

${signalBlock}

# LOAD-BEARING CONCERNS (raised ≥ 2 times, still unaddressed)
${loadBearingTopics.length > 0 ? loadBearingTopics.join(', ') : '(none)'}

# RECENT SIGNALS (last 5 of your prior decisions in this channel)
${recentLines}

# CONTRADICTIONS DETECTED (deterministic anchor checks)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide. Output the structured TriggerOutput.`;
}

export async function runTriggerDetector(opts: {
  utterance: Utterance;
  hotTail: HotTailEntry[];
  prevMemory: MeetingMemory;
  brief: PreCallBrief;
  recentSuggestions: RecentSuggestionEntry[];
}): Promise<TriggerOutput> {
  const raw = await llmGenerateObject({
    step: 'trigger_detector',
    modelKey: 'suggester',
    schema: TriggerOutputSchema,
    prompt: buildTriggerPrompt(opts),
    system: TRIGGER_DETECTOR_SYSTEM,
  });
  return raw as TriggerOutput;
}

// ─── Signal → play mapping (deterministic) ────────────────────────────────────
import type { SuggestionPlay } from '@atlas/types';

export function signalToPlay(signal: SignalType): SuggestionPlay {
  switch (signal) {
    case 'pain_vague': return 'drill_vague';
    case 'pain_quantified': return 'quantify_pain';
    case 'objection_first': return 'reframe_objection';
    case 'objection_repeat': return 'reframe_objection';
    case 'champion_behavior': return 'multi_thread';
    case 'stakeholder_named': return 'probe_stakeholder';
    case 'commitment_phrase': return 'trial_close';
    case 'anchor_violation': return 'correct_contradiction';
    case 'rep_feature_dump': return 'rep_feature_dump';
    case 'rep_skipped_drill': return 'rep_skipped_drill';
    case 'rep_defended': return 'rep_defended_objection';
    case 'rep_no_next_step': return 'rep_no_next_step';
    case 'none': return 'none';
  }
}

export function signalToPriority(signal: SignalType): 'critical' | 'nudge' | 'fyi' {
  if (signal === 'anchor_violation') return 'critical';
  if (signal === 'objection_repeat') return 'critical';
  return 'nudge';
}
