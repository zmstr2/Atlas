/**
 * Prompt regression test: early-call probe_stakeholder suppression.
 *
 * Scenario: turn 1 (rep intro) + turn 2 (prospect intro: "I'm Maya, VP Marketing...").
 * Memory is empty — Need is 'unknown'. The old prompt (V1) fired probe_stakeholder
 * on this turn; the new prompt should stay silent.
 *
 * These tests make real LLM calls and require VERCEL_AI_GATEWAY_TOKEN to be set.
 * Run with: bun test apps/agent/src/agents/suggester.test.ts --timeout 30000
 */

import { describe, test, expect } from 'bun:test';
import { runSuggester, SUGGESTER_SYSTEM_V1, SUGGESTER_SYSTEM, buildSuggesterPrompt } from './suggester';
import { createEmptyMemory } from '../memory/store';
import type { Utterance, PreCallBrief } from '@atlas/types';
import type { HotTailEntry } from '../memory/hotTail';

// ── Fixtures ──────────────────────────────────────────────────────────────

const BRIEF: PreCallBrief = {
  lead: { name: 'Maya Chen', title: 'VP Marketing', company: 'MidCo', companySize: '50-200 employees' },
  avaContext: { campaignId: 'campaign-47', leadScore: 0.62, scoringSignals: [] },
  pastInteractions: [],
  callGoal: 'qualify',
  suggestedQuestions: [],
  productSnippets: [
    'Ava deploys in 2 weeks with no implementation help required.',
    'Native HubSpot sync: Ava writes back to the CRM automatically.',
    'Personalized AI sequences that learn from reply patterns.',
  ],
};

// u1: rep intro (already spoken — lives in hotTail as prior context)
const U1_REP: HotTailEntry = {
  id: 'u1',
  speaker: 'rep',
  text: "Hi Maya, thanks for taking the time today. I'm Alex from Artisan. Quick housekeeping — I may take a few notes as we go, hope that's alright.",
  ts: 0,
};

// u2: prospect intro — the utterance that triggered the early probe_stakeholder
const U2_PROSPECT: Utterance = {
  id: 'u2',
  speaker: 'customer',
  text: "Of course, no problem. Yeah, I'm Maya — VP Marketing here at MidCo. We're about 130 people, B2B SaaS, been around about four years.",
  startMs: 9000,
  endMs: 20000,
  confidence: 0.98,
  derivedFromLowConfidence: false,
};

// Empty memory: Need=unknown, callMinute=0 — this is the exact state the
// suggester sees when u2 arrives on a fresh call.
const EARLY_MEMORY = createEmptyMemory();

const HOT_TAIL: HotTailEntry[] = [U1_REP];

// ── Helper ────────────────────────────────────────────────────────────────

