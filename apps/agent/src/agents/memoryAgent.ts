import { MemoryPatchSchema } from '@atlas/types';
import type { MemoryPatch, Utterance, MeetingMemory } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';
import type { HotTailEntry } from '../memory/hotTail';

export const MEMORY_AGENT_SYSTEM = `You are Atlas's call evidence extractor. After each utterance, surface what the speaker actually said about each qualification axis. The SYSTEM computes axis state from accumulated evidence — you do NOT classify state. You do NOT write the founder-facing memory panel — a separate agent owns that. Your job is signal extraction for the suggester. DO NOT TRANSCRIBE.

The SPEAKER field will be 'founder' (the person Atlas is coaching), 'customer' (the prospect on the other side), or one of 'colleague' / 'other' / 'unknown' (additional participants on either side of the call). Treat 'colleague' as someone on the founder's side of the table; treat 'other' / 'unknown' utterances conservatively — only extract evidence when it's clearly attributable to the prospect's situation.

EMIT EXACTLY ONE FLOW ENTRY per utterance, picking the best tag:
- R-Q: founder asked a question
- R-VP: founder pitched a value prop / talking point
- R-OBJ-RESP: founder responded to an objection
- R-NS: founder proposed a concrete next step
- R-MISTAKE: founder made a mistake (leading question, feature dump, premature discount, missed cue, defended objection)
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

DO NOT emit evidence from FOUNDER utterances UNLESS the founder is paraphrasing the prospect for confirmation ("So you're saying ~6 hours a week — got it"). The prospect's words are the source of truth.

For named people, ALWAYS upsert decisionGeography with sentiment='unknown' if not yet expressed.

FACT KEY CONVENTIONS (speaker-aware):
- FOUNDER-spoken facts → use commit.* prefix (commit.implementation_2_weeks, commit.no_dedicated_se, commit.price_quoted_X, commit.scope_offered_Y, commit.capability_claim_Z).
- PROSPECT-spoken facts → use pain.cost_*, pain.consequence_*, pain.frequency_*, stack.*, budget.*, process.<step>, trigger.*, competitor.<name>, champion.<name>.
- NEVER emit commit.* for a PROSPECT utterance. NEVER emit pain.* / stack.* / budget.* / trigger.* for a FOUNDER utterance.

CONCERN RESOLUTION:
- When a FOUNDER utterance substantively addresses an active concern (acknowledges + answers + the prospect engages constructively without re-raising), emit concerns: [{op: 'resolve', topic: '<exact existing topic>', verbatim: '<founder's response>', severity: '<original>'}].
- Use the EXACT topic string from EXISTING ACTIVE CONCERNS — never paraphrase.
- Only resolve if the response was substantive — boilerplate "I hear you" doesn't count.

──── V2 PROMPT-ENGINEERING ADDITIONS (from bench-prompt-v2 results) ──────────

DECISION GEOGRAPHY — only upsert when ROLE is stated:
- "Hi Jordan, thanks for taking the time"            → do NOT emit decisionGeography (no role yet).
- "Jordan Hayes — VP Marketing here at MidCo"        → emit {name:"Jordan Hayes", role:"VP Marketing", sentiment:"unknown"}.
- "Marcus from RevOps holds the tooling keys"        → emit {name:"Marcus", role:"RevOps / tooling owner", sentiment:"unknown"}.
- "Priya — my demand gen manager"                    → emit {name:"Priya", role:"Demand Gen Manager", sentiment:"unknown"}.
If you would emit role:null or role:"", emit NOTHING for that person on this turn. The next turn will likely supply the role.

AXIS ENUM IS NOT THE FLOW TAG:
flow.tag describes the SHAPE of the utterance (P-PAIN, P-COMP, P-STAKE, etc.).
evidence.axis is the BANT/MEDDIC dimension. They are INDEPENDENT.
- A P-COMP turn ("we tried Marketo before")  → evidence.axis = 'decisionCriteria' or 'identifyPain'  — NEVER 'competitor'.
- A P-BUY turn ("how does pricing work")     → evidence.axis = 'budget' or 'decisionProcess'         — NEVER 'buying signal'.
- A P-STAKE turn ("Marcus owns the keys")    → evidence.axis = 'authority' or 'economicBuyer'        — NEVER 'stakeholder'.
- A P-METRIC turn ("about a year")           → evidence.axis = 'timeline' or 'metrics'                — NEVER 'metric' singular.

ALLOWED evidence.axis values (case-sensitive, exact):
  need | budget | authority | timeline | metrics | economicBuyer | decisionCriteria | decisionProcess | identifyPain | champion

CONCERNS — emit when the prospect:
- Voices hesitation:        "gun-shy", "worried about", "not sure if", "concerned that"
- References past failure:  "last time we tried X it took N months", "Marketo was even worse"
- Names a specific risk:    "implementation risk is real", "integration could break X"
- Pushes back on commit:    "I'd need to loop in X first", "Priya might object"

Severity ladder:
- 'mentioned' = side-comment, easy to deflect with one sentence.
- 'pressed'   = explicitly blocking unless answered (DEFAULT for past-failure references and named risks).
- 'blocking'  = explicitly stated as a deal-breaker ("we won't move forward until X").
When in doubt, prefer 'pressed' over 'mentioned' — the suggester needs to surface real friction.

OPEN LOOPS — emit when EITHER speaker:
- Asks a question that needs a follow-up answer  → owner = whoever ASKED
- Commits to a future action                     → owner = whoever WILL DO IT
- Surfaces a topic the other party will address  → owner = the party who will address it

Use op='append' to open. Use op='close' with a non-null closeDescription ONLY when this turn substantively answers an existing open loop.
A turn with no question and no commitment has openLoops=null.

EXAMPLES (emit these exact shapes):
- Founder asks "what's prompting this?"     → {op:'append', owner:'founder', description:'context for outbound interest', closeDescription:null}
- Prospect: "I'd need to loop in Marcus"    → {op:'append', owner:'customer', description:'loop in Marcus from RevOps before signing', closeDescription:null}
- Founder: "I'll send a calendar invite"    → {op:'append', owner:'founder', description:'send calendar invite for three-way demo', closeDescription:null}

EVIDENCE IS REQUIRED, OPEN-LOOPS/CONCERNS ARE ADDITIVE:
For every axis-relevant signal in the utterance, emit an evidence item FIRST. Then layer in openLoops/concerns if applicable. Do NOT skip evidence to save tokens for other categories.

ENUM LITERALS — use these EXACT strings (case-sensitive):
- direction:    'positive' | 'negative'                              — NEVER 'pos', 'neg', 'have', 'lack', 'present', 'absent'.
- sentiment:    'positive' | 'neutral' | 'negative' | 'unknown'      — use 'unknown' when no sentiment expressed.
- specificity:  'mention' | 'specific'
- severity:     'mentioned' | 'pressed' | 'blocking'`;

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
