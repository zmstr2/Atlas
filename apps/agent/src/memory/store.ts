import { nanoid } from 'nanoid';
import type { MeetingMemory, Fact, Concern, OpenLoop, DecisionActor, FlowEntry, VerbatimAnchor, AxisKey, AnchorAxis, Evidence, QualSignal, RelevantFact, PanelPatch } from '@atlas/types';
import { emptyScorecard, emptyMeetingMemoryExtras } from '@atlas/types';
import type { ExtractorPatch, MemoryPatch } from '@atlas/types';
import { computeScorecard } from './scorecard';

// Mappings from the unified AxisKey (LLM-emitted) onto the legacy BANT/MEDDIC
// enums and the legacy AnchorAxis enum. These are used to synthesize
// qualSignals + verbatimAnchors from evidence so downstream consumers (suggester,
// scorecard, render) keep working unchanged.
const AXIS_KEY_TO_BANT: Partial<Record<AxisKey, 'need' | 'budget' | 'authority' | 'timeline'>> = {
  need: 'need',
  budget: 'budget',
  authority: 'authority',
  timeline: 'timeline',
  identifyPain: 'need',
  economicBuyer: 'authority',
  champion: 'authority',
};
const AXIS_KEY_TO_MEDDIC: Partial<Record<AxisKey, QualSignal['meddic']>> = {
  metrics: 'metrics',
  economicBuyer: 'economic_buyer',
  decisionCriteria: 'decision_criteria',
  decisionProcess: 'decision_process',
  identifyPain: 'identify_pain',
  champion: 'champion',
  budget: 'budget',
  need: 'identify_pain',
  authority: 'economic_buyer',
  timeline: 'decision_process',
};
const AXIS_KEY_TO_ANCHOR: Partial<Record<AxisKey, AnchorAxis>> = {
  need: 'need',
  budget: 'budget',
  authority: 'authority',
  timeline: 'timeline',
  metrics: 'metric',
  identifyPain: 'need',
  champion: 'champion',
  economicBuyer: 'stakeholder',
};

export function createEmptyMemory(): MeetingMemory {
  return {
    facts: [],
    concerns: [],
    openLoops: [],
    qualSignals: [],
    decisionGeography: [],
    silenceTopics: [],
    narrative: '',
    flow: [],
    verbatimAnchors: [],
    scorecard: emptyScorecard(),
    ...emptyMeetingMemoryExtras(),
  };
}

export type CallStats = {
  callStartedAt: number;
  repWords: number;
  prospectWords: number;
  turnsSinceLastRepQuestion: number;
  turnsSinceLastNextStepProposal: number;
};

export class MemoryStore {
  private memory: MeetingMemory;
  private listeners: Array<(memory: MeetingMemory, utteranceId: string) => void> = [];
  private factsByKey = new Map<string, Fact>();
  private concernsByTopic = new Map<string, Concern>();
  private openLoopsByDesc = new Map<string, OpenLoop>();
  private decisionByName = new Map<string, DecisionActor>();
  private cachedSnapshot: MeetingMemory | null = null;
  private stats: CallStats = {
    callStartedAt: Date.now(),
    repWords: 0,
    prospectWords: 0,
    turnsSinceLastRepQuestion: 0,
    turnsSinceLastNextStepProposal: 0,
  };

  constructor(initial?: MeetingMemory) {
    this.memory = initial ?? createEmptyMemory();
    if (initial) this.rebuildIndices();
  }

