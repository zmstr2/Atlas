#!/usr/bin/env bun
/**
 * eval-conversation.ts
 *
 * End-to-end eval of the suggester against a synthetic ~10-min discovery
 * call with Sarah Park (Head of Growth, EarlyCo).
 *
 * Design: each utterance is fed through the real runSuggester (live LLM call
 * via OpenRouter). Memory state is manually advanced after each turn — this
 * eliminates extractor noise and gives us ground-truth BANT state so we can
 * specifically test how the suggester uses that state (e.g. discovery gate).
 *
 * Key scenarios tested:
 *  1.  Early authority mention before Need is established → SILENT (gate test)
 *  2.  Vague pain → drill_vague should fire
 *  3.  Rep drilling correctly → SILENT (no over-fire)
 *  4.  Approximate metric dropped → quantify_pain should fire
 *  5.  Rep skips metric, pivots → rep_skipped_drill (may be masked by cadence)
 *  6.  Q1 miss with concrete numbers → quantify_pain (consequence unexplored)
 *  7.  Rep feature dump right after hot prospect turn → rep_feature_dump (may be cadence-masked)
 *  8.  ICP objection raised → reframe_objection should fire
 *  9.  Rep defends objection, skips LAER → rep_defended_objection (may be cadence-masked)
 * 10.  Same ICP concern raised again → reframe_objection (load-bearing)
 * 11.  Champion behavior (offers to share with Tyler) → multi_thread should fire
 * 12.  New stakeholder named with role after pain established → probe_stakeholder
 * 13.  Vague "I'll send something" close → rep_no_next_step (may be cadence-masked)
 * 14.  Rep feature dump at call end (cadence clear) → rep_feature_dump should fire
 * 15.  Call end with no booked follow-up → anchor_next_step should fire
 *
 * Requires:
 *   OPENROUTER_API_KEY  — suggester routes direct to OpenRouter
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/eval-conversation.ts
 */

import { resolve } from 'node:path';
// Ensure workspace packages resolve correctly from scripts dir
process.chdir(resolve(import.meta.dir, '..'));

const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error('ERROR: OPENROUTER_API_KEY not set'); process.exit(1); }

import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { runSuggester, SUGGESTER_SYSTEM } from '../src/agents/suggester';
import type { RecentSuggestionEntry } from '../src/agents/suggester';
import type { PreCallBrief, Utterance, MemoryPatch, Suggestion } from '@atlas/types';

// ─── Brief ────────────────────────────────────────────────────────────────────
const BRIEF: PreCallBrief = {
  lead: { name: 'Sarah Park', title: 'Head of Growth', company: 'EarlyCo', companySize: '15-50 employees' },
  avaContext: {
    campaignId: 'campaign-47',
    leadScore: 0.58,
    scoringSignals: [
      { signal: 'Head of Growth title', weight: 0.30 },
      { signal: 'Recent Series A ($8M)', weight: 0.35 },
      { signal: 'B2B SaaS company', weight: 0.20 },
      { signal: 'Follows AI thought leaders on LinkedIn', weight: 0.15 },
    ],
  },
  pastInteractions: [
    { type: 'email', date: '2026-04-18', summary: 'Cold outbound re: AI-powered sequences. Sarah opened once.' },
  ],
  callGoal: 'qualify',
  suggestedQuestions: [
    "What's driving outbound for you right now — are reps running sequences manually or do you have tooling in place?",
    "Now that you've closed your Series A, is there budget allocated for sales infrastructure?",
    "What does your outbound team look like — how many reps are focused on this?",
  ],
  productSnippets: [
    "Ava scales outbound 3x without adding headcount — one AE's pipeline looks like three.",
    "AI personalization sequences trained on your best-performing emails from day one.",
    "For early-stage teams, we have a startup plan — lower seat cost, scales as you hire.",
    "Native HubSpot + Apollo sync: writes back to CRM automatically, no manual logging.",
    "Customers at your stage typically see 3x pipeline within 90 days of deployment.",
  ],
};

// ─── Conversation ─────────────────────────────────────────────────────────────
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };

