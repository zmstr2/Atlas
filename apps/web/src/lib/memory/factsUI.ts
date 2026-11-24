import type {
  MeetingMemory,
  CallFactsUI,
  AxisCard,
  AxisKey,
  AxisState,
  StakeholderCard,
  QualSignal,
  Fact,
} from '@atlas/types';

const PUSH_PROMPTS: Record<AxisKey, string> = {
  need: 'Drill on the prospect\'s pain — get a specific, recent example.',
  budget: 'Ask about budget — whose budget would this come out of?',
  authority: 'Map authority — who signs off, and at what dollar threshold?',
  timeline: 'Anchor a timeline — what\'s driving the urgency?',
  metrics: 'Quantify the pain — hours, dollars, or % impact?',
  economicBuyer: 'Identify the economic buyer — whose budget is at stake?',
  decisionCriteria: 'Surface decision criteria — what do they need to see to say yes?',
  decisionProcess: 'Map the process — walk through how they bought their last tool like this.',
  identifyPain: 'Confirm pain — get a recent, specific example.',
  champion: 'Probe the champion — sentiment + influence on the named stakeholder.',
};

/**
 * UI maps the 7-state axis taxonomy onto a 4-state visual ladder:
 * unknown / soft / firm / confirmed_negative.
 */
function uiAxisState(s: AxisState): AxisCard['state'] {
  switch (s) {
    case 'confirmed_negative': return 'confirmed_negative';
    case 'firm':
    case 'confirmed': return 'firm';
    case 'soft':
    case 'partial':
    case 'vague': return 'soft';
    case 'unknown':
    default: return 'unknown';
  }
}

/**
 * Pick the strongest evidence text for an axis card.
 * Preference: anchor on this axis → highest-confidence positive qualSignal → fact.content.
 */
function pickEvidence(
  memory: MeetingMemory,
  axisKey: AxisKey,
): { evidence: string | null; anchorTurnId: string | null } {
  // Anchor first — exact axis match
  const anchorAxisMap: Partial<Record<AxisKey, string[]>> = {
    need: ['need'],
    budget: ['budget'],
    authority: ['authority'],
    timeline: ['timeline'],
    metrics: ['metric'],
    economicBuyer: ['stakeholder'],
    champion: ['champion', 'stakeholder'],
    decisionProcess: [],
    decisionCriteria: [],
    identifyPain: ['need', 'consequence'],
  };
  const candidates = anchorAxisMap[axisKey] ?? [];
  for (const ax of candidates) {
    const a = [...memory.verbatimAnchors].reverse().find((x) => x.axis === ax);
    if (a) return { evidence: a.verbatim, anchorTurnId: a.turnId };
  }

  // QualSignal — pick the most recent positive on this axis
  const matchSignal = (sig: QualSignal): boolean => {
    if (sig.direction !== 'positive') return false;
    if (axisKey === 'need' && (sig.bantBucket === 'need' || sig.meddic === 'identify_pain')) return true;
    if (axisKey === 'identifyPain' && sig.meddic === 'identify_pain') return true;
    if (axisKey === 'budget' && sig.bantBucket === 'budget') return true;
    if (axisKey === 'authority' && sig.bantBucket === 'authority') return true;
    if (axisKey === 'timeline' && sig.bantBucket === 'timeline') return true;
    if (axisKey === 'metrics' && sig.meddic === 'metrics') return true;
    if (axisKey === 'economicBuyer' && sig.meddic === 'economic_buyer') return true;
    if (axisKey === 'decisionCriteria' && sig.meddic === 'decision_criteria') return true;
    if (axisKey === 'decisionProcess' && sig.meddic === 'decision_process') return true;
    if (axisKey === 'champion' && sig.meddic === 'champion') return true;
    return false;
  };
  const sig = [...memory.qualSignals].reverse().find(matchSignal);
  if (sig) return { evidence: sig.content, anchorTurnId: null };

  // Fact fallback for budget/timeline/need
  const factFallback: Partial<Record<AxisKey, (f: Fact) => boolean>> = {
    budget: (f) => f.category === 'budget',
    timeline: (f) => f.category === 'timeline',
    need: (f) => f.key.startsWith('pain.'),
    identifyPain: (f) => f.key.startsWith('pain.'),
  };
  const ff = factFallback[axisKey];
  if (ff) {
    const f = [...memory.facts].reverse().find(ff);
    if (f) return { evidence: f.content, anchorTurnId: null };
  }

  return { evidence: null, anchorTurnId: null };
}

