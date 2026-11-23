#!/usr/bin/env bun
/**
 * eval-dag-system.ts
 *
 * Head-to-head eval: NEW DAG-based memory + suggester vs CURRENT system.
 *
 * Scenario: 12-turn founder-led discovery call (HireLoop selling to TechCo).
 *
 * Tracks per-system:
 *   - Precision, recall, F1 against gold labels
 *   - Memory agent output tokens per turn (and total)
 *   - Suggester input tokens per turn (and total)
 *
 * Key semantic detail (per user): the suggester sees the PREVIOUS turn's
 * memory state, not the current turn's. Memory updates happen AFTER the
 * suggester fires (mirrors production parallel pipeline).
 *
 * Usage:
 *   set -a && source ../../.env.local && set +a
 *   bun scripts/eval-dag-system.ts
 */
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dir, '..'));

const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error('ERROR: OPENROUTER_API_KEY not set'); process.exit(1); }

const MODEL = 'openai/gpt-oss-20b';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// ─── Fixture: 12-turn founder-led discovery call ────────────────────────────

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
  u01: { fire: false },
  u02: { fire: false },
  u03: { fire: false },
  u04: { fire: true,  play: 'drill_pain',                rationale: 'vague pain — drowning, exhausted, can\'t close' },
  u05: { fire: false },
  u06: { fire: true,  play: 'quantify',                  rationale: 'concrete numbers dropped but cost/impact unexplored' },
  u07: { fire: true,  play: 'rep_skipped_drill',         rationale: 'rep pivoted away from quantified pain to tech stack' },
  u08: { fire: false },
  u09: { fire: true,  play: 'rep_pitching_in_discovery', rationale: 'founder feature dump, no anchor to stated pain' },
  u10: { fire: false }, // objection raised — rep needs to handle next turn, no fire yet
  u11: { fire: true,  play: 'rep_defending',             rationale: 'defended without acknowledging/exploring the objection' },
  u12: { fire: true,  play: 'probe_stakeholder',         rationale: 'pain established + new stakeholder with role = MAP phase ripeness' },
};

const BRIEF = {
  lead: { name: 'Priya Sharma', title: 'Head of People', company: 'TechCo', size: '150 people, Series B' },
  callGoal: 'qualify',
  pastInteractions: [{ type: 'linkedin', summary: 'LinkedIn shows TechCo is hiring aggressively post Series B' }],
  productSnippets: [
    'HireLoop cuts time-to-fill 40-60% via AI sourcing, screening, scheduling',
    'Native Greenhouse + Lever integration',
    'Customers at your stage typically see 25-day reduction in time-to-fill',
  ],
  suggestedQuestions: [
    'What\'s your time-to-fill target vs actual?',
    'How is hiring success measured at TechCo?',
    'Who else on your team feels the hiring pain most?',
  ],
};

// ─── LLM call helper with token tracking ────────────────────────────────────

type LLMResult = { content: string; inputTokens: number; outputTokens: number; latencyMs: number };

