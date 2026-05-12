#!/usr/bin/env bun
/**
 * eval-sam-lin.ts
 *
 * Production-faithful eval on the Sam Lin / GearStack 40-turn scenario.
 *
 * Differs from eval-conversation.ts in two ways:
 *  1. Different scenario (B2B fintech sales-ops persona vs SaaS growth lead)
 *  2. Uses the REAL runMemoryAgent for memory state (production parity) instead
 *     of hand-authored memory patches. Slower and noisier — but matches what
 *     the suggester actually sees in production.
 *
 * Gold labels copied verbatim from bench-suggester-40turn-v3.ts.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/eval-sam-lin.ts
 */
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dir, '..'));

if (!process.env.OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set');
  process.exit(1);
}

import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { runSuggester } from '../src/agents/suggester';
import { runMemoryAgent } from '../src/agents/memoryAgent';
import type { RecentSuggestionEntry } from '../src/agents/suggester';
import type { PreCallBrief, Utterance, Suggestion } from '@atlas/types';

const BRIEF: PreCallBrief = {
  lead: { name: 'Sam Lin', title: 'Director of Sales Ops', company: 'GearStack', companySize: '200 employees' },
  avaContext: {
    campaignId: 'campaign-sam',
    leadScore: 0.72,
    scoringSignals: [
      { signal: 'Director of Sales Ops title', weight: 0.35 },
      { signal: 'B2B fintech, 200 employees', weight: 0.25 },
      { signal: 'Recent Gong cancellation (intent signal)', weight: 0.40 },
    ],
  },
  pastInteractions: [
    { type: 'email', date: '2026-04-22', summary: 'Intro via Diana — Sam interested in coaching tooling post-Gong.' },
  ],
  callGoal: 'qualify',
  suggestedQuestions: [
    "What's prompting the look at coaching tools right now?",
    "How are you measuring ramp time today?",
    "What didn't work about Gong specifically?",
  ],
  productSnippets: [
    'Atlas surfaces top 2-3 coachable moments per rep per week',
    'Manager dashboards show coaching coverage gaps before 1:1s',
    'Live in-call nudges based on BANT/MEDDIC anchors',
    'Integrates with HubSpot, Salesloft, Outreach, Gong recordings',
    'Typical ramp-time reduction: 15-25 days at 6 months',
    'Pricing scales with seat count; pilot programs available',
  ],
};