const TRANSCRIPT: Utt[] = [
  // Phase 1: opener — Need unknown, Tyler dropped early
  {
    id: 'u01', speaker: 'rep',
    text: "Hey Sarah, thanks for jumping on — Alex from Artisan. How's your Tuesday going?",
    startMs: 0, endMs: 7000,
  },
  {
    id: 'u02', speaker: 'customer',
    text: "Pretty hectic but good! So I'm Sarah, Head of Growth at EarlyCo. We just closed our Series A about six weeks ago — really exciting time. My CEO Tyler basically handed this to me: figure out our outbound motion before we start scaling up the team.",
    startMs: 8000, endMs: 30000,
  },
  {
    id: 'u03', speaker: 'rep',
    text: "Congrats on the Series A — that's exciting. What does outbound look like day-to-day right now? Are you running sequences manually or is there tooling involved?",
    startMs: 31000, endMs: 47000,
  },
  // Phase 2: vague pain surfaces
  {
    id: 'u04', speaker: 'customer',
    text: "Pretty much all manual. We've got one SDR — Rachel — and she does everything by hand in Apollo. It kind of works but it's really messy and I keep worrying it's just not going to scale.",
    startMs: 48000, endMs: 72000,
  },
  {
    id: 'u05', speaker: 'rep',
    text: "When you say messy — is it the lead volume, the follow-up cadence, the personalization, or something else that's the real bottleneck?",
    startMs: 73000, endMs: 88000,
  },
  // Phase 3: approximate metric dropped
  {
    id: 'u06', speaker: 'customer',
    text: "Mostly follow-up honestly. Rachel probably spends something like three to four hours a day just tracking down leads that didn't respond. And we're definitely dropping some because she just can't keep up with the volume.",
    startMs: 89000, endMs: 118000,
  },
  // Phase 4: rep skips metric, pivots — bad move right after hot turn
  {
    id: 'u07', speaker: 'rep',
    text: "Yeah, three to four hours a day is a lot. So what made you take this call now — was there a specific trigger that made the timing feel right?",
    startMs: 119000, endMs: 134000,
  },
  // Phase 5: Q1 miss with specifics
  {
    id: 'u08', speaker: 'customer',
    text: "Tyler pushed for it after we missed our Q1 targets pretty badly. We were supposed to close fifteen new accounts and we closed eight. He wants outbound volume higher before we ramp hiring in Q2.",
    startMs: 135000, endMs: 168000,
  },
  // Phase 6: rep feature dump right after hot prospect turn
  {
    id: 'u09', speaker: 'rep',
    text: "Got it. Well, Ava is really purpose-built for this — we have AI-personalized sequences, automatic follow-up so Rachel doesn't have to do any of that manual work, native Apollo and HubSpot integrations, and most teams your size see triple the pipeline in the first ninety days.",
    startMs: 169000, endMs: 198000,
  },
  // Phase 7: ICP objection
  {
    id: 'u10', speaker: 'customer',
    text: "I've heard the AI-sequences pitch a lot lately. Our problem is we don't actually know our ICP well enough to be running personalized outbound at scale. We're still figuring out who our best buyer is.",
    startMs: 199000, endMs: 232000,
  },
  // Phase 8: rep defends without LAER
  {
    id: 'u11', speaker: 'rep',
    text: "That's actually a perfect use case for Ava — the AI learns what messages convert and what don't, so it literally helps you find your ICP rather than assuming you already know it.",
    startMs: 233000, endMs: 254000,
  },
  // Phase 9: ICP concern raised AGAIN (load-bearing) + budget objection + Tyler as econ buyer
  {
    id: 'u12', speaker: 'customer',
    text: "I hear you but I'm skeptical — we've tried tools before and they just added noise, didn't clarify anything. And honestly budget is the bigger blocker. Tyler has said nothing new until we've signed our first twenty customers organically.",
    startMs: 255000, endMs: 298000,
  },
  // Phase 10: rep caves, vague defer
  {
    id: 'u13', speaker: 'rep',
    text: "That makes complete sense. I'll circle back when you're closer to that twenty-customer milestone — probably Q3 territory. Sound good?",
    startMs: 299000, endMs: 314000,
  },
  // Phase 11: champion behavior — Sarah offers to share with Tyler
  {
    id: 'u14', speaker: 'customer',
    text: "Yeah, probably. Although — if you had something concrete I could show Tyler, like a case study from a team our size at Series A, I think I could get him to look at it earlier. That might move things up.",
    startMs: 315000, endMs: 347000,
  },
  // Phase 12: rep gives vague "I'll send something" — bad close
  {
    id: 'u15', speaker: 'rep',
    text: "Yeah absolutely, I'll put something together and send it over. Really great talking to you!",
    startMs: 348000, endMs: 360000,
  },
  // Phase 13: Rachel named as day-to-day owner with role — fresh info, late in call
  {
    id: 'u16', speaker: 'customer',
    text: "Sounds good. Oh, and just so you know — Rachel would actually be managing whatever tool we end up with day-to-day, so she'd need to be comfortable with it too.",
    startMs: 361000, endMs: 383000,
  },
  // Phase 14: rep feature dump at close — cadence should be clear by now
  {
    id: 'u17', speaker: 'rep',
    text: "Totally — we have a great onboarding program, Rachel would get her own dedicated success manager, plus there's an analytics dashboard, a conversation intelligence layer, and an SDR performance benchmarking module to help her get up to speed fast.",
    startMs: 384000, endMs: 408000,
  },
  {
    id: 'u18', speaker: 'customer',
    text: "Okay, I'll look for your email.",
    startMs: 409000, endMs: 415000,
  },
  // Phase 15: rep soft-close with no call booked — anchor_next_step territory
  {
    id: 'u19', speaker: 'rep',
    text: "Will do — I'll send over the case study and our startup pricing page. Take care!",
    startMs: 416000, endMs: 425000,
  },
  {
    id: 'u20', speaker: 'customer',
    text: "Sounds good, bye!",
    startMs: 426000, endMs: 430000,
  },
];

// ─── Gold standards ────────────────────────────────────────────────────────────
// Accounts for the hard cadence rule: "if the immediately prior turn fired,
// default silent." Turns marked SILENT_CADENCE are ones where the ideal play
// WOULD fire in a perfect world but cadence correctly suppresses it.

type GoldStandard =
  | { fire: false; rationale: string; cadenceMask?: string }
  | { fire: true; play: string; axis?: string; rationale: string; cadenceMask?: string };