async function callLLM(system: string, user: string, label: string): Promise<LLMResult> {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 1200,
      reasoning: { effort: 'low' },
      response_format: { type: 'json_object' },
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${label} HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  return {
    content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
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

// ─── NEW SYSTEM: types ──────────────────────────────────────────────────────

type DagNode = {
  id: string;
  category: string;
  content: string;
  sourceUtteranceId: string;
  addedAtTurn: number;
};
type DagEdge = {
  from: string;
  to: string;
  type: 'evidences' | 'resolves' | 'references' | 'contradicts' | 'follows_up';
  sourceUtteranceId: string;
  addedAtTurn: number;
};
type Dag = { nodes: DagNode[]; edges: DagEdge[] };

// ─── NEW MEMORY AGENT PROMPT ────────────────────────────────────────────────

const NEW_MEMORY_SYSTEM = `You maintain a knowledge graph of sales-relevant information learned during a discovery call.

After each utterance, decide: did anything sales-meaningful just get added to what we know about this deal?

If yes: emit new nodes (knowledge added) and/or new edges (relationships).
If no: emit empty arrays. Most turns will be empty — that's correct and expected.

# Record this
- Pain: specific challenges or problems the prospect named
- Evidence: numbers, deadlines, named stakeholders with role, vendors, dollar amounts
- Objections: concerns or skepticism raised by the prospect
- Commitments: specific next-step proposals (rep's or prospect's)
- Assertions: rep claims that anchor future expectations (price, scope, capability)
- References: when the latest utterance calls back to an earlier topic (edge only, no new node)
- Contradictions: when the latest utterance conflicts with an established node
- Resolutions: when an open loop just got closed by what just happened

# Do not record
- Rapport, pleasantries, acknowledgments ("got it", "okay")
- Restatements without new specifics
- Generic discovery questions (record the answer when it comes, not the question)
- Conversational glue
- Anything already in the pre-call brief unless new context is added

# Node IDs
- Short readable IDs: "pain_time_to_fill", "stakeholder_eva", "objection_ai_burnt"
- REUSE existing node IDs when knowledge connects to one — the DAG STATE lists every existing node
- Only create a new node when the knowledge is genuinely new

# Edge types (only 5)
- evidences:  X provides specifics for Y
- resolves:   X closes Y
- references: X calls back to Y (utterance refers to earlier topic, no new node)
- contradicts: X conflicts with Y
- follows_up: X is a deeper drill on Y

# Output JSON
{
  "reasoning": "<one sentence on what's new, or 'no new knowledge'>",
  "newNodes": [
    { "id": "...", "category": "pain|evidence|objection|stakeholder|commitment|assertion|other", "content": "...", "sourceUtteranceId": "..." }
  ],
  "newEdges": [
    { "from": "<node id or utterance id>", "to": "<node id>", "type": "evidences|resolves|references|contradicts|follows_up", "sourceUtteranceId": "..." }
  ]
}

If nothing new: empty arrays. Output ONLY the JSON object.`;

// ─── NEW SUGGESTER PROMPT ───────────────────────────────────────────────────

const NEW_SUGGESTER_SYSTEM = `You are a live coach for a sales rep on a discovery call. After each utterance you make ONE decision: did something just happen in this turn that needs a coaching response RIGHT NOW?

Coaching is EVENT-DRIVEN. You react to what just happened in the latest utterance. You do NOT react to state. If nothing coachable happened this turn, stay silent — even if there are unresolved loops in memory. Open loops are addressed when something happens that makes them ripe again, not on every turn afterward.

# How to decide (follow this order — do not skip steps)

## Step 1: What is the EVENT in the latest utterance?
The latest utterance is exactly one of:
  (a) Prospect opened a door — revealed pain, dropped a specific, raised an objection, named a stakeholder, proposed a commitment
  (b) Rep made a mistake — pitched in discovery, defended an objection, skipped a drill, caved on price, monologued
  (c) Nothing coachable — rapport, acknowledgment, factual answer, valid discovery question, valid response to objection

If (c), shouldFire=false. Stop. Most turns will be (c).

## Step 2: Who just spoke?
Speaker GATES which plays are eligible. This is a hard constraint:

PROSPECT TURN — only these plays can fire:
  drill_pain | quantify | probe_stakeholder | multi_thread
  anchor_commitment | confirm_understanding | surface_brief_context

REP TURN — only these plays can fire:
  rep_skipped_drill | rep_pitching_in_discovery | rep_defending | rep_caving
  slow_down | handle_objection | surface_brief_context

A rep-correction play on a prospect turn is impossible (the rep didn't just do anything). A prospect-signal play on a rep turn is also impossible (the rep is not the prospect). If you find yourself reaching for a play from the wrong column, the answer is shouldFire=false.

## Step 3: For prospect-signal plays — did the rep ALREADY handle it?
Look at the IMMEDIATELY PRIOR REP UTTERANCE in the hot tail. If the rep already made the move (asked a drilling question, quantified, probed the stakeholder, etc.), the rep doesn't need coaching for it. shouldFire=false.

A rep asking "is it the volume, the cadence, or the personalization?" IS drilling. Don't fire drill_pain on the following prospect turn — the rep is already on it.

## Step 4: Match the EVENT to the play's trigger
Each play has a precise trigger keyed to the latest utterance:

drill_pain — prospect just stated VAGUE pain (no number/owner/workflow attached): "we're drowning", "it's messy"
quantify — prospect just dropped a SPECIFIC (number/deadline/named cost) AND its downstream impact is unexplored
probe_stakeholder — prospect just named a NEW stakeholder with role/sentiment AND pain is already anchored in DAG
multi_thread — prospect just offered to involve someone internally ("I could show this to X")
anchor_commitment — prospect just proposed a VAGUE next step ("send me something", "circle back")
confirm_understanding — prospect just dropped a lot of related info and rep hasn't reflected any of it back yet

rep_skipped_drill — rep just pivoted away from a quantified prospect pain without anchoring its cost/impact
rep_pitching_in_discovery — rep just made ≥2 product claims in one turn while pain is still vague or unanchored
rep_defending — rep just responded to a prospect objection with counter-claims/features INSTEAD OF acknowledging+exploring
rep_caving — rep just made a concession (discount, scope, terms) before value was anchored
slow_down — rep just attempted to advance (pricing talk, close attempt, commitment) before discovery is complete
handle_objection — rep is responding to an objection AND has not yet acknowledged it

If you can't name the specific event in this turn that triggers the play, do not fire. "There's pain in the DAG" is not an event — the pain was added on some earlier turn.

## Step 5: Cadence
If you fired the SAME play in the last 2 turns, don't fire it again — repetition is noise. Different plays on consecutive turns are fine.

# Phase (soft prior — NOT a gate)
The call arcs through OPEN → DIAGNOSE → MAP → ADVANCE → CLOSE. This is background context, not a filter. probe_stakeholder is somewhat rarer (but not banned) early; anchor_commitment is somewhat rarer (but not banned) late. Do not use phase to suppress a play whose triggering event clearly just happened.

# Voice
Whisper is 6-12 words, action verb first, founder-natural, no jargon (no "LAER", no "BANT").
Good: "Pin the cost of those 30% missed hires in dollars."
Good: "Acknowledge the burn before pitching the accuracy stat."
Bad: "Apply LAER framework to handle this objection."

# Output JSON
{
  "event": "<what just happened in 1 phrase, or 'nothing coachable'>",
  "speaker": "<rep | prospect>",
  "rep_already_handled": <bool | null>,
  "shouldFire": <bool>,
  "play": "<play name>",
  "markdown": "<the whisper, only if shouldFire=true>",
  "reasoning": "<your reasoning>"
}

Output ONLY the JSON object. Silence is the default — when in doubt, shouldFire=false.`;

// ─── Render DAG for prompt ──────────────────────────────────────────────────

function renderDag(dag: Dag): string {
  if (dag.nodes.length === 0) return '(empty — no knowledge captured yet)';
  const byCategory: Record<string, DagNode[]> = {};
  for (const n of dag.nodes) {
    byCategory[n.category] = byCategory[n.category] ?? [];
    byCategory[n.category].push(n);
  }
  const lines: string[] = [];
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`## ${cat.toUpperCase()}`);
    for (const n of byCategory[cat]) {
      const incomingResolves = dag.edges.filter((e) => e.to === n.id && e.type === 'resolves');
      const status = incomingResolves.length > 0 ? `resolved at ${incomingResolves[0].sourceUtteranceId}` : `OPEN since ${n.sourceUtteranceId}`;
      lines.push(`- ${n.id} [${status}]: "${n.content}"`);
    }
  }
  if (dag.edges.length > 0) {
    lines.push('');
    lines.push('## EDGES');
    for (const e of dag.edges) {
      lines.push(`- ${e.from} --${e.type}--> ${e.to} (at ${e.sourceUtteranceId})`);
    }
  }
  return lines.join('\n');
}

