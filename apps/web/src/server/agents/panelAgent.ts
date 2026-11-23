import { PanelPatchSchema } from '@atlas/types';
import type { PanelPatch, MeetingMemory, MemoryPatch } from '@atlas/types';
import { llmGenerateObject } from '../llm/wrapper';

/**
 * Should the panel agent run after this extractor patch?
 *
 * Gate by speaker AND substance:
 *  - Prospect turns are the only source of BANT panel facts. The rep doesn't
 *    expose the prospect's budget; running on rep turns was the bug that
 *    caused the panel to flicker after every rep statement.
 *  - Even on a prospect turn, skip if the extractor pulled out nothing
 *    panel-relevant — small talk shouldn't trigger a panel rewrite.
 */
export function shouldRunPanelAgent(patch: MemoryPatch): boolean {
  if (patch.speaker !== 'customer') return false;
  const hasEvidence = (patch.evidence?.length ?? 0) > 0;
  const hasConcerns = (patch.concerns?.length ?? 0) > 0;
  const hasStakeholders = (patch.decisionGeography?.length ?? 0) > 0;
  // commit.* facts come from the rep and aren't panel-relevant; everything
  // else (pain.*, stack.*, budget.*, trigger.*, competitor.*, champion.*) is.
  const hasNonCommitFacts = (patch.facts ?? []).some((f) => !f.key.startsWith('commit.'));
  return hasEvidence || hasConcerns || hasStakeholders || hasNonCommitFacts;
}

export const PANEL_AGENT_SYSTEM = `You are Atlas's memory-panel writer. The rep glances at this panel mid-call to track what they know about the prospect on each BANT axis and to surface other call-shaping facts. You are NOT an extractor — you do not see the latest utterance directly. You see the WHOLE conversation as accumulated structured state, and you write a stable, glanceable summary that reflects the call so far.

YOUR INPUT is the call's accumulated memory:
- Per-axis EVIDENCE (every signal extracted across the call, with verbatim quotes, direction, specificity)
- Per-axis VERBATIM ANCHORS (specific quotes — numbers, names, dates)
- DECISION GEOGRAPHY (named stakeholders + roles + sentiment)
- ACTIVE CONCERNS
- RECENT FLOW (turn-by-turn paraphrased tags)
- PRIOR PANEL — what you wrote last time

YOUR OUTPUT is a complete panel: every BANT axis (need / budget / authority / timeline) gets a render, and you choose up to 4 relevant facts. Output is the FULL panel — partial output means "blank panel" to the consumer, so always emit all four axes.

BANT RENDER per axis:
- headline: ≤8 words. Declarative fact written for glanceability. No leading "they said" / "prospect mentioned" / quotes. Third person or noun phrase. If there is genuinely nothing yet on this axis, set headline=null and detail=null.
- detail: ≤12 words. The qualifier — the driver, scope, constraint, or named stakeholder that makes the headline matter. Null if nothing useful adds.

PRINCIPLES:
1. STABILITY. Prefer keeping the prior render unchanged over writing a slight rephrasing. The rep is glancing — flicker without information gain is a regression. Only rewrite when new evidence genuinely adds a fact (a number, name, date, or sub-point that wasn't there).
2. WHOLE-CALL VIEW. The newest utterance is NOT privileged. A specific fact mentioned 5 turns ago that has not been contradicted is still load-bearing. Combine the strongest facts across the entire call, not just the latest.
3. PERSISTENCE OF SPECIFICS. Every concrete token in the prior render — numbers, $ amounts, %, hours, named people, named tools, dates — survives unless directly superseded (corrected number, different person for the same role, moved date). Vague new info NEVER replaces a specific prior fact.
4. PRIORITY when ≤8 words forces choices:
   a. Quantified > qualitative ("$30k budget" beats "tight budget"; "6 hrs/week" beats "lots of time")
   b. Named > generic ("Marcus signs <$25k" beats "manager has authority")
   c. Firm date > fuzzy ("July board" beats "this quarter")
   d. Strategic driver > tactical detail (a 3x ARR target beats a single workflow gripe)
5. COEXIST when needed. If two facts on the same axis are different sub-points (budget amount + approval gate; pipeline target + time waste), combine them — use the detail line, or compress with a separator.

TIMELINE axis is ONLY about the deal-closing or solution-go-live timeline — when the rep needs to close, or when the prospect needs the solution implemented. Examples that DO qualify: "decision before July board", "go-live by mid-June", "Q3 deadline", "signing this quarter". Examples that DO NOT qualify: meeting scheduling ("Tuesday at 3", "follow-up next week"), call logistics ("hard stop in 30 min"), historical durations ("nine-month rollout last time" — that is a need/risk fact, not a timeline). If the only timeline-flavored evidence is meeting logistics, leave timeline.headline null.

DO NOT INVENT. Every concrete token in the headline or detail must trace to a verbatim or to a fact in the input. If the evidence is too thin to write a real headline, set headline=null. Do not fabricate to fill space.

RELEVANT FACTS (≤4 total): non-BANT context that genuinely shapes the rep's next move. Re-rank from scratch each call — this is NOT an append. Categories: stack (tools/systems), metric (numbers/KPIs not on a BANT axis), trigger (events driving urgency), competitor (named alternatives), commitment (rep promises), process (buying-process steps the rep needs to navigate). Each ≤10 words, factual, no filler. If nothing rises to "the rep needs this in their working set," return fewer than 4 — even zero. Never pad.`;