const GOLD: Record<string, GoldStandard> = {
  // t1 — REP: opener, zero axis signal
  u01: { fire: false, rationale: 'Greeting. No axis signal present.' },

  // t2 — PROSPECT: Tyler named as CEO, but Need=unknown. Gate test.
  u02: {
    fire: false,
    rationale: 'Need=unknown at this point. Discovery gate suppresses probe_stakeholder / multi_thread. Tyler mention should not trigger authority plays until pain is established.',
  },

  // t3 — REP: good open-ended discovery question
  u03: { fire: false, rationale: 'Solid discovery question. Rep doing the right thing — no prompt needed.' },

  // t4 — PROSPECT: "messy" and "won't scale" — vague pain, no numbers
  u04: {
    fire: true,
    play: 'drill_vague',
    axis: 'need',
    rationale: '"Messy" and "won\'t scale" are qualitative pain descriptors with no number, owner, or workflow behind them. Rep should drill what specifically breaks down before moving on.',
  },

  // t5 — REP: drills correctly into "what part is messy" — also suppressed by cadence (t4 fired)
  u05: {
    fire: false,
    rationale: 'Rep is drilling the vague pain exactly correctly. Silent on behavior grounds alone. Also suppressed by cadence (t4 fired).',
  },

  // t6 — PROSPECT: "three to four hours a day" — approximate metric, needs pinning
  // Prospect stream: [t2:s, t4:F] → 1 fired → cadence open
  u06: {
    fire: true,
    play: 'quantify_pain',
    axis: 'metric',
    rationale: '"Three to four hours a day" is an approximate metric. The rep should pin the exact figure and translate it to weekly cost / pipeline impact before moving on.',
  },

  // t7 — REP: skips metric, pivots to trigger question — rep mistake
  // Rep stream: [t1:s, t3:s, t5:s] → 0 fired → cadence open. With split streams,
  // rep-watcher fires independently from prospect-suggester cadence.
  u07: {
    fire: true,
    play: 'rep_skipped_drill',
    axis: 'metric',
    rationale: 'Rep received a metric (3-4 hrs/day) and pivoted to a new question without quantifying it or translating to cost. Should drill the cost of those hours.',
  },

  // t8 — PROSPECT: Q1 miss (15 → 8) — concrete numbers but consequence not explored
  // Prospect stream: [t2:s, t4:F, t6:F] → 2/5 fired
  u08: {
    fire: true,
    play: 'quantify_pain',
    axis: 'need',
    rationale: '"Fifteen expected, closed eight" — specific miss stated but cost of that miss is unexplored. Quantify: what does 7 missed deals represent in ARR / runway impact?',
  },

  // t9 — REP: feature dump (4 features, none tied to pain)
  // Rep stream: [t1:s, t3:s, t5:s, t7:F] → 1/5 fired → cadence open
  u09: {
    fire: true,
    play: 'rep_feature_dump',
    axis: 'need',
    rationale: 'Rep listed AI sequences, auto follow-up, Apollo+HubSpot integration, 3x pipeline (4 claims) without tying any to Rachel\'s manual follow-up pain or the Q1 miss. Tether to a named pain or drop the pitch.',
  },

  // t10 — PROSPECT: ICP objection
  // Prospect stream: [t2:s, t4:F, t6:F, t8:F] → 3/5 fired → CADENCE-MASKED
  u10: {
    fire: false,
    rationale: 'Cadence: prospect stream has 3 of last 5 fired (t4, t6, t8). Hard cadence rule suppresses unless critical anchor violation.',
    cadenceMask: 'reframe_objection — explicit ICP objection. Should fire in a world without cadence suppression OR if Wave 2 makes load-bearing concerns critical.',
  },

  // t11 — REP: defends objection, no acknowledge/explore/confirm — rep mistake
  // Rep stream: [t3:s, t5:s, t7:F, t9:F] → 2/5 fired → cadence open
  u11: {
    fire: true,
    play: 'rep_defended_objection',
    axis: 'need',
    rationale: 'Rep went straight to "that\'s actually a perfect use case" with no Acknowledge, no Assess, no Confirm step. Skipped LAER entirely.',
  },

  // t12 — PROSPECT: ICP concern raised AGAIN (load-bearing) + budget objection + Tyler
  // Prospect stream: [t4:F, t6:F, t8:F, t10:s] → 3/5 fired → CADENCE-MASKED (Wave 1)
  // Will be fixed in Wave 2 (load-bearing → critical → cadence bypass)
  u12: {
    fire: false,
    rationale: 'Cadence: prospect stream still 3 of last 5 fired (t4, t6, t8). Wave 1 cadence rule suppresses.',
    cadenceMask: 'reframe_objection (load-bearing, critical) — ICP concern raised second time with past-failure evidence. Wave 2 will promote this to priority=critical to bypass cadence.',
  },

  // t13 — REP: vague defer "I\'ll circle back in Q3" — rep mistake
  // Rep stream: [t5:s, t7:F, t9:F, t11:F] → 3/5 fired → CADENCE-MASKED
  u13: {
    fire: false,
    rationale: 'Cadence: rep stream has 3 of last 5 fired (t7, t9, t11). Hard cadence rule suppresses.',
    cadenceMask: 'rep_no_next_step — "circle back in Q3" is a non-commitment. Cadence-masked because the rep_watcher caught 3 prior mistakes.',
  },

  // t14 — PROSPECT: champion behavior — offers to show Tyler materials
  // Prospect stream: [t6:F, t8:F, t10:s, t12:s] → 2/5 fired → cadence open
  u14: {
    fire: true,
    play: 'multi_thread',
    axis: 'champion',
    rationale: 'Sarah is offering to champion internally — "I could get him to look at it earlier." Need is established. Fresh champion behavior that should be anchored.',
  },

  // t15 — REP: vague "I\'ll put something together"
  // Rep stream: [t7:F, t9:F, t11:F, t13:s] → 3/5 fired → CADENCE-MASKED
  u15: {
    fire: false,
    rationale: 'Cadence: rep stream still 3 of last 5 fired (t7, t9, t11). Hard rule suppresses.',
    cadenceMask: 'rep_no_next_step — "I\'ll put something together" gives no timeline. Cadence-masked.',
  },

  // t16 — PROSPECT: Rachel named with concrete role (day-to-day tool owner)
  // Prospect stream: [t8:F, t10:s, t12:s, t14:F] → 2/5 fired → cadence open
  u16: {
    fire: true,
    play: 'probe_stakeholder',
    axis: 'stakeholder',
    rationale: 'Rachel named with a specific role (day-to-day manager of tool). Fresh information. Need is confirmed → discovery gate open for stakeholder probes.',
  },

  // t17 — REP: feature dump at close
  // Rep stream: [t9:F, t11:F, t13:s, t15:s] → 2/5 fired → cadence open
  u17: {
    fire: true,
    play: 'rep_feature_dump',
    axis: 'need',
    rationale: 'Five untethered features (onboarding, success manager, analytics, conv intelligence, benchmarking) none tied to Rachel\'s or Sarah\'s stated concerns. Third feature dump of the call.',
  },

  // t18 — PROSPECT: soft close/dismissal
  u18: {
    fire: false,
    rationale: '"I\'ll look for your email" is a soft acknowledgment. Nothing concrete to anchor.',
  },

  // t19 — REP: ends call with email-only close — anchor_next_step territory
  u19: {
    fire: true,
    play: 'anchor_next_step',
    axis: 'timeline',
    rationale: 'Call ends with "I\'ll send over X" and zero booked follow-up. No meeting scheduled, no timeline pinned. A champion (Sarah) offered to share with Tyler — that action needs a concrete date and ask. Last 5 = 2/5 fired (t14, t16). Prior turn t18 silent.',
  },

  // t20 — PROSPECT: closing pleasantry
  u20: { fire: false, rationale: 'Closing pleasantry. Nothing to anchor.' },
};