type Utt = { id: string; speaker: 'rep' | 'customer'; text: string };
const TRANSCRIPT: Utt[] = [
  { id: 'u1',  speaker: 'rep',      text: "Hey Sam, thanks for making time today. Quick one before we dive in — how's your week been?" },
  { id: 'u2',  speaker: 'customer', text: "Pretty hectic actually, we're closing the Q1 forecast this week so half my team is heads-down." },
  { id: 'u3',  speaker: 'rep',      text: "Got it. Won't take more than twenty minutes. Mind if I share what I learned from Diana then we can dig into what you're trying to solve?" },
  { id: 'u4',  speaker: 'customer', text: "Yeah go ahead, that works for me." },
  { id: 'u5',  speaker: 'rep',      text: "So Diana mentioned you've been looking at sales coaching tools. What's prompting that?" },
  { id: 'u6',  speaker: 'customer', text: "Honestly it's gotten kind of urgent. Our SDR ramp time has crept from like sixty days to over a hundred days in the last year, and our VP of Sales is asking why." },
  { id: 'u7',  speaker: 'rep',      text: "That's a big jump. How are you measuring ramp today — is it time to first closed-won, time to quota, something else?" },
  { id: 'u8',  speaker: 'customer', text: "Time to eighty percent of quota, basically." },
  { id: 'u9',  speaker: 'rep',      text: "Got it. And what's the team size we're talking about — how many SDRs, how many AEs?" },
  { id: 'u10', speaker: 'customer', text: "We've got twenty-four SDRs, eighteen AEs, and managers split across three regions." },
  { id: 'u11', speaker: 'rep',      text: "Three regions — are they on the same playbook or different?" },
  { id: 'u12', speaker: 'customer', text: "EMEA and APAC have totally different scripts and call patterns from NA. We've tried to standardize but the regional VPs push back." },
  { id: 'u13', speaker: 'rep',      text: "What does that push-back look like — is it a coaching alignment thing or a process thing?" },
  { id: 'u14', speaker: 'customer', text: "Both. EMEA has a longer sales cycle — more committee-driven. So the same coaching framework lands flat there." },
  { id: 'u15', speaker: 'rep',      text: "Right. Have you tried a coaching tool before, or is this the first time you're considering one?" },
  { id: 'u16', speaker: 'customer', text: "We had Gong for eighteen months but ripped it out last quarter. Cost was hard to justify and the AI summaries weren't actionable enough for our managers." },
  { id: 'u17', speaker: 'rep',      text: "Interesting — so what'd be different about evaluating Atlas specifically?" },
  { id: 'u18', speaker: 'customer', text: "Honestly I'm not sure yet. We need something that actually changes manager behavior, not just produces transcripts. Gong was great at recording, terrible at coaching." },
  { id: 'u19', speaker: 'rep',      text: "What does 'changes manager behavior' look like for you concretely?" },
  { id: 'u20', speaker: 'customer', text: "Like, my managers should walk into 1:1s knowing the top two coachable moments per rep without me prompting them. Right now they wing it." },
  { id: 'u21', speaker: 'rep',      text: "That's a great success metric. Who else is involved in this evaluation?" },
  { id: 'u22', speaker: 'customer', text: "Me primarily, then my VP Sales, Aisha Patel. And probably our CFO if it's over a hundred K because we've got a tighter approval process this year." },
  { id: 'u23', speaker: 'rep',      text: "Got it. What's the timeline you're working with — is there a trigger that's pushing this?" },
  { id: 'u24', speaker: 'customer', text: "We want to have something rolled out before our sales kickoff in late June." },
  { id: 'u25', speaker: 'rep',      text: "And what's your budget range for this?" },
  { id: 'u26', speaker: 'customer', text: "We've earmarked roughly one fifty to two hundred K annual for the whole sales tech stack refresh, but coaching specifically would be a slice of that." },
  { id: 'u27', speaker: 'rep',      text: "Great range. Let me show you our pricing then so we can see if there's fit." },
  { id: 'u28', speaker: 'customer', text: "Sure but quickly — can you do an annual contract or is it monthly only?" },
  { id: 'u29', speaker: 'rep',      text: "Annual is what we recommend, but we're flexible. Quick question though — when Gong didn't deliver, who at your end was the loudest voice that wanted to keep it?" },
  { id: 'u30', speaker: 'customer', text: "Honestly that was Aisha. She loved the call recording for QA. So if we move off Gong replacement she's going to want to know we keep that capability." },
  { id: 'u31', speaker: 'rep',      text: "Got it — call recording for QA. We do that. What else does Aisha care about?" },
  { id: 'u32', speaker: 'customer', text: "She'd probably want to see this work for her top two reps before rolling out to the full team." },
  { id: 'u33', speaker: 'rep',      text: "That's actually how most of our customers start. Sounds like we're aligned." },
  { id: 'u34', speaker: 'customer', text: "How long does implementation take? We can't have something disruptive while we're closing Q1." },
  { id: 'u35', speaker: 'rep',      text: "Implementation is usually two to three weeks, but we can be flexible. Should I send you references from teams your size?" },
  { id: 'u36', speaker: 'customer', text: "Yeah send those. And what does the success metric tracking look like once we're live? My CFO is going to ask me what ROI looks like in month six." },
  { id: 'u37', speaker: 'rep',      text: "Great question. We typically baseline against three KPIs you pick — let's hammer those out next week. What's good for you Tuesday?" },
  { id: 'u38', speaker: 'customer', text: "Tuesday afternoon could work. Send a few options." },
  { id: 'u39', speaker: 'rep',      text: "Will do. One last thing — anyone else from your end who should be on Tuesday's call?" },
  { id: 'u40', speaker: 'customer', text: "Probably Aisha, and our SalesOps lead Devon — he runs our tooling stack so any deployment touches his team." },
];

type Gold =
  | { fire: false; rationale: string }
  | { fire: true; play: string; rationale: string };

