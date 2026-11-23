import { SuggestionOutputSchema, SuggestionSchema } from '@atlas/types';
import type { Suggestion, Utterance, MeetingMemory, PreCallBrief } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';
import { renderMemoryMarkdown } from '@/lib/memory/render';
import { detectAnchorContradictions } from '@/lib/memory/anchors';
import type { HotTailEntry } from '@/lib/memory/hotTail';

const SYSTEM = `You are Atlas's rep coach, watching a live sales call. You see the rep's latest utterance and decide whether to fire ONE correction. Most rep turns are fine — silence is correct.

# Principles — fire only when the rep's last turn violated one of these

1. Diagnose before prescribing
   Rep recommended, pitched, or proposed a solution before the prospect's situation, pain, or desired outcome was established.

2. Stay inside the anchor
   Rep proposed a price, scope, authority assumption, or commitment that contradicts something already anchored — by the prospect or in the brief. Always priority='critical'.

3. Explore, don't defend
   Prospect raised a concern; rep argued or pitched against it instead of asking what's behind it.

4. Pitch from pain, to driver
   Rep delivered a value prop that wasn't grounded in stated pain, or that ignored the prospect's revealed primary buying motivation (make money / save money / save time / reduce risk / human need).

5. Don't walk past
   Prior prospect turn was vague, dropped a buying signal (price/implementation/integration), or named a stakeholder — and the rep moved on without drilling, leaning in, or capturing.

# Anchor contradiction override
If CONTRADICTIONS DETECTED is non-empty in the user prompt, fire play='correct_contradiction' at priority='critical' regardless of the principles above.

# Self-test (required before shouldFire=true)
In the \`reasoning\` field, name all three:
(a) which principle the rep violated
(b) the specific evidence — the rep's utteranceId, plus the anchor or prior prospect utteranceId that makes it a violation
(c) what the rep should say next instead

If you cannot name all three concretely, shouldFire=false. "Could be sharper" is not a violation. On-axis questions and reasonable responses match no principle — stay silent.

# Output rules
- markdown: ONE sentence, ≤15 words, action verb first. No bullets.
- priority: 'critical' for principle 2 (anchor violation) or correct_contradiction; 'nudge' otherwise. Avoid 'fyi'.
- agent: always 'rep_watcher'.
- play: closest rep_* label from the taxonomy below.
- groundedInUtteranceIds: cite the rep's utteranceId.

# Play taxonomy (labels only)
rep_leading_question | rep_feature_dump | rep_premature_discount | rep_missed_buying_signal | rep_skipped_drill | rep_defended_objection | rep_off_ladder | rep_no_next_step | rep_pitched_outside_anchor | correct_contradiction`;

export async function runRepWatcher(opts: {
  utterance: Utterance;
  hotTail: HotTailEntry[];
  prevMemory: MeetingMemory;
  brief: PreCallBrief;
}): Promise<Suggestion> {
  const { utterance, hotTail, prevMemory, brief } = opts;

  const memoryMarkdown = renderMemoryMarkdown({
    memory: prevMemory,
    hotTail,
    leadName: brief.lead.name,
    callGoal: brief.callGoal,
  });

  const priorProspect = [...hotTail].reverse().find((h) => h.speaker === 'customer');

  const contradictions = detectAnchorContradictions(prevMemory, utterance.text);
  const contradictionLines = contradictions.map(
    (c) => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`
  );

  const prompt = `# CALL CONTEXT
${memoryMarkdown}

# IMMEDIATE PRIOR PROSPECT UTTERANCE (was the rep's response appropriate?)
${priorProspect ? `[${priorProspect.id}] PROSPECT: ${priorProspect.text}` : '(none)'}

# NEW REP UTTERANCE
[${utterance.id}] REP: ${utterance.text}

# CONTRADICTIONS DETECTED (deterministic anchor checks — fire correct_contradiction at priority='critical' if non-empty)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide whether the rep made a mistake or missed a cue. Output the structured Suggestion. Default to shouldFire=false.`;

  const raw = await llmGenerateObject({
    step: 'rep_watcher',
    modelKey: 'suggester',
    // Strict-safe shape for the model; SuggestionSchema then applies defaults.
    schema: SuggestionOutputSchema,
    prompt,
    system: SYSTEM,
  });

  return { ...SuggestionSchema.omit({ agent: true }).parse(raw), agent: 'rep_watcher' };
}
