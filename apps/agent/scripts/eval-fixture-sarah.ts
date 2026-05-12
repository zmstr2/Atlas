/**
 * Shared fixture for the Sarah Park 20-turn evaluation.
 *
 * Used by both eval-conversation.ts (single-call suggester) and
 * eval-split-architecture.ts (Wave 3.1 split prototype benchmark) so the
 * two scripts evaluate the same scenario with the same gold standards.
 */

import type { PreCallBrief, MemoryPatch } from '@atlas/types';

export const BRIEF: PreCallBrief = {
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

export type FixtureUtt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };

export const TRANSCRIPT: FixtureUtt[] = [
  { id: 'u01', speaker: 'rep', text: "Hey Sarah, thanks for jumping on — Alex from Artisan. How's your Tuesday going?", startMs: 0, endMs: 7000 },
  { id: 'u02', speaker: 'customer', text: "Pretty hectic but good! So I'm Sarah, Head of Growth at EarlyCo. We just closed our Series A about six weeks ago — really exciting time. My CEO Tyler basically handed this to me: figure out our outbound motion before we start scaling up the team.", startMs: 8000, endMs: 30000 },
  { id: 'u03', speaker: 'rep', text: "Congrats on the Series A — that's exciting. What does outbound look like day-to-day right now? Are you running sequences manually or is there tooling involved?", startMs: 31000, endMs: 47000 },
  { id: 'u04', speaker: 'customer', text: "Pretty much all manual. We've got one SDR — Rachel — and she does everything by hand in Apollo. It kind of works but it's really messy and I keep worrying it's just not going to scale.", startMs: 48000, endMs: 72000 },
  { id: 'u05', speaker: 'rep', text: "When you say messy — is it the lead volume, the follow-up cadence, the personalization, or something else that's the real bottleneck?", startMs: 73000, endMs: 88000 },
  { id: 'u06', speaker: 'customer', text: "Mostly follow-up honestly. Rachel probably spends something like three to four hours a day just tracking down leads that didn't respond. And we're definitely dropping some because she just can't keep up with the volume.", startMs: 89000, endMs: 118000 },
  { id: 'u07', speaker: 'rep', text: "Yeah, three to four hours a day is a lot. So what made you take this call now — was there a specific trigger that made the timing feel right?", startMs: 119000, endMs: 134000 },
  { id: 'u08', speaker: 'customer', text: "Tyler pushed for it after we missed our Q1 targets pretty badly. We were supposed to close fifteen new accounts and we closed eight. He wants outbound volume higher before we ramp hiring in Q2.", startMs: 135000, endMs: 168000 },
  { id: 'u09', speaker: 'rep', text: "Got it. Well, Ava is really purpose-built for this — we have AI-personalized sequences, automatic follow-up so Rachel doesn't have to do any of that manual work, native Apollo and HubSpot integrations, and most teams your size see triple the pipeline in the first ninety days.", startMs: 169000, endMs: 198000 },
  { id: 'u10', speaker: 'customer', text: "I've heard the AI-sequences pitch a lot lately. Our problem is we don't actually know our ICP well enough to be running personalized outbound at scale. We're still figuring out who our best buyer is.", startMs: 199000, endMs: 232000 },
  { id: 'u11', speaker: 'rep', text: "That's actually a perfect use case for Ava — the AI learns what messages convert and what don't, so it literally helps you find your ICP rather than assuming you already know it.", startMs: 233000, endMs: 254000 },
  { id: 'u12', speaker: 'customer', text: "I hear you but I'm skeptical — we've tried tools before and they just added noise, didn't clarify anything. And honestly budget is the bigger blocker. Tyler has said nothing new until we've signed our first twenty customers organically.", startMs: 255000, endMs: 298000 },
  { id: 'u13', speaker: 'rep', text: "That makes complete sense. I'll circle back when you're closer to that twenty-customer milestone — probably Q3 territory. Sound good?", startMs: 299000, endMs: 314000 },
  { id: 'u14', speaker: 'customer', text: "Yeah, probably. Although — if you had something concrete I could show Tyler, like a case study from a team our size at Series A, I think I could get him to look at it earlier. That might move things up.", startMs: 315000, endMs: 347000 },
  { id: 'u15', speaker: 'rep', text: "Yeah absolutely, I'll put something together and send it over. Really great talking to you!", startMs: 348000, endMs: 360000 },
  { id: 'u16', speaker: 'customer', text: "Sounds good. Oh, and just so you know — Rachel would actually be managing whatever tool we end up with day-to-day, so she'd need to be comfortable with it too.", startMs: 361000, endMs: 383000 },
  { id: 'u17', speaker: 'rep', text: "Totally — we have a great onboarding program, Rachel would get her own dedicated success manager, plus there's an analytics dashboard, a conversation intelligence layer, and an SDR performance benchmarking module to help her get up to speed fast.", startMs: 384000, endMs: 408000 },
  { id: 'u18', speaker: 'customer', text: "Okay, I'll look for your email.", startMs: 409000, endMs: 415000 },
  { id: 'u19', speaker: 'rep', text: "Will do — I'll send over the case study and our startup pricing page. Take care!", startMs: 416000, endMs: 425000 },
  { id: 'u20', speaker: 'customer', text: "Sounds good, bye!", startMs: 426000, endMs: 430000 },
];