// ─── Memory patch helpers ─────────────────────────────────────────────────────
// Manually-crafted patches representing what the memory agent would extract.
// This isolates suggester quality from extractor quality and gives us
// ground-truth BANT state to test the discovery ladder gate precisely.

function makePatch(
  utteranceId: string,
  turnId: string,
  speaker: 'rep' | 'customer',
  opts: {
    flow?: { tag: string; content: string };
    evidence?: Array<{ axis: string; direction: 'positive' | 'negative'; verbatim: string; specificity: 'mention' | 'specific' }>;
    concerns?: Array<{ op: 'upsert' | 'append' | 'resolve'; topic: string; verbatim: string; severity: 'mentioned' | 'pressed' | 'blocking' }>;
    decisionGeography?: Array<{ op: 'upsert'; name: string; role: string; sentiment: 'positive' | 'neutral' | 'negative' | 'unknown' }>;
    facts?: Array<{ op: 'upsert'; key: string; category: string; content: string; confidence: number }>;
    openLoops?: Array<{ op: 'append' | 'close'; description: string; owner: 'rep' | 'customer'; closeDescription: string | null }>;
  }
): MemoryPatch {
  return {
    utteranceId,
    turnId,
    speaker,
    flow: opts.flow ? { tag: opts.flow.tag as any, content: opts.flow.content } : null,
    evidence: (opts.evidence ?? []).map((e) => ({
      axis: e.axis as any,
      direction: e.direction,
      verbatim: e.verbatim,
      specificity: e.specificity,
    })),
    concerns: opts.concerns?.map((c) => ({
      op: c.op,
      topic: c.topic,
      verbatim: c.verbatim,
      severity: c.severity,
    })) ?? null,
    decisionGeography: opts.decisionGeography?.map((d) => ({
      op: d.op,
      name: d.name,
      role: d.role,
      sentiment: d.sentiment,
    })) ?? null,
    facts: opts.facts?.map((f) => ({
      op: f.op,
      key: f.key,
      category: f.category as any,
      content: f.content,
      confidence: f.confidence,
    })) ?? null,
    openLoops: opts.openLoops?.map((l) => ({
      op: l.op,
      description: l.description,
      owner: l.owner,
      closeDescription: l.closeDescription,
    })) ?? null,
    bantRender: null,
    relevantFacts: null,
  };
}

