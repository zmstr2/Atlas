#!/usr/bin/env bun
/**
 * Realistic 5-case × 13-model suggester bench.
 *
 * Each case supplies full production-realistic inputs:
 *   - MeetingMemory  (BANT/MEDDIC scorecard, flow, anchors, concerns, facts, stakeholders)
 *   - recentSuggestions (cadence state, last 5 decisions)
 *   - hotTail  (last 3–5 raw utterances, ground truth)
 *   - PreCallBrief with ICP block
 *
 * SUGGESTER_SYSTEM is extracted from production source at runtime so prompt
 * format is byte-for-byte identical to what runs in production.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/bench-suggester-realistic.ts
 */

import { resolve } from 'node:path';

const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const ROOT = resolve(import.meta.dir, '..', '..', '..');

// ── Extract SUGGESTER_SYSTEM from production source ───────────────────────────
const suggesterSrc = await Bun.file(
  resolve(ROOT, 'apps/agent/src/agents/suggester.ts'),
).text();

// Match `export const SUGGESTER_SYSTEM = \`...\`` (not V1/V2/V3 variants)
const sysMatch = suggesterSrc.match(/export const SUGGESTER_SYSTEM\s*=\s*`([\s\S]*?)`;/m);
if (!sysMatch) throw new Error('could not extract SUGGESTER_SYSTEM from suggester.ts');
const SUGGESTER_SYSTEM = sysMatch[1];
console.log(`SUGGESTER_SYSTEM: ${SUGGESTER_SYSTEM.length} chars\n`);

// ── Inline types (mirrors packages/types — no runtime import needed) ──────────
type AxisState = 'unknown' | 'vague' | 'soft' | 'partial' | 'firm' | 'confirmed' | 'confirmed_negative';
type FlowTag = 'R-Q' | 'R-VP' | 'R-OBJ-RESP' | 'R-NS' | 'R-MISTAKE' | 'P-PAIN' | 'P-METRIC' | 'P-OBJ' | 'P-STAKE' | 'P-BUY' | 'P-COMP' | 'P-NEG' | 'P-DQ' | 'OTHER';

type FlowEntry = {
  turnId: string; speaker: 'rep' | 'customer'; tag: FlowTag; content: string; utteranceIds: string[];
};
type VerbatimAnchor = {
  turnId: string; axis: string; verbatim: string; utteranceIds: string[]; supersededBy?: string;
};
type QualScorecard = {
  bant: { need: AxisState; budget: AxisState; authority: AxisState; timeline: AxisState };
  meddic: {
    metrics: AxisState; economicBuyer: AxisState; decisionCriteria: AxisState;
    decisionProcess: AxisState; identifyPain: AxisState; champion: AxisState;
  };
  pushQueue: string[];
  hardDisqualify: boolean;
  softDisqualifySignals: string[];
  talkRatio: { repWords: number; prospectWords: number };
  turnsSinceLastRepQuestion: number;
  turnsSinceLastNextStepProposal: number;
  callMinute: number;
};
type MeetingMemory = {
  facts: { id: string; key: string; category: string; content: string; utteranceIds: string[]; confidence: number; extractedAt: number; revisions: any[] }[];
  concerns: { id: string; topic: string; verbatim: string; severity: 'mentioned' | 'pressed' | 'blocking'; addressed: boolean; utteranceIds: string[] }[];
  openLoops: { id: string; description: string; owner: 'rep' | 'customer'; status: 'open' | 'addressed' }[];
  qualSignals: any[];
  decisionGeography: { name: string; role: string; sentiment: 'positive' | 'neutral' | 'negative' | 'unknown'; utteranceIds: string[] }[];
  silenceTopics: any[];
  narrative: string;
  flow: FlowEntry[];
  verbatimAnchors: VerbatimAnchor[];
  scorecard: QualScorecard;
  bantRender: Record<string, any>;
  relevantFacts: any[];
};
type HotTailEntry = { id: string; speaker: 'rep' | 'customer'; text: string; ts: number };
type Utterance = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number; confidence: number; derivedFromLowConfidence: boolean };
type PreCallBrief = {
  lead: { name: string; title: string; company: string; companySize: string };
  avaContext: { campaignId: string; leadScore: number; scoringSignals: { signal: string; weight: number }[] };
  pastInteractions: { type: 'email' | 'meeting'; date: string; summary: string }[];
  callGoal: string;
  suggestedQuestions: string[];
  productSnippets: string[];
  icp?: {
    dealShape: string; cycleLength: string; buyerPersona: string; decisionMakerCount: string;
    competitiveLandscape: string; valueFrame: string;
    buyingSignals: string[]; objectionRoots: string[]; goodNextStep: string;
  };
};
type RecentSuggestionEntry = {
  turn: number; speaker: 'rep' | 'customer'; agent: 'prospect_suggester' | 'rep_watcher';
  fired: boolean; priority: 'critical' | 'nudge' | 'fyi'; play: string; markdown: string;
};

// ── Inline detectAnchorContradictions (from apps/agent/src/memory/anchors.ts) ─
const NUMERIC_WORD: Record<string, number> = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000,
};
function extractDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const lower = text.toLowerCase();
  const reNum = /\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m|thousand|million)?/g;
  let m: RegExpExecArray | null;
  while ((m = reNum.exec(lower)) !== null) {
    const n = parseFloat(m[1]); const suf = m[2];
    let v = n;
    if (suf === 'k' || suf === 'thousand') v *= 1000;
    if (suf === 'm' || suf === 'million') v *= 1_000_000;
    if (v >= 100) out.push(v);
  }
  const reWord = /(?:(\w+)[-\s])?(\w+)\s+(thousand|million)/g;
  while ((m = reWord.exec(lower)) !== null) {
    const a = NUMERIC_WORD[m[1] ?? ''] ?? 0;
    const b = NUMERIC_WORD[m[2]] ?? 0;
    const mul = m[3] === 'million' ? 1_000_000 : 1000;
    const v = (a + b) * mul;
    if (v >= 1000) out.push(v);
  }
  return out;
}
function detectAnchorContradictions(memory: MeetingMemory, newText: string) {
  const out: { anchor: VerbatimAnchor; axis: string; reason: string }[] = [];
  const newAmounts = extractDollarAmounts(newText);
  for (const anchor of memory.verbatimAnchors) {
    if (anchor.axis === 'budget') {
      const nums = extractDollarAmounts(anchor.verbatim);
      if (nums.length === 0) continue;
      const max = Math.max(...nums);
      const violator = newAmounts.find(n => n > max * 1.5);
      if (violator !== undefined) {
        out.push({ anchor, axis: 'budget', reason: `pitched $${violator} but budget anchor is $${Math.min(...nums)}–$${max}` });
      }
    } else if (anchor.axis === 'authority') {
      const nums = extractDollarAmounts(anchor.verbatim);
      if (nums.length === 0) continue;
      const cap = Math.min(...nums);
      const violator = newAmounts.find(n => n > cap * 1.5);
      if (violator !== undefined) {
        out.push({ anchor, axis: 'authority', reason: `mentioned $${violator} but authority cap is $${cap}` });
      }
    }
  }
  return out;
}

