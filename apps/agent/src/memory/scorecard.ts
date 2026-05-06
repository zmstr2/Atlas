import type {
  MeetingMemory,
  QualScorecard,
  AxisState,
  AxisKey,
  QualSignal,
  Concern,
} from '@atlas/types';

type StatsInput = {
  founderWords: number;
  prospectWords: number;
  turnsSinceLastRepQuestion: number;
  turnsSinceLastNextStepProposal: number;
  callMinute: number;
};

// MEDDIC dimension → BANT bucket maps already exist in qualSignals; we read both.
// Priority order from the plan:
//   need > budget > authority > timeline > champion > metrics > economicBuyer > decisionProcess > decisionCriteria
const PUSH_PRIORITY: AxisKey[] = [
  'need',
  'budget',
  'authority',
  'timeline',
  'champion',
  'metrics',
  'economicBuyer',
  'decisionProcess',
  'decisionCriteria',
];

const STATE_RANK: Record<AxisState, number> = {
  unknown: 0,
  vague: 1,
  soft: 2,
  partial: 2,
  firm: 3,
  confirmed: 4,
  // confirmed_negative is a terminal axis state — excluded from pushQueue
  confirmed_negative: -1,
};

function takeStronger(a: AxisState, b: AxisState): AxisState {
  // confirmed_negative wins over everything (it's a terminal "do not push" state)
  if (a === 'confirmed_negative' || b === 'confirmed_negative') return 'confirmed_negative';
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

/**
 * Map a qualSignal to its axis impact.
 * Positive signals raise the axis state; negative signals on the same axis
 * mark it confirmed_negative.
 */
function axisFromSignal(sig: QualSignal): AxisKey[] {
  // Each signal contributes to its BANT bucket and its MEDDIC axis.
  const out: AxisKey[] = [];
  // BANT bucket → axis (1:1)
  switch (sig.bantBucket) {
    case 'budget': out.push('budget'); break;
    case 'authority': out.push('authority'); break;
    case 'need': out.push('need'); break;
    case 'timeline': out.push('timeline'); break;
  }
  // MEDDIC dimension → axis
  switch (sig.meddic) {
    case 'metrics': out.push('metrics'); break;
    case 'economic_buyer': out.push('economicBuyer'); break;
    case 'decision_criteria': out.push('decisionCriteria'); break;
    case 'decision_process': out.push('decisionProcess'); break;
    case 'identify_pain': out.push('need'); break;        // pain → need
    case 'champion': out.push('champion'); break;
    case 'budget': out.push('budget'); break;
  }
  return out;
}

/**
 * Default positive contribution by axis: signals are usually 'soft' unless
 * a stronger fact backs them up.
 */
function positiveContribution(): AxisState {
  return 'soft';
}

function applySignalsToAxes(memory: MeetingMemory): Record<AxisKey, AxisState> {
  const axes: Record<AxisKey, AxisState> = {
    need: 'unknown',
    budget: 'unknown',
    authority: 'unknown',
    timeline: 'unknown',
    metrics: 'unknown',
    economicBuyer: 'unknown',
    decisionCriteria: 'unknown',
    decisionProcess: 'unknown',
    identifyPain: 'unknown',
    champion: 'unknown',
  };

  for (const sig of memory.qualSignals) {
    const targets = axisFromSignal(sig);
    for (const ax of targets) {
      if (sig.direction === 'negative') {
        axes[ax] = 'confirmed_negative';
      } else {
        axes[ax] = takeStronger(axes[ax], positiveContribution());
      }
    }
  }

  // identifyPain mirrors need (both backed by 'identify_pain' signals).
  axes.identifyPain = takeStronger(axes.identifyPain, axes.need);

  // Facts upgrade certain axes:
  //   budget category fact w/ confidence ≥ 0.7 → 'firm' (unless already confirmed_negative)
  //   timeline category fact w/ confidence ≥ 0.7 → 'firm'
  for (const fact of memory.facts) {
    if (fact.category === 'budget' && fact.confidence >= 0.7) {
      axes.budget = takeStronger(axes.budget, 'firm');
    }
    if (fact.category === 'timeline' && fact.confidence >= 0.7) {
      axes.timeline = takeStronger(axes.timeline, 'firm');
    }
    // pain.cost_*, pain.consequence_* → need=confirmed
    if (fact.key.startsWith('pain.cost_') || fact.key.startsWith('pain.consequence_')) {
      axes.need = takeStronger(axes.need, 'confirmed');
      axes.identifyPain = takeStronger(axes.identifyPain, 'confirmed');
      // also feeds metrics if a numeric cost was named
      if (fact.key.startsWith('pain.cost_')) {
        axes.metrics = takeStronger(axes.metrics, 'firm');
      }
    }
    if (fact.key.startsWith('pain.')) {
      axes.need = takeStronger(axes.need, 'soft');
    }
  }

  // Decision-geography fills champion / economicBuyer
  for (const actor of memory.decisionGeography) {
    const role = actor.role.toLowerCase();
    const isExec = /chief|cfo|ceo|coo|cto|vp|vice president|head of|director/.test(role);
    if (actor.sentiment === 'positive') {
      // present champion if positive and influential, else weak (still 'soft' axis-wise)
      if (isExec) {
        axes.champion = takeStronger(axes.champion, 'firm');
        axes.economicBuyer = takeStronger(axes.economicBuyer, 'firm');
      } else {
        axes.champion = takeStronger(axes.champion, 'soft');
      }
    } else if (actor.sentiment === 'unknown') {
      // named but unprobed — partial signal at most
      if (isExec) axes.economicBuyer = takeStronger(axes.economicBuyer, 'partial');
    } else if (actor.sentiment === 'negative') {
      // a known blocker doesn't disqualify champion (could still find another) but doesn't help
    }
  }

  return axes;
}

function detectSoftDisqualifiers(memory: MeetingMemory, callMinute: number, needState: AxisState): string[] {
  const out = new Set<string>();
  // Pattern 1: "send info" / "just send a deck" → send_info_deflection
  for (const c of memory.concerns as Concern[]) {
    const v = c.verbatim.toLowerCase();
    if (/(send (me )?(a )?(deck|info|information|something)|just (send|email))/.test(v)) {
      out.add('send_info_deflection');
    }
    if (c.topic === 'vague_pain' || /vague[_-]?pain/i.test(c.topic)) {
      out.add('vague_pain_after_drill');
    }
    if (/scope[_-]?creep/i.test(c.topic) || /can it (also )?do/i.test(v)) {
      out.add('scope_creep');
    }
    if (/sole[_-]?dm|only (decision )?maker/i.test(c.topic) || /^i (alone )?decide/i.test(v)) {
      out.add('sole_dm_at_scale');
    }
    if (/no[_-]?trigger/i.test(c.topic)) {
      out.add('no_trigger');
    }
  }
  // Pattern 2: late-stage with vague Need
  if (callMinute >= 20 && (needState === 'unknown' || needState === 'vague')) {
    out.add('late_with_vague_need');
  }
  return [...out];
}

export function computeScorecard(memory: MeetingMemory, stats: StatsInput): QualScorecard {
  const axes = applySignalsToAxes(memory);

  const bant = {
    need: axes.need,
    budget: axes.budget,
    authority: axes.authority,
    timeline: axes.timeline,
  };
  const meddic = {
    metrics: axes.metrics,
    economicBuyer: axes.economicBuyer,
    decisionCriteria: axes.decisionCriteria,
    decisionProcess: axes.decisionProcess,
    identifyPain: axes.identifyPain,
    champion: axes.champion,
  };

  const hardDisqualify =
    axes.need === 'confirmed_negative' ||
    axes.budget === 'confirmed_negative';

  const softDisqualifySignals = detectSoftDisqualifiers(memory, stats.callMinute, axes.need);

  // Push queue: priority-ordered axes that are still unknown/vague AND not confirmed_negative.
  const pushQueue: AxisKey[] = PUSH_PRIORITY.filter((k) => {
    const s = axes[k];
    if (s === 'confirmed_negative') return false;
    if (s === 'firm' || s === 'confirmed') return false;
    return true;
  });

  return {
    bant,
    meddic,
    pushQueue,
    hardDisqualify,
    softDisqualifySignals,
    talkRatio: { founderWords: stats.founderWords, prospectWords: stats.prospectWords },
    turnsSinceLastRepQuestion: stats.turnsSinceLastRepQuestion,
    turnsSinceLastNextStepProposal: stats.turnsSinceLastNextStepProposal,
    callMinute: stats.callMinute,
  };
}
