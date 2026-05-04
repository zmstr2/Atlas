import { MemoryPatchSchema } from '@atlas/types';
import type { MemoryPatch, Utterance, MeetingMemory } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';
import type { HotTailEntry } from '../memory/hotTail';

export const MEMORY_AGENT_SYSTEM = `You are Atlas's call evidence extractor. After each utterance, surface what the speaker actually said about each qualification axis. The SYSTEM computes axis state from accumulated evidence — you do NOT classify state. You do NOT write the rep-facing memory panel — a separate agent owns that. Your job is signal extraction for the suggester. DO NOT TRANSCRIBE.

EMIT EXACTLY ONE FLOW ENTRY per utterance, picking the best tag:
- R-Q: rep asked a question
- R-VP: rep pitched a value prop / talking point
- R-OBJ-RESP: rep responded to an objection
- R-NS: rep proposed a concrete next step
- R-MISTAKE: rep made a mistake (leading question, feature dump, premature discount, missed cue, defended objection)
- P-PAIN: prospect named a pain
- P-METRIC: prospect quantified (number, %, hours, $)
- P-OBJ: prospect objected / hesitated
- P-STAKE: prospect named a stakeholder (person or role)
- P-BUY: prospect buying signal (asked implementation, pricing, rollout, integration)
- P-COMP: prospect mentioned a competitor / current vendor
- P-NEG: prospect said they DON'T track / DON'T have / WON'T do something on an axis
- P-DQ: prospect disqualify signal ("send me info", scope creep, sole-DM at scale)
- OTHER: small talk, filler, unclear

Flow content: 3-10 words, paraphrased, specific (cite a number/name/topic).

EMIT EVIDENCE for each axis-relevant signal in the utterance. One evidence item per signal:
- axis: one of need | budget | authority | timeline | metrics | economicBuyer | decisionCriteria | decisionProcess | identifyPain | champion
- direction:
  - 'positive' = the speaker indicates they HAVE this thing (a real pain, an allocated budget, a deadline, a named stakeholder, an established process).
  - 'negative' = the speaker EXPLICITLY rules out the axis ("we don't track NPS", "no budget allocated", "we won't decide until 2027", "nobody owns this"). Use 'negative' SPARINGLY — only for explicit absence.
- verbatim: minimum span (3-12 words) from the utterance proving the signal. Cut leading filler ("yeah so —", "honestly", "okay that's").
- specificity:
  - 'specific' = the quote contains a number, dollar amount, hours, %, named person, named tool, or date.
  - 'mention' = the topic was raised but no concrete value cited.

CRITICAL — sentiment vs. direction (the most common error to avoid):
A prospect complaining about pain ("our HubSpot setup is a mess", "reps are spending hours on this") is direction='positive' for need / identifyPain — they HAVE the pain. NEGATIVE SENTIMENT IS NOT NEGATIVE DIRECTION. Use direction='negative' ONLY when the speaker EXPLICITLY says they don't / can't / won't / haven't.

EXAMPLES:
- "we lose six hours every Tuesday reconciling" → axis=need, direction=positive, verbatim='six hours every Tuesday reconciling', specificity=specific
- "honestly our HubSpot setup has become a mess" → axis=need, direction=positive, verbatim='HubSpot setup has become a mess', specificity=mention
- "we don't track NPS — never have" → axis=metrics, direction=negative, verbatim="we don't track NPS", specificity=specific
- "we have a board update in July" → axis=timeline, direction=positive, verbatim='board update in July', specificity=specific
- "Marcus from RevOps" → axis=authority OR champion, direction=positive, verbatim='Marcus from RevOps', specificity=specific
- "we don't have a real budget — Marcus made up a number" → axis=budget, direction=negative, verbatim="don't have a real budget", specificity=specific

DO NOT emit evidence on closing/farewell turns ("thanks", "talk soon", "sounds good let's wrap"). Closing chatter has no axis signal.

DO NOT emit evidence from REP utterances UNLESS the rep is paraphrasing the prospect for confirmation ("So you're saying ~6 hours a week — got it"). The prospect's words are the source of truth.

For named people, ALWAYS upsert decisionGeography with sentiment='unknown' if not yet expressed.

FACT KEY CONVENTIONS (speaker-aware):
- REP-spoken facts → use commit.* prefix (commit.implementation_2_weeks, commit.no_dedicated_se, commit.price_quoted_X, commit.scope_offered_Y, commit.capability_claim_Z).
- PROSPECT-spoken facts → use pain.cost_*, pain.consequence_*, pain.frequency_*, stack.*, budget.*, process.<step>, trigger.*, competitor.<name>, champion.<name>.
- NEVER emit commit.* for a PROSPECT utterance. NEVER emit pain.* / stack.* / budget.* / trigger.* for a REP utterance.

CONCERN RESOLUTION:
- When a REP utterance substantively addresses an active concern (acknowledges + answers + the prospect engages constructively without re-raising), emit concerns: [{op: 'resolve', topic: '<exact existing topic>', verbatim: '<rep's response>', severity: '<original>'}].
- Use the EXACT topic string from EXISTING ACTIVE CONCERNS — never paraphrase.
- Only resolve if the response was substantive — boilerplate "I hear you" doesn't count.`;