export type GoldStandard =
  | { fire: false; rationale: string; cadenceMask?: string }
  | { fire: true; play: string; axis?: string; rationale: string; cadenceMask?: string };

export const GOLD: Record<string, GoldStandard> = {
  u01: { fire: false, rationale: 'Greeting.' },
  u02: { fire: false, rationale: 'Need=unknown. Tyler mention should not trigger authority plays.' },
  u03: { fire: false, rationale: 'Solid discovery question.' },
  u04: { fire: true, play: 'drill_vague', axis: 'need', rationale: 'Vague pain — should drill before moving on.' },
  u05: { fire: false, rationale: 'Rep drilling correctly.' },
  u06: { fire: true, play: 'quantify_pain', axis: 'metric', rationale: '"3-4 hours/day" approximate metric — pin it.' },
  u07: { fire: true, play: 'rep_skipped_drill', axis: 'metric', rationale: 'Rep received metric, pivoted without quantifying.' },
  u08: { fire: true, play: 'quantify_pain', axis: 'need', rationale: 'Q1 miss specific but consequence unexplored.' },
  u09: { fire: true, play: 'rep_feature_dump', axis: 'need', rationale: '4 feature claims with no tie to stated pain.' },
  u10: { fire: false, rationale: 'Prospect stream 3/5 fired — cadence suppresses.', cadenceMask: 'reframe_objection' },
  u11: { fire: true, play: 'rep_defended_objection', axis: 'need', rationale: 'Rep skipped LAER on ICP objection.' },
  u12: { fire: false, rationale: 'Prospect stream 3/5 fired — Wave 2 promotes to critical.', cadenceMask: 'reframe_objection (load-bearing)' },
  u13: { fire: false, rationale: 'Rep stream 3/5 fired — cadence suppresses.', cadenceMask: 'rep_no_next_step' },
  u14: { fire: true, play: 'multi_thread', axis: 'champion', rationale: 'Sarah offering to champion to Tyler — anchor it.' },
  u15: { fire: false, rationale: 'Rep stream 3/5 fired — cadence suppresses.', cadenceMask: 'rep_no_next_step' },
  u16: { fire: true, play: 'probe_stakeholder', axis: 'stakeholder', rationale: 'Rachel named with day-to-day role.' },
  u17: { fire: true, play: 'rep_feature_dump', axis: 'need', rationale: '5 untethered feature claims at close.' },
  u18: { fire: false, rationale: 'Soft acknowledgment.' },
  u19: { fire: true, play: 'anchor_next_step', axis: 'timeline', rationale: 'Call ending without booked follow-up.' },
  u20: { fire: false, rationale: 'Closing pleasantry.' },
};

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
  }
): MemoryPatch {
  return {
    utteranceId, turnId, speaker,
    flow: opts.flow ? { tag: opts.flow.tag as any, content: opts.flow.content } : null,
    evidence: (opts.evidence ?? []).map((e) => ({ axis: e.axis as any, direction: e.direction, verbatim: e.verbatim, specificity: e.specificity })),
    concerns: opts.concerns?.map((c) => ({ op: c.op, topic: c.topic, verbatim: c.verbatim, severity: c.severity })) ?? null,
    decisionGeography: opts.decisionGeography?.map((d) => ({ op: d.op, name: d.name, role: d.role, sentiment: d.sentiment })) ?? null,
    facts: opts.facts?.map((f) => ({ op: f.op, key: f.key, category: f.category as any, content: f.content, confidence: f.confidence })) ?? null,
    openLoops: null,
    bantRender: null,
    relevantFacts: null,
  };
}