  recordUtteranceStats(speaker: 'rep' | 'customer', text: string) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (speaker === 'rep') this.stats.repWords += words;
    else this.stats.prospectWords += words;
    this.stats.turnsSinceLastRepQuestion += 1;
    this.stats.turnsSinceLastNextStepProposal += 1;
  }

  noteRepQuestion() { this.stats.turnsSinceLastRepQuestion = 0; }
  noteNextStepProposal() { this.stats.turnsSinceLastNextStepProposal = 0; }
  getStats(): CallStats { return { ...this.stats }; }

  private rebuildIndices() {
    this.factsByKey.clear();
    this.concernsByTopic.clear();
    this.openLoopsByDesc.clear();
    this.decisionByName.clear();
    for (const f of this.memory.facts) this.factsByKey.set(f.key, f);
    for (const c of this.memory.concerns) this.concernsByTopic.set(c.topic, c);
    for (const l of this.memory.openLoops) {
      if (l.status === 'open') this.openLoopsByDesc.set(l.description, l);
    }
    for (const d of this.memory.decisionGeography) this.decisionByName.set(d.name, d);
  }

  get snapshot(): MeetingMemory {
    if (!this.cachedSnapshot) this.cachedSnapshot = structuredClone(this.memory);
    return this.cachedSnapshot;
  }

  onChange(fn: (memory: MeetingMemory, utteranceId: string) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify(utteranceId: string) {
    const snap = this.snapshot;
    for (const fn of this.listeners) fn(snap, utteranceId);
  }

  applyPatch(patch: ExtractorPatch): void {
    this.applyPatchInternal(patch);
    this.cachedSnapshot = null;
    this.recomputeScorecard();
    this.notify(patch.utteranceId);
  }

  /**
   * Apply a MemoryPatch — the simplified evidence-based shape emitted by the
   * memory agent. Each evidence item is synthesized into:
   *   - a qualSignal (positive/negative direction, mapped to BANT + MEDDIC),
   *   - and a verbatimAnchor when specificity='specific'.
   * Axis state is then derived deterministically by recomputeScorecard from the
   * accumulated signals + facts. The LLM never classifies state directly —
   * removing the failure mode where positive-pain complaints flipped to
   * confirmed_negative under sentiment pressure.
   */
  applyMemoryPatch(patch: MemoryPatch): void {
    const {
      utteranceId, turnId, speaker,
      facts, concerns, openLoops, decisionGeography,
      flow, evidence,
    } = patch;

    // Synthesize qualSignals from evidence. One qualSignal per evidence item.
    const synthesizedSignals = (evidence ?? []).flatMap((ev) => {
      const bant = AXIS_KEY_TO_BANT[ev.axis];
      const meddic = AXIS_KEY_TO_MEDDIC[ev.axis];
      if (!bant || !meddic) return [];
      return [{
        op: 'append' as const,
        direction: ev.direction,
        meddic,
        bantBucket: bant,
        content: ev.verbatim,
      }];
    });

    // Apply structured fields via the legacy ExtractorPatch path. Synthesized
    // qualSignals flow through here so downstream scorecard/suggester see them
    // identically to the old direct-emission path.
    this.applyPatchInternal({
      utteranceId,
      facts: facts ?? undefined,
      concerns: concerns ?? undefined,
      openLoops: openLoops ?? undefined,
      qualSignals: synthesizedSignals.length > 0 ? synthesizedSignals : undefined,
      decisionGeography: decisionGeography ?? undefined,
    });

    // Append flow entry
    if (flow) {
      const entry: FlowEntry = {
        turnId,
        speaker,
        tag: flow.tag,
        content: flow.content,
        utteranceIds: [utteranceId],
      };
      this.memory.flow.push(entry);
      if (flow.tag === 'R-Q') this.noteRepQuestion();
      if (flow.tag === 'R-NS') this.noteNextStepProposal();
    }

    // Synthesize verbatim anchors from specificity='specific' evidence.
    // Anchors stay sparse because 'mention'-strength evidence doesn't qualify.
    for (const ev of evidence ?? []) {
      if (ev.specificity !== 'specific') continue;
      const anchorAxis = AXIS_KEY_TO_ANCHOR[ev.axis];
      if (!anchorAxis) continue;
      const a: VerbatimAnchor = {
        turnId,
        axis: anchorAxis,
        verbatim: ev.verbatim,
        utteranceIds: [utteranceId],
      };
      this.memory.verbatimAnchors.push(a);
    }

    // bantRender + relevantFacts are owned by the panel agent. If a legacy
    // patch happens to include them (older benches/tests) ignore them here —
    // applyPanelPatch is the only writer for those fields now.

    this.cachedSnapshot = null;
    this.recomputeScorecard();
    this.notify(utteranceId);
  }

  /**
   * Apply the panel agent's output. The panel agent owns bantRender and
   * relevantFacts wholesale — both fields are rewritten as a complete unit
   * each call (the panel agent re-ranks relevantFacts from scratch rather
   * than appending). Returns true if anything actually changed, so callers
   * can skip emitting redundant SSE deltas.
   */
  applyPanelPatch(patch: PanelPatch, turnId: string): boolean {
    let changed = false;

    for (const axis of ['need', 'budget', 'authority', 'timeline'] as const) {
      const next = patch.bantRender[axis];
      const prev = this.memory.bantRender[axis];
      if (!prev || prev.headline !== next.headline || prev.detail !== next.detail) {
        this.memory.bantRender[axis] = next;
        changed = true;
      }
    }

    const nextFacts: RelevantFact[] = patch.relevantFacts.map((f) => ({
      id: nanoid(),
      turnId,
      category: f.category,
      text: f.text,
    }));
    const prevKey = this.memory.relevantFacts.map((f) => `${f.category}|${f.text}`).join('§');
    const nextKey = nextFacts.map((f) => `${f.category}|${f.text}`).join('§');
    if (prevKey !== nextKey) {
      this.memory.relevantFacts = nextFacts;
      changed = true;
    }

    if (changed) {
      this.cachedSnapshot = null;
      this.notify('panel');
    }
    return changed;
  }

  /**
   * Internal: apply structured fields without scorecard recompute or notify.
   * Used by both applyPatch and applyMemoryPatch.
   */
  private applyPatchInternal(patch: ExtractorPatch): void {
    const now = Date.now();

    if (patch.facts) {
      for (const op of patch.facts) {
        const existing = this.factsByKey.get(op.key);
        if (existing) {
          existing.revisions.push({
            previousContent: existing.content,
            overwrittenAt: now,
            utteranceIds: existing.utteranceIds,
          });
          existing.content = op.content;
          existing.confidence = op.confidence;
          existing.utteranceIds = [patch.utteranceId];
          existing.extractedAt = now;
        } else {
          const fact: Fact = {
            id: nanoid(),
            key: op.key,
            category: op.category,
            content: op.content,
            utteranceIds: [patch.utteranceId],
            confidence: op.confidence,
            extractedAt: now,
            revisions: [],
          };
          this.memory.facts.push(fact);
          this.factsByKey.set(fact.key, fact);
        }
      }
    }

    if (patch.concerns) {
      for (const op of patch.concerns) {
        if (op.op === 'resolve') {
          // V1: mark existing concern (matched by topic) as addressed.
          const existing = this.concernsByTopic.get(op.topic);
          if (existing) {
            existing.addressed = true;
            existing.utteranceIds.push(patch.utteranceId);
          }
        } else if (op.op === 'upsert') {
          const existing = this.concernsByTopic.get(op.topic);
          if (existing) {
            const severityOrder = { mentioned: 0, pressed: 1, blocking: 2 };
            if (severityOrder[op.severity] > severityOrder[existing.severity]) {
              existing.severity = op.severity;
              existing.verbatim = op.verbatim;
            }
            existing.utteranceIds.push(patch.utteranceId);
          } else {
            const concern: Concern = {
              id: nanoid(),
              topic: op.topic,
              verbatim: op.verbatim,
              severity: op.severity,
              addressed: false,
              utteranceIds: [patch.utteranceId],
            };
            this.memory.concerns.push(concern);
            this.concernsByTopic.set(concern.topic, concern);
          }
        } else {
          this.memory.concerns.push({
            id: nanoid(),
            topic: op.topic,
            verbatim: op.verbatim,
            severity: op.severity,
            addressed: false,
            utteranceIds: [patch.utteranceId],
          });
        }
      }
    }

    if (patch.openLoops) {
      for (const op of patch.openLoops) {
        if (op.op === 'close') {
          const existing = this.openLoopsByDesc.get(op.description);
          if (existing) {
            existing.status = 'addressed';
            this.openLoopsByDesc.delete(op.description);
          }
        } else {
          const loop: OpenLoop = {
            id: nanoid(),
            description: op.description,
            owner: op.owner,
            status: 'open',
          };
          this.memory.openLoops.push(loop);
          this.openLoopsByDesc.set(loop.description, loop);
        }
      }
    }

    if (patch.qualSignals) {
      for (const op of patch.qualSignals) {
        this.memory.qualSignals.push({
          id: nanoid(),
          direction: op.direction,
          meddic: op.meddic,
          bantBucket: op.bantBucket,
          content: op.content,
          utteranceIds: [patch.utteranceId],
        });
      }
    }

    if (patch.decisionGeography) {
      for (const op of patch.decisionGeography) {
        const existing = this.decisionByName.get(op.name);
        if (existing) {
          existing.role = op.role;
          existing.sentiment = op.sentiment;
          existing.utteranceIds.push(patch.utteranceId);
        } else {
          const actor: DecisionActor = {
            name: op.name,
            role: op.role,
            sentiment: op.sentiment,
            utteranceIds: [patch.utteranceId],
          };
          this.memory.decisionGeography.push(actor);
          this.decisionByName.set(actor.name, actor);
        }
      }
    }
  }

  private recomputeScorecard() {
    const callMinute = Math.max(0, Math.floor((Date.now() - this.stats.callStartedAt) / 60_000));
    this.memory.scorecard = computeScorecard(this.memory, {
      ...this.stats,
      callMinute,
    });
  }
}