// ─── Rep state (heuristics, no LLM) ─────────────────────────────────────────

function computeRepState(tail: Utt[]): string {
  const repTurns = tail.filter((u) => u.speaker === 'rep');
  if (repTurns.length === 0) return '(no rep turns yet)';
  const last = repTurns[repTurns.length - 1];
  const wordCount = last.text.split(/\s+/).length;
  const productClaims = (last.text.match(/we (?:have|do|use|integrate|offer)|HireLoop|our AI|our customers/gi) || []).length;
  const hedges = (last.text.match(/\b(?:I think|probably|maybe|I guess|kind of|sort of)\b/gi) || []).length;
  const concessions = (last.text.match(/\b(?:we could|I can offer|let me drop|special pricing)\b/gi) || []).length;
  const repWords = repTurns.reduce((s, u) => s + u.text.split(/\s+/).length, 0);
  const allWords = tail.reduce((s, u) => s + u.text.split(/\s+/).length, 0);
  const airtime = allWords > 0 ? Math.round((repWords / allWords) * 100) : 0;

  const signals: string[] = [];
  if (wordCount > 70) signals.push(`monologuing (${wordCount} words in last rep turn)`);
  if (productClaims >= 3) signals.push(`pitching_in_discovery (${productClaims} product claims)`);
  if (hedges >= 2) signals.push(`hedging (${hedges} hedge phrases)`);
  if (concessions >= 1) signals.push(`caving (concession language)`);
  if (airtime > 65) signals.push(`monopolizing_airtime (${airtime}% rep share)`);

  return signals.length === 0 ? '(no flags)' : signals.join('; ');
}

