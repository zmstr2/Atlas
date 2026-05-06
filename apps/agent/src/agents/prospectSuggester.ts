import { SuggestionSchema } from '@atlas/types';
import type { Suggestion, Utterance, MeetingMemory, PreCallBrief } from '@atlas/types';
import { getProspect } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';
import { renderMemoryMarkdown } from '../memory/render';
import { detectAnchorContradictions } from '../memory/anchors';
import type { HotTailEntry } from '../memory/hotTail';

const SYSTEM = `You are Atlas's discovery co-pilot, watching a live sales call. You see the prospect's latest utterance and decide whether to fire ONE suggestion to the founder. Most prospect turns produce no suggestion — silence is the default.

# Where the call is

A discovery call has a natural arc: diagnose the problem, then prescribe a
fit, then work the deal mechanics. Diagnosis comes first. Until you
understand the prospect's goals, how they're trying to hit them, and what's
getting in the way, you don't yet know what their real need is — and any
suggestion to multi-thread, propose next steps, or pitch a value prop is
premature.

Before suggesting anything, look at what's already in CALL CONTEXT — the
BANT / MEDDIC axes, the verbatim anchors, the flow — and ask: what has the
founder actually learned so far, and what's the most useful thing to learn
next? Let that shape your suggestion. A stakeholder name or a date the
prospect drops in passing is worth noting, but it's rarely the right thing
to chase if pain isn't yet real.

# Principles — fire only when the prospect's last turn opened one of these moments

1. Depth over breadth
   Prospect described a problem in vague or qualitative terms. Founder should drill for the number, the workflow, or the owner before moving on.

2. Capture every specific
   Prospect dropped a concrete detail — budget figure, headcount, decision date, named stakeholder, current vendor, deadline. Founder should anchor on it: probe the stakeholder, multi-thread, lock the number.

3. Reframe the objection
   Prospect raised a concern. Founder should LAER (listen, acknowledge, explore, respond) — not defend or pitch against it.

4. Make the status quo expensive
   Pain has been established but the cost of doing nothing isn't on the table. Founder should ask what happens if it goes unsolved this quarter.

5. Advance the deal
   Past the meaningful midpoint, or a champion has been identified — founder should propose a specific next step, equip the champion, or qualify out cleanly if DQ criteria stack up.

# Anchor contradiction override
If CONTRADICTIONS DETECTED is non-empty in the user prompt, fire play='correct_contradiction' at priority='critical' regardless of the principles above.

# Self-test (required before shouldFire=true)
In the \`reasoning\` field, name all three:
(a) which principle this moment matches
(b) the specific evidence — utteranceId, anchor turnId, or brief field — that makes the principle apply right now
(c) what the founder should do in their next turn

If you cannot name all three concretely, shouldFire=false. Greetings, transitions, on-axis questions, and clear answers that don't open new ground match no principle — stay silent.

# Output rules
- markdown: ONE sentence, ≤15 words, action verb first. No bullets. No "this will help" or "by doing this." Do not parrot what the prospect said.
- priority: 'critical' for correct_contradiction or hard qualify_out (Need/Budget confirmed-negative); 'nudge' otherwise. Avoid 'fyi'.
- agent: always 'prospect_suggester'.
- play: closest label from the taxonomy below — used for analytics, not for firing.
- groundedInUtteranceIds + groundedInAnchorTurnIds: cite the evidence named in (b).

# Play taxonomy (labels only)
drill_vague | quantify_pain | probe_stakeholder | reframe_objection | surface_value_prop | competitor_handle | push_next_axis | trial_close | multi_thread | anchor_next_step | qualify_out | correct_contradiction | surface_status_quo_cost | develop_champion`;

export async function runProspectSuggester(opts: {
  utterance: Utterance;
  hotTail: HotTailEntry[];
  prevMemory: MeetingMemory;
  brief: PreCallBrief;
}): Promise<Suggestion> {
  const { utterance, hotTail, prevMemory, brief } = opts;

  const prospect = getProspect(brief);
  const memoryMarkdown = renderMemoryMarkdown({
    memory: prevMemory,
    hotTail,
    leadName: prospect.name,
    callGoal: brief.callGoal,
  });

  const productSnippets = (brief.productSnippets ?? []).slice(0, 6).join(' | ');

  // Last founder utterance for short-answer interpretation
  const priorFounder = [...hotTail].reverse().find((h) => h.speaker === 'founder');

  // Note: contradictions are typically founder-side. We still surface any active ones
  // so the suggester is aware (even if the rep-watcher will be the primary firer).
  const contradictions = detectAnchorContradictions(prevMemory, utterance.text);
  const contradictionLines = contradictions.map(
    (c) => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`
  );

  const prompt = `# CALL CONTEXT
${memoryMarkdown}

# PRE-CALL BRIEF
Lead: ${prospect.name}${prospect.title ? `, ${prospect.title}` : ''}${prospect.company ? ` @ ${prospect.company}` : ''}
Call goal: ${brief.callGoal ?? '(none specified)'}
Product snippets (for surface_value_prop play): ${productSnippets || '(none)'}

# IMMEDIATE PRIOR FOUNDER UTTERANCE (for short-answer interpretation)
${priorFounder ? `[${priorFounder.id}] FOUNDER: ${priorFounder.text}` : '(none)'}

# NEW PROSPECT UTTERANCE
[${utterance.id}] PROSPECT: ${utterance.text}

# CONTRADICTIONS DETECTED (deterministic anchor checks)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide whether to fire a suggestion, and if so which play. Output the structured Suggestion.`;

  const raw = await llmGenerateObject({
    step: 'prospect_suggester',
    modelKey: 'hotPath',
    schema: SuggestionSchema.omit({ agent: true }),
    prompt,
    system: SYSTEM,
  });

  return { ...raw, agent: 'prospect_suggester' };
}