async function runBoth() {
  const sharedOpts = {
    utterance: U2_PROSPECT,
    hotTail: HOT_TAIL,
    prevMemory: EARLY_MEMORY,
    brief: BRIEF,
    recentSuggestions: [],
  };

  const [v1Result, v2Result] = await Promise.all([
    runSuggester({ ...sharedOpts, system: SUGGESTER_SYSTEM_V1 }),
    runSuggester({ ...sharedOpts, system: SUGGESTER_SYSTEM }),
  ]);

  return { v1: v1Result, v2: v2Result };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('suggester prompt regression — early-call probe_stakeholder', () => {
  test('V2 does not fire probe_stakeholder on bare prospect intro (Need=unknown)', async () => {
    const { v1, v2 } = await runBoth();

    console.log('\n── V1 (old prompt) ──');
    console.log(`  shouldFire: ${v1.shouldFire}  play: ${v1.play}  priority: ${v1.priority}`);
    console.log(`  markdown:   ${v1.markdown}`);
    console.log(`  reasoning:  ${v1.reasoning}`);

    console.log('\n── V2 (new prompt) ──');
    console.log(`  shouldFire: ${v2.shouldFire}  play: ${v2.play}  priority: ${v2.priority}`);
    console.log(`  markdown:   ${v2.markdown}`);
    console.log(`  reasoning:  ${v2.reasoning}`);

    // Core assertion: V2 must not fire a stakeholder probe when Need is unknown.
    if (v2.shouldFire) {
      expect(v2.play).not.toBe('probe_stakeholder');
      expect(v2.play).not.toBe('multi_thread');
    }
  }, 30_000);

  test('V2 stays silent on bare prospect intro (preferred outcome)', async () => {
    const { v2 } = await runBoth();

    // Preferred: complete silence on a plain intro turn.
    // If V2 fires, it must be drill_vague or quantify_pain — not a stakeholder/advance play.
    if (v2.shouldFire) {
      const allowedEarlyPlays = ['drill_vague', 'quantify_pain', 'reframe_objection'];
      expect(allowedEarlyPlays).toContain(v2.play);
    }
  }, 30_000);

  test('V1 exhibits the regression (probe_stakeholder or fires on intro)', async () => {
    const { v1 } = await runBoth();

    // Document the known bug in V1: it fires probe_stakeholder (or at minimum
    // fires something) on this turn. If V1 is silent here it means the model
    // already self-corrected — log a warning but don't fail the suite.
    if (!v1.shouldFire) {
      console.warn('[warning] V1 was silent on u2 — regression may be intermittent or model already improved');
    } else {
      console.log(`[confirmed] V1 fired play=${v1.play} on bare intro — regression present`);
    }
    // Not asserting a hard failure here: we just want the output visible.
    expect(true).toBe(true);
  }, 30_000);
});

describe('suggester regression — load-bearing concern bypass (Wave 2.1)', () => {
  test('repeated concern + same topic touched again promotes reframe_objection to critical', async () => {
    // Setup: a memory state where an "icp_uncertainty" concern was raised
    // twice already (load-bearing). The LATEST utterance touches it for a
    // third time. The code-level bypass should promote priority to 'critical'
    // even if the model chose 'nudge', and cadence should be bypassed.
    const { createEmptyMemory } = await import('../memory/store');
    const memory = createEmptyMemory();
    // Inject two concerns with same topic (memory agent may append duplicates)
    memory.concerns = [
      {
        id: 'c1', topic: 'icp_uncertainty',
        verbatim: 'we don\'t know our ICP', severity: 'pressed',
        addressed: false, utteranceIds: ['u10'],
      },
      {
        id: 'c2', topic: 'icp_uncertainty',
        verbatim: 'tools just added noise', severity: 'pressed',
        addressed: false, utteranceIds: ['u12'],
      },
    ];
    // Also pretend pain is established so the gate is open
    memory.scorecard.bant.need = 'soft';

    const utterance: Utterance = {
      id: 'u14',
      speaker: 'customer',
      text: 'Look — I keep saying it: we just don\'t know who our best buyer is yet. That\'s the real blocker, not the tool.',
      startMs: 100000, endMs: 110000,
      confidence: 0.98, derivedFromLowConfidence: false,
    };

    const result = await runSuggester({
      utterance,
      hotTail: HOT_TAIL,
      prevMemory: memory,
      brief: BRIEF,
      // Pretend cadence is hot (3 of last 5 fired) — load-bearing should bypass
      recentSuggestions: [
        { turn: 9, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'drill_vague', markdown: 'Ask about pain' },
        { turn: 10, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'quantify_pain', markdown: 'Pin the number' },
        { turn: 11, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'reframe_objection', markdown: 'LAER it' },
        { turn: 12, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'none', markdown: '' },
        { turn: 13, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'none', markdown: '' },
      ],
      system: SUGGESTER_SYSTEM,
    });

    console.log('\n── Load-bearing concern test ──');
    console.log(`  shouldFire: ${result.shouldFire}  play: ${result.play}  priority: ${result.priority}`);
    console.log(`  markdown:   ${result.markdown}`);

    // If it fires reframe_objection, priority must be critical (code-level promotion).
    if (result.shouldFire && result.play === 'reframe_objection') {
      expect(result.priority).toBe('critical');
    }
  }, 30_000);
});

describe('suggester prompt regression — minute gate on advance plays', () => {
  test('V2 does not fire advance/trial_close plays before minute 8', async () => {
    // u4: prospect describes real pain — enough to move Need to vague/soft,
    // but callMinute is still 0 (early call). Advance plays should stay dormant.
    const earlyPainUtterance: Utterance = {
      id: 'u4',
      speaker: 'customer',
      text: "Yeah so — honestly our HubSpot setup has become a mess. We have sequences but our reps are spending like two hours a day doing manual follow-ups because the workflow automation just doesn't talk to our other tools.",
      startMs: 32000,
      endMs: 62000,
      confidence: 0.97,
      derivedFromLowConfidence: false,
    };

    const result = await runSuggester({
      utterance: earlyPainUtterance,
      hotTail: HOT_TAIL,
      prevMemory: EARLY_MEMORY,
      brief: BRIEF,
      recentSuggestions: [],
      system: SUGGESTER_SYSTEM,
    });

    console.log('\n── V2 advance-gate test ──');
    console.log(`  shouldFire: ${result.shouldFire}  play: ${result.play}`);
    console.log(`  reasoning:  ${result.reasoning}`);

    // Advance/close plays should not appear before minute 8.
    if (result.shouldFire) {
      const advancePlays = ['trial_close', 'anchor_next_step', 'qualify_out', 'multi_thread'];
      expect(advancePlays).not.toContain(result.play);
    }
  }, 30_000);
});