// ─── Phase inference (heuristics) ───────────────────────────────────────────

function inferPhase(turn: number, dag: Dag, currentText: string): string {
  const totalTurns = TRANSCRIPT.length;
  const fraction = turn / totalTurns;

  // Read the current utterance too — phase shouldn't lag the conversation
  // by a turn. A prospect raising pain on this very turn means we're in
  // DIAGNOSE even if the DAG hasn't recorded it yet.
  const text = currentText.toLowerCase();
  const painLanguage = /\b(drowning|exhausted|struggling|messy|painful|hard|problem|challeng|frustrat|broken|stuck|miss(ed|ing)|burn)/i.test(text);
  const numberLanguage = /\b\d+\s*(?:%|percent|days?|weeks?|months?|hours?|hires?|reps?|customers?|leads?|deals?|k\b|m\b)\b/i.test(text);

  const hasPain = dag.nodes.some((n) => n.category === 'pain') || painLanguage;
  const hasEvidence = dag.nodes.some((n) => n.category === 'evidence') || numberLanguage;
  const hasStakeholder = dag.nodes.some((n) => n.category === 'stakeholder');
  const hasCommitment = dag.nodes.some((n) => n.category === 'commitment');

  if (turn < 3) return 'OPEN';
  if (hasCommitment) return fraction > 0.85 ? 'CLOSE' : 'ADVANCE';
  if (hasStakeholder && hasPain && hasEvidence) return 'MAP';
  if (hasPain || hasEvidence) return 'DIAGNOSE';
  return 'OPEN';
}

// ─── Suggester input renderer ───────────────────────────────────────────────

function buildSuggesterUserPrompt(opts: {
  current: Utt;
  tail: Utt[];
  prevDag: Dag;
  turnNum: number;
  repState: string;
  phase: string;
  recentSuggestions: Array<{ turn: string; fired: boolean; play: string; markdown: string }>;
}): string {
  const { current, tail, prevDag, turnNum, repState, phase, recentSuggestions } = opts;
  const tailStr = tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const dagStr = renderDag(prevDag);
  const recentStr = recentSuggestions.length === 0
    ? '(none yet)'
    : recentSuggestions.map((r) => `- ${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.play}] ${r.markdown}`).join('\n');

  return `# THE MOMENT
[${current.id}] ${current.speaker.toUpperCase()}: ${current.text}

# HOT TAIL (last few raw utterances)
${tailStr || '(none)'}

# REP STATE
${repState}

# CALL ARC
- Phase: ${phase}
- Turn: ${turnNum} of ${TRANSCRIPT.length} expected

# KNOWLEDGE GRAPH (from previous turn — current utterance not yet digested)
${dagStr}

# RECENT SUGGESTER HISTORY
${recentStr}

# PRE-CALL BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company} (${BRIEF.lead.size})
Call goal: ${BRIEF.callGoal}
Past: ${BRIEF.pastInteractions.map((p) => p.summary).join('; ')}
Suggested questions: ${BRIEF.suggestedQuestions.join(' | ')}
Product snippets: ${BRIEF.productSnippets.join(' | ')}

# YOUR DECISION
Decide whether to fire on this turn.`;
}

// ─── Memory agent input renderer ────────────────────────────────────────────

function buildMemoryUserPrompt(opts: { current: Utt; tail: Utt[]; dag: Dag }): string {
  const { current, tail, dag } = opts;
  const tailStr = tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const dagStr = renderDag(dag);
  return `# CURRENT UTTERANCE
[${current.id}] ${current.speaker.toUpperCase()}: ${current.text}

# RECENT CONTEXT
${tailStr || '(none)'}

# DAG STATE
${dagStr}

# PRE-CALL BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company}

# YOUR TASK
Did the current utterance add new sales-relevant knowledge? Emit nodes/edges or empty arrays.`;
}

