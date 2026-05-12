#!/usr/bin/env bun
/**
 * eval-dag-v3.ts
 *
 * Five improvements wired into one head-to-head eval:
 *   1. Generative judge (claude-opus-4.7 via OpenRouter)
 *   2. Split architecture (detector → labeler → writer) vs monolithic v2
 *   3. Outcome tracking (did the rep act on the whisper next turn?)
 *   4. Memory-quality eval (actual DAG vs hand-authored ideal)
 *   5. Confidence on DAG nodes (tentative | stated | confirmed)
 *
 * Measures per stage:
 *   - Latency (ms)
 *   - Input/output tokens
 *   - Cost estimate (USD)
 *
 * Usage: bun scripts/eval-dag-v3.ts  (env loaded via .env.local)
 */
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dir, '..'));

const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error('ERROR: OPENROUTER_API_KEY not set'); process.exit(1); }

const OP_MODEL = 'openai/gpt-oss-20b';
const JUDGE_MODEL = 'deepseek/deepseek-v4-flash';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const N_RUNS = Number(process.env.N_RUNS ?? 3);

// Cost per 1M tokens (USD, approx OpenRouter pricing — updated 2026-05)
const PRICES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'openai/gpt-oss-20b':        { inputPer1M: 0.05,  outputPer1M: 0.20 },
  'anthropic/claude-opus-4.7': { inputPer1M: 15.0,  outputPer1M: 75.0 },
  'deepseek/deepseek-v4-flash': { inputPer1M: 0.054, outputPer1M: 0.45 },
};

// ─── Fixture (same 12-turn founder call) ────────────────────────────────────

type Utt = { id: string; speaker: 'rep' | 'customer'; text: string };
const TRANSCRIPT: Utt[] = [
  { id: 'u01', speaker: 'rep',      text: "Hey Priya, thanks for jumping on. I'm Marcus from HireLoop. You've got about 30 minutes, right?" },
  { id: 'u02', speaker: 'customer', text: "Yeah, that works. Looking forward to hearing what you've got." },
  { id: 'u03', speaker: 'rep',      text: "Awesome. I read on LinkedIn you've been growing fast — what's been the biggest challenge with hiring at TechCo recently?" },
  { id: 'u04', speaker: 'customer', text: "Honestly we're just drowning. Like, my team is exhausted. Reqs are piling up and we can't seem to close fast enough." },
  { id: 'u05', speaker: 'rep',      text: "When you say 'can't close fast enough' — is it the volume of reqs, the candidate quality, the time to fill, or something else?" },
  { id: 'u06', speaker: 'customer', text: "Mostly time to fill. We've got like 40 reqs open this quarter, and our average is sitting around 55 days. We need to be at 30. We've missed our hiring plan by 30% YTD." },
  { id: 'u07', speaker: 'rep',      text: "Got it. Tell me about your tech stack — what are you using for ATS, sourcing, etc?" },
  { id: 'u08', speaker: 'customer', text: "We use Greenhouse for ATS, LinkedIn Recruiter for sourcing. We tried Gem for outbound but didn't see the ROI so we cut it." },
  { id: 'u09', speaker: 'rep',      text: "Yeah Gem can be hit or miss. HireLoop is purpose-built for time-to-fill — we use AI to auto-source, screen, and schedule, which usually cuts your filling time in half. We integrate with Greenhouse, have automated screening, custom workflows, candidate scoring." },
  { id: 'u10', speaker: 'customer', text: "Sounds nice in theory but we've been burned by AI tools before. The screening always ends up needing to be reviewed manually anyway and we lose more time." },
  { id: 'u11', speaker: 'rep',      text: "Right, but HireLoop's AI is trained on real recruiting data and we have a 90% accuracy rate on screening. Our customers see meaningful time savings within the first month — we have case studies." },
  { id: 'u12', speaker: 'customer', text: "Mm. Well, my Director of Talent, Eva, would be the one actually using something like this. She's pretty discerning about new tools." },
];

type Gold = { fire: false } | { fire: true; play: string; rationale: string };
const GOLD: Record<string, Gold> = {
  u01: { fire: false }, u02: { fire: false }, u03: { fire: false },
  u04: { fire: true,  play: 'drill_pain',                rationale: 'vague pain' },
  u05: { fire: false },
  u06: { fire: true,  play: 'quantify',                  rationale: 'specifics dropped, cost unexplored' },
  u07: { fire: true,  play: 'rep_skipped_drill',         rationale: 'rep pivoted from quantified pain' },
  u08: { fire: false },
  u09: { fire: true,  play: 'rep_pitching_in_discovery', rationale: 'feature dump while pain unanchored' },
  u10: { fire: false },
  u11: { fire: true,  play: 'rep_defending',             rationale: 'defended without acknowledging' },
  u12: { fire: true,  play: 'probe_stakeholder',         rationale: 'new stakeholder named with role' },
};

const BRIEF = {
  lead: { name: 'Priya Sharma', title: 'Head of People', company: 'TechCo', size: '150 people, Series B' },
  callGoal: 'qualify',
  pastInteractions: [{ type: 'linkedin', summary: 'TechCo hiring aggressively post Series B' }],
  productSnippets: [
    'HireLoop cuts time-to-fill 40-60% via AI sourcing, screening, scheduling',
    'Native Greenhouse + Lever integration',
    'Customers see ~25-day reduction in time-to-fill',
  ],
};

// ─── Hand-authored IDEAL DAG (for memory quality eval) ──────────────────────