function buildAxisCard(memory: MeetingMemory, axisKey: AxisKey, state: AxisState): AxisCard {
  const ev = pickEvidence(memory, axisKey);
  const render = memory.bantRender?.[axisKey];
  const uiState = uiAxisState(state);
  return {
    state: uiState,
    // The panel agent writes headlines on its own cadence. Until it has, fall
    // back to the strongest evidence so a scored axis never renders empty.
    headline: render?.headline ?? (uiState !== 'unknown' ? ev.evidence : null),
    detail: render?.detail ?? null,
    anchorTurnId: ev.anchorTurnId,
    quote: ev.anchorTurnId ? ev.evidence : null,
  };
}

function buildStakeholderCard(actor: MeetingMemory['decisionGeography'][number], memory: MeetingMemory): StakeholderCard {
  const role = actor.role.toLowerCase();
  const isExec = /chief|cfo|ceo|coo|cto|vp|vice president|head of|director/.test(role);

  let role_hint: StakeholderCard['role_hint'] = 'other';
  if (isExec && actor.sentiment !== 'negative') role_hint = 'economic_buyer_candidate';
  if (actor.sentiment === 'positive') role_hint = 'champion_candidate';
  if (actor.sentiment === 'negative') role_hint = 'blocker';

  // Try to find an anchor that mentions this name
  const anchor = memory.verbatimAnchors.find((a) =>
    a.axis === 'stakeholder' && a.verbatim.toLowerCase().includes(actor.name.toLowerCase())
  );

  return {
    name: actor.name,
    role: actor.role,
    sentiment: actor.sentiment,
    role_hint,
    anchorTurnId: anchor?.turnId ?? null,
  };
}

export function buildCallFactsUI(memory: MeetingMemory): CallFactsUI {
  const sc = memory.scorecard;

  const bant = {
    need: buildAxisCard(memory, 'need', sc.bant.need),
    budget: buildAxisCard(memory, 'budget', sc.bant.budget),
    authority: buildAxisCard(memory, 'authority', sc.bant.authority),
    timeline: buildAxisCard(memory, 'timeline', sc.bant.timeline),
  };
  const meddic = {
    metrics: buildAxisCard(memory, 'metrics', sc.meddic.metrics),
    economicBuyer: buildAxisCard(memory, 'economicBuyer', sc.meddic.economicBuyer),
    decisionCriteria: buildAxisCard(memory, 'decisionCriteria', sc.meddic.decisionCriteria),
    decisionProcess: buildAxisCard(memory, 'decisionProcess', sc.meddic.decisionProcess),
    identifyPain: buildAxisCard(memory, 'identifyPain', sc.meddic.identifyPain),
    champion: buildAxisCard(memory, 'champion', sc.meddic.champion),
  };

  const stakeholders = memory.decisionGeography.map((a) => buildStakeholderCard(a, memory));
  const openLoops = memory.openLoops
    .filter((l) => l.status === 'open')
    .map((l) => ({ id: l.id, description: l.description, owner: l.owner }));
  const anchors = memory.verbatimAnchors.map((a) => ({
    axis: a.axis,
    verbatim: a.verbatim,
    turnId: a.turnId,
  }));

  const top = sc.pushQueue[0];
  const pushNext = top
    ? { axis: top, humanPrompt: PUSH_PROMPTS[top] }
    : null;

  const totalWords = sc.talkRatio.repWords + sc.talkRatio.prospectWords;
  const ratio = totalWords > 0
    ? { rep: sc.talkRatio.repWords / totalWords, prospect: sc.talkRatio.prospectWords / totalWords }
    : { rep: 0, prospect: 0 };

  return {
    bant,
    meddic,
    stakeholders,
    openLoops,
    anchors,
    pushNext,
    disqualifiers: {
      hard: sc.hardDisqualify,
      softCount: sc.softDisqualifySignals.length,
      soft: sc.softDisqualifySignals,
    },
    stage: {
      callMinute: sc.callMinute,
      talkRatio: ratio,
      turnsSinceLastRepQuestion: sc.turnsSinceLastRepQuestion,
      turnsSinceLastNextStepProposal: sc.turnsSinceLastNextStepProposal,
    },
    relevantFacts: memory.relevantFacts ?? [],
  };
}