// ─── Apply memory delta to DAG ──────────────────────────────────────────────

function applyDelta(dag: Dag, delta: any, turnNum: number): Dag {
  const newDag: Dag = { nodes: [...dag.nodes], edges: [...dag.edges] };
  if (Array.isArray(delta?.newNodes)) {
    for (const n of delta.newNodes) {
      if (!n.id || !n.content) continue;
      // dedupe by id
      if (newDag.nodes.some((x) => x.id === n.id)) continue;
      newDag.nodes.push({
        id: String(n.id), category: String(n.category ?? 'other'),
        content: String(n.content), sourceUtteranceId: String(n.sourceUtteranceId ?? ''),
        addedAtTurn: turnNum,
      });
    }
  }
  if (Array.isArray(delta?.newEdges)) {
    for (const e of delta.newEdges) {
      if (!e.from || !e.to || !e.type) continue;
      newDag.edges.push({
        from: String(e.from), to: String(e.to), type: e.type,
        sourceUtteranceId: String(e.sourceUtteranceId ?? ''), addedAtTurn: turnNum,
      });
    }
  }
  return newDag;
}

// ─── CURRENT SYSTEM (baseline) — extract prompts from production source ─────

const SUGGESTER_SRC = await Bun.file(resolve('src/agents/suggester.ts')).text();
const CUR_SUG_MATCH = SUGGESTER_SRC.match(/export const SUGGESTER_SYSTEM\s*=\s*`([\s\S]*?)`;/m);
if (!CUR_SUG_MATCH) throw new Error('could not extract current SUGGESTER_SYSTEM');
const CUR_SUGGESTER_SYSTEM = CUR_SUG_MATCH[1];

const MEMORY_SRC = await Bun.file(resolve('src/agents/memoryAgent.ts')).text();
const CUR_MEM_MATCH = MEMORY_SRC.match(/export const MEMORY_AGENT_SYSTEM\s*=\s*`([\s\S]*?)`;/m);
const CUR_MEMORY_SYSTEM = CUR_MEM_MATCH ? CUR_MEM_MATCH[1] : '';

// Simplified baseline state — just hot tail + brief, no full BANT/MEDDIC scaffold.
// This isolates the prompt comparison from the memory infrastructure.
function buildBaselineSuggesterPrompt(opts: { current: Utt; tail: Utt[]; turnNum: number; recentSuggestions: any[] }): string {
  const { current, tail, recentSuggestions } = opts;
  const tailStr = tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const recentStr = recentSuggestions.length === 0 ? '(none)' : recentSuggestions.map((r) => `- ${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.play}] ${r.markdown}`).join('\n');
  return `# CALL CONTEXT
(memory state — current production renders BANT/MEDDIC scorecard, flow tags, concerns, anchors here. For this isolated prompt comparison we use raw hot tail.)

## HOT TAIL
${tailStr}

# PRE-CALL BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company} (${BRIEF.lead.size})
Call goal: ${BRIEF.callGoal}
Product snippets: ${BRIEF.productSnippets.join(' | ')}

# RECENT SUGGESTIONS
${recentStr}

# LATEST UTTERANCE
[${current.id}] ${current.speaker.toUpperCase()}: ${current.text}

# YOUR DECISION
Decide whether to fire. Output the JSON schema specified in your system prompt.`;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

type TurnScore = { id: string; gold: Gold; fired: boolean; play: string; outcome: 'tp' | 'fp' | 'tn' | 'fn' | 'fire-wrong-play' };

function scoreTurn(gold: Gold, suggestion: any): TurnScore {
  const fired = suggestion?.shouldFire === true;
  const play = suggestion?.play ?? 'none';
  if (gold.fire === false) {
    return { id: '', gold, fired, play, outcome: fired ? 'fp' : 'tn' };
  }
  if (!fired) return { id: '', gold, fired, play, outcome: 'fn' };
  // map play synonyms loosely
  const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, '');
  const ok = norm(play).includes(norm(gold.play)) || norm(gold.play).includes(norm(play));
  return { id: '', gold, fired, play, outcome: ok ? 'tp' : 'fire-wrong-play' };
}