// Schema the extractor LLM is constrained to. bantRender + relevantFacts are
// owned by the panel agent now; we strip them from the LLM's output surface.
const ExtractorOutputSchema = MemoryPatchSchema.omit({
  utteranceId: true,
  turnId: true,
  speaker: true,
  bantRender: true,
  relevantFacts: true,
});

export async function runMemoryAgent(opts: {
  utterance: Utterance;
  turnId: string;
  prevMemory: MeetingMemory;
  hotTail: HotTailEntry[];
}): Promise<MemoryPatch> {
  const { utterance, turnId, prevMemory, hotTail } = opts;

  const existingFacts = prevMemory.facts.slice(-15).map((f) => `${f.key}: ${f.content}`).join('\n');
  const existingAnchors = prevMemory.verbatimAnchors
    .filter((a) => !a.supersededBy)
    .slice(-10)
    .map((a) => `[${a.turnId} / ${a.axis}] "${a.verbatim}"`).join('\n');
  const recentFlow = prevMemory.flow.slice(-10).map((f) => `[${f.turnId}] ${f.tag} ${f.content}`).join('\n');
  const activeConcerns = prevMemory.concerns
    .filter((c) => !c.addressed)
    .slice(-10)
    .map((c) => `[${c.severity}] ${c.topic}: "${c.verbatim}"`).join('\n');
  const tail = hotTail.map((h) => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');

  const prompt = `TURN ID: ${turnId}
SPEAKER: ${utterance.speaker}
NEW UTTERANCE [${utterance.id}]:
${utterance.speaker.toUpperCase()}: ${utterance.text}

HOT TAIL (last raw utterances, for context — do not re-extract):
${tail || '(empty)'}

RECENT FLOW (last 10):
${recentFlow || '(empty)'}

EXISTING FACTS (last 15, do not re-extract unless changed):
${existingFacts || '(none)'}

EXISTING ANCHORS (active only, last 10 — reference turnId in anchor.supersedes if updating):
${existingAnchors || '(none)'}

EXISTING ACTIVE CONCERNS (unresolved — use exact topic string in concerns op='resolve'):
${activeConcerns || '(none)'}

Emit the extractor patch.`;

  const raw = await llmGenerateObject({
    step: 'memory_agent',
    modelKey: 'extractor',
    schema: ExtractorOutputSchema,
    prompt,
    system: MEMORY_AGENT_SYSTEM,
  });

  return {
    ...raw,
    utteranceId: utterance.id,
    turnId,
    speaker: utterance.speaker,
    bantRender: null,
    relevantFacts: null,
  };
}