type IdealNode = { id: string; category: string; content: string; confidence: 'tentative' | 'stated' | 'confirmed' };
const IDEAL_DAG_NODES: IdealNode[] = [
  // u04
  { id: 'pain_hiring_volume',         category: 'pain',        content: 'drowning in hiring, team exhausted, can\'t close fast enough', confidence: 'tentative' },
  // u06
  { id: 'evidence_open_reqs',         category: 'evidence',    content: '40 reqs open this quarter',                                    confidence: 'stated' },
  { id: 'evidence_time_to_fill',      category: 'evidence',    content: 'average 55 days, target 30',                                   confidence: 'stated' },
  { id: 'evidence_hiring_miss',       category: 'evidence',    content: 'missed hiring plan by 30% YTD',                                 confidence: 'stated' },
  // u08
  { id: 'evidence_ats',               category: 'evidence',    content: 'Greenhouse for ATS',                                            confidence: 'stated' },
  { id: 'evidence_sourcing',          category: 'evidence',    content: 'LinkedIn Recruiter for sourcing',                               confidence: 'stated' },
  { id: 'objection_prior_ai_failed',  category: 'objection',   content: 'tried Gem, didn\'t see ROI, cut it',                            confidence: 'stated' },
  // u09 (rep assertions)
  { id: 'assertion_ai_capabilities',  category: 'assertion',   content: 'HireLoop does AI sourcing, screening, scheduling',              confidence: 'stated' },
  // u10
  { id: 'objection_ai_screening',     category: 'objection',   content: 'AI screening needs manual review, loses time',                  confidence: 'stated' },
  // u11
  { id: 'assertion_accuracy_rate',    category: 'assertion',   content: 'HireLoop 90% screening accuracy',                               confidence: 'stated' },
  // u12
  { id: 'stakeholder_eva',            category: 'stakeholder', content: 'Eva, Director of Talent, discerning about tools',               confidence: 'stated' },
];
const IDEAL_EDGE_COUNT = 4; // approximate — quantification edges, contradicts on u11→u10, etc.

// ─── LLM call helper ────────────────────────────────────────────────────────