function summarize(scores: TurnScore[]) {
  const tp = scores.filter((s) => s.outcome === 'tp').length;
  const fp = scores.filter((s) => s.outcome === 'fp').length;
  const tn = scores.filter((s) => s.outcome === 'tn').length;
  const fn = scores.filter((s) => s.outcome === 'fn').length;
  const wrongPlay = scores.filter((s) => s.outcome === 'fire-wrong-play').length;
  // Strict: fire-wrong-play counts as a half-correct fire — count it as a fire-on-fire-turn but not as a clean tp.
  // For precision/recall, a fire with the wrong play is still "fired correctly" (we did fire when we should have).
  // We'll report both strict (play match) and lenient (fire match) variants.
  const lenientTp = tp + wrongPlay;
  const lenientFn = fn;
  const goldFireCount = scores.filter((s) => s.gold.fire === true).length;
  const goldSilentCount = scores.filter((s) => s.gold.fire === false).length;

  const precisionStrict = tp + fp > 0 ? tp / (tp + fp + wrongPlay) : 0;
  const recallStrict = goldFireCount > 0 ? tp / goldFireCount : 0;
  const f1Strict = precisionStrict + recallStrict > 0 ? (2 * precisionStrict * recallStrict) / (precisionStrict + recallStrict) : 0;

  const precisionLenient = lenientTp + fp > 0 ? lenientTp / (lenientTp + fp) : 0;
  const recallLenient = goldFireCount > 0 ? lenientTp / goldFireCount : 0;
  const f1Lenient = precisionLenient + recallLenient > 0 ? (2 * precisionLenient * recallLenient) / (precisionLenient + recallLenient) : 0;

  return {
    tp, fp, tn, fn, wrongPlay, goldFireCount, goldSilentCount,
    precisionStrict, recallStrict, f1Strict,
    precisionLenient, recallLenient, f1Lenient,
  };
}

// ─── Run NEW system ─────────────────────────────────────────────────────────

async function runNewSystem() {
  console.log('\n' + '═'.repeat(70));
  console.log('NEW SYSTEM (DAG memory + new suggester)');
  console.log('═'.repeat(70));

  let dag: Dag = { nodes: [], edges: [] };
  const tail: Utt[] = [];
  const recentSuggestions: Array<{ turn: string; fired: boolean; play: string; markdown: string }> = [];
  const scores: TurnScore[] = [];
  let memInTok = 0, memOutTok = 0, sugInTok = 0, sugOutTok = 0;
  const turnDetails: any[] = [];

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const turnNum = i + 1;
    const prevDag = structuredClone(dag);  // suggester sees PREVIOUS turn's memory
    const recentTail = tail.slice(-4);

    // 1. Suggester first (with prev DAG)
    const repState = computeRepState([...recentTail, utt]);
    const phase = inferPhase(turnNum, prevDag, utt.text);
    const sugUser = buildSuggesterUserPrompt({
      current: utt, tail: recentTail, prevDag, turnNum, repState, phase, recentSuggestions,
    });
    const sugRes = await callLLM(NEW_SUGGESTER_SYSTEM, sugUser, `sug-${utt.id}`);
    sugInTok += sugRes.inputTokens;
    sugOutTok += sugRes.outputTokens;
    const suggestion = tryParseJSON(sugRes.content) ?? { shouldFire: false, play: 'none', markdown: '', reasoning: 'parse-fail' };

    const gold = GOLD[utt.id];
    const score = scoreTurn(gold, suggestion);
    score.id = utt.id;
    scores.push(score);
    recentSuggestions.push({
      turn: utt.id, fired: !!suggestion.shouldFire, play: suggestion.play ?? 'none', markdown: suggestion.markdown ?? '',
    });
    if (recentSuggestions.length > 5) recentSuggestions.shift();

    // 2. Memory agent updates DAG (after suggester)
    const memUser = buildMemoryUserPrompt({ current: utt, tail: recentTail, dag });
    const memRes = await callLLM(NEW_MEMORY_SYSTEM, memUser, `mem-${utt.id}`);
    memInTok += memRes.inputTokens;
    memOutTok += memRes.outputTokens;
    const delta = tryParseJSON(memRes.content) ?? { newNodes: [], newEdges: [] };
    dag = applyDelta(dag, delta, turnNum);

    tail.push(utt);

    turnDetails.push({
      id: utt.id, gold, fired: !!suggestion.shouldFire, play: suggestion.play, markdown: suggestion.markdown,
      sugInTok: sugRes.inputTokens, sugOutTok: sugRes.outputTokens,
      memInTok: memRes.inputTokens, memOutTok: memRes.outputTokens,
      dagSize: dag.nodes.length, dagEdges: dag.edges.length,
      newNodes: delta?.newNodes?.length ?? 0, newEdges: delta?.newEdges?.length ?? 0,
      phase, repState,
    });

    const mark = score.outcome === 'tp' ? '✓' : score.outcome === 'tn' ? '✓' : score.outcome === 'fire-wrong-play' ? '~' : '✗';
    const goldStr = gold.fire ? `FIRE[${gold.play}]` : 'silent';
    const gotStr = suggestion.shouldFire ? `FIRE[${suggestion.play}]` : 'silent';
    console.log(`${mark} [${utt.id}] gold=${goldStr.padEnd(32)} got=${gotStr.padEnd(32)} sug_in=${sugRes.inputTokens} mem_out=${memRes.outputTokens} dag=${dag.nodes.length}n/${dag.edges.length}e`);
  }

  const sum = summarize(scores);
  console.log('\n─── NEW SYSTEM SUMMARY ───');
  console.log(`Turns: ${TRANSCRIPT.length} | Gold FIRE: ${sum.goldFireCount} | Gold SILENT: ${sum.goldSilentCount}`);
  console.log(`Confusion: TP=${sum.tp} FP=${sum.fp} TN=${sum.tn} FN=${sum.fn} fire-wrong-play=${sum.wrongPlay}`);
  console.log(`Strict (play match): P=${sum.precisionStrict.toFixed(2)} R=${sum.recallStrict.toFixed(2)} F1=${sum.f1Strict.toFixed(2)}`);
  console.log(`Lenient (fire match): P=${sum.precisionLenient.toFixed(2)} R=${sum.recallLenient.toFixed(2)} F1=${sum.f1Lenient.toFixed(2)}`);
  console.log(`\nMemory agent tokens — total in: ${memInTok}, total out: ${memOutTok}, avg out/turn: ${(memOutTok / TRANSCRIPT.length).toFixed(0)}`);
  console.log(`Suggester tokens   — total in: ${sugInTok}, total out: ${sugOutTok}, avg in/turn: ${(sugInTok / TRANSCRIPT.length).toFixed(0)}`);
  console.log(`\nFinal DAG: ${dag.nodes.length} nodes, ${dag.edges.length} edges`);

  return { sum, memInTok, memOutTok, sugInTok, sugOutTok, dag, turnDetails };
}