// Patches applied AFTER each turn (simulating memory agent extraction).
// Keys match utterance IDs.
const MEMORY_PATCHES: Record<string, MemoryPatch> = {
  u01: makePatch('u01', 't001', 'rep', {
    flow: { tag: 'OTHER', content: 'opening rapport' },
  }),

  u02: makePatch('u02', 't002', 'customer', {
    flow: { tag: 'OTHER', content: 'intro: EarlyCo, Series A, Tyler handed outbound brief' },
    decisionGeography: [
      { op: 'upsert', name: 'Tyler', role: 'CEO', sentiment: 'unknown' },
    ],
    // NOTE: No need/pain evidence yet — Tyler is named but Need stays unknown.
    // This is intentional: the gate test at u02 depends on Need=unknown.
  }),

  u03: makePatch('u03', 't003', 'rep', {
    flow: { tag: 'R-Q', content: 'asked about outbound setup — manual vs tooling' },
  }),

  u04: makePatch('u04', 't004', 'customer', {
    flow: { tag: 'P-PAIN', content: 'all-manual Apollo; SDR overloaded; "messy, won\'t scale"' },
    evidence: [
      { axis: 'identifyPain', direction: 'positive', verbatim: 'messy and I keep worrying it\'s just not going to scale', specificity: 'mention' },
    ],
    // After this patch: Need = soft (one positive identify_pain signal at mention level)
  }),

  u05: makePatch('u05', 't005', 'rep', {
    flow: { tag: 'R-Q', content: 'drilled: what makes it messy — volume, cadence, personalization?' },
  }),

  u06: makePatch('u06', 't006', 'customer', {
    flow: { tag: 'P-METRIC', content: 'Rachel: ~3-4 hrs/day manual follow-up; dropping leads' },
    evidence: [
      { axis: 'identifyPain', direction: 'positive', verbatim: 'three to four hours a day just tracking down leads', specificity: 'specific' },
      { axis: 'metrics', direction: 'positive', verbatim: 'three to four hours a day', specificity: 'specific' },
    ],
    // After: Need = soft (multiple positive signals, specific), metrics = soft
  }),

  u07: makePatch('u07', 't007', 'rep', {
    flow: { tag: 'R-Q', content: 'asked about trigger for this call' },
    // Rep pivoted off the metric — mark as a question but not a mistake tag
    // (the real memory agent might tag R-MISTAKE here; we leave it as R-Q to
    //  test whether the suggester catches the pivot on its own)
  }),

  u08: makePatch('u08', 't008', 'customer', {
    flow: { tag: 'P-METRIC', content: 'Q1 miss: 15 target, 8 closed; Tyler driving urgency for Q2' },
    evidence: [
      { axis: 'identifyPain', direction: 'positive', verbatim: 'fifteen new accounts expected, closed eight', specificity: 'specific' },
      { axis: 'timeline', direction: 'positive', verbatim: 'wants outbound volume higher before Q2 hiring', specificity: 'mention' },
    ],
    facts: [
      { op: 'upsert', key: 'pain.consequence_q1_miss', category: 'other', content: 'Q1 target: 15 accounts, actual: 8. CEO-driven urgency to fix outbound before Q2 scale.', confidence: 0.92 },
    ],
    // After: Need = confirmed (pain.consequence_* fact → confirmed in scorecard)
  }),

  u09: makePatch('u09', 't009', 'rep', {
    flow: { tag: 'R-VP', content: 'feature dump: AI sequences, auto follow-up, Apollo+HubSpot, 3x pipeline' },
    // In a real call the memory agent would tag this R-MISTAKE. Leaving as R-VP
    // so the suggester must evaluate behavior, not just read the flow tag.
  }),

  u10: makePatch('u10', 't010', 'customer', {
    flow: { tag: 'P-OBJ', content: 'ICP objection: don\'t know buyer well enough for personalization' },
    concerns: [
      { op: 'append', topic: 'icp_uncertainty', verbatim: 'don\'t actually know our ICP well enough to be running personalized outbound', severity: 'pressed' },
    ],
  }),

  u11: makePatch('u11', 't011', 'rep', {
    flow: { tag: 'R-OBJ-RESP', content: 'defended ICP objection: Ava helps find ICP' },
    // Left as R-OBJ-RESP (not R-MISTAKE) to test whether suggester catches
    // the missed LAER step without the flow tag helping it.
  }),

  u12: makePatch('u12', 't012', 'customer', {
    flow: { tag: 'P-OBJ', content: 'ICP concern repeated + past failure; budget blocked by Tyler: no tools until 20 customers' },
    concerns: [
      { op: 'append', topic: 'icp_uncertainty', verbatim: 'tried tools before and they just added noise', severity: 'pressed' },
      { op: 'append', topic: 'budget_blocked_by_ceo', verbatim: 'Tyler has said nothing new until we\'ve signed first twenty customers', severity: 'blocking' },
    ],
    evidence: [
      { axis: 'budget', direction: 'negative', verbatim: 'nothing new until we\'ve signed first twenty customers', specificity: 'specific' },
      { axis: 'economicBuyer', direction: 'positive', verbatim: 'Tyler has said nothing new', specificity: 'mention' },
    ],
    // After: budget → confirmed_negative (explicit negative direction)
    //        economicBuyer → partial (exec, unknown sentiment)
  }),

  u13: makePatch('u13', 't013', 'rep', {
    flow: { tag: 'R-NS', content: 'vague defer: circle back at Q3 / 20-customer milestone' },
    // R-NS because rep is proposing a next step — but it's vague. The suggester
    // should catch the lack of specificity if cadence allows.
  }),

  u14: makePatch('u14', 't014', 'customer', {
    flow: { tag: 'P-BUY', content: 'champion behavior: offers to show Tyler a case study to pull timeline forward' },
    evidence: [
      { axis: 'champion', direction: 'positive', verbatim: 'I could get him to look at it earlier', specificity: 'mention' },
    ],
    // After: champion = soft (positive signal, mention level)
  }),

  u15: makePatch('u15', 't015', 'rep', {
    flow: { tag: 'R-NS', content: 'vague send: I\'ll put something together and send it' },
  }),

  u16: makePatch('u16', 't016', 'customer', {
    flow: { tag: 'P-STAKE', content: 'Rachel named as day-to-day tool manager — fresh stakeholder info' },
    decisionGeography: [
      { op: 'upsert', name: 'Rachel', role: 'SDR / day-to-day tool owner', sentiment: 'unknown' },
    ],
    // After: Rachel in decision geography, fresh in latest utterance
  }),

  u17: makePatch('u17', 't017', 'rep', {
    flow: { tag: 'R-VP', content: 'feature dump at close: onboarding, success manager, analytics, conv intelligence, benchmarking' },
  }),

  u18: makePatch('u18', 't018', 'customer', {
    flow: { tag: 'OTHER', content: 'soft close: "I\'ll look for your email"' },
  }),

  u19: makePatch('u19', 't019', 'rep', {
    flow: { tag: 'R-NS', content: 'sends case study + startup pricing page — no call booked' },
  }),

  u20: makePatch('u20', 't020', 'customer', {
    flow: { tag: 'OTHER', content: 'closing pleasantry' },
  }),
};

