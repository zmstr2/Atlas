'use client';

import { useState } from 'react';
import { CallSidebar } from '@/components/voice/CallSidebar';
import { MemoryPanel } from '@/components/MemoryPanel';
import type { CallFactsUI, MeetingMemory } from '@atlas/types';

// ─── Mock data ────────────────────────────────────────────────────────────────

const EMPTY_AXIS = { state: 'unknown' as const, headline: null, detail: null, anchorTurnId: null };

const MOCK_FACTS_PARTIAL: CallFactsUI = {
  bant: {
    need: { state: 'confirmed', headline: 'Newer campus must self-sustain', detail: 'Keep people from falling through the cracks', anchorTurnId: null },
    budget: EMPTY_AXIS,
    authority: { state: 'soft', headline: 'Lead pastor at Cornerstone', detail: null, anchorTurnId: null },
    timeline: EMPTY_AXIS,
  },
  meddic: {
    metrics: EMPTY_AXIS, economicBuyer: EMPTY_AXIS, decisionCriteria: EMPTY_AXIS,
    decisionProcess: EMPTY_AXIS, identifyPain: EMPTY_AXIS, champion: EMPTY_AXIS,
  },
  stakeholders: [
    { name: 'Marcus Webb', role: 'Lead Pastor', sentiment: 'neutral', role_hint: 'economic_buyer_candidate', anchorTurnId: null },
    { name: 'David Kim', role: 'Associate Pastor', sentiment: 'positive', role_hint: 'champion_candidate', anchorTurnId: null },
  ],
  openLoops: [
    { id: 'l1', description: 'Send case study from Elevation Church implementation', owner: 'rep' },
    { id: 'l2', description: 'Confirm budget approval process timeline', owner: 'customer' },
  ],
  anchors: [],
  pushNext: null,
  disqualifiers: { hard: false, softCount: 0, soft: [] },
  stage: { callMinute: 12, talkRatio: { rep: 0.45, prospect: 0.55 }, turnsSinceLastRepQuestion: 2, turnsSinceLastNextStepProposal: 8 },
  relevantFacts: [
    { id: 'f1', text: 'Newer campus becoming self-sustaining', category: 'trigger' },
    { id: 'f2', text: 'Tightening path from first-time guest into community', category: 'process' },
    { id: 'f3', text: 'Cornerstone has two campuses', category: 'stack' },
    { id: 'f4', text: 'First-year retention is the stated pain', category: 'metric' },
  ],
};

const MOCK_FACTS_FULL: CallFactsUI = {
  ...MOCK_FACTS_PARTIAL,
  bant: {
    need: { state: 'confirmed', headline: 'Newer campus must self-sustain', detail: 'Keep people from falling through the cracks', anchorTurnId: null },
    budget: { state: 'soft', headline: '~$800/mo range mentioned', detail: 'Subject to elder board sign-off', anchorTurnId: null },
    authority: { state: 'confirmed', headline: 'Lead pastor at Cornerstone', detail: 'Elder board has final say on budget', anchorTurnId: null },
    timeline: { state: 'partial', headline: 'Wants something before fall semester', detail: 'Roughly 4 months', anchorTurnId: null },
  },
  relevantFacts: [
    ...MOCK_FACTS_PARTIAL.relevantFacts,
    { id: 'f5', text: 'Evaluating Planning Center as an alternative', category: 'competitor' },
    { id: 'f6', text: 'Committed to follow-up call next Tuesday', category: 'commitment' },
  ],
};

const MOCK_MEMORY_WITH_CONCERNS: MeetingMemory = {
  concerns: [
    { id: 'c1', topic: 'Data privacy for congregation', verbatim: "I just want to make sure we're not tracking people in a way that feels corporate", severity: 'pressed', addressed: false, utteranceIds: [] },
    { id: 'c2', topic: 'Staff adoption', verbatim: "My team isn't very tech-savvy", severity: 'mentioned', addressed: false, utteranceIds: [] },
  ],
  facts: [],
  qualSignals: [],
  silenceTopics: [],
  decisionActors: [],
  openLoops: [],
  flowEntries: [],
  verbatimAnchors: [],
  scorecard: null,
};

// ─── Scenario selector ────────────────────────────────────────────────────────

type Scenario = 'empty' | 'partial' | 'full' | 'error';

const SCENARIOS: { id: Scenario; label: string; description: string }[] = [
  { id: 'empty', label: 'Empty', description: 'Call just started — no signal yet' },
  { id: 'partial', label: 'Partial', description: 'Need + Authority confirmed, rest pending' },
  { id: 'full', label: 'Fully qualified', description: 'All 4 axes + concerns + loops' },
  { id: 'error', label: 'With error', description: 'Schema mismatch error in sidebar' },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MockSidebarPage() {
  const [scenario, setScenario] = useState<Scenario>('partial');
  const [muted, setMuted] = useState(false);

  const factsUI =
    scenario === 'empty' ? null
    : scenario === 'partial' ? MOCK_FACTS_PARTIAL
    : MOCK_FACTS_FULL;

  const memory =
    scenario === 'full' || scenario === 'error' ? MOCK_MEMORY_WITH_CONCERNS : null;

  const errors =
    scenario === 'error'
      ? ["LLM schema mismatch — play: Invalid enum value. Expected 'drill_vague' | 'quantify_pain' | 'probe_stakeholder' | 'reframe_objection' | 'surface_value_prop' | 'competitor_handle' | 'push_next_axis' | 'trial_close', received 'surface_status_quo_cost'"]
      : [];

  return (
    <div className="min-h-screen bg-[#FAFAF9] p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="text-xs font-semibold text-fg-muted uppercase tracking-widest mb-1">Mock UI</div>
        <h1 className="text-xl font-bold text-fg-primary">Sidebar preview</h1>
        <p className="text-sm text-fg-muted mt-1">Switch scenarios to see different populated states.</p>
      </div>

      {/* Scenario tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScenario(s.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition border ${
              scenario === s.id
                ? 'bg-fg-primary text-white border-fg-primary'
                : 'bg-white text-fg-secondary border-border hover:border-fg-muted'
            }`}
          >
            {s.label}
            <span className="ml-2 text-[11px] opacity-60 font-normal hidden sm:inline">
              {s.description}
            </span>
          </button>
        ))}
      </div>

      {/* Sidebar preview — same width + card as in CallStage */}
      <div className="flex gap-4 items-start max-w-[400px]">
        <div className="w-full rounded-2xl border border-[#E7E5E4] bg-white shadow-sm overflow-hidden flex flex-col">
          {/* CallSidebar */}
          <div className="shrink-0 border-b border-[#E7E5E4]">
            <CallSidebar
              remoteStream={null}
              displayName="Pastor Marcus Webb"
              subtitle="Lead Pastor, Cornerstone Church"
              color="#5B3FBE"
              muted={muted}
              onToggleMute={() => setMuted((v) => !v)}
              onHangup={() => alert('End call clicked')}
              phase="live"
              errors={errors}
            />
          </div>

          {/* MemoryPanel */}
          <div className="flex-1 min-h-0 max-h-[640px] overflow-hidden">
            <MemoryPanel
              memory={memory}
              factsUI={factsUI}
              className="w-full bg-white"
              redundantPhrases={['Pastor Marcus Webb', 'Lead Pastor, Cornerstone Church']}
            />
          </div>
        </div>
      </div>

      <p className="mt-4 text-xs text-fg-muted">
        Mute toggle is interactive. End call shows an alert. Memory updates live as you switch scenarios.
      </p>
    </div>
  );
}