// ─── Run CURRENT system (baseline) ──────────────────────────────────────────

async function runBaseline() {
  console.log('\n' + '═'.repeat(70));
  console.log('CURRENT SYSTEM (production prompts, isolated — no live memory agent)');
  console.log('═'.repeat(70));

  const tail: Utt[] = [];
  const recentSuggestions: Array<{ turn: string; fired: boolean; play: string; markdown: string }> = [];
  const scores: TurnScore[] = [];
  let sugInTok = 0, sugOutTok = 0;

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const utt = TRANSCRIPT[i];
    const turnNum = i + 1;
    const recentTail = tail.slice(-4);
    const sugUser = buildBaselineSuggesterPrompt({ current: utt, tail: recentTail, turnNum, recentSuggestions });
    const sugRes = await callLLM(CUR_SUGGESTER_SYSTEM, sugUser, `cur-sug-${utt.id}`);
    sugInTok += sugRes.inputTokens;
    sugOutTok += sugRes.outputTokens;
    const suggestion = tryParseJSON(sugRes.content) ?? { shouldFire: false, play: 'none' };

    const gold = GOLD[utt.id];
    const score = scoreTurn(gold, suggestion);
    score.id = utt.id;
    scores.push(score);
    recentSuggestions.push({ turn: utt.id, fired: !!suggestion.shouldFire, play: suggestion.play ?? 'none', markdown: suggestion.markdown ?? '' });
    if (recentSuggestions.length > 5) recentSuggestions.shift();
    tail.push(utt);

    const mark = score.outcome === 'tp' ? '✓' : score.outcome === 'tn' ? '✓' : score.outcome === 'fire-wrong-play' ? '~' : '✗';
    const goldStr = gold.fire ? `FIRE[${gold.play}]` : 'silent';
    const gotStr = suggestion.shouldFire ? `FIRE[${suggestion.play}]` : 'silent';
    console.log(`${mark} [${utt.id}] gold=${goldStr.padEnd(32)} got=${gotStr.padEnd(32)} sug_in=${sugRes.inputTokens}`);
  }

  const sum = summarize(scores);
  console.log('\n─── CURRENT SYSTEM SUMMARY ───');
  console.log(`Turns: ${TRANSCRIPT.length} | Gold FIRE: ${sum.goldFireCount} | Gold SILENT: ${sum.goldSilentCount}`);
  console.log(`Confusion: TP=${sum.tp} FP=${sum.fp} TN=${sum.tn} FN=${sum.fn} fire-wrong-play=${sum.wrongPlay}`);
  console.log(`Strict (play match): P=${sum.precisionStrict.toFixed(2)} R=${sum.recallStrict.toFixed(2)} F1=${sum.f1Strict.toFixed(2)}`);
  console.log(`Lenient (fire match): P=${sum.precisionLenient.toFixed(2)} R=${sum.recallLenient.toFixed(2)} F1=${sum.f1Lenient.toFixed(2)}`);
  console.log(`Suggester tokens — total in: ${sugInTok}, total out: ${sugOutTok}, avg in/turn: ${(sugInTok / TRANSCRIPT.length).toFixed(0)}`);

  return { sum, sugInTok, sugOutTok };
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log('Eval: DAG-based memory + suggester vs CURRENT prompts');
console.log(`Model: ${MODEL}`);
console.log(`Fixture: ${TRANSCRIPT.length}-turn founder-led discovery call (HireLoop → TechCo)`);
console.log(`Gold: ${Object.values(GOLD).filter((g) => g.fire).length} FIRE turns, ${Object.values(GOLD).filter((g) => !g.fire).length} SILENT turns`);