const GOLD: Record<string, Gold> = {
  u1:  { fire: false, rationale: 'greeting' },
  u2:  { fire: false, rationale: 'small talk' },
  u3:  { fire: false, rationale: 'rep agenda-setting' },
  u4:  { fire: false, rationale: 'acknowledgment' },
  u5:  { fire: false, rationale: 'open discovery — right move' },
  u6:  { fire: true,  play: 'quantify_pain', rationale: 'concrete metric just dropped' },
  u7:  { fire: false, rationale: 'rep drilling correctly' },
  u8:  { fire: false, rationale: 'clear specific answer' },
  u9:  { fire: false, rationale: 'good breadth question' },
  u10: { fire: false, rationale: 'clean factual answer' },
  u11: { fire: false, rationale: 'reasonable clarifier' },
  u12: { fire: true,  play: 'drill_vague', rationale: '"push back" vague, sits at cause' },
  u13: { fire: false, rationale: 'rep drilling exactly right' },
  u14: { fire: true,  play: 'drill_vague', rationale: 'EMEA cycle vague specific' },
  u15: { fire: false, rationale: 'good history probe' },
  u16: { fire: true,  play: 'reframe_objection', rationale: 'past failure with criterion' },
  u17: { fire: true,  play: 'rep_leading_question', rationale: 'rep leading instead of probing Gong failure' },
  u18: { fire: true,  play: 'drill_vague', rationale: 'vague success criterion' },
  u19: { fire: false, rationale: 'rep drilling well' },
  u20: { fire: true,  play: 'trial_close', rationale: 'prospect defined success — anchor it' },
  u21: { fire: false, rationale: 'multi-thread probe — right move' },
  u22: { fire: true,  play: 'probe_stakeholder', rationale: 'three specifics dropped' },
  u23: { fire: false, rationale: 'good timeline probe' },
  u24: { fire: true,  play: 'anchor_next_step', rationale: 'hard deadline named' },
  u25: { fire: true,  play: 'rep_skipped_drill', rationale: 'rep jumped to budget before pain quantified' },
  u26: { fire: true,  play: 'quantify_pain', rationale: 'slice — need carve-out' },
  u27: { fire: true,  play: 'rep_premature_discount', rationale: 'pricing before champion locked' },
  u28: { fire: true,  play: 'trial_close', rationale: 'buying signal question' },
  u29: { fire: false, rationale: 'excellent champion-of-old probe' },
  u30: { fire: true,  play: 'multi_thread', rationale: 'Aisha hidden requirement' },
  u31: { fire: false, rationale: 'right next probe' },
  u32: { fire: true,  play: 'multi_thread', rationale: 'pilot scope' },
  u33: { fire: true,  play: 'rep_defended_objection', rationale: 'rep closing on pilot without checking representativeness' },
  u34: { fire: true,  play: 'anchor_next_step', rationale: 'timing constraints stack' },
  u35: { fire: false, rationale: 'solid references offer' },
  u36: { fire: true,  play: 'multi_thread', rationale: 'CFO question = champion coaching' },
  u37: { fire: false, rationale: 'good close — specific time' },
  u38: { fire: true,  play: 'anchor_next_step', rationale: 'specific time + sweep stakeholders' },
  u39: { fire: false, rationale: 'good multi-thread question' },
  u40: { fire: true,  play: 'probe_stakeholder', rationale: 'new stakeholder Devon' },
};

function scoreTurn(gold: Gold, s: Suggestion): { score: number; verdict: string } {
  const fired = s.shouldFire;
  if (gold.fire === false) {
    if (!fired) return { score: 5, verdict: 'silent-correct' };
    return { score: 1, verdict: 'over-fire' };
  }
  if (!fired) return { score: 1, verdict: 'missed' };
  if (s.play === gold.play) return { score: 5, verdict: 'fire-sharp' };
  return { score: 3, verdict: 'fire-off-target' };
}

const store = new MemoryStore();
const hotTail = new HotTail(5);
const recentProspect: RecentSuggestionEntry[] = [];
const recentRep: RecentSuggestionEntry[] = [];

let total = 0;
let correct = 0;
let overFires = 0;
let misses = 0;
let goldFireCount = 0;
let goldSilentCount = 0;