export const MEMORY_PATCHES: Record<string, MemoryPatch> = {
  u01: makePatch('u01', 't001', 'rep', { flow: { tag: 'OTHER', content: 'opening rapport' } }),
  u02: makePatch('u02', 't002', 'customer', {
    flow: { tag: 'OTHER', content: 'intro: EarlyCo, Series A, Tyler handed outbound brief' },
    decisionGeography: [{ op: 'upsert', name: 'Tyler', role: 'CEO', sentiment: 'unknown' }],
  }),
  u03: makePatch('u03', 't003', 'rep', { flow: { tag: 'R-Q', content: 'asked about outbound setup' } }),
  u04: makePatch('u04', 't004', 'customer', {
    flow: { tag: 'P-PAIN', content: 'all-manual; "messy, won\'t scale"' },
    evidence: [{ axis: 'identifyPain', direction: 'positive', verbatim: 'messy and I keep worrying it\'s just not going to scale', specificity: 'mention' }],
  }),
  u05: makePatch('u05', 't005', 'rep', { flow: { tag: 'R-Q', content: 'drilled: what makes it messy' } }),
  u06: makePatch('u06', 't006', 'customer', {
    flow: { tag: 'P-METRIC', content: 'Rachel: 3-4 hrs/day manual follow-up' },
    evidence: [
      { axis: 'identifyPain', direction: 'positive', verbatim: 'three to four hours a day just tracking down leads', specificity: 'specific' },
      { axis: 'metrics', direction: 'positive', verbatim: 'three to four hours a day', specificity: 'specific' },
    ],
  }),
  u07: makePatch('u07', 't007', 'rep', { flow: { tag: 'R-Q', content: 'asked about trigger' } }),
  u08: makePatch('u08', 't008', 'customer', {
    flow: { tag: 'P-METRIC', content: 'Q1 miss: 15 target, 8 closed' },
    evidence: [
      { axis: 'identifyPain', direction: 'positive', verbatim: 'fifteen new accounts expected, closed eight', specificity: 'specific' },
      { axis: 'timeline', direction: 'positive', verbatim: 'wants outbound volume higher before Q2 hiring', specificity: 'mention' },
    ],
    facts: [{ op: 'upsert', key: 'pain.consequence_q1_miss', category: 'other', content: 'Q1 target: 15 accounts, actual: 8.', confidence: 0.92 }],
  }),
  u09: makePatch('u09', 't009', 'rep', { flow: { tag: 'R-VP', content: 'feature dump' } }),
  u10: makePatch('u10', 't010', 'customer', {
    flow: { tag: 'P-OBJ', content: 'ICP objection' },
    concerns: [{ op: 'append', topic: 'icp_uncertainty', verbatim: 'don\'t actually know our ICP', severity: 'pressed' }],
  }),
  u11: makePatch('u11', 't011', 'rep', { flow: { tag: 'R-OBJ-RESP', content: 'defended ICP objection' } }),
  u12: makePatch('u12', 't012', 'customer', {
    flow: { tag: 'P-OBJ', content: 'ICP repeated + budget blocker' },
    concerns: [
      { op: 'append', topic: 'icp_uncertainty', verbatim: 'tried tools before and they just added noise', severity: 'pressed' },
      { op: 'append', topic: 'budget_blocked_by_ceo', verbatim: 'nothing new until twenty customers', severity: 'blocking' },
    ],
    evidence: [
      { axis: 'budget', direction: 'negative', verbatim: 'nothing new until we\'ve signed first twenty customers', specificity: 'specific' },
      { axis: 'economicBuyer', direction: 'positive', verbatim: 'Tyler has said nothing new', specificity: 'mention' },
    ],
  }),
  u13: makePatch('u13', 't013', 'rep', { flow: { tag: 'R-NS', content: 'vague Q3 defer' } }),
  u14: makePatch('u14', 't014', 'customer', {
    flow: { tag: 'P-BUY', content: 'champion behavior — offers to show Tyler' },
    evidence: [{ axis: 'champion', direction: 'positive', verbatim: 'I could get him to look at it earlier', specificity: 'mention' }],
  }),
  u15: makePatch('u15', 't015', 'rep', { flow: { tag: 'R-NS', content: 'vague send' } }),
  u16: makePatch('u16', 't016', 'customer', {
    flow: { tag: 'P-STAKE', content: 'Rachel as day-to-day owner' },
    decisionGeography: [{ op: 'upsert', name: 'Rachel', role: 'SDR / day-to-day tool owner', sentiment: 'unknown' }],
  }),
  u17: makePatch('u17', 't017', 'rep', { flow: { tag: 'R-VP', content: 'feature dump at close' } }),
  u18: makePatch('u18', 't018', 'customer', { flow: { tag: 'OTHER', content: 'soft close' } }),
  u19: makePatch('u19', 't019', 'rep', { flow: { tag: 'R-NS', content: 'sends materials — no call booked' } }),
  u20: makePatch('u20', 't020', 'customer', { flow: { tag: 'OTHER', content: 'closing pleasantry' } }),
};
