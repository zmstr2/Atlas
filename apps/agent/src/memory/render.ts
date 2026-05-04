import type { MeetingMemory } from '@atlas/types';
import type { HotTailEntry } from './hotTail';

/**
 * Compact markdown rendering of memory state. Used by all reader agents
 * (prospect-suggester, rep-watcher, coach chat) so they see the same shape.
 *
 * Target ~400-500 tokens for a 30-minute call.
 */
export function renderMemoryMarkdown(opts: {
  memory: MeetingMemory;
  hotTail?: HotTailEntry[];
  leadName?: string;
  callGoal?: string;
}): string {
  const { memory, hotTail = [], leadName, callGoal } = opts;
  const sc = memory.scorecard;
  const lines: string[] = [];

  if (leadName || callGoal) {
    lines.push(`# Call — ${leadName ?? '?'}`);
    if (callGoal) lines.push(`Goal: ${callGoal}`);
    lines.push('');
  }

  // Stage
  const totalWords = sc.talkRatio.repWords + sc.talkRatio.prospectWords;
  const repPct = totalWords > 0 ? Math.round((sc.talkRatio.repWords / totalWords) * 100) : 0;
  const prospectPct = totalWords > 0 ? Math.round((sc.talkRatio.prospectWords / totalWords) * 100) : 0;
  lines.push('## Stage');
  lines.push(`Minute ${sc.callMinute}. Talk ratio (words): rep ${repPct}% / prospect ${prospectPct}%. Turns since last R-Q: ${sc.turnsSinceLastRepQuestion}. Turns since last R-NS: ${sc.turnsSinceLastNextStepProposal}.`);
  lines.push('');

  // BANT / MEDDIC
  lines.push('## BANT / MEDDIC');
  lines.push(`- Need: ${sc.bant.need}`);
  lines.push(`- Budget: ${sc.bant.budget}`);
  lines.push(`- Authority: ${sc.bant.authority}`);
  lines.push(`- Timeline: ${sc.bant.timeline}`);
  lines.push(`- Metrics: ${sc.meddic.metrics}`);
  lines.push(`- Economic Buyer: ${sc.meddic.economicBuyer}`);
  lines.push(`- Decision Criteria: ${sc.meddic.decisionCriteria}`);
  lines.push(`- Decision Process: ${sc.meddic.decisionProcess}`);
  lines.push(`- Identify Pain: ${sc.meddic.identifyPain}`);
  lines.push(`- Champion: ${sc.meddic.champion}`);
  lines.push('');

  // Push queue
  lines.push('## Push queue (priority order, ambiguous absences only)');
  if (sc.pushQueue.length === 0) lines.push('(empty — all axes filled or confirmed-negative)');
  else sc.pushQueue.slice(0, 5).forEach((k, i) => lines.push(`${i + 1}. ${k}`));
  lines.push('');

  // Disqualifiers
  lines.push('## Disqualifiers');
  if (sc.hardDisqualify) lines.push('- HARD: Need or Budget confirmed-negative — qualify out.');
  if (sc.softDisqualifySignals.length > 0) {
    for (const s of sc.softDisqualifySignals) lines.push(`- soft: ${s}`);
  }
  if (!sc.hardDisqualify && sc.softDisqualifySignals.length === 0) lines.push('none active');
  lines.push('');

  // Flow
  lines.push('## Flow (compressed, last 20)');
  if (memory.flow.length === 0) lines.push('(no entries)');
  else for (const f of memory.flow.slice(-20)) {
    lines.push(`[${f.turnId}] ${f.tag} ${f.content}`);
  }
  lines.push('');

  // Verbatim anchors (filter out superseded ones — V2)
  const activeAnchors = memory.verbatimAnchors.filter((a) => !a.supersededBy);
  lines.push('## Verbatim anchors (load-bearing details)');
  if (activeAnchors.length === 0) lines.push('(none)');
  else for (const a of activeAnchors) {
    lines.push(`- [${a.turnId} / ${a.axis}] "${a.verbatim}"`);
  }
  lines.push('');

  // Stakeholders
  if (memory.decisionGeography.length > 0) {
    lines.push('## Stakeholders');
    for (const a of memory.decisionGeography) {
      lines.push(`- ${a.name} (${a.role}) — sentiment: ${a.sentiment}`);
    }
    lines.push('');
  }

  // Open loops
  const openLoops = memory.openLoops.filter((l) => l.status === 'open');
  if (openLoops.length > 0) {
    lines.push('## Open loops');
    for (const l of openLoops) lines.push(`- [${l.owner}] ${l.description}`);
    lines.push('');
  }

  // Key facts
  if (memory.facts.length > 0) {
    lines.push('## Key facts (extracted)');
    for (const f of memory.facts) {
      lines.push(`- [${f.key}] ${f.content}`);
    }
    lines.push('');
  }

  // Active concerns (unaddressed objections / hesitations)
  const activeConcerns = memory.concerns.filter((c) => !c.addressed);
  if (activeConcerns.length > 0) {
    lines.push('## Active concerns');
    for (const c of activeConcerns) {
      lines.push(`- [${c.severity}] ${c.topic}: "${c.verbatim}"`);
    }
    lines.push('');
  }

  // Hot tail (raw, never paraphrased — ground truth for short utterances)
  if (hotTail.length > 0) {
    lines.push('## Hot tail (last raw utterances)');
    for (const h of hotTail) {
      lines.push(`[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