// ── Inline renderMemoryMarkdown (from apps/agent/src/memory/render.ts) ────────
function renderMemoryMarkdown(opts: {
  memory: MeetingMemory; hotTail?: HotTailEntry[]; leadName?: string; callGoal?: string;
}): string {
  const { memory, hotTail = [], leadName, callGoal } = opts;
  const sc = memory.scorecard;
  const lines: string[] = [];
  if (leadName || callGoal) {
    lines.push(`# Call — ${leadName ?? '?'}`);
    if (callGoal) lines.push(`Goal: ${callGoal}`);
    lines.push('');
  }
  const totalWords = sc.talkRatio.repWords + sc.talkRatio.prospectWords;
  const repPct = totalWords > 0 ? Math.round((sc.talkRatio.repWords / totalWords) * 100) : 0;
  const prospectPct = totalWords > 0 ? Math.round((sc.talkRatio.prospectWords / totalWords) * 100) : 0;
  lines.push('## Stage');
  lines.push(`Minute ${sc.callMinute}. Talk ratio (words): rep ${repPct}% / prospect ${prospectPct}%. Turns since last R-Q: ${sc.turnsSinceLastRepQuestion}. Turns since last R-NS: ${sc.turnsSinceLastNextStepProposal}.`);
  lines.push('');
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
  lines.push('## Push queue (priority order, ambiguous absences only)');
  if (sc.pushQueue.length === 0) lines.push('(empty — all axes filled or confirmed-negative)');
  else sc.pushQueue.slice(0, 5).forEach((k, i) => lines.push(`${i + 1}. ${k}`));
  lines.push('');
  lines.push('## Disqualifiers');
  if (sc.hardDisqualify) lines.push('- HARD: Need or Budget confirmed-negative — qualify out.');
  for (const s of sc.softDisqualifySignals) lines.push(`- soft: ${s}`);
  if (!sc.hardDisqualify && sc.softDisqualifySignals.length === 0) lines.push('none active');
  lines.push('');
  lines.push('## Flow (compressed, last 20)');
  if (memory.flow.length === 0) lines.push('(no entries)');
  else for (const f of memory.flow.slice(-20)) lines.push(`[${f.turnId}] ${f.tag} ${f.content}`);
  lines.push('');
  const activeAnchors = memory.verbatimAnchors.filter(a => !a.supersededBy);
  lines.push('## Verbatim anchors (load-bearing details)');
  if (activeAnchors.length === 0) lines.push('(none)');
  else for (const a of activeAnchors) lines.push(`- [${a.turnId} / ${a.axis}] "${a.verbatim}"`);
  lines.push('');
  if (memory.decisionGeography.length > 0) {
    lines.push('## Stakeholders');
    for (const a of memory.decisionGeography) lines.push(`- ${a.name} (${a.role}) — sentiment: ${a.sentiment}`);
    lines.push('');
  }
  const openLoops = memory.openLoops.filter(l => l.status === 'open');
  if (openLoops.length > 0) {
    lines.push('## Open loops');
    for (const l of openLoops) lines.push(`- [${l.owner}] ${l.description}`);
    lines.push('');
  }
  if (memory.facts.length > 0) {
    lines.push('## Key facts (extracted)');
    for (const f of memory.facts) lines.push(`- [${f.key}] ${f.content}`);
    lines.push('');
  }
  const activeConcerns = memory.concerns.filter(c => !c.addressed);
  if (activeConcerns.length > 0) {
    lines.push('## Active concerns');
    for (const c of activeConcerns) lines.push(`- [${c.severity}] ${c.topic}: "${c.verbatim}"`);
    lines.push('');
  }
  if (hotTail.length > 0) {
    lines.push('## Hot tail (last raw utterances)');
    for (const h of hotTail) lines.push(`[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Inline buildSuggesterPrompt (from apps/agent/src/agents/suggester.ts) ─────
function buildSuggesterPrompt(opts: {
  utterance: Utterance; hotTail: HotTailEntry[];
  prevMemory: MeetingMemory; brief: PreCallBrief; recentSuggestions: RecentSuggestionEntry[];
}): string {
  const { utterance, hotTail, prevMemory, brief, recentSuggestions } = opts;
  const memoryMarkdown = renderMemoryMarkdown({
    memory: prevMemory, hotTail, leadName: brief.lead.name, callGoal: brief.callGoal,
  });
  const productSnippets = brief.productSnippets.slice(0, 6).join(' | ');
  const isProspect = utterance.speaker === 'customer';
  const priorOpposite = [...hotTail].reverse().find(h => h.speaker !== utterance.speaker);
  const contradictions = detectAnchorContradictions(prevMemory, utterance.text);
  const contradictionLines = contradictions.map(c => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`);
  const firedCount = recentSuggestions.slice(-5).filter(r => r.fired).length;
  const recentLines = recentSuggestions.length === 0
    ? '(none yet)'
    : recentSuggestions.map(r => {
        const tag = r.fired ? 'FIRED' : 'silent';
        return `- t${r.turn} ${tag} [${r.agent}/${r.priority}/${r.play}] ${r.markdown || '(no text)'}`;
      }).join('\n');
  const speakerLabel = isProspect ? 'PROSPECT' : 'REP';
  const priorLabel = isProspect ? 'IMMEDIATE PRIOR REP UTTERANCE' : 'IMMEDIATE PRIOR PROSPECT UTTERANCE';
  const modeLabel = isProspect ? 'PROSPECT MODE' : 'REP MODE';
  const personaContext = brief.icp
    ? `\n# [PERSONA-CONTEXT] — ICP-specific tuning for this deal
- Deal shape: ${brief.icp.dealShape}
- Cycle length: ${brief.icp.cycleLength}
- Buyer persona: ${brief.icp.buyerPersona}
- Decision-maker count: ${brief.icp.decisionMakerCount}
- Competitive landscape: ${brief.icp.competitiveLandscape}
- Value frame (what the buyer is actually buying): ${brief.icp.valueFrame}
- Persona-specific buying signals (additional to generic structural categories):
${brief.icp.buyingSignals.map(s => `  - ${s}`).join('\n')}
- Persona-specific objection roots (the structural root often hidden under surface objections):
${brief.icp.objectionRoots.map(s => `  - ${s}`).join('\n')}
- Good next step looks like: ${brief.icp.goodNextStep}\n`
    : '';

  return `# CALL CONTEXT
${memoryMarkdown}

# PRE-CALL BRIEF
Lead: ${brief.lead.name}, ${brief.lead.title} @ ${brief.lead.company}
Call goal: ${brief.callGoal}
Product snippets: ${productSnippets}
${personaContext}

# ${priorLabel}
${priorOpposite ? `[${priorOpposite.id}] ${priorOpposite.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${priorOpposite.text}` : '(none)'}

# NEW ${speakerLabel} UTTERANCE — you are in ${modeLabel}
[${utterance.id}] ${speakerLabel}: ${utterance.text}

# RECENT SUGGESTIONS (your last decisions, oldest first; ${firedCount} of last 5 fired)
${recentLines}

# CONTRADICTIONS DETECTED (deterministic anchor checks)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide. Output the structured Suggestion.`;
}

const SUG_JSON_INSTR = `Output ONLY a compact JSON object:
{"shouldFire":<bool>,"priority":"<critical|nudge|fyi>","play":"<one of taxonomy>","axis":"<need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder> OR null","markdown":"<≤15 words, action verb first>","reasoning":"<one paragraph>","groundedInUtteranceIds":[],"groundedInAnchorTurnIds":[]}
No <think> blocks, no preamble, no markdown fences. Begin with { and end with }.`;

// ── Shared call context ───────────────────────────────────────────────────────
// Single deal: Atlas → Streamline (200-person B2B SaaS, RevOps buyer)
const BRIEF: PreCallBrief = {
  lead: {
    name: 'Marcus Webb',
    title: 'Head of Revenue Operations',
    company: 'Streamline',
    companySize: '200 employees, ~60-seat sales org',
  },
  avaContext: {
    campaignId: 'camp_mid_market_revops_q2',
    leadScore: 0.74,
    scoringSignals: [
      { signal: 'opened 3 emails in last 14 days', weight: 0.3 },
      { signal: 'visited pricing page twice', weight: 0.4 },
      { signal: 'champion referral from existing customer', weight: 0.3 },
    ],
  },
  pastInteractions: [
    { type: 'email', date: '2026-04-28', summary: 'Marcus replied positively to cold outreach; said his VP Sales had flagged coaching consistency as a Q2 priority.' },
  ],
  callGoal: 'Discovery — qualify need, surface budget and authority, identify champion, confirm timeline vs Q2 SKO.',
  suggestedQuestions: [
    'What does ramping look like for a new AE today?',
    'Who owns coaching cadence — managers or RevOps?',
    'What would "working" look like in 90 days?',
  ],
  productSnippets: [
    'Atlas surfaces the 2–3 coachable moments per rep per week managers actually act on',
    'Manager dashboards show coaching coverage gaps before 1:1s — no manual prep',
    'Live in-call nudges based on BANT/MEDDIC anchors (same tech you\'re evaluating now)',
    'Integrates with HubSpot, Salesloft, Outreach, Gong recordings',
    'Typical ramp-time reduction: 18–26 days at month 6',
    'Pricing scales with seat count; pilot programs available at no commitment',
  ],
  icp: {
    dealShape: '$60K–$150K ARR, annual contract, piloted on 1–2 teams before full rollout',
    cycleLength: '6–10 weeks from first call to signature for mid-market (200–500 employees)',
    buyerPersona: 'RevOps or SalesOps lead who owns the sales tech stack; VP Sales often co-decision-maker; CFO gates deals above $75K',
    decisionMakerCount: '2–3 (RevOps + VP Sales + Finance above threshold)',
    competitiveLandscape: 'Gong (dominant, high-recall, weak coaching); Chorus/ZoomInfo (cheaper, compliance-heavy); status quo (no tool, manager judgment)',
    valueFrame: 'Manager time reclaimed + rep ramp-time reduction; not transcription or call recording — they have that',
    buyingSignals: [
      'Mentions manager time spent on manual coaching prep',
      'References a specific ramp time or new-hire failure rate',
      'Asks about integration with existing stack (HubSpot, Salesforce)',
      'Proactively offers to loop in another stakeholder',
      'Asks how other RevOps teams measure ROI',
    ],
    objectionRoots: [
      'Past tool fatigue (Gong, Chorus) — root: promise of insight never translated to behavior change',
      'Manager adoption risk — root: tool adds process overhead without clear personal win for managers',
      'Budget authority confusion — root: RevOps influences but doesn\'t own headcount budget; VP Sales owns discretionary',
    ],
    goodNextStep: 'Confirmed meeting with VP Sales + Marcus + one manager to scope a 2-week pilot on 3–5 reps, with explicit success metric agreed before pilot starts',
  },
};

// ── 5 test cases ─────────────────────────────────────────────────────────────
type TestCase = {
  id: string;
  label: string;
  description: string;
  gold: { fire: boolean; play?: string; rationale: string };
  utterance: Utterance;
  hotTail: HotTailEntry[];
  prevMemory: MeetingMemory;
  recentSuggestions: RecentSuggestionEntry[];
};

const CASES: TestCase[] = [
  // ── Case 1: Minute 8, prospect quantifies manager pain for first time ────────
  {
    id: 'c1',
    label: 'C1 · min 8 · fresh pain quantification (PROSPECT)',
    description: 'Prospect drops first quantified manager pain. Need=vague, memory sparse. Expected: quantify_pain or drill_vague.',
    gold: { fire: true, play: 'quantify_pain', rationale: 'First structural metric (4 hrs × 6 managers = 24 manager hours/week). Anchor it before moving on.' },
    utterance: { id: 'u7', speaker: 'customer', text: "Honestly the biggest time suck right now is building coaching reports — my managers are spending probably four hours a week each just pulling data from Salesforce and formatting it for their 1:1s. We have six managers, so that's like twenty-four hours a week of manager time on admin.", startMs: 480000, endMs: 494000, confidence: 0.97, derivedFromLowConfidence: false },
    hotTail: [
      { id: 'u5', speaker: 'rep', text: "What's prompting the look at coaching tooling now — is there a specific trigger?", ts: 460000 },
      { id: 'u6', speaker: 'customer', text: "Two things: our VP Sales flagged that ramp time for new AEs has slipped from about 60 to 90 days over the past year, and personally I'm spending too much time managing the managers instead of the process.", ts: 472000 },
      { id: 'u7', speaker: 'customer', text: "Honestly the biggest time suck right now is building coaching reports — my managers are spending probably four hours a week each just pulling data from Salesforce and formatting it for their 1:1s. We have six managers, so that's like twenty-four hours a week of manager time on admin.", ts: 480000 },
    ],
    prevMemory: {
      facts: [
        { id: 'f1', key: 'team_size', category: 'tech_stack', content: '60-seat sales org: AEs + SDRs across 2 regions', utteranceIds: ['u3'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
      ],
      concerns: [],
      openLoops: [],
      qualSignals: [],
      decisionGeography: [],
      silenceTopics: [],
      narrative: 'Early discovery. Marcus is Head of RevOps at Streamline. Two stated triggers: AE ramp slipping 60→90 days, and manager time overhead.',
      flow: [
        { turnId: 'u1', speaker: 'rep', tag: 'R-Q', content: 'Opened with context-setting on why reaching out', utteranceIds: ['u1'] },
        { turnId: 'u2', speaker: 'customer', tag: 'OTHER', content: 'Brief rapport exchange', utteranceIds: ['u2'] },
        { turnId: 'u3', speaker: 'rep', tag: 'R-Q', content: 'Asked about team structure', utteranceIds: ['u3'] },
        { turnId: 'u4', speaker: 'customer', tag: 'P-PAIN', content: 'AE ramp slipped from 60 to 90 days over past year', utteranceIds: ['u4'] },
        { turnId: 'u5', speaker: 'rep', tag: 'R-Q', content: 'Asked what\'s prompting coaching tooling look now', utteranceIds: ['u5'] },
        { turnId: 'u6', speaker: 'customer', tag: 'P-PAIN', content: 'Ramp trigger + manager overhead spending too much time managing managers', utteranceIds: ['u6'] },
      ],
      verbatimAnchors: [],
      scorecard: {
        bant: { need: 'vague', budget: 'unknown', authority: 'unknown', timeline: 'unknown' },
        meddic: { metrics: 'unknown', economicBuyer: 'unknown', decisionCriteria: 'unknown', decisionProcess: 'unknown', identifyPain: 'vague', champion: 'unknown' },
        pushQueue: ['need', 'budget', 'authority', 'timeline', 'metrics', 'economicBuyer'],
        hardDisqualify: false, softDisqualifySignals: [],
        talkRatio: { repWords: 180, prospectWords: 210 },
        turnsSinceLastRepQuestion: 0, turnsSinceLastNextStepProposal: 7,
        callMinute: 8,
      },
      bantRender: {}, relevantFacts: [],
    },
    recentSuggestions: [
      { turn: 4, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'drill_vague', markdown: 'silent' },
      { turn: 6, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'drill_vague', markdown: 'silent — ramp trigger noted but vague; memory not yet rich enough' },
    ],
  },

  // ── Case 2: Minute 17, new named stakeholder + authority threshold ───────────
  {
    id: 'c2',
    label: 'C2 · min 17 · new stakeholder + authority threshold (PROSPECT)',
    description: 'Prospect names CRO with budget authority threshold $75K. Need=soft, authority=unknown. Expected: probe_stakeholder or anchor this specific (multi_thread / lock buying signal).',
    gold: { fire: true, play: 'probe_stakeholder', rationale: 'CRO Elena named with explicit role (final sign-off above $75K). Multi-thread: surface her criteria before pricing conversation.' },
    utterance: { id: 'u16', speaker: 'customer', text: "Yeah, so it wouldn't just be me. Our CRO, Elena Romero, she'd have final say on any tech spend above seventy-five K. And she's pretty skeptical of AI tools after the Gong disappointment — she was the one who pushed to rip it out.", startMs: 1020000, endMs: 1036000, confidence: 0.96, derivedFromLowConfidence: false },
    hotTail: [
      { id: 'u14', speaker: 'rep', text: "Who else would be involved in evaluating and signing off on something like this?", ts: 1000000 },
      { id: 'u15', speaker: 'customer', text: "Me primarily. My VP Sales would probably want to see it work first. And then finance if it's a significant spend.", ts: 1010000 },
      { id: 'u16', speaker: 'customer', text: "Yeah, so it wouldn't just be me. Our CRO, Elena Romero, she'd have final say on any tech spend above seventy-five K. And she's pretty skeptical of AI tools after the Gong disappointment — she was the one who pushed to rip it out.", ts: 1020000 },
    ],
    prevMemory: {
      facts: [
        { id: 'f1', key: 'team_size', category: 'team', content: '60-seat sales org; 6 managers; AEs + SDRs across 2 regions', utteranceIds: ['u3'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
        { id: 'f2', key: 'ramp_time', category: 'process', content: 'AE ramp slipped from 60 to 90 days over past year — VP Sales flagged as priority', utteranceIds: ['u4'], confidence: 0.92, extractedAt: Date.now(), revisions: [] },
        { id: 'f3', key: 'manager_admin_waste', category: 'process', content: '4 hrs/week per manager on coaching report prep × 6 managers = 24 hrs/week admin overhead', utteranceIds: ['u7'], confidence: 0.95, extractedAt: Date.now(), revisions: [] },
        { id: 'f4', key: 'prior_tool', category: 'tech_stack', content: 'Gong was in use; ripped out due to cost + managers didn\'t find AI summaries actionable', utteranceIds: ['u9'], confidence: 0.93, extractedAt: Date.now(), revisions: [] },
      ],
      concerns: [
        { id: 'cn1', topic: 'AI tool credibility', verbatim: "Gong's AI summaries weren't actionable enough for our managers", severity: 'pressed', addressed: false, utteranceIds: ['u9'] },
      ],
      openLoops: [
        { id: 'ol1', description: 'Understand what "actionable" looks like to managers in their 1:1 workflow', owner: 'rep', status: 'open' },
      ],
      qualSignals: [],
      decisionGeography: [
        { name: 'VP Sales', role: 'needs to see it work before sign-off', sentiment: 'neutral', utteranceIds: ['u15'] },
      ],
      silenceTopics: [],
      narrative: 'Mid-early discovery. Pain quantified: 24 manager hours/week + ramp slippage. Gong scar tissue present. VP Sales needs proof-of-concept. Authority structure not yet confirmed.',
      flow: [
        { turnId: 'u4', speaker: 'customer', tag: 'P-PAIN', content: 'AE ramp slipped 60→90 days, VP Sales priority', utteranceIds: ['u4'] },
        { turnId: 'u7', speaker: 'customer', tag: 'P-METRIC', content: '4 hrs × 6 managers = 24 hrs/week manager admin overhead', utteranceIds: ['u7'] },
        { turnId: 'u8', speaker: 'rep', tag: 'R-Q', content: 'Drilled for cost impact — good move', utteranceIds: ['u8'] },
        { turnId: 'u9', speaker: 'customer', tag: 'P-OBJ', content: 'Gong ripped out — cost + AI summaries not actionable', utteranceIds: ['u9'] },
        { turnId: 'u10', speaker: 'rep', tag: 'R-Q', content: 'Asked what "actionable" would have looked like', utteranceIds: ['u10'] },
        { turnId: 'u11', speaker: 'customer', tag: 'P-PAIN', content: 'Managers need to walk into 1:1s with top coachable moments pre-identified — no prep', utteranceIds: ['u11'] },
        { turnId: 'u12', speaker: 'rep', tag: 'R-Q', content: 'Asked about success metrics in first 90 days', utteranceIds: ['u12'] },
        { turnId: 'u13', speaker: 'customer', tag: 'P-METRIC', content: 'Ramp delta measurable; manager 1:1 coaching coverage as leading indicator', utteranceIds: ['u13'] },
        { turnId: 'u14', speaker: 'rep', tag: 'R-Q', content: 'Asked who else involved in evaluation', utteranceIds: ['u14'] },
        { turnId: 'u15', speaker: 'customer', tag: 'P-STAKE', content: 'VP Sales + finance for significant spend', utteranceIds: ['u15'] },
      ],
      verbatimAnchors: [
        { turnId: 'u7', axis: 'metric', verbatim: 'four hours a week each just pulling data from Salesforce and formatting it for their 1:1s. We have six managers, so that\'s like twenty-four hours a week of manager time on admin', utteranceIds: ['u7'] },
        { turnId: 'u11', axis: 'need', verbatim: 'managers should walk into 1:1s knowing the top coachable moments per rep without having to prep — right now they\'re winging it', utteranceIds: ['u11'] },
      ],
      scorecard: {
        bant: { need: 'soft', budget: 'unknown', authority: 'unknown', timeline: 'unknown' },
        meddic: { metrics: 'soft', economicBuyer: 'unknown', decisionCriteria: 'vague', decisionProcess: 'vague', identifyPain: 'soft', champion: 'unknown' },
        pushQueue: ['budget', 'authority', 'timeline', 'economicBuyer', 'decisionProcess'],
        hardDisqualify: false, softDisqualifySignals: [],
        talkRatio: { repWords: 420, prospectWords: 580 },
        turnsSinceLastRepQuestion: 0, turnsSinceLastNextStepProposal: 16,
        callMinute: 17,
      },
      bantRender: {}, relevantFacts: [],
    },
    recentSuggestions: [
      { turn: 7, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'quantify_pain', markdown: 'Anchor 24 manager hours — get the loaded cost before moving on.' },
      { turn: 9, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'drill_vague', markdown: 'silent — rep drilled Gong failure mode correctly' },
      { turn: 11, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'drill_vague', markdown: 'silent — manager 1:1 anchor already recorded' },
      { turn: 13, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'push_next_axis', markdown: 'silent — metrics emerging naturally' },
      { turn: 15, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'probe_stakeholder', markdown: 'silent — VP Sales named but no specifics yet' },
    ],
  },

  // ── Case 3: Minute 23, rep defends objection instead of LAER ────────────────
  {
    id: 'c3',
    label: 'C3 · min 23 · rep defends objection — skipped LAER (REP)',
    description: 'Prospect raised Gong burn scar + switching cost concern. Rep jumped straight to comparison pitch without acknowledging or exploring. Expected: rep_defended_objection.',
    gold: { fire: true, play: 'rep_defended_objection', rationale: 'Rep skipped Acknowledge + Explore, went straight to pitch-vs-Gong. The Confirm step is completely absent. Needs LAER redirect.' },
    utterance: { id: 'u23', speaker: 'rep', text: "Totally understand the Gong frustration — their dashboards are notoriously clunky and managers rarely opened them. Our interface is a lot cleaner and we've designed specifically around the coaching 1:1 workflow, not just call recording.", startMs: 1380000, endMs: 1396000, confidence: 0.97, derivedFromLowConfidence: false },
    hotTail: [
      { id: 'u21', speaker: 'rep', text: "And what would it take for Elena specifically to get comfortable after the Gong experience?", ts: 1360000 },
      { id: 'u22', speaker: 'customer', text: "Honestly that's the hardest part. We sunk about a hundred and twenty K into Gong and barely got the value. Switching cost isn't just money — it's the political capital I'd spend asking people to change their workflow again. Elena would need to see it work before she'd even consider it.", ts: 1368000 },
      { id: 'u23', speaker: 'rep', text: "Totally understand the Gong frustration — their dashboards are notoriously clunky and managers rarely opened them. Our interface is a lot cleaner and we've designed specifically around the coaching 1:1 workflow, not just call recording.", ts: 1380000 },
    ],
    prevMemory: {
      facts: [
        { id: 'f1', key: 'team_size', category: 'team', content: '60-seat sales org; 6 managers; AEs + SDRs across 2 regions', utteranceIds: ['u3'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
        { id: 'f2', key: 'ramp_time', category: 'process', content: 'AE ramp slipped from 60 to 90 days over past year', utteranceIds: ['u4'], confidence: 0.92, extractedAt: Date.now(), revisions: [] },
        { id: 'f3', key: 'manager_admin_waste', category: 'process', content: '4 hrs/week per manager × 6 managers = 24 hrs/week admin overhead', utteranceIds: ['u7'], confidence: 0.95, extractedAt: Date.now(), revisions: [] },
        { id: 'f4', key: 'gong_spend', category: 'budget', content: 'Gong cost $120K/year; ripped out Q4 2025 — managers didn\'t adopt', utteranceIds: ['u22'], confidence: 0.94, extractedAt: Date.now(), revisions: [] },
      ],
      concerns: [
        { id: 'cn1', topic: 'AI tool credibility (Gong burn)', verbatim: "We sunk about a hundred and twenty K into Gong and barely got the value. Switching cost isn't just money — it's the political capital I'd spend asking people to change their workflow again.", severity: 'blocking', addressed: false, utteranceIds: ['u22'] },
      ],
      openLoops: [
        { id: 'ol1', description: 'What specifically would Elena need to see to get comfortable — define proof criteria', owner: 'rep', status: 'open' },
        { id: 'ol2', description: 'Pilot scope: how many reps, what success metric, what timeframe', owner: 'rep', status: 'open' },
      ],
      qualSignals: [],
      decisionGeography: [
        { name: 'Elena Romero', role: 'CRO — final sign-off on tech spend above $75K; skeptical of AI tools post-Gong', sentiment: 'negative', utteranceIds: ['u16'] },
        { name: 'VP Sales', role: 'co-decision-maker; needs proof-of-concept', sentiment: 'neutral', utteranceIds: ['u15'] },
      ],
      silenceTopics: [],
      narrative: 'Mid-discovery. Pain confirmed. Gong scar is a blocking concern — both financial ($120K loss) and political (switching cost, Elena skepticism). Authority structure surfaced: Elena CRO gates above $75K.',
      flow: [
        { turnId: 'u7', speaker: 'customer', tag: 'P-METRIC', content: '24 hrs/week manager admin overhead', utteranceIds: ['u7'] },
        { turnId: 'u9', speaker: 'customer', tag: 'P-OBJ', content: 'Gong ripped out — cost + AI summaries not actionable', utteranceIds: ['u9'] },
        { turnId: 'u11', speaker: 'customer', tag: 'P-PAIN', content: 'Managers need pre-identified coaching moments — winging it now', utteranceIds: ['u11'] },
        { turnId: 'u14', speaker: 'rep', tag: 'R-Q', content: 'Asked who else in evaluation', utteranceIds: ['u14'] },
        { turnId: 'u16', speaker: 'customer', tag: 'P-STAKE', content: 'CRO Elena — final sign-off above $75K; skeptical after Gong', utteranceIds: ['u16'] },
        { turnId: 'u17', speaker: 'rep', tag: 'R-Q', content: 'Asked about budget range', utteranceIds: ['u17'] },
        { turnId: 'u18', speaker: 'customer', tag: 'P-BUY', content: 'Budget earmarked $80-90K for coaching specifically', utteranceIds: ['u18'] },
        { turnId: 'u19', speaker: 'rep', tag: 'R-Q', content: 'Asked about timeline', utteranceIds: ['u19'] },
        { turnId: 'u20', speaker: 'customer', tag: 'P-BUY', content: 'Need deployed before Q3 SKO — mid-July deadline', utteranceIds: ['u20'] },
        { turnId: 'u21', speaker: 'rep', tag: 'R-Q', content: 'Asked what Elena would need to get comfortable', utteranceIds: ['u21'] },
        { turnId: 'u22', speaker: 'customer', tag: 'P-OBJ', content: '$120K Gong loss + switching cost political capital concern — Elena needs to see it work first', utteranceIds: ['u22'] },
      ],
      verbatimAnchors: [
        { turnId: 'u7', axis: 'metric', verbatim: 'twenty-four hours a week of manager time on admin', utteranceIds: ['u7'] },
        { turnId: 'u11', axis: 'need', verbatim: 'managers should walk into 1:1s knowing the top coachable moments per rep without having to prep', utteranceIds: ['u11'] },
        { turnId: 'u18', axis: 'budget', verbatim: "we've got $80K earmarked for coaching specifically, maybe up to $90K if it really delivers", utteranceIds: ['u18'] },
        { turnId: 'u20', axis: 'timeline', verbatim: 'need it deployed before Q3 SKO, which is mid-July', utteranceIds: ['u20'] },
        { turnId: 'u22', axis: 'competitor', verbatim: 'we sunk about a hundred and twenty K into Gong and barely got the value', utteranceIds: ['u22'] },
      ],
      scorecard: {
        bant: { need: 'firm', budget: 'partial', authority: 'partial', timeline: 'firm' },
        meddic: { metrics: 'soft', economicBuyer: 'partial', decisionCriteria: 'unknown', decisionProcess: 'vague', identifyPain: 'firm', champion: 'unknown' },
        pushQueue: ['decisionCriteria', 'decisionProcess', 'champion', 'metrics', 'economicBuyer'],
        hardDisqualify: false, softDisqualifySignals: ['Gong burn — re-buy risk requires proof before spend'],
        talkRatio: { repWords: 620, prospectWords: 890 },
        turnsSinceLastRepQuestion: 2, turnsSinceLastNextStepProposal: 23,
        callMinute: 22,
      },
      bantRender: {}, relevantFacts: [],
    },
    recentSuggestions: [
      { turn: 16, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'probe_stakeholder', markdown: 'Get Elena\'s specific proof criteria before budget discussion.' },
      { turn: 18, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'anchor_next_step', markdown: 'silent — budget anchor recorded' },
      { turn: 20, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'anchor_next_step', markdown: 'Lock mid-July SKO as hard deployment deadline — work back a pilot start date.' },
      { turn: 21, speaker: 'rep', agent: 'rep_watcher', fired: false, priority: 'nudge', play: 'none', markdown: 'silent — good question on Elena comfort criteria' },
      { turn: 22, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'reframe_objection', markdown: 'silent — objection surfaced; waiting for rep response' },
    ],
  },

  // ── Case 4: Minute 29, prospect self-identifies as champion ──────────────────
  {
    id: 'c4',
    label: 'C4 · min 29 · prospect self-identifies as champion (PROSPECT)',
    description: 'Prospect explicitly says they\'ll run the internal business case and have pre-sold the CRO on exploration. Champion=unknown in memory. Expected: multi_thread (equip champion, confirm internal selling plan).',
    gold: { fire: true, play: 'multi_thread', rationale: 'Champion self-identification with specific internal role ("I\'ll run the business case"). First time this level of commitment. Lock it and equip Marcus.' },
    utterance: { id: 'u29', speaker: 'customer', text: "Look, I'll be transparent — I've already had a conversation with Elena and she's open to exploring this if the pilot is structured right. If the pilot works, I'll be the one putting together the business case. I know how to frame the ROI story for her.", startMs: 1740000, endMs: 1756000, confidence: 0.97, derivedFromLowConfidence: false },
    hotTail: [
      { id: 'u27', speaker: 'rep', text: "If this goes the way we've described, who would be building the internal case to get Elena across the line?", ts: 1720000 },
      { id: 'u28', speaker: 'customer', text: "That'd be me. I've done it before with other tools — I know how Elena thinks about ROI.", ts: 1730000 },
      { id: 'u29', speaker: 'customer', text: "Look, I'll be transparent — I've already had a conversation with Elena and she's open to exploring this if the pilot is structured right. If the pilot works, I'll be the one putting together the business case. I know how to frame the ROI story for her.", ts: 1740000 },
    ],
    prevMemory: {
      facts: [
        { id: 'f1', key: 'team_size', category: 'team', content: '60-seat sales org; 6 managers', utteranceIds: ['u3'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
        { id: 'f2', key: 'ramp_time', category: 'process', content: 'AE ramp slipped 60→90 days — VP Sales priority', utteranceIds: ['u4'], confidence: 0.92, extractedAt: Date.now(), revisions: [] },
        { id: 'f3', key: 'manager_admin_waste', category: 'process', content: '24 hrs/week manager admin overhead on coaching reports', utteranceIds: ['u7'], confidence: 0.95, extractedAt: Date.now(), revisions: [] },
        { id: 'f4', key: 'gong_spend', category: 'budget', content: 'Gong cost $120K/year; ripped out; managers didn\'t adopt', utteranceIds: ['u22'], confidence: 0.94, extractedAt: Date.now(), revisions: [] },
        { id: 'f5', key: 'pilot_scope_preference', category: 'process', content: 'Elena wants to see pilot work before committing; pilot on small group first', utteranceIds: ['u25'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
      ],
      concerns: [
        { id: 'cn1', topic: 'Gong burn scar', verbatim: "we sunk about a hundred and twenty K into Gong and barely got the value", severity: 'mentioned', addressed: true, utteranceIds: ['u22'] },
      ],
      openLoops: [
        { id: 'ol1', description: 'Define pilot success criteria before start — what metric proves Atlas works for Elena', owner: 'rep', status: 'open' },
        { id: 'ol2', description: 'Confirm VP Sales involvement in pilot scope conversation', owner: 'rep', status: 'open' },
      ],
      qualSignals: [],
      decisionGeography: [
        { name: 'Elena Romero', role: 'CRO — final sign-off above $75K; open to exploring with right pilot structure', sentiment: 'neutral', utteranceIds: ['u16', 'u25'] },
        { name: 'VP Sales', role: 'co-decision-maker; needs proof-of-concept', sentiment: 'neutral', utteranceIds: ['u15'] },
      ],
      silenceTopics: [],
      narrative: 'Mid-to-late discovery. Pain, budget, timeline all established. Gong concern acknowledged and partially addressed. Elena open to pilot if structured correctly. Champion status not yet confirmed.',
      flow: [
        { turnId: 'u18', speaker: 'customer', tag: 'P-BUY', content: '$80-90K budget earmarked for coaching', utteranceIds: ['u18'] },
        { turnId: 'u20', speaker: 'customer', tag: 'P-BUY', content: 'Mid-July SKO deadline', utteranceIds: ['u20'] },
        { turnId: 'u22', speaker: 'customer', tag: 'P-OBJ', content: 'Gong $120K loss — switching cost concern', utteranceIds: ['u22'] },
        { turnId: 'u23', speaker: 'rep', tag: 'R-OBJ-RESP', content: 'Compared to Gong — partial LAER (no acknowledge/explore)', utteranceIds: ['u23'] },
        { turnId: 'u24', speaker: 'customer', tag: 'P-BUY', content: 'Asked about integration with HubSpot and Salesforce', utteranceIds: ['u24'] },
        { turnId: 'u25', speaker: 'rep', tag: 'R-VP', content: 'Confirmed HubSpot + SFDC integration; described pilot structure', utteranceIds: ['u25'] },
        { turnId: 'u26', speaker: 'customer', tag: 'P-BUY', content: 'Responded positively to pilot structure; asked how other RevOps teams measure ROI', utteranceIds: ['u26'] },
        { turnId: 'u27', speaker: 'rep', tag: 'R-Q', content: 'Asked who would build internal business case', utteranceIds: ['u27'] },
        { turnId: 'u28', speaker: 'customer', tag: 'P-BUY', content: 'Marcus says he\'d build the case; knows how Elena thinks about ROI', utteranceIds: ['u28'] },
      ],
      verbatimAnchors: [
        { turnId: 'u7', axis: 'metric', verbatim: 'twenty-four hours a week of manager time on admin', utteranceIds: ['u7'] },
        { turnId: 'u11', axis: 'need', verbatim: 'managers should walk into 1:1s knowing the top coachable moments per rep without having to prep', utteranceIds: ['u11'] },
        { turnId: 'u18', axis: 'budget', verbatim: "we've got $80K earmarked for coaching specifically, maybe up to $90K if it really delivers", utteranceIds: ['u18'] },
        { turnId: 'u20', axis: 'timeline', verbatim: 'deployed before Q3 SKO, which is mid-July', utteranceIds: ['u20'] },
      ],
      scorecard: {
        bant: { need: 'confirmed', budget: 'partial', authority: 'partial', timeline: 'confirmed' },
        meddic: { metrics: 'soft', economicBuyer: 'partial', decisionCriteria: 'vague', decisionProcess: 'partial', identifyPain: 'confirmed', champion: 'unknown' },
        pushQueue: ['champion', 'decisionCriteria', 'metrics', 'decisionProcess'],
        hardDisqualify: false, softDisqualifySignals: [],
        talkRatio: { repWords: 890, prospectWords: 1180 },
        turnsSinceLastRepQuestion: 0, turnsSinceLastNextStepProposal: 29,
        callMinute: 28,
      },
      bantRender: {}, relevantFacts: [],
    },
    recentSuggestions: [
      { turn: 23, speaker: 'rep', agent: 'rep_watcher', fired: true, priority: 'nudge', play: 'rep_defended_objection', markdown: 'Acknowledge the Gong investment lost before pitching Atlas — ask what would\'ve made it worth it.' },
      { turn: 24, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'anchor_next_step', markdown: 'silent — integration questions good sign; rep handled' },
      { turn: 25, speaker: 'rep', agent: 'rep_watcher', fired: false, priority: 'nudge', play: 'none', markdown: 'silent — good integration + pilot description' },
      { turn: 26, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'anchor_next_step', markdown: 'silent — positive signal but cadence check: last fired was t23' },
      { turn: 28, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'multi_thread', markdown: 'silent — champion hint emerging; waiting for more explicit signal' },
    ],
  },

  // ── Case 5: Minute 36, rep pitches price that blows the budget anchor ─────────
  {
    id: 'c5',
    label: 'C5 · min 36 · anchor violation — rep pitches $140K vs $80-90K anchor (REP)',
    description: 'Budget anchor is $80K (up to $90K). Rep proposes $140K standard package. Contradiction should be detected and correct_contradiction fired at critical priority.',
    gold: { fire: true, play: 'correct_contradiction', rationale: '$140K is 56% above the $90K ceiling. Hard anchor violation. Must fire regardless of cadence.' },
    utterance: { id: 'u36', speaker: 'rep', text: "So based on your sixty-seat org, our standard Growth package would be $140K annually — that gets you the full coaching layer, manager dashboards, and call recording. We could also look at a scaled pilot version.", startMs: 2160000, endMs: 2176000, confidence: 0.97, derivedFromLowConfidence: false },
    hotTail: [
      { id: 'u34', speaker: 'rep', text: "Let me pull up our pricing so you can see where we typically land for a team your size.", ts: 2140000 },
      { id: 'u35', speaker: 'customer', text: "Yeah, happy to look at it. I want to make sure we're in the right ballpark before I bring Elena in.", ts: 2150000 },
      { id: 'u36', speaker: 'rep', text: "So based on your sixty-seat org, our standard Growth package would be one hundred and forty K annually — that gets you the full coaching layer, manager dashboards, and call recording. We could also look at a scaled pilot version.", ts: 2160000 },
    ],
    prevMemory: {
      facts: [
        { id: 'f1', key: 'team_size', category: 'team', content: '60-seat sales org; 6 managers', utteranceIds: ['u3'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
        { id: 'f2', key: 'ramp_time', category: 'process', content: 'AE ramp slipped 60→90 days; VP Sales priority', utteranceIds: ['u4'], confidence: 0.92, extractedAt: Date.now(), revisions: [] },
        { id: 'f3', key: 'manager_admin_waste', category: 'process', content: '24 hrs/week manager admin overhead on coaching reports', utteranceIds: ['u7'], confidence: 0.95, extractedAt: Date.now(), revisions: [] },
        { id: 'f4', key: 'champion_confirmed', category: 'process', content: 'Marcus will build internal business case; pre-sold Elena on exploration; knows her ROI frame', utteranceIds: ['u29'], confidence: 0.95, extractedAt: Date.now(), revisions: [] },
        { id: 'f5', key: 'pilot_agreed', category: 'process', content: 'Pilot agreed in principle: 3–5 reps, 2 weeks; success metrics to be defined', utteranceIds: ['u31'], confidence: 0.9, extractedAt: Date.now(), revisions: [] },
      ],
      concerns: [],
      openLoops: [
        { id: 'ol1', description: 'Define pilot success metric before kickoff — Marcus needs this for Elena\'s business case', owner: 'rep', status: 'open' },
        { id: 'ol2', description: 'Schedule next call with Marcus + Elena + VP Sales to align on pilot terms', owner: 'rep', status: 'open' },
      ],
      qualSignals: [],
      decisionGeography: [
        { name: 'Elena Romero', role: 'CRO — final sign-off; open to pilot', sentiment: 'neutral', utteranceIds: ['u16', 'u29'] },
        { name: 'VP Sales', role: 'co-decision-maker', sentiment: 'neutral', utteranceIds: ['u15'] },
        { name: 'Marcus Webb', role: 'Champion — will build and present business case', sentiment: 'positive', utteranceIds: ['u29'] },
      ],
      silenceTopics: [],
      narrative: 'Late discovery, pre-close. Pain confirmed, champion confirmed (Marcus), budget anchored at $80-90K, timeline mid-July. Pilot structure agreed. Rep about to discuss pricing.',
      flow: [
        { turnId: 'u18', speaker: 'customer', tag: 'P-BUY', content: '$80-90K budget for coaching specifically', utteranceIds: ['u18'] },
        { turnId: 'u20', speaker: 'customer', tag: 'P-BUY', content: 'Mid-July SKO deadline', utteranceIds: ['u20'] },
        { turnId: 'u29', speaker: 'customer', tag: 'P-BUY', content: 'Marcus champion confirmation — will build business case, Elena pre-sold on exploring', utteranceIds: ['u29'] },
        { turnId: 'u30', speaker: 'rep', tag: 'R-Q', content: 'Asked what ROI story would resonate with Elena', utteranceIds: ['u30'] },
        { turnId: 'u31', speaker: 'customer', tag: 'P-BUY', content: 'Ramp-time delta vs loaded cost of a failing AE is the Elena ROI frame', utteranceIds: ['u31'] },
        { turnId: 'u32', speaker: 'rep', tag: 'R-NS', content: 'Proposed next step: scoping call with Marcus + Elena + 1 manager', utteranceIds: ['u32'] },
        { turnId: 'u33', speaker: 'customer', tag: 'P-BUY', content: 'Agreed on scoping call; asked about Tuesday options', utteranceIds: ['u33'] },
        { turnId: 'u34', speaker: 'rep', tag: 'OTHER', content: 'Pivoted to pricing discussion before next step confirmed', utteranceIds: ['u34'] },
        { turnId: 'u35', speaker: 'customer', tag: 'OTHER', content: 'Agreed to look at pricing to check ballpark', utteranceIds: ['u35'] },
      ],
      verbatimAnchors: [
        { turnId: 'u7', axis: 'metric', verbatim: 'twenty-four hours a week of manager time on admin', utteranceIds: ['u7'] },
        { turnId: 'u11', axis: 'need', verbatim: 'managers should walk into 1:1s knowing the top coachable moments per rep without having to prep', utteranceIds: ['u11'] },
        { turnId: 'u18', axis: 'budget', verbatim: "we've got $80K earmarked for coaching specifically, maybe up to $90K if it really delivers", utteranceIds: ['u18'] },
        { turnId: 'u20', axis: 'timeline', verbatim: 'deployed before Q3 SKO, which is mid-July', utteranceIds: ['u20'] },
        { turnId: 'u29', axis: 'champion', verbatim: "if the pilot works, I'll be the one putting together the business case. I know how to frame the ROI story for her", utteranceIds: ['u29'] },
      ],
      scorecard: {
        bant: { need: 'confirmed', budget: 'partial', authority: 'confirmed', timeline: 'confirmed' },
        meddic: { metrics: 'soft', economicBuyer: 'confirmed', decisionCriteria: 'soft', decisionProcess: 'firm', identifyPain: 'confirmed', champion: 'confirmed' },
        pushQueue: ['metrics', 'decisionCriteria'],
        hardDisqualify: false, softDisqualifySignals: [],
        talkRatio: { repWords: 1240, prospectWords: 1580 },
        turnsSinceLastRepQuestion: 4, turnsSinceLastNextStepProposal: 4,
        callMinute: 35,
      },
      bantRender: {}, relevantFacts: [],
    },
    recentSuggestions: [
      { turn: 29, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'multi_thread', markdown: 'Lock Marcus as champion — get his exact ROI frame for the Elena business case.' },
      { turn: 31, speaker: 'customer', agent: 'prospect_suggester', fired: false, priority: 'nudge', play: 'anchor_next_step', markdown: 'silent — rep handled ROI discussion' },
      { turn: 32, speaker: 'rep', agent: 'rep_watcher', fired: false, priority: 'nudge', play: 'anchor_next_step', markdown: 'silent — rep proposed good next step' },
      { turn: 33, speaker: 'customer', agent: 'prospect_suggester', fired: true, priority: 'nudge', play: 'anchor_next_step', markdown: 'Nail down Tuesday time + attendee list while momentum is here.' },
      { turn: 34, speaker: 'rep', agent: 'rep_watcher', fired: false, priority: 'nudge', play: 'rep_off_ladder', markdown: 'silent — pricing pivot noted but not a clear break yet' },
    ],
  },
];

// ── Model variants ────────────────────────────────────────────────────────────
type ReasoningParam = { enabled: false } | { effort: 'low' | 'minimal' | 'none' };
type Variant = { label: string; orId: string; reasoning?: ReasoningParam };

const VARIANTS: Variant[] = [
  { label: 'qwen3.6-35b-a3b',           orId: 'qwen/qwen3.6-35b-a3b',                 reasoning: { enabled: false } },
  { label: 'qwen3.6-27b',               orId: 'qwen/qwen3.6-27b',                     reasoning: { enabled: false } },
  { label: 'qwen3.5-9b',                orId: 'qwen/qwen3.5-9b',                      reasoning: { enabled: false } },
  { label: 'gemma-4-31b-it',            orId: 'google/gemma-4-31b-it',                reasoning: { enabled: false } },
  { label: 'gemma-4-26b-a4b-it',        orId: 'google/gemma-4-26b-a4b-it',            reasoning: { enabled: false } },
  { label: 'glm-4.7-flash',             orId: 'z-ai/glm-4.7-flash',                   reasoning: { enabled: false } },
  { label: 'gpt-oss-20b',               orId: 'openai/gpt-oss-20b',                   reasoning: { effort: 'low' } },
  { label: 'nemotron-3-nano-30b',        orId: 'nvidia/nemotron-3-nano-30b-a3b' },
  { label: 'deepseek-chat-v3.1',         orId: 'deepseek/deepseek-chat-v3.1',          reasoning: { enabled: false } },
  { label: 'deepseek-v3.1-terminus',     orId: 'deepseek/deepseek-v3.1-terminus',      reasoning: { enabled: false } },
  { label: 'deepseek-v4-flash',          orId: 'deepseek/deepseek-v4-flash',           reasoning: { enabled: false } },
  { label: 'llama-4-maverick',           orId: 'meta-llama/llama-4-maverick' },
  { label: 'llama-3.3-70b-instruct',     orId: 'meta-llama/llama-3.3-70b-instruct' },
];

// ── Pricing cache ─────────────────────────────────────────────────────────────
const modelPricing = new Map<string, { promptPer1M: number; completionPer1M: number }>();
{
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data: any = await r.json();
    for (const m of (data?.data ?? [])) {
      if (m?.pricing) {
        modelPricing.set(m.id, {
          promptPer1M: parseFloat(m.pricing.prompt ?? '0') * 1e6,
          completionPer1M: parseFloat(m.pricing.completion ?? '0') * 1e6,
        });
      }
    }
    console.log(`Pricing loaded for ${modelPricing.size} models\n`);
  } catch (e) {
    console.warn('Pricing fetch failed, cost will show as N/A');
  }
}

// ── Semaphore ─────────────────────────────────────────────────────────────────
function makeSemaphore(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = () => new Promise<void>(resolve => {
    if (active < limit) { active++; resolve(); }
    else queue.push(resolve);
  });
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  return { acquire, release };
}
const sem = makeSemaphore(30);

// ── Per-call runner ───────────────────────────────────────────────────────────
type RunResult = {
  caseId: string; variantLabel: string; orId: string;
  ok: boolean; ttftMs: number; ttltMs: number;
  promptTokens: number; completionTokens: number; costUsd: number;
  raw: string; parsed: any; error?: string;
};

async function runOne(tc: TestCase, v: Variant, attempt = 0): Promise<RunResult> {
  await sem.acquire();
  const base: Omit<RunResult, 'ok' | 'ttftMs' | 'ttltMs' | 'promptTokens' | 'completionTokens' | 'costUsd' | 'raw' | 'parsed' | 'error'> = {
    caseId: tc.id, variantLabel: v.label, orId: v.orId,
  };
  const start = Date.now();
  let ttftMs = -1;

  const userPrompt = buildSuggesterPrompt({
    utterance: tc.utterance,
    hotTail: tc.hotTail,
    prevMemory: tc.prevMemory,
    brief: BRIEF,
    recentSuggestions: tc.recentSuggestions,
  });

  const body: any = {
    model: v.orId,
    messages: [
      { role: 'system', content: SUGGESTER_SYSTEM },
      { role: 'user', content: `${userPrompt}\n\n${SUG_JSON_INSTR}` },
    ],
    max_tokens: 512,
    stream: true,
    temperature: 0,
  };
  if (v.reasoning) body.reasoning = v.reasoning;

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      sem.release();
      return { ...base, ok: false, ttftMs: -1, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, costUsd: 0, raw: '', parsed: null, error: `HTTP ${resp.status}: ${err.slice(0, 200)}` };
    }

    let raw = '';
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of resp.body as any) {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const d = JSON.parse(payload);
          // Usage
          if (d?.usage) {
            promptTokens = d.usage.prompt_tokens ?? promptTokens;
            completionTokens = d.usage.completion_tokens ?? completionTokens;
          }
          const content: string | null = d?.choices?.[0]?.delta?.content ?? null;
          if (typeof content === 'string' && content.length > 0) {
            if (ttftMs < 0) ttftMs = Date.now() - start;
            raw += content;
          }
        } catch {}
      }
    }

    const ttltMs = Date.now() - start;
    const pricing = modelPricing.get(v.orId);
    const costUsd = pricing
      ? (promptTokens / 1e6) * pricing.promptPer1M + (completionTokens / 1e6) * pricing.completionPer1M
      : 0;

    // Parse JSON from response (strip think blocks if any leaked through)
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    let parsed: any = null;
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try { parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)); } catch {}
    }

    sem.release();
    return { ...base, ok: true, ttftMs, ttltMs, promptTokens, completionTokens, costUsd, raw, parsed };
  } catch (err) {
    sem.release();
    const isTransient = String(err).includes('socket') || String(err).includes('ECONNRESET') || String(err).includes('connect');
    if (isTransient && attempt < 1) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
      return runOne(tc, v, attempt + 1);
    }
    return { ...base, ok: false, ttftMs: -1, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, costUsd: 0, raw: '', parsed: null, error: String(err).slice(0, 200) };
  }
}

// ── Run all 65 calls ──────────────────────────────────────────────────────────
console.log(`Running ${CASES.length} cases × ${VARIANTS.length} models = ${CASES.length * VARIANTS.length} calls...\n`);
const startAll = Date.now();

const allResults = await Promise.all(
  CASES.flatMap(tc => VARIANTS.map(v => runOne(tc, v)))
);

console.log(`\nAll calls complete in ${((Date.now() - startAll) / 1000).toFixed(1)}s\n`);

// ── Aggregate table ───────────────────────────────────────────────────────────
type ModelStats = {
  label: string; orId: string;
  n: number; ok: number; parseOk: number;
  ttft: number[]; ttlt: number[];
  totalCost: number;
  fireRate: number; correctFireRate: number;
  c5Fires: boolean; // case 5 is the anchor violation — must fire at critical
};

const statMap = new Map<string, ModelStats>();
for (const v of VARIANTS) {
  statMap.set(v.label, { label: v.label, orId: v.orId, n: 0, ok: 0, parseOk: 0, ttft: [], ttlt: [], totalCost: 0, fireRate: 0, correctFireRate: 0, c5Fires: false });
}

for (const r of allResults) {
  const st = statMap.get(r.variantLabel)!;
  st.n++;
  if (r.ok) { st.ok++; st.ttft.push(r.ttftMs); st.ttlt.push(r.ttltMs); st.totalCost += r.costUsd; }
  if (r.parsed) { st.parseOk++; }
  if (r.caseId === 'c5' && r.parsed?.shouldFire === true && r.parsed?.play === 'correct_contradiction') {
    st.c5Fires = true;
  }
}

// Compute rates
for (const r of allResults) {
  const tc = CASES.find(c => c.id === r.caseId)!;
  const st = statMap.get(r.variantLabel)!;
  if (r.parsed) {
    if (r.parsed.shouldFire === tc.gold.fire) st.correctFireRate++;
    if (r.parsed.shouldFire) st.fireRate++;
  }
}
for (const st of statMap.values()) {
  st.fireRate = st.parseOk > 0 ? st.fireRate / st.parseOk : 0;
  st.correctFireRate = st.parseOk > 0 ? st.correctFireRate / st.parseOk : 0;
}

function pct(n: number) { return (n * 100).toFixed(0) + '%'; }
function avg(arr: number[]) { return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function p50(arr: number[]) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.5)]; }

const W = [28, 8, 8, 10, 10, 12, 10, 10, 8];
const cols = ['model', 'ok/n', 'parse%', 'avgTTFT', 'avgTTLT', 'cost/1k $', 'fire%', 'correct%', 'c5✓?'];
console.log('\n' + cols.map((c, i) => c.padEnd(W[i])).join('  '));
console.log(W.map(w => '─'.repeat(w)).join('  '));

for (const [, st] of statMap) {
  const c1k = st.ok > 0 ? (st.totalCost / st.ok * 1000).toFixed(2) : 'N/A';
  const row = [
    st.label,
    `${st.ok}/${st.n}`,
    pct(st.parseOk / Math.max(st.n, 1)),
    `${avg(st.ttft).toFixed(0)}ms`,
    `${avg(st.ttlt).toFixed(0)}ms`,
    c1k,
    pct(st.fireRate),
    pct(st.correctFireRate),
    st.c5Fires ? '✓' : '✗',
  ];
  console.log(row.map((c, i) => String(c).padEnd(W[i])).join('  '));
}

// ── Per-case verbatim side-by-side ───────────────────────────────────────────
const FOCUS = ['gpt-oss-20b', 'gemma-4-26b-a4b-it', 'qwen3.6-35b-a3b'];
const COL_W = 52;
const pad = (s: string) => s.length > COL_W ? s.slice(0, COL_W - 1) + '…' : s.padEnd(COL_W);

console.log('\n\n══════════════════════════════════════════════════════════════════════════════════');
console.log('VERBATIM SIDE-BY-SIDE (gpt-oss-20b vs gemma-4-26b vs qwen3.6-35b)');
console.log('══════════════════════════════════════════════════════════════════════════════════\n');

for (const tc of CASES) {
  console.log(`\n┌─ ${tc.label}`);
  console.log(`│  ${tc.utterance.speaker.toUpperCase()}: "${tc.utterance.text.slice(0, 120)}${tc.utterance.text.length > 120 ? '…' : ''}"`);
  console.log(`│  GOLD: fire=${tc.gold.fire} play=${tc.gold.play ?? 'n/a'} — ${tc.gold.rationale}`);
  console.log(`│  ${'─'.repeat(COL_W * FOCUS.length + (FOCUS.length - 1) * 2)}`);

  const header = FOCUS.map(f => f.padEnd(COL_W)).join('  ');
  console.log(`│  ${header}`);

  // fire/play row
  const fireRow = FOCUS.map(label => {
    const r = allResults.find(x => x.variantLabel === label && x.caseId === tc.id);
    if (!r || !r.parsed) return (r?.error ? `ERR: ${r.error.slice(0, 30)}` : 'no parse').padEnd(COL_W);
    const f = r.parsed.shouldFire ? '🔥' : '🤐';
    const play = r.parsed.play ?? '?';
    const pri = r.parsed.priority ?? '?';
    return `${f} [${play}/${pri}]`.padEnd(COL_W);
  });
  console.log(`│  ${fireRow.join('  ')}`);

  // markdown row
  const mdRow = FOCUS.map(label => {
    const r = allResults.find(x => x.variantLabel === label && x.caseId === tc.id);
    if (!r?.parsed?.shouldFire) return pad('');
    return pad(`"${r.parsed.markdown ?? '(no text)'}"`);
  });
  console.log(`│  ${mdRow.join('  ')}`);

  // timing row
  const timeRow = FOCUS.map(label => {
    const r = allResults.find(x => x.variantLabel === label && x.caseId === tc.id);
    if (!r) return pad('');
    return pad(`TTFT ${r.ttftMs}ms / TTLT ${r.ttltMs}ms`);
  });
  console.log(`│  ${timeRow.join('  ')}`);

  console.log(`└${'─'.repeat(COL_W * FOCUS.length + (FOCUS.length - 1) * 2 + 2)}`);
}

// ── Save full results JSON ────────────────────────────────────────────────────
const outPath = '/tmp/bench-realistic-results.json';
await Bun.write(outPath, JSON.stringify({ cases: CASES.map(c => ({ id: c.id, label: c.label, gold: c.gold })), results: allResults }, null, 2));
console.log(`\nFull results saved to ${outPath}`);