const baseline = await runBaseline();
const newSys = await runNewSystem();

// Token-per-turn growth in NEW system
console.log('\n' + '═'.repeat(70));
console.log('TOKEN GROWTH (NEW system, per turn)');
console.log('═'.repeat(70));
console.log('turn | sug_in | mem_out | dag_size | new_nodes | new_edges');
for (const t of newSys.turnDetails) {
  console.log(`${t.id.padEnd(4)} | ${String(t.sugInTok).padStart(6)} | ${String(t.memOutTok).padStart(7)} | ${String(t.dagSize).padStart(4)}n/${String(t.dagEdges).padStart(2)}e | ${String(t.newNodes).padStart(9)} | ${String(t.newEdges).padStart(9)}`);
}

console.log('\n' + '═'.repeat(70));
console.log('HEAD-TO-HEAD');
console.log('═'.repeat(70));
console.log(`                   |  CURRENT  |    NEW    | delta`);
console.log(`F1 (strict)        |   ${baseline.sum.f1Strict.toFixed(2)}    |   ${newSys.sum.f1Strict.toFixed(2)}    | ${(newSys.sum.f1Strict - baseline.sum.f1Strict >= 0 ? '+' : '')}${(newSys.sum.f1Strict - baseline.sum.f1Strict).toFixed(2)}`);
console.log(`F1 (lenient)       |   ${baseline.sum.f1Lenient.toFixed(2)}    |   ${newSys.sum.f1Lenient.toFixed(2)}    | ${(newSys.sum.f1Lenient - baseline.sum.f1Lenient >= 0 ? '+' : '')}${(newSys.sum.f1Lenient - baseline.sum.f1Lenient).toFixed(2)}`);
console.log(`Precision (strict) |   ${baseline.sum.precisionStrict.toFixed(2)}    |   ${newSys.sum.precisionStrict.toFixed(2)}    | ${(newSys.sum.precisionStrict - baseline.sum.precisionStrict >= 0 ? '+' : '')}${(newSys.sum.precisionStrict - baseline.sum.precisionStrict).toFixed(2)}`);
console.log(`Recall (strict)    |   ${baseline.sum.recallStrict.toFixed(2)}    |   ${newSys.sum.recallStrict.toFixed(2)}    | ${(newSys.sum.recallStrict - baseline.sum.recallStrict >= 0 ? '+' : '')}${(newSys.sum.recallStrict - baseline.sum.recallStrict).toFixed(2)}`);
console.log(`Suggester in (avg) |   ${Math.round(baseline.sugInTok / TRANSCRIPT.length)}    |   ${Math.round(newSys.sugInTok / TRANSCRIPT.length)}    |`);
console.log(`Memory out (total) |     —     |   ${newSys.memOutTok}    |`);