// ─── Scoring helpers ──────────────────────────────────────────────────────────
type TurnResult = {
  id: string;
  speaker: 'rep' | 'customer';
  text: string;
  gold: GoldStandard;
  suggestion: Suggestion;
  latencyMs: number;
  score: number;        // 0-5
  verdict: string;
  notes: string;
};

function scoreTurn(gold: GoldStandard, s: Suggestion): { score: number; verdict: string; notes: string } {
  const fired = s.shouldFire;

  if (gold.fire === false) {
    if (!fired) return { score: 5, verdict: '✓ CORRECT (silent)', notes: '' };
    return {
      score: 1,
      verdict: '✗ OVER-FIRED',
      notes: `Fired [${s.play}]: "${s.markdown}"`,
    };
  }

  // Gold = fire
  if (!fired) {
    if (gold.cadenceMask) {
      return {
        score: 3,
        verdict: '~ CADENCE-SUPPRESSED (expected)',
        notes: `Expected play: ${gold.play}. Correctly suppressed by cadence rule.`,
      };
    }
    return { score: 1, verdict: '✗ MISSED (should fire)', notes: `Expected play: ${gold.play}` };
  }

  const playMatch = s.play === gold.play;
  const mdWords = s.markdown.split(/\s+/).filter(Boolean).length;
  const mdActionVerb = /^[A-Z]/.test(s.markdown); // roughly checks action-verb start after capitalisation

  const goldTokens = new Set(
    gold.play.replace(/_/g, ' ').split(/\s+/).concat(
      (gold.rationale).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    ).filter((t) => t.length > 4)
  );
  const mdTokens = new Set(s.markdown.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/));
  const overlap = [...goldTokens].filter((t) => mdTokens.has(t)).length;

  if (playMatch && mdWords <= 15 && overlap >= 2) return { score: 5, verdict: '✓ CORRECT (fire, sharp)', notes: '' };
  if (playMatch && overlap >= 1) return { score: 4, verdict: '✓ CORRECT (fire, good)', notes: '' };
  if (playMatch) return { score: 3, verdict: '~ CORRECT PLAY (generic markdown)', notes: `md="${s.markdown}"` };
  if (overlap >= 2) return { score: 3, verdict: '~ WRONG PLAY (sharp markdown)', notes: `got [${s.play}] expected [${gold.play}]` };
  return { score: 2, verdict: '~ FIRED (off-target)', notes: `got [${s.play}] expected [${gold.play}]. md="${s.markdown}"` };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('ATLAS SUGGESTER EVAL — Sarah Park / EarlyCo');
  console.log('20-turn synthetic discovery call');
  console.log('Model: SUGGESTER_SYSTEM (current) via gpt-oss-20b on OpenRouter');
  console.log('═'.repeat(70) + '\n');

  const store = new MemoryStore();
  const hotTail = new HotTail(5);
  // Mirror the live pipeline: cadence is tracked per channel (prospect vs rep)
  // so a rep-watcher fire doesn't bleed into prospect-suggester suppression.
  const recentProspectSuggestions: RecentSuggestionEntry[] = [];
  const recentRepSuggestions: RecentSuggestionEntry[] = [];
  const results: TurnResult[] = [];

  let turnCounter = 0;

  for (const utt of TRANSCRIPT) {
    turnCounter++;
    const turnId = `t${String(turnCounter).padStart(3, '0')}`;

    // Stats tracking (mirrors processUtterance)
    store.recordUtteranceStats(utt.speaker, utt.text);

    // Snapshot BEFORE current utterance is digested (mirrors pipeline semantics)
    const prevMemory = store.snapshot;
    const tail = hotTail.snapshot();

    // Capture BANT state for logging
    const bantBefore = prevMemory.scorecard.bant;

    console.log(`Processing [${utt.id}] ${utt.speaker.toUpperCase()}...`);

    const matchingRecent = utt.speaker === 'customer'
      ? recentProspectSuggestions
      : recentRepSuggestions;

    const t0 = Date.now();
    const suggestion = await runSuggester({
      utterance: utt,
      hotTail: tail,
      prevMemory,
      brief: BRIEF,
      recentSuggestions: [...matchingRecent],
    });
    const latencyMs = Date.now() - t0;

    const gold = GOLD[utt.id];
    const { score, verdict, notes } = scoreTurn(gold, suggestion);

    results.push({
      id: utt.id,
      speaker: utt.speaker,
      text: utt.text,
      gold,
      suggestion,
      latencyMs,
      score,
      verdict,
      notes,
    });

    // Update the correct cadence stream — route by agent (same logic as
    // pipeline.ts pushRecent)
    const fired = suggestion.shouldFire;
    const target = suggestion.agent === 'prospect_suggester'
      ? recentProspectSuggestions
      : recentRepSuggestions;
    target.push({
      turn: turnCounter,
      speaker: utt.speaker,
      agent: suggestion.agent,
      fired,
      priority: suggestion.priority,
      play: suggestion.play,
      markdown: suggestion.markdown,
    });
    if (target.length > 6) target.splice(0, target.length - 6);

    // Advance hotTail (add CURRENT utterance so next turn sees it)
    hotTail.push(utt);

    // Apply manual memory patch (simulates memory agent)
    const patch = MEMORY_PATCHES[utt.id];
    if (patch) store.applyMemoryPatch(patch);

    const bantAfter = store.snapshot.scorecard.bant;
    const bantChanged = JSON.stringify(bantBefore) !== JSON.stringify(bantAfter);
    if (bantChanged) {
      console.log(`  → BANT updated: need=${bantAfter.need}, budget=${bantAfter.budget}, auth=${bantAfter.authority}, time=${bantAfter.timeline}`);
    }
  }

  // ─── Per-turn report ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('PER-TURN RESULTS');
  console.log('═'.repeat(70));

  const firedCount = (arr: TurnResult[]) => arr.filter((r) => r.suggestion.shouldFire).length;
  let runningFired = 0;

  for (const r of results) {
    const speakerTag = r.speaker === 'rep' ? 'REP      ' : 'PROSPECT ';
    const goldTag = r.gold.fire ? `FIRE [${r.gold.play}]` : 'SILENT';
    const actualTag = r.suggestion.shouldFire ? `🔥 FIRE [${r.suggestion.play}]` : `🤐 SILENT`;
    const scoreSymbol = r.score >= 4 ? '●' : r.score === 3 ? '◑' : '○';

    console.log(`\n[${r.id}] ${speakerTag} ${r.text.slice(0, 90)}${r.text.length > 90 ? '…' : ''}`);
    console.log(`  Gold:   ${goldTag}`);
    console.log(`  Actual: ${actualTag}  (${(r.latencyMs / 1000).toFixed(1)}s)`);
    if (r.suggestion.shouldFire) {
      const mdLen = r.suggestion.markdown.split(/\s+/).filter(Boolean).length;
      console.log(`  Text:   "${r.suggestion.markdown}" [${mdLen}w]`);
    }
    console.log(`  Score:  ${scoreSymbol} ${r.score}/5   ${r.verdict}`);
    if (r.notes) console.log(`  Note:   ${r.notes}`);
    if (r.gold.fire === false && r.gold.cadenceMask) {
      console.log(`  [CADENCE MASK] Ideal: ${r.gold.cadenceMask}`);
    }
    if (r.gold.fire === true && r.gold.cadenceMask && !r.suggestion.shouldFire) {
      console.log(`  [CADENCE MASK EXPECTED] ${r.gold.cadenceMask}`);
    }
    console.log(`  Reasoning excerpt: ${r.suggestion.reasoning.slice(0, 200)}…`);
  }

  // ─── Aggregate ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('AGGREGATE SCORES');
  console.log('═'.repeat(70));

  const goldFire = results.filter((r) => r.gold.fire === true);
  const goldSilent = results.filter((r) => r.gold.fire === false);
  const cadenceMasked = results.filter((r) => r.gold.fire === true && r.gold.cadenceMask);
  const trueGoldFire = goldFire.filter((r) => !r.gold.cadenceMask); // turns we expect to fire, not cadence-suppressed

  const correct = results.filter((r) => r.score >= 4).length;
  const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
  const fireCorrect = goldFire.filter((r) => r.suggestion.shouldFire || r.gold.cadenceMask).length;
  const silentCorrect = goldSilent.filter((r) => !r.suggestion.shouldFire).length;
  const overFires = goldSilent.filter((r) => r.suggestion.shouldFire).length;

  const trueFireFired = trueGoldFire.filter((r) => r.suggestion.shouldFire).length;
  const trueFireMissed = trueGoldFire.filter((r) => !r.suggestion.shouldFire).length;

  console.log(`\nTotal turns:         ${results.length}`);
  console.log(`Gold FIRE turns:     ${goldFire.length}  (${cadenceMasked.length} cadence-suppressed by design)`);
  console.log(`Gold SILENT turns:   ${goldSilent.length}`);
  console.log(`\nOverall avg score:   ${avg.toFixed(2)}/5`);
  console.log(`Correct decisions:   ${correct}/${results.length}`);
  console.log(`\nPrecision (no false fires on gold-silent): ${silentCorrect}/${goldSilent.length}  (${overFires} over-fire${overFires !== 1 ? 's' : ''})`);
  console.log(`Recall on must-fire turns (cadence-masked excluded): ${trueFireFired}/${trueGoldFire.length}`);
  console.log(`  (${cadenceMasked.length} turns were cadence-suppressed by design — not counted as misses)`);

  // ─── Cadence analysis ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('CADENCE SUPPRESSION ANALYSIS');
  console.log('─'.repeat(70));
  console.log('\nTurns where cadence masked an important play:');
  for (const r of results.filter((r) => r.gold.cadenceMask)) {
    const status = r.suggestion.shouldFire ? 'FIRED ANYWAY (cadence bypassed?)' : 'silenced (expected)';
    console.log(`  [${r.id}] ${status} — ${r.gold.cadenceMask}`);
  }

  // ─── Discovery gate analysis ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('DISCOVERY GATE ANALYSIS');
  console.log('─'.repeat(70));
  const u02 = results.find((r) => r.id === 'u02')!;
  const u16 = results.find((r) => r.id === 'u16')!;
  console.log(`\n[u02] Early CEO mention (Need=unknown at eval time):`);
  console.log(`  Expected: SILENT (gate suppresses probe_stakeholder)`);
  console.log(`  Actual:   ${u02.suggestion.shouldFire ? `🔥 FIRED [${u02.suggestion.play}] ← GATE FAILURE` : '🤐 SILENT ✓'}`);
  console.log(`\n[u16] Rachel named with role (Need=confirmed at eval time):`);
  console.log(`  Expected: FIRE probe_stakeholder (gate now open)`);
  console.log(`  Actual:   ${u16.suggestion.shouldFire ? `🔥 FIRED [${u16.suggestion.play}] ✓` : '🤐 SILENT ← MISSED'}`);

  // ─── Rep mistake catch analysis ──────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('REP MISTAKE CATCH ANALYSIS');
  console.log('─'.replace(/-/g, '─').repeat(70));
  const repMistakes = [
    { id: 'u07', play: 'rep_skipped_drill', note: 'Rep skipped 3-4 hrs/day metric' },
    { id: 'u09', play: 'rep_feature_dump', note: 'Feature dump after Q1 miss' },
    { id: 'u11', play: 'rep_defended_objection', note: 'No LAER on ICP objection' },
    { id: 'u13', play: 'rep_no_next_step', note: 'Vague Q3 defer' },
    { id: 'u15', play: 'rep_no_next_step', note: 'Vague "I\'ll send something"' },
    { id: 'u17', play: 'rep_feature_dump', note: 'Feature dump at close' },
    { id: 'u19', play: 'anchor_next_step', note: 'Call ends without booked follow-up' },
  ];
  console.log('');
  for (const m of repMistakes) {
    const r = results.find((x) => x.id === m.id)!;
    const cadenced = !!r.gold.cadenceMask;
    const caught = r.suggestion.shouldFire;
    const icon = caught ? '✓ CAUGHT' : cadenced ? '~ CADENCE-MASKED' : '✗ MISSED';
    const play = caught ? `[${r.suggestion.play}]` : `[expected: ${m.play}]`;
    console.log(`  [${m.id}] ${icon}  ${play}  — ${m.note}`);
  }

  // ─── Markdown quality ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('MARKDOWN QUALITY (fired turns only)');
  console.log('─'.repeat(70));
  console.log('');
  for (const r of results.filter((r) => r.suggestion.shouldFire)) {
    const words = r.suggestion.markdown.split(/\s+/).filter(Boolean).length;
    const over = words > 15 ? ` ← OVER LIMIT (${words}w)` : '';
    const hasVerb = /^[A-Z][a-z]+(?: [a-z]+)*/.test(r.suggestion.markdown);
    console.log(`  [${r.id}] "${r.suggestion.markdown}" [${words}w]${over}`);
  }

  // ─── Final qualitative summary ───────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('QUALITATIVE ANALYSIS');
  console.log('═'.repeat(70));
  console.log(`
Key findings from this evaluation:

1. CADENCE SUPPRESSION ON REP MISTAKES
   The hard cadence rule ("if prior turn fired, default silent") systematically
   prevents rep_watcher catches when rep mistakes follow hot prospect turns.
   In this call, ${cadenceMasked.length} potentially high-value rep catches were suppressed.
   The design intentionally prioritises not flooding reps over catching every
   mistake — but the effect is that feature dumps, defended objections, and
   vague closes are disproportionately silenced.

2. DISCOVERY GATE (Need-based suppression)
   The gate's core job: suppress authority/stakeholder plays when Need=unknown.
   [u02] Tyler mention result: ${u02.suggestion.shouldFire ? 'FAILURE — system fired when it should be silent' : 'PASS — correctly silent when Need=unknown'}.
   [u16] Rachel named with role (Need=confirmed): ${u16.suggestion.shouldFire ? 'PASS — correctly fires probe_stakeholder' : 'FAILURE — missed late-call stakeholder signal'}.

3. PAIN DIAGNOSIS QUALITY
   Core discovery plays (drill_vague, quantify_pain) at turns u04, u06, u08.
   Checking results:
${[results.find((r) => r.id === 'u04'), results.find((r) => r.id === 'u06'), results.find((r) => r.id === 'u08')]
  .filter(Boolean)
  .map((r) => `   [${r!.id}] ${r!.verdict} — ${r!.suggestion.shouldFire ? r!.suggestion.markdown : '(silent)'}`)
  .join('\n')}

4. OBJECTION HANDLING
   [u10] ICP objection: ${results.find((r) => r.id === 'u10')?.verdict}
   [u12] Load-bearing repeat: ${results.find((r) => r.id === 'u12')?.verdict}

5. CHAMPION DETECTION
   [u14] Champion behaviour: ${results.find((r) => r.id === 'u14')?.verdict}
`);

  console.log('═'.repeat(70) + '\n');
}

await main();