type LLMResult = { content: string; inputTokens: number; outputTokens: number; latencyMs: number; model: string };
async function callLLM(system: string, user: string, model: string, label: string, jsonMode = true): Promise<LLMResult> {
  const t0 = Date.now();
  const body: any = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: model.startsWith('deepseek') ? 3000 : 1500,  // reasoning models need headroom
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (model.startsWith('openai/gpt-oss')) body.reasoning = { effort: 'low' };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${label} (${model}) HTTP ${res.status}: ${errText.slice(0, 250)}`);
  }
  const data = await res.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs, model,
  };
}

function tryParseJSON(text: string): any {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    return null;
  }
}

function costUSD(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (inTok / 1_000_000) * p.inputPer1M + (outTok / 1_000_000) * p.outputPer1M;
}

// ─── DAG types with confidence ──────────────────────────────────────────────

type DagNode = { id: string; category: string; content: string; confidence: 'tentative' | 'stated' | 'confirmed'; sourceUtteranceId: string; addedAtTurn: number };
type DagEdge = { from: string; to: string; type: string; sourceUtteranceId: string; addedAtTurn: number };
type Dag = { nodes: DagNode[]; edges: DagEdge[] };

// ─── Memory agent (v3, with confidence) ─────────────────────────────────────

const MEMORY_SYSTEM_V3 = `You maintain a knowledge graph of sales-relevant information learned during a discovery call. After each utterance, decide: did anything sales-meaningful just get added?

If yes: emit new nodes (knowledge added) and/or new edges (relationships).
If no: emit empty arrays. Most turns will be empty — that's expected.

# Record
- Pain: specific challenges or problems the prospect named
- Evidence: numbers, deadlines, named stakeholders with role, vendors, dollar amounts
- Objections: concerns or skepticism raised
- Commitments: next-step proposals
- Assertions: rep claims that anchor future expectations
- References (edge only): latest utterance calls back to an earlier topic
- Contradictions (edge): latest utterance conflicts with an established node
- Resolutions (edge): an open loop just got closed

# Do not record
- Rapport, acknowledgments, restatements without new specifics
- Generic discovery questions (record the answer, not the question)
- Anything already in the brief unless new context added

# Confidence on every node
- tentative: hedged ("I think", "probably", "kind of", "around"), speculative, soft
- stated:    clear assertion, single source
- confirmed: anchored — rep acknowledged it AND prospect didn't walk it back later

# Node IDs
- Short readable. Examples: "pain_time_to_fill", "stakeholder_eva", "objection_ai_burnt"
- REUSE existing node IDs (listed in DAG STATE) when knowledge connects.

# Edges (only 5)
- evidences | resolves | references | contradicts | follows_up

# Output JSON
{
  "reasoning": "<one sentence>",
  "newNodes": [{"id":"...","category":"pain|evidence|objection|stakeholder|commitment|assertion|other","content":"...","confidence":"tentative|stated|confirmed","sourceUtteranceId":"..."}],
  "newEdges": [{"from":"...","to":"...","type":"...","sourceUtteranceId":"..."}]
}

Empty arrays if nothing new. JSON only.`;

function renderDag(dag: Dag): string {
  if (dag.nodes.length === 0) return '(empty)';
  const out: string[] = [];
  for (const n of dag.nodes) {
    const incomingResolves = dag.edges.filter((e) => e.to === n.id && e.type === 'resolves');
    const status = incomingResolves.length > 0 ? 'resolved' : 'OPEN';
    out.push(`- ${n.id} [${n.category}, ${n.confidence}, ${status} from ${n.sourceUtteranceId}]: "${n.content}"`);
  }
  if (dag.edges.length) {
    out.push('Edges:');
    for (const e of dag.edges) out.push(`- ${e.from} --${e.type}--> ${e.to}`);
  }
  return out.join('\n');
}

function applyDelta(dag: Dag, delta: any, turnNum: number): Dag {
  const newDag: Dag = { nodes: [...dag.nodes], edges: [...dag.edges] };
  if (Array.isArray(delta?.newNodes)) {
    for (const n of delta.newNodes) {
      if (!n.id || !n.content || newDag.nodes.some((x) => x.id === n.id)) continue;
      newDag.nodes.push({
        id: String(n.id), category: String(n.category ?? 'other'),
        content: String(n.content), confidence: (n.confidence as any) ?? 'stated',
        sourceUtteranceId: String(n.sourceUtteranceId ?? ''), addedAtTurn: turnNum,
      });
    }
  }
  if (Array.isArray(delta?.newEdges)) {
    for (const e of delta.newEdges) {
      if (!e.from || !e.to || !e.type) continue;
      newDag.edges.push({
        from: String(e.from), to: String(e.to), type: String(e.type),
        sourceUtteranceId: String(e.sourceUtteranceId ?? ''), addedAtTurn: turnNum,
      });
    }
  }
  return newDag;
}

// ─── Phase + rep state ──────────────────────────────────────────────────────

function inferPhase(turn: number, dag: Dag, currentText: string): string {
  const text = currentText.toLowerCase();
  const painLang = /\b(drown|exhaust|struggl|messy|painful|problem|challeng|frustrat|broken|stuck|miss(ed|ing)|burn)/i.test(text);
  const numLang = /\b\d+\s*(?:%|percent|days?|weeks?|months?|hours?|hires?|reps?|customers?|leads?|k\b|m\b)\b/i.test(text);
  const hasPain = dag.nodes.some((n) => n.category === 'pain') || painLang;
  const hasEvidence = dag.nodes.some((n) => n.category === 'evidence') || numLang;
  const hasStakeholder = dag.nodes.some((n) => n.category === 'stakeholder');
  const hasCommitment = dag.nodes.some((n) => n.category === 'commitment');
  if (turn < 3) return 'OPEN';
  if (hasCommitment) return turn / TRANSCRIPT.length > 0.85 ? 'CLOSE' : 'ADVANCE';
  if (hasStakeholder && hasPain && hasEvidence) return 'MAP';
  if (hasPain || hasEvidence) return 'DIAGNOSE';
  return 'OPEN';
}

function computeRepState(tail: Utt[]): string {
  const repTurns = tail.filter((u) => u.speaker === 'rep');
  if (repTurns.length === 0) return '(no rep turns yet)';
  const last = repTurns[repTurns.length - 1];
  const wc = last.text.split(/\s+/).length;
  const claims = (last.text.match(/we (?:have|do|use|integrate|offer)|HireLoop|our AI|our customers/gi) || []).length;
  const flags: string[] = [];
  if (wc > 70) flags.push(`monologuing (${wc}w)`);
  if (claims >= 3) flags.push(`pitching_in_discovery (${claims} claims)`);
  return flags.length === 0 ? '(no flags)' : flags.join('; ');
}

// ─── MONOLITHIC SUGGESTER (v2, event-driven, our current best) ──────────────

const MONO_SYSTEM = `You are a live coach for a sales rep on a discovery call. After each utterance you make ONE decision: did something just happen that needs a coaching response RIGHT NOW?

Coaching is EVENT-DRIVEN. React to what just happened in the latest utterance. Do NOT react to state. If nothing coachable happened this turn, stay silent — even if there are unresolved loops in memory.

# Steps (in order)

## Step 1: What EVENT in the latest utterance?
  (a) Prospect opened a door — pain, specific, objection, stakeholder, commitment
  (b) Rep made a mistake — pitched, defended, skipped, caved, advanced too early
  (c) Nothing coachable — rapport, acknowledgment, factual answer, valid question/response
If (c): shouldFire=false. Stop.

## Step 2: Who spoke? (gates eligible plays)
PROSPECT TURN plays: drill_pain | quantify | probe_stakeholder | multi_thread | anchor_commitment | confirm_understanding | surface_brief_context
REP TURN plays: rep_skipped_drill | rep_pitching_in_discovery | rep_defending | rep_caving | slow_down | handle_objection | surface_brief_context
A play on the wrong speaker side → shouldFire=false.

## Step 3: For prospect-signal plays, did the rep ALREADY handle it?
If the immediately prior rep utterance already made the move → silent.

## Step 4: Match event to play trigger
drill_pain — prospect just stated VAGUE pain (no number/owner/workflow)
quantify — prospect just dropped a SPECIFIC (number/deadline) and downstream impact unexplored
probe_stakeholder — prospect just named a NEW stakeholder with role AND pain anchored in DAG
multi_thread — prospect just offered to involve someone internally
anchor_commitment — prospect just proposed a vague next step
confirm_understanding — prospect dropped a lot of related info, rep hasn't reflected
rep_skipped_drill — rep just pivoted away from a quantified prospect pain without anchoring cost
rep_pitching_in_discovery — rep just made ≥2 product claims while pain still vague/unanchored
rep_defending — rep just responded to objection with counter-claims instead of acknowledging+exploring
rep_caving — rep just made a concession before value anchored
slow_down — rep just attempted to advance before discovery complete
handle_objection — rep responding to objection without acknowledging

If you can't name the specific event triggering the play, do not fire.

## Step 5: Cadence
Same play in last 2 turns → don't repeat.

# Confidence on DAG nodes (use this)
Each DAG node has a confidence: tentative | stated | confirmed.
- tentative: hedged ("I think", "around", "kind of"), speculative
- stated: clear assertion, single source
- confirmed: anchored — rep acknowledged AND prospect hasn't walked back

Adjustments to play choice based on confidence:
- A specific dropped (number/deadline) on top of a tentative pain → quantify (the specific upgrades the pain to stated)
- Stakeholder named while DAG pain is still tentative → silent (pain anchoring matters more than stakeholder mapping)
- Rep skipped past a tentative pain → drill_pain (push for specifics) NOT rep_skipped_drill (skipped_drill requires confirmed/stated pain underneath)
- Objection raised contradicting a confirmed anchor → flag the contradiction explicitly in the markdown

# Voice
6-12 words, action verb first, no jargon. Examples:
- "Pin the cost of those 30% missed hires."
- "Acknowledge the burn before pitching accuracy."

# Output JSON
{"event":"<phrase>","speaker":"rep|prospect","rep_already_handled":<bool|null>,"shouldFire":<bool>,"play":"<name>","markdown":"<6-12w if fire>","reasoning":"..."}

Silence is default. JSON only.`;

// ─── SPLIT ARCHITECTURE: Detector + Labeler + Writer ────────────────────────

const DETECTOR_SYSTEM = `You watch a live sales call. Your job is CLASSIFICATION ONLY: what kind of thing just happened in the latest utterance?

You are NOT deciding whether to coach. The labeler downstream makes that call. Your job is to put the latest utterance into one bucket from the catalog below. Be permissive — if the utterance plausibly matches an event, classify it as that event.

# Prospect turn — pick exactly one
EVENTS (worth examining):
- vague_pain        — pain/frustration/struggle stated without specifics ("drowning", "messy", "exhausted", "can't keep up")
- specific_dropped  — number, deadline, percentage, vendor, or named cost dropped
- objection_raised  — concern, skepticism, doubt, mention of past burn or risk
- stakeholder_named — a person named with role/title or function
- commitment_offered — proposes a forward step (any kind)
- info_dump         — multiple related facts in one turn

NON-EVENTS (not coachable):
- acknowledgment    — "got it", "okay", "sure", "yeah"
- factual_answer    — direct one-fact response to a rep question
- rapport           — small talk, greetings

# Rep turn — pick exactly one
EVENTS (worth examining):
- skipped_drill         — pivoted away from a quantified prospect pain
- pitching_in_discovery — multiple product/feature claims in one turn
- defending_objection   — responded to a prospect objection with counter-claims/features
- caving                — concession on price/scope/terms
- advancing_too_early   — pricing/close/commitment attempt
- monologuing           — long turn (>70 words), multiple claims

NON-EVENTS:
- valid_discovery       — drilling, asking a focused question, listening
- valid_response        — acknowledging an objection, exploring it, asking what's underneath
- responding_factually  — answering a direct question
- rapport               — small talk

# Rules
- Classify what's IN the utterance, not what should happen next. Don't second-guess.
- "Permissive" means: if the prospect says "we tried Gem and cut it," that's objection_raised (past burn). If the rep says "we have AI, integrations, and case studies" in one turn, that's pitching_in_discovery — don't agonize over whether it's "really bad."
- Speaker constraint is hard: prospect-side labels on prospect turns only, rep-side on rep turns only.

# Output JSON
{
  "speaker": "rep | prospect",
  "event": "<one of the labels above>",
  "evidence": "<short phrase from utterance, or 'n/a'>",
  "reasoning": "<one sentence>"
}

JSON only.`;

const LABELER_SYSTEM = `You decide whether to fire a coaching whisper given a classified event.

# Non-events: always shouldFire=false
acknowledgment | factual_answer | rapport | valid_discovery | valid_response | responding_factually
For these, output: {"shouldFire": false, "play": "none", "reasoning": "non-event"}

# Events: default play mapping
vague_pain → drill_pain
specific_dropped → quantify
objection_raised → silent (wait for rep's response next turn; you don't coach the prospect for raising it)
stakeholder_named → probe_stakeholder IF a pain node exists in DAG with confidence ≥ stated, else silent
commitment_offered → anchor_commitment
info_dump → confirm_understanding
skipped_drill → rep_skipped_drill
pitching_in_discovery → rep_pitching_in_discovery
defending_objection → rep_defending
caving → rep_caving
advancing_too_early → slow_down
monologuing → slow_down

# Confidence-aware adjustments (when reading DAG)
- DAG nodes carry confidence: tentative | stated | confirmed
- For specific_dropped on a tentative pain → still fire quantify (specifics confirm the pain)
- For stakeholder_named while DAG pain is still tentative → silent (drill the pain first)
- For skipped_drill where the pain in DAG is tentative → fire drill_pain instead (deeper issue is pain isn't anchored yet)

# Cadence
If the chosen play fired in last 2 turns → shouldFire=false. Repetition is noise.

# Phase (soft prior)
Early in the call (OPEN/early DIAGNOSE), bias toward drilling plays. Don't fire probe_stakeholder or anchor_commitment in OPEN — they're premature. But don't use phase to override a clear event.

# Output JSON
{"shouldFire": <bool>, "play": "<play name>", "reasoning": "<one sentence>"}

JSON only.`;

const WRITER_SYSTEM = `You compose ONE coaching whisper for a sales rep on a live call.

Constraints:
- 6-12 words
- Action verb first
- Founder-natural voice
- No jargon (no LAER, no BANT, no MEDDIC)
- Specific to what just happened, not abstract

Examples (style only — never copy):
- "Pin the cost of those 30% missed hires in dollars."
- "Acknowledge the burn before pitching the accuracy stat."
- "Probe Eva's concerns before pricing comes up."

# Output JSON
{"markdown": "<6-12 word whisper>"}

JSON only.`;

// ─── Suggester input builders ───────────────────────────────────────────────

function buildSuggesterContext(opts: {
  current: Utt; tail: Utt[]; prevDag: Dag; turnNum: number;
  repState: string; phase: string;
  recentSuggestions: Array<{ turn: string; fired: boolean; play: string; markdown: string }>;
}): string {
  const { current, tail, prevDag, turnNum, repState, phase, recentSuggestions } = opts;
  const tailStr = tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  return `# THE MOMENT
[${current.id}] ${current.speaker.toUpperCase()}: ${current.text}

# HOT TAIL
${tailStr || '(none)'}

# REP STATE
${repState}

# CALL ARC: Phase=${phase}, Turn=${turnNum}/${TRANSCRIPT.length}

# DAG (previous turn's memory)
${renderDag(prevDag)}

# RECENT SUGGESTIONS
${recentSuggestions.length === 0 ? '(none)' : recentSuggestions.map((r) => `- ${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.play}] ${r.markdown}`).join('\n')}

# BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company}
Call goal: ${BRIEF.callGoal}
Product snippets: ${BRIEF.productSnippets.join(' | ')}`;
}

// ─── Run MONOLITHIC ─────────────────────────────────────────────────────────

type TurnResult = {
  id: string;
  gold: Gold;
  shouldFire: boolean;
  play: string;
  markdown: string;
  totalLatencyMs: number;
  totalInTokens: number;
  totalOutTokens: number;
  totalCostUSD: number;
  stages: { name: string; latencyMs: number; inTok: number; outTok: number }[];
};

async function runMonolithic(memDag: Dag): Promise<{ results: TurnResult[]; memDag: Dag; memTokens: { inTok: number; outTok: number; latencyMs: number } }> {
  let dag: Dag = { nodes: [], edges: [] };
  const tail: Utt[] = [];
  const recent: Array<{ turn: string; fired: boolean; play: string; markdown: string }> = [];
  const results: TurnResult[] = [];
  let memInTok = 0, memOutTok = 0, memLatency = 0;

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const prevDag = structuredClone(dag);
    const recentTail = tail.slice(-4);
    const repState = computeRepState([...recentTail, utt]);
    const phase = inferPhase(i + 1, prevDag, utt.text);
    const ctx = buildSuggesterContext({ current: utt, tail: recentTail, prevDag, turnNum: i + 1, repState, phase, recentSuggestions: recent });

    const sug = await callLLM(MONO_SYSTEM, ctx + '\n\n# DECISION', OP_MODEL, `mono-${utt.id}`);
    const parsed = tryParseJSON(sug.content) ?? { shouldFire: false, play: 'none', markdown: '' };

    const r: TurnResult = {
      id: utt.id, gold: GOLD[utt.id],
      shouldFire: !!parsed.shouldFire, play: parsed.play ?? 'none', markdown: parsed.markdown ?? '',
      totalLatencyMs: sug.latencyMs,
      totalInTokens: sug.inputTokens, totalOutTokens: sug.outputTokens,
      totalCostUSD: costUSD(OP_MODEL, sug.inputTokens, sug.outputTokens),
      stages: [{ name: 'suggester', latencyMs: sug.latencyMs, inTok: sug.inputTokens, outTok: sug.outputTokens }],
    };
    results.push(r);
    recent.push({ turn: utt.id, fired: r.shouldFire, play: r.play, markdown: r.markdown });
    if (recent.length > 5) recent.shift();

    // Memory agent (shared with split — runs once per turn either way)
    const mem = await callLLM(MEMORY_SYSTEM_V3, `# CURRENT
[${utt.id}] ${utt.speaker.toUpperCase()}: ${utt.text}

# CONTEXT
${recentTail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n') || '(none)'}

# DAG
${renderDag(dag)}

# BRIEF
Lead: ${BRIEF.lead.name} @ ${BRIEF.lead.company}`, OP_MODEL, `mem-${utt.id}`);
    memInTok += mem.inputTokens; memOutTok += mem.outputTokens; memLatency += mem.latencyMs;
    const delta = tryParseJSON(mem.content) ?? { newNodes: [], newEdges: [] };
    dag = applyDelta(dag, delta, i + 1);
    tail.push(utt);
  }

  return { results, memDag: dag, memTokens: { inTok: memInTok, outTok: memOutTok, latencyMs: memLatency } };
}

// ─── Run SPLIT ──────────────────────────────────────────────────────────────

async function runSplit(): Promise<{ results: TurnResult[]; memDag: Dag; memTokens: { inTok: number; outTok: number; latencyMs: number } }> {
  let dag: Dag = { nodes: [], edges: [] };
  const tail: Utt[] = [];
  const recent: Array<{ turn: string; fired: boolean; play: string; markdown: string }> = [];
  const results: TurnResult[] = [];
  let memInTok = 0, memOutTok = 0, memLatency = 0;

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const prevDag = structuredClone(dag);
    const recentTail = tail.slice(-4);
    const repState = computeRepState([...recentTail, utt]);
    const phase = inferPhase(i + 1, prevDag, utt.text);
    const ctx = buildSuggesterContext({ current: utt, tail: recentTail, prevDag, turnNum: i + 1, repState, phase, recentSuggestions: recent });

    const stages: TurnResult['stages'] = [];

    // STAGE 1: Detector
    const det = await callLLM(DETECTOR_SYSTEM, ctx, OP_MODEL, `det-${utt.id}`);
    stages.push({ name: 'detector', latencyMs: det.latencyMs, inTok: det.inputTokens, outTok: det.outputTokens });
    const detParsed = tryParseJSON(det.content) ?? { event: 'none' };
    let shouldFire = false, play = 'none', markdown = '';
    let totalLatency = det.latencyMs;

    // Run labeler unless detector classified as a non-event (skip LLM call to save latency on silent turns)
    const NON_EVENTS = new Set([
      'acknowledgment', 'factual_answer', 'rapport',
      'valid_discovery', 'valid_response', 'responding_factually',
      'none',
    ]);
    const isEvent = detParsed.event && !NON_EVENTS.has(detParsed.event);
    if (isEvent) {
      // STAGE 2: Labeler
      const labCtx = `# DETECTED EVENT
event: ${detParsed.event}
speaker: ${detParsed.speaker}
evidence: "${detParsed.evidence ?? ''}"

# CONTEXT
Phase: ${phase}
Recent suggestions: ${recent.length === 0 ? '(none)' : recent.map((r) => `${r.turn} [${r.play}] ${r.fired ? 'fired' : 'silent'}`).join('; ')}

# DAG (relevant facts — note confidence levels)
${renderDag(prevDag)}`;
      const lab = await callLLM(LABELER_SYSTEM, labCtx, OP_MODEL, `lab-${utt.id}`);
      stages.push({ name: 'labeler', latencyMs: lab.latencyMs, inTok: lab.inputTokens, outTok: lab.outputTokens });
      const labParsed = tryParseJSON(lab.content) ?? { shouldFire: false, play: 'none' };
      totalLatency += lab.latencyMs;

      if (labParsed.shouldFire) {
        // STAGE 3: Writer
        play = labParsed.play;
        const writerCtx = `# PLAY
${play}

# WHY (from detector)
event: ${detParsed.event}
evidence: "${detParsed.evidence ?? ''}"

# LATEST PROSPECT TURN
${recentTail.filter((u) => u.speaker === 'customer').slice(-1)[0]?.text ?? '(none)'}

# LATEST REP TURN
${recentTail.filter((u) => u.speaker === 'rep').slice(-1)[0]?.text ?? '(none)'}

# BRIEF SNIPPETS (use if relevant)
${BRIEF.productSnippets.join(' | ')}

Compose the whisper.`;
        const wri = await callLLM(WRITER_SYSTEM, writerCtx, OP_MODEL, `wri-${utt.id}`);
        stages.push({ name: 'writer', latencyMs: wri.latencyMs, inTok: wri.inputTokens, outTok: wri.outputTokens });
        const wriParsed = tryParseJSON(wri.content) ?? { markdown: '' };
        markdown = wriParsed.markdown ?? '';
        shouldFire = !!markdown && markdown.split(/\s+/).length >= 4;
        totalLatency += wri.latencyMs;
      }
    }

    const inTok = stages.reduce((s, st) => s + st.inTok, 0);
    const outTok = stages.reduce((s, st) => s + st.outTok, 0);

    results.push({
      id: utt.id, gold: GOLD[utt.id],
      shouldFire, play, markdown,
      totalLatencyMs: totalLatency, totalInTokens: inTok, totalOutTokens: outTok,
      totalCostUSD: costUSD(OP_MODEL, inTok, outTok),
      stages,
    });
    recent.push({ turn: utt.id, fired: shouldFire, play, markdown });
    if (recent.length > 5) recent.shift();

    // Memory agent
    const mem = await callLLM(MEMORY_SYSTEM_V3, `# CURRENT
[${utt.id}] ${utt.speaker.toUpperCase()}: ${utt.text}

# CONTEXT
${recentTail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n') || '(none)'}

# DAG
${renderDag(dag)}

# BRIEF
Lead: ${BRIEF.lead.name} @ ${BRIEF.lead.company}`, OP_MODEL, `mem-split-${utt.id}`);
    memInTok += mem.inputTokens; memOutTok += mem.outputTokens; memLatency += mem.latencyMs;
    const delta = tryParseJSON(mem.content) ?? { newNodes: [], newEdges: [] };
    dag = applyDelta(dag, delta, i + 1);
    tail.push(utt);
  }

  return { results, memDag: dag, memTokens: { inTok: memInTok, outTok: memOutTok, latencyMs: memLatency } };
}

// ─── Judge (Opus) ───────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a senior sales coach evaluating whether an AI live-coaching system made the right call on a single turn of a discovery call.

You will see:
- The transcript up to and including the current turn
- The NEXT 1-2 turns (so you can see what actually happened next)
- The system's decision (fire or silent, and if fire, the whisper)

Score 1-5 on coaching usefulness:
- 5: Excellent — would whisper exactly this (or very close) at this moment
- 4: Good — right move, slightly off on phrasing or focus
- 3: Acceptable — coaching present but mediocre; or correct silence on a marginal turn
- 2: Poor — fired when shouldn't have, OR silent when something obvious was needed
- 1: Wrong — actively harmful (wrong play, would distract the rep)

Also separately rate:
- whether_to_fire: "correct" | "wrong"
- play_choice: "good" | "adjacent" | "wrong" | "n/a" (n/a if silent)
- whisper_quality: "sharp" | "generic" | "off-target" | "n/a"

Output JSON:
{"score": <1-5>, "whether_to_fire": "...", "play_choice": "...", "whisper_quality": "...", "reasoning": "<one paragraph>"}`;

async function runJudge(turnIndex: number, system: string, result: TurnResult): Promise<{ score: number; tokens: number; cost: number; latencyMs: number; rawJSON: any }> {
  const before = TRANSCRIPT.slice(0, turnIndex + 1).map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const after = TRANSCRIPT.slice(turnIndex + 1, Math.min(turnIndex + 3, TRANSCRIPT.length)).map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const decision = result.shouldFire
    ? `FIRE [${result.play}]: "${result.markdown}"`
    : `SILENT (no whisper)`;
  const user = `# TRANSCRIPT UP TO AND INCLUDING TURN ${result.id}
${before}

# NEXT 1-2 TURNS (so you can see what happened next)
${after || '(end of call)'}

# SYSTEM DECISION ON TURN ${result.id}
${decision}

Evaluate. JSON only.`;
  const res = await callLLM(JUDGE_SYSTEM, user, JUDGE_MODEL, `judge-${result.id}`, true);
  const parsed = tryParseJSON(res.content) ?? { score: 3, reasoning: 'parse-fail' };
  return {
    score: Number(parsed.score) || 3,
    tokens: res.inputTokens + res.outputTokens,
    cost: costUSD(JUDGE_MODEL, res.inputTokens, res.outputTokens),
    latencyMs: res.latencyMs,
    rawJSON: parsed,
  };
}

// ─── Outcome tracking ───────────────────────────────────────────────────────

function trackOutcomes(results: TurnResult[]): { fired: number; actedOn: number; details: any[] } {
  let actedOn = 0;
  const fired = results.filter((r) => r.shouldFire);
  const details: any[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.shouldFire) continue;
    const turnIdx = TRANSCRIPT.findIndex((u) => u.id === r.id);
    const nextRep = TRANSCRIPT.slice(turnIdx + 1, turnIdx + 4).find((u) => u.speaker === 'rep');
    if (!nextRep) {
      details.push({ id: r.id, play: r.play, outcome: 'no_next_rep_turn' });
      continue;
    }
    const acted = didRepActOnWhisper(r.play, r.markdown, nextRep.text);
    if (acted) actedOn++;
    details.push({ id: r.id, play: r.play, nextRep: nextRep.id, outcome: acted ? 'acted' : 'did_not_act' });
  }
  return { fired: fired.length, actedOn, details };
}

function didRepActOnWhisper(play: string, markdown: string, nextRepText: string): boolean {
  const text = nextRepText.toLowerCase();
  // Simple heuristics matched to play type
  switch (play) {
    case 'drill_pain':
    case 'drill_vague':
      return /\b(when you say|what (?:do you mean|specifically)|tell me more|how (?:exactly|specifically))/i.test(text);
    case 'quantify':
      return /\b(how much|how many|what (?:s|is) the (?:cost|impact)|in (?:dollars|terms of)|translates to|equates to)/i.test(text);
    case 'rep_skipped_drill':
    case 'rep_pitching_in_discovery':
    case 'slow_down':
      // The rep "acts on" these by stopping and going back to discovery
      return /\b(let me|let's go back|before that|actually|sorry|to your point)\b/i.test(text);
    case 'rep_defending':
    case 'handle_objection':
      return /\b(I hear you|that makes sense|tell me more|what (?:would|did)|what does .* look like)/i.test(text);
    case 'probe_stakeholder':
    case 'multi_thread':
      return /\b(who else|tell me about|how does \w+ feel|what does \w+ care about|involve)/i.test(text);
    case 'anchor_commitment':
      return /\b(specific|let's schedule|when works|how about|by (?:when|what date)|book)/i.test(text);
    default:
      return false;
  }
}

// ─── Memory quality eval ────────────────────────────────────────────────────

function scoreMemoryQuality(actual: Dag, ideal: IdealNode[]): { precision: number; recall: number; f1: number; matched: number; missed: string[]; hallucinated: string[]; categoryAccuracy: number; confidenceAccuracy: number } {
  // Fuzzy match by category + content overlap
  const matched: { idealId: string; actualId: string; categoryMatch: boolean; confidenceMatch: boolean }[] = [];
  const matchedActualIds = new Set<string>();

  for (const idealNode of ideal) {
    const idealKeywords = idealNode.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const candidates = actual.nodes
      .filter((n) => !matchedActualIds.has(n.id))
      .map((n) => {
        const actualKeywords = n.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const overlap = idealKeywords.filter((k) => actualKeywords.some((a) => a.includes(k) || k.includes(a))).length;
        return { node: n, overlap };
      })
      .filter((c) => c.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap);
    if (candidates.length > 0) {
      const best = candidates[0].node;
      matchedActualIds.add(best.id);
      matched.push({
        idealId: idealNode.id,
        actualId: best.id,
        categoryMatch: best.category === idealNode.category,
        confidenceMatch: best.confidence === idealNode.confidence,
      });
    }
  }

  const tp = matched.length;
  const fp = actual.nodes.length - tp; // hallucinated
  const fn = ideal.length - tp;        // missed
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = ideal.length > 0 ? tp / ideal.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const categoryAccuracy = tp > 0 ? matched.filter((m) => m.categoryMatch).length / tp : 0;
  const confidenceAccuracy = tp > 0 ? matched.filter((m) => m.confidenceMatch).length / tp : 0;
  const missed = ideal.filter((i) => !matched.some((m) => m.idealId === i.id)).map((i) => i.id);
  const hallucinated = actual.nodes.filter((n) => !matchedActualIds.has(n.id)).map((n) => n.id);

  return { precision, recall, f1, matched: tp, missed, hallucinated, categoryAccuracy, confidenceAccuracy };
}

// ─── Label scoring ──────────────────────────────────────────────────────────

function scoreLabels(results: TurnResult[]) {
  let tp = 0, fp = 0, tn = 0, fn = 0, wrongPlay = 0;
  for (const r of results) {
    if (r.gold.fire === false) {
      if (!r.shouldFire) tn++; else fp++;
    } else {
      if (!r.shouldFire) { fn++; continue; }
      const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, '');
      const ok = norm(r.play).includes(norm(r.gold.play)) || norm(r.gold.play).includes(norm(r.play));
      if (ok) tp++; else wrongPlay++;
    }
  }
  const goldFire = results.filter((r) => r.gold.fire === true).length;
  const goldSilent = results.length - goldFire;
  const pStrict = (tp + fp + wrongPlay) > 0 ? tp / (tp + fp + wrongPlay) : 0;
  const rStrict = goldFire > 0 ? tp / goldFire : 0;
  const f1Strict = pStrict + rStrict > 0 ? (2 * pStrict * rStrict) / (pStrict + rStrict) : 0;
  const pLenient = (tp + wrongPlay + fp) > 0 ? (tp + wrongPlay) / (tp + wrongPlay + fp) : 0;
  const rLenient = goldFire > 0 ? (tp + wrongPlay) / goldFire : 0;
  const f1Lenient = pLenient + rLenient > 0 ? (2 * pLenient * rLenient) / (pLenient + rLenient) : 0;
  return { tp, fp, tn, fn, wrongPlay, goldFire, goldSilent, pStrict, rStrict, f1Strict, pLenient, rLenient, f1Lenient };
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log('═'.repeat(72));
console.log(`eval-dag-v3: N=${N_RUNS} runs of mono vs split`);
console.log('Model (operational): ' + OP_MODEL);
console.log('Model (judge): ' + JUDGE_MODEL);
console.log(`Fixture: ${TRANSCRIPT.length} turns; Ideal DAG nodes: ${IDEAL_DAG_NODES.length}`);
console.log('═'.repeat(72));

type RunMetrics = {
  f1Strict: number; f1Lenient: number; pStrict: number; rStrict: number;
  judgeAvg: number; memF1: number; categoryAcc: number; confidenceAcc: number;
  avgLat: number; silentLat: number; fireLat: number; totalCost: number;
  detLat: number; labLat: number; wriLat: number;
};

const monoRuns: RunMetrics[] = [];
const splitRuns: RunMetrics[] = [];
let totalJudgeCost = 0, totalJudgeTokens = 0;

for (let run = 1; run <= N_RUNS; run++) {
  console.log(`\n${'─'.repeat(20)} RUN ${run}/${N_RUNS} ${'─'.repeat(20)}`);

  console.log('Running monolithic…');
  const mono = await runMonolithic({ nodes: [], edges: [] });
  console.log('Running split…');
  const split = await runSplit();

  console.log('Judging…');
  const monoJudge: any[] = [];
  const splitJudge: any[] = [];
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const [mj, sj] = await Promise.all([
      runJudge(i, MONO_SYSTEM, mono.results[i]),
      runJudge(i, DETECTOR_SYSTEM, split.results[i]),
    ]);
    monoJudge.push(mj); splitJudge.push(sj);
    totalJudgeCost += mj.cost + sj.cost;
    totalJudgeTokens += mj.tokens + sj.tokens;
  }

  const mLab = scoreLabels(mono.results);
  const sLab = scoreLabels(split.results);
  const mMem = scoreMemoryQuality(mono.memDag, IDEAL_DAG_NODES);
  const sMem = scoreMemoryQuality(split.memDag, IDEAL_DAG_NODES);

  const monoAvgLat = mono.results.reduce((s, r) => s + r.totalLatencyMs, 0) / mono.results.length;
  const splitAvgLat = split.results.reduce((s, r) => s + r.totalLatencyMs, 0) / split.results.length;
  const splitFireRs = split.results.filter((r) => r.shouldFire);
  const splitSilentRs = split.results.filter((r) => !r.shouldFire);
  const splitFireLat = splitFireRs.length > 0 ? splitFireRs.reduce((s, r) => s + r.totalLatencyMs, 0) / splitFireRs.length : 0;
  const splitSilentLat = splitSilentRs.length > 0 ? splitSilentRs.reduce((s, r) => s + r.totalLatencyMs, 0) / splitSilentRs.length : 0;

  const monoCost = (mono.results.reduce((s, r) => s + r.totalInTokens, 0) / 1e6) * PRICES[OP_MODEL].inputPer1M
                 + (mono.results.reduce((s, r) => s + r.totalOutTokens, 0) / 1e6) * PRICES[OP_MODEL].outputPer1M;
  const splitCost = (split.results.reduce((s, r) => s + r.totalInTokens, 0) / 1e6) * PRICES[OP_MODEL].inputPer1M
                  + (split.results.reduce((s, r) => s + r.totalOutTokens, 0) / 1e6) * PRICES[OP_MODEL].outputPer1M;

  const detLat = split.results.reduce((s, r) => s + (r.stages.find((x) => x.name === 'detector')?.latencyMs ?? 0), 0) / split.results.length;
  const withLab = split.results.filter((r) => r.stages.some((x) => x.name === 'labeler'));
  const labLatAvg = withLab.length > 0 ? withLab.reduce((s, r) => s + (r.stages.find((x) => x.name === 'labeler')?.latencyMs ?? 0), 0) / withLab.length : 0;
  const withWri = split.results.filter((r) => r.stages.some((x) => x.name === 'writer'));
  const wriLatAvg = withWri.length > 0 ? withWri.reduce((s, r) => s + (r.stages.find((x) => x.name === 'writer')?.latencyMs ?? 0), 0) / withWri.length : 0;

  monoRuns.push({
    f1Strict: mLab.f1Strict, f1Lenient: mLab.f1Lenient, pStrict: mLab.pStrict, rStrict: mLab.rStrict,
    judgeAvg: monoJudge.reduce((s, j) => s + j.score, 0) / monoJudge.length,
    memF1: mMem.f1, categoryAcc: mMem.categoryAccuracy, confidenceAcc: mMem.confidenceAccuracy,
    avgLat: monoAvgLat, silentLat: 0, fireLat: 0, totalCost: monoCost,
    detLat: 0, labLat: 0, wriLat: 0,
  });
  splitRuns.push({
    f1Strict: sLab.f1Strict, f1Lenient: sLab.f1Lenient, pStrict: sLab.pStrict, rStrict: sLab.rStrict,
    judgeAvg: splitJudge.reduce((s, j) => s + j.score, 0) / splitJudge.length,
    memF1: sMem.f1, categoryAcc: sMem.categoryAccuracy, confidenceAcc: sMem.confidenceAccuracy,
    avgLat: splitAvgLat, silentLat: splitSilentLat, fireLat: splitFireLat, totalCost: splitCost,
    detLat, labLat: labLatAvg, wriLat: wriLatAvg,
  });

  console.log(`  Mono: F1strict=${mLab.f1Strict.toFixed(2)} F1lenient=${mLab.f1Lenient.toFixed(2)} judge=${monoRuns[run-1].judgeAvg.toFixed(2)} memF1=${mMem.f1.toFixed(2)} ${monoAvgLat.toFixed(0)}ms $${monoCost.toFixed(4)}`);
  console.log(`  Split: F1strict=${sLab.f1Strict.toFixed(2)} F1lenient=${sLab.f1Lenient.toFixed(2)} judge=${splitRuns[run-1].judgeAvg.toFixed(2)} memF1=${sMem.f1.toFixed(2)} ${splitAvgLat.toFixed(0)}ms (silent ${splitSilentLat.toFixed(0)} fire ${splitFireLat.toFixed(0)}) $${splitCost.toFixed(4)}`);
}

// ─── Aggregate across runs ──────────────────────────────────────────────────

function stats(vals: number[]): { mean: number; min: number; max: number; std: number } {
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return { mean, min: Math.min(...vals), max: Math.max(...vals), std: Math.sqrt(variance) };
}

function fmt(s: { mean: number; min: number; max: number; std: number }, digits = 2): string {
  return `${s.mean.toFixed(digits)} [${s.min.toFixed(digits)}-${s.max.toFixed(digits)}, σ=${s.std.toFixed(digits)}]`;
}

console.log('\n' + '═'.repeat(72));
console.log(`AGGREGATE (N=${N_RUNS})`);
console.log('═'.repeat(72));

const metrics: (keyof RunMetrics)[] = ['f1Strict', 'f1Lenient', 'pStrict', 'rStrict', 'judgeAvg', 'memF1', 'categoryAcc', 'confidenceAcc'];
console.log('\n── Quality metrics (mean [min-max, σ]) ──');
console.log(`Metric                    MONOLITHIC                    SPLIT`);
for (const m of metrics) {
  const mStats = stats(monoRuns.map((r) => r[m]));
  const sStats = stats(splitRuns.map((r) => r[m]));
  const delta = sStats.mean - mStats.mean;
  console.log(`${m.padEnd(24)}  ${fmt(mStats).padEnd(28)}  ${fmt(sStats).padEnd(28)} Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
}

console.log('\n── Latency (ms) ──');
console.log(`MONO avg/turn:           ${fmt(stats(monoRuns.map((r) => r.avgLat)), 0)}`);
console.log(`SPLIT avg/turn:          ${fmt(stats(splitRuns.map((r) => r.avgLat)), 0)}`);
console.log(`SPLIT silent turn:       ${fmt(stats(splitRuns.map((r) => r.silentLat)), 0)}  (detector only)`);
console.log(`SPLIT fire turn:         ${fmt(stats(splitRuns.map((r) => r.fireLat)), 0)}  (3 stages)`);
console.log(`  Detector stage:        ${fmt(stats(splitRuns.map((r) => r.detLat)), 0)}`);
console.log(`  Labeler stage:         ${fmt(stats(splitRuns.map((r) => r.labLat)), 0)}`);
console.log(`  Writer stage:          ${fmt(stats(splitRuns.map((r) => r.wriLat)), 0)}`);

console.log('\n── Cost per full 12-turn call (USD) ──');
console.log(`MONO:   ${fmt(stats(monoRuns.map((r) => r.totalCost * 10000)), 0)} × 10⁻⁴ = ~$${stats(monoRuns.map((r) => r.totalCost)).mean.toFixed(4)}`);
console.log(`SPLIT:  ${fmt(stats(splitRuns.map((r) => r.totalCost * 10000)), 0)} × 10⁻⁴ = ~$${stats(splitRuns.map((r) => r.totalCost)).mean.toFixed(4)}`);
const splitCostMult = stats(splitRuns.map((r) => r.totalCost)).mean / stats(monoRuns.map((r) => r.totalCost)).mean;
console.log(`SPLIT cost multiplier:   ${splitCostMult.toFixed(2)}x`);

console.log('\n── Judge cost (DeepSeek, all runs combined) ──');
console.log(`Total judge tokens:      ${totalJudgeTokens}`);
console.log(`Total judge cost:        $${totalJudgeCost.toFixed(4)}  (${N_RUNS} runs × 2 systems × ${TRANSCRIPT.length} turns = ${N_RUNS * 2 * TRANSCRIPT.length} judge calls)`);
console.log(`Cost per judge call:     $${(totalJudgeCost / (N_RUNS * 2 * TRANSCRIPT.length)).toFixed(5)}`);

console.log('\n── Bottom line ──');
const mF1 = stats(monoRuns.map((r) => r.f1Strict)).mean;
const sF1 = stats(splitRuns.map((r) => r.f1Strict)).mean;
const mJudge = stats(monoRuns.map((r) => r.judgeAvg)).mean;
const sJudge = stats(splitRuns.map((r) => r.judgeAvg)).mean;
const mMem = stats(monoRuns.map((r) => r.memF1)).mean;
const sMem = stats(splitRuns.map((r) => r.memF1)).mean;
console.log(`Split vs Mono averaged across ${N_RUNS} runs:`);
console.log(`  F1 strict:    ${(sF1 - mF1 >= 0 ? '+' : '')}${(sF1 - mF1).toFixed(2)}`);
console.log(`  Judge:        ${(sJudge - mJudge >= 0 ? '+' : '')}${(sJudge - mJudge).toFixed(2)}/5`);
console.log(`  Memory F1:    ${(sMem - mMem >= 0 ? '+' : '')}${(sMem - mMem).toFixed(2)}`);
console.log(`  Cost:         ${splitCostMult.toFixed(2)}x`);