console.log('═'.repeat(70));
console.log('SAM LIN / GearStack — 40-turn eval (production-faithful memory)');
console.log('═'.repeat(70));

for (let i = 0; i < TRANSCRIPT.length; i++) {
  const utt = TRANSCRIPT[i];
  const turnId = `t${String(i + 1).padStart(3, '0')}`;

  const u: Utterance = {
    id: utt.id, speaker: utt.speaker, text: utt.text,
    startMs: i * 10000, endMs: i * 10000 + 8000,
    confidence: 1, derivedFromLowConfidence: false,
  };
  store.recordUtteranceStats(u.speaker, u.text);

  const prevMemory = store.snapshot;
  const tail = hotTail.snapshot();
  const matching = u.speaker === 'customer' ? recentProspect : recentRep;

  // Suggester + memory agent in parallel (mirrors production pipeline).
  // Both wrapped in catch — flaky upstream calls shouldn't abort the eval.
  const [suggestion, memoryPatch] = await Promise.all([
    runSuggester({ utterance: u, hotTail: tail, prevMemory, brief: BRIEF, recentSuggestions: [...matching] })
      .catch((e) => {
        console.error(`  suggester failed on ${utt.id}: ${(e as Error).message?.slice(0, 80)}`);
        return {
          shouldFire: false, priority: 'nudge' as const, play: 'none' as const,
          axis: null, markdown: '', reasoning: 'suggester error',
          groundedInUtteranceIds: [], groundedInAnchorTurnIds: [],
          agent: (u.speaker === 'customer' ? 'prospect_suggester' : 'rep_watcher') as 'prospect_suggester' | 'rep_watcher',
        } as Suggestion;
      }),
    runMemoryAgent({ utterance: u, turnId, prevMemory, hotTail: tail }).catch((e) => {
      console.error(`  memory failed on ${utt.id}: ${(e as Error).message?.slice(0, 80)}`);
      return null;
    }),
  ]);

  const gold = GOLD[utt.id];
  if (gold.fire) goldFireCount++; else goldSilentCount++;
  const { score, verdict } = scoreTurn(gold, suggestion);
  total += score;
  if (verdict === 'silent-correct' || verdict === 'fire-sharp') correct++;
  if (verdict === 'over-fire') overFires++;
  if (verdict === 'missed') misses++;

  const goldStr = gold.fire ? `FIRE[${gold.play}]` : 'SILENT';
  const gotStr = suggestion.shouldFire ? `FIRE[${suggestion.play}]` : 'silent';
  const mark = verdict === 'silent-correct' || verdict === 'fire-sharp' ? '✓' :
               verdict === 'fire-off-target' ? '~' : '✗';
  console.log(`${mark} [${utt.id}] gold=${goldStr.padEnd(28)} got=${gotStr.padEnd(28)} ${verdict}`);

  // Apply memory patch (now part of state for next turn)
  if (memoryPatch) store.applyMemoryPatch(memoryPatch);
  hotTail.push(u);

  const target = suggestion.agent === 'prospect_suggester' ? recentProspect : recentRep;
  target.push({
    turn: i + 1, speaker: u.speaker, agent: suggestion.agent,
    fired: suggestion.shouldFire, priority: suggestion.priority,
    play: suggestion.play, markdown: suggestion.markdown,
  });
  if (target.length > 6) target.splice(0, target.length - 6);
}

console.log('═'.repeat(70));
console.log(`Total turns:       ${TRANSCRIPT.length}`);
console.log(`Gold FIRE:         ${goldFireCount}`);
console.log(`Gold SILENT:       ${goldSilentCount}`);
console.log(`Avg score:         ${(total / TRANSCRIPT.length).toFixed(2)}/5`);
console.log(`Correct decisions: ${correct}/${TRANSCRIPT.length}`);
console.log(`Over-fires:        ${overFires}/${goldSilentCount}`);
console.log(`Misses:            ${misses}/${goldFireCount}`);
console.log(`Precision:         ${(goldSilentCount - overFires)}/${goldSilentCount}`);
console.log(`Recall:            ${(goldFireCount - misses)}/${goldFireCount}`);