export async function runPanelAgent(opts: {
  memory: MeetingMemory;
}): Promise<PanelPatch> {
  const { memory } = opts;

  // Group evidence by axis for the panel agent's input. We pull from
  // qualSignals (synthesized from extractor evidence) and verbatimAnchors —
  // both already accumulated across the whole call.
  const signalsByAxis: Record<string, string[]> = {
    need: [], budget: [], authority: [], timeline: [],
  };
  for (const s of memory.qualSignals) {
    if (!s.bantBucket) continue;
    const dir = s.direction === 'negative' ? '[NEG]' : '[POS]';
    signalsByAxis[s.bantBucket]?.push(`${dir} "${s.content}"`);
  }
  const anchorsByAxis: Record<string, string[]> = {
    need: [], budget: [], authority: [], timeline: [],
  };
  for (const a of memory.verbatimAnchors) {
    if (a.supersededBy) continue;
    if (a.axis === 'need' || a.axis === 'budget' || a.axis === 'authority' || a.axis === 'timeline') {
      anchorsByAxis[a.axis]?.push(`[${a.turnId}] "${a.verbatim}"`);
    }
  }

  const stakeholders = memory.decisionGeography
    .map((d) => `${d.name} (${d.role}, sentiment=${d.sentiment})`)
    .join('\n') || '(none)';

  const concerns = memory.concerns
    .filter((c) => !c.addressed)
    .map((c) => `[${c.severity}] ${c.topic}: "${c.verbatim}"`)
    .join('\n') || '(none)';

  const recentFlow = memory.flow.slice(-15)
    .map((f) => `[${f.turnId}] ${f.tag} ${f.content}`).join('\n') || '(empty)';

  const facts = memory.facts.slice(-25)
    .map((f) => `${f.key}: ${f.content}`).join('\n') || '(none)';

  const priorPanel = (['need', 'budget', 'authority', 'timeline'] as const)
    .map((axis) => {
      const r = memory.bantRender?.[axis];
      if (!r?.headline) return `${axis}: (no prior render)`;
      return `${axis}: "${r.headline}"${r.detail ? ` | detail: "${r.detail}"` : ''}`;
    }).join('\n');

  const priorRelevant = (memory.relevantFacts ?? [])
    .map((f) => `[${f.category}] ${f.text}`).join('\n') || '(none)';

  const axisBlock = (['need', 'budget', 'authority', 'timeline'] as const)
    .map((axis) => `=== ${axis.toUpperCase()} ===
SIGNALS:
${signalsByAxis[axis]?.join('\n') || '(none)'}
SPECIFIC ANCHORS:
${anchorsByAxis[axis]?.join('\n') || '(none)'}`)
    .join('\n\n');

  const prompt = `ACCUMULATED CALL STATE — write the panel from this. Do not assume the most recent thing is the most important.

${axisBlock}

STAKEHOLDERS:
${stakeholders}

ACTIVE CONCERNS:
${concerns}

RECENT FLOW (last 15 turns, for context only — does not override accumulated evidence):
${recentFlow}

ACCUMULATED FACTS (last 25):
${facts}

PRIOR PANEL (keep unchanged unless new evidence genuinely adds):
${priorPanel}

PRIOR RELEVANT FACTS (re-rank from scratch — do not just append):
${priorRelevant}

Emit the full panel patch (all four BANT axes + relevantFacts).`;

  return llmGenerateObject({
    step: 'panel_agent',
    modelKey: 'extractor',
    schema: PanelPatchSchema,
    prompt,
    system: PANEL_AGENT_SYSTEM,
  });
}
