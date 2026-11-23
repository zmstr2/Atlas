#!/usr/bin/env bun
/**
 * bench-suggester-multimodel.ts
 *
 * Benchmark 10 candidate models for the suggester role on the 12-turn
 * HireLoop founder-led discovery call fixture.
 *
 * Method:
 *   1. Pre-compute memory DAG snapshots once (gpt-oss-20b memory agent).
 *      All suggester-model trials see the SAME memory state per turn.
 *   2. For each model, N=2 runs: stream the suggester call per turn,
 *      capture TTFT (time to first token), TTLT (total), cost (from
 *      OpenRouter usage.cost field).
 *   3. Judge each turn with deepseek-v4-flash for usefulness 1-5.
 *   4. Compute label P/R/F1 against gold.
 *
 * Reasoning disabled for all (effort=minimal for openai, enabled=false others).
 *
 * Usage: bun scripts/bench-suggester-multimodel.ts
 */
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dir, '..'));

const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error('ERROR: OPENROUTER_API_KEY not set'); process.exit(1); }

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const JUDGE_MODEL = 'deepseek/deepseek-v4-flash';
const MEMORY_MODEL = 'openai/gpt-oss-20b';
const N_RUNS = Number(process.env.N_RUNS ?? 5);

type ModelConfig = { id: string; reasoning: any };
const MODELS: ModelConfig[] = [
  { id: 'moonshotai/kimi-k2.6',        reasoning: { enabled: false } },
  { id: 'google/gemma-4-31b-it',       reasoning: { enabled: false } },
  { id: 'z-ai/glm-5.1',                reasoning: { enabled: false } },
];

// ─── Fixture ────────────────────────────────────────────────────────────────

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

type Gold = { fire: false } | { fire: true; play: string };
const GOLD: Record<string, Gold> = {
  u01: { fire: false }, u02: { fire: false }, u03: { fire: false },
  u04: { fire: true,  play: 'drill_pain' },
  u05: { fire: false },
  u06: { fire: true,  play: 'quantify' },
  u07: { fire: true,  play: 'rep_skipped_drill' },
  u08: { fire: false },
  u09: { fire: true,  play: 'rep_pitching_in_discovery' },
  u10: { fire: false },
  u11: { fire: true,  play: 'rep_defending' },
  u12: { fire: true,  play: 'probe_stakeholder' },
};

const BRIEF = {
  lead: { name: 'Priya Sharma', title: 'Head of People', company: 'TechCo', size: '150, Series B' },
  callGoal: 'qualify',
  productSnippets: [
    'HireLoop cuts time-to-fill 40-60% via AI sourcing + screening',
    'Greenhouse + Lever native integration',
    '~25-day time-to-fill reduction at customers Priya\'s size',
  ],
};

// ─── DAG types (with confidence) ────────────────────────────────────────────

type DagNode = { id: string; category: string; content: string; confidence: 'tentative' | 'stated' | 'confirmed'; sourceUtteranceId: string };
type DagEdge = { from: string; to: string; type: string; sourceUtteranceId: string };
type Dag = { nodes: DagNode[]; edges: DagEdge[] };

function renderDag(dag: Dag): string {
  if (dag.nodes.length === 0) return '(empty)';
  return dag.nodes.map((n) => `- ${n.id} [${n.category}/${n.confidence}/from ${n.sourceUtteranceId}]: "${n.content}"`).join('\n')
    + (dag.edges.length ? '\nEdges:\n' + dag.edges.map((e) => `- ${e.from}--${e.type}-->${e.to}`).join('\n') : '');
}

function applyDelta(dag: Dag, delta: any): Dag {
  const nd: Dag = { nodes: [...dag.nodes], edges: [...dag.edges] };
  for (const n of (delta?.newNodes ?? [])) {
    if (!n.id || !n.content || nd.nodes.some((x) => x.id === n.id)) continue;
    nd.nodes.push({
      id: String(n.id), category: String(n.category ?? 'other'),
      content: String(n.content), confidence: (n.confidence as any) ?? 'stated',
      sourceUtteranceId: String(n.sourceUtteranceId ?? ''),
    });
  }
  for (const e of (delta?.newEdges ?? [])) {
    if (!e.from || !e.to || !e.type) continue;
    nd.edges.push({ from: String(e.from), to: String(e.to), type: String(e.type), sourceUtteranceId: String(e.sourceUtteranceId ?? '') });
  }
  return nd;
}

// ─── Streaming LLM call: captures TTFT, TTLT, cost ──────────────────────────

type StreamResult = { content: string; ttftMs: number; ttltMs: number; inputTokens: number; outputTokens: number; cost: number; ok: boolean; error?: string };

async function streamCall(model: string, reasoning: any, system: string, user: string, jsonMode = true): Promise<StreamResult> {
  const t0 = Date.now();
  const body: any = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.3,
    max_tokens: 1500,
    reasoning,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OR_KEY}`, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { content: '', ttftMs: 0, ttltMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, ok: false, error: (e as Error).message };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { content: '', ttftMs: 0, ttltMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, ok: false, error: `HTTP ${res.status}: ${t.slice(0, 200)}` };
  }
  if (!res.body) return { content: '', ttftMs: 0, ttltMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, ok: false, error: 'no body' };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let ttftMs = -1;
  let usage: any = null;
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]' || data === '') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttftMs < 0) ttftMs = Date.now() - t0;
            content += delta;
          }
          if (j.usage) usage = j.usage;
        } catch {}
      }
    }
  } catch (e) {
    return { content, ttftMs: ttftMs < 0 ? Date.now() - t0 : ttftMs, ttltMs: Date.now() - t0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, cost: usage?.cost ?? 0, ok: false, error: (e as Error).message };
  }
  const ttltMs = Date.now() - t0;
  return {
    content,
    ttftMs: ttftMs < 0 ? ttltMs : ttftMs,
    ttltMs,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cost: Number(usage?.cost ?? 0),
    ok: true,
  };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function tryParseJSON(text: string): any {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    return null;
  }
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const MEMORY_SYSTEM = `You maintain a knowledge graph of sales-relevant info learned during a discovery call. After each utterance, decide: did anything sales-meaningful just get added?

Record: pain, evidence (numbers/deadlines/vendors), objections, commitments, rep assertions, contradictions, resolutions, references.
Do NOT record: rapport, acknowledgments, restatements, generic discovery questions.

Confidence on every node:
- tentative: hedged ("I think", "around", "kind of")
- stated: clear assertion
- confirmed: anchored by rep + not walked back

Edges (5 only): evidences | resolves | references | contradicts | follows_up
Reuse existing node IDs (in DAG STATE). Create new only if genuinely new.

Output JSON:
{"reasoning":"...","newNodes":[{"id":"...","category":"pain|evidence|objection|stakeholder|commitment|assertion|other","content":"...","confidence":"tentative|stated|confirmed","sourceUtteranceId":"..."}],"newEdges":[{"from":"...","to":"...","type":"...","sourceUtteranceId":"..."}]}
Empty arrays if nothing new. JSON only.`;

const SUGGESTER_SYSTEM = `You are a live coach for a sales rep on a discovery call. After each utterance you make ONE decision: did something just happen that needs a coaching response RIGHT NOW?

Coaching is EVENT-DRIVEN. React to what just happened in the LATEST utterance. Do NOT react to state. If nothing coachable happened this turn, stay silent.

# Steps (in order)
## Step 1: What EVENT in latest utterance?
(a) Prospect opened a door (vague pain, specific dropped, objection, stakeholder named, commitment offered)
(b) Rep made a mistake (pitched/defended/skipped drill/caved/advanced too early)
(c) Nothing coachable
If (c): shouldFire=false.

## Step 2: Who spoke? (gates plays)
PROSPECT plays: drill_pain | quantify | probe_stakeholder | multi_thread | anchor_commitment | confirm_understanding
REP plays: rep_skipped_drill | rep_pitching_in_discovery | rep_defending | rep_caving | slow_down | handle_objection

## Step 3: For prospect-signal plays — did the rep ALREADY handle it?
If immediately prior rep utterance already made the move, silent.

## Step 4: Match event to play trigger (strict)
drill_pain: vague pain stated (no number/owner/workflow)
quantify: specific number/deadline dropped AND impact unexplored
probe_stakeholder: NEW stakeholder named with role AND pain anchored in DAG
multi_thread: prospect offered to involve someone internally
anchor_commitment: prospect proposed vague next step
confirm_understanding: prospect dropped a lot of info, rep hasn't reflected
rep_skipped_drill: rep pivoted away from quantified pain
rep_pitching_in_discovery: rep made ≥2 product claims while pain vague/unanchored
rep_defending: rep responded to objection with counter-claims instead of acknowledge+explore
rep_caving: rep gave concession before value anchored
slow_down: rep attempted to advance before discovery complete
handle_objection: rep responding to objection without acknowledging

## Step 5: Cadence: same play in last 2 turns → don't repeat.

# Confidence in DAG nodes
Nodes have confidence (tentative/stated/confirmed). Specific dropped + tentative pain → quantify. Stakeholder + pain still tentative → silent. Rep skipped tentative pain → drill_pain not rep_skipped_drill.

# Voice
6-12 words, action verb first, founder-natural, no jargon (no LAER/BANT).

# Output JSON
{"event":"<phrase>","speaker":"rep|prospect","shouldFire":<bool>,"play":"<name>","markdown":"<6-12w>","reasoning":"..."}
Silence is default. JSON only.`;

const JUDGE_SYSTEM = `You are a senior sales coach evaluating whether an AI live-coaching system made the right call on one turn of a discovery call.

Score 1-5 on coaching usefulness:
- 5: Excellent — would whisper exactly this (or very close)
- 4: Good — right move, slightly off on phrasing/focus
- 3: Acceptable — mediocre coaching present; or correct silence on marginal turn
- 2: Poor — fired when shouldn't have, OR silent when something obvious was needed
- 1: Wrong — actively harmful (wrong play would distract the rep)

Output JSON: {"score":<1-5>,"whether_to_fire":"correct|wrong","reasoning":"<one sentence>"}`;

// ─── Build prompts ──────────────────────────────────────────────────────────

function buildSuggesterUser(curr: Utt, tail: Utt[], prevDag: Dag, turnNum: number, recent: any[]): string {
  return `# THE MOMENT
[${curr.id}] ${curr.speaker.toUpperCase()}: ${curr.text}

# HOT TAIL
${tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n') || '(none)'}

# CALL ARC: Turn ${turnNum} of ${TRANSCRIPT.length}

# DAG (previous turn's memory)
${renderDag(prevDag)}

# RECENT SUGGESTIONS
${recent.length === 0 ? '(none)' : recent.map((r) => `- ${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.play}] ${r.markdown ?? ''}`).join('\n')}

# BRIEF
Lead: ${BRIEF.lead.name}, ${BRIEF.lead.title} @ ${BRIEF.lead.company}
Goal: ${BRIEF.callGoal}
Snippets: ${BRIEF.productSnippets.join(' | ')}

Decide.`;
}

function buildMemoryUser(curr: Utt, tail: Utt[], dag: Dag): string {
  return `# CURRENT
[${curr.id}] ${curr.speaker.toUpperCase()}: ${curr.text}

# CONTEXT
${tail.map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n') || '(none)'}

# DAG
${renderDag(dag)}

# BRIEF
Lead: ${BRIEF.lead.name} @ ${BRIEF.lead.company}`;
}

function buildJudgeUser(turnIdx: number, decision: any): string {
  const before = TRANSCRIPT.slice(0, turnIdx + 1).map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const after = TRANSCRIPT.slice(turnIdx + 1, Math.min(turnIdx + 3, TRANSCRIPT.length)).map((u) => `[${u.id}] ${u.speaker.toUpperCase()}: ${u.text}`).join('\n');
  const dec = decision.shouldFire ? `FIRE [${decision.play}]: "${decision.markdown}"` : `SILENT`;
  return `# TRANSCRIPT UP TO AND INCLUDING TURN ${TRANSCRIPT[turnIdx].id}
${before}

# NEXT 1-2 TURNS
${after || '(end of call)'}

# SYSTEM DECISION ON ${TRANSCRIPT[turnIdx].id}
${dec}

Evaluate.`;
}

// ─── Pre-compute memory DAG progression ─────────────────────────────────────

console.log('═'.repeat(72));
console.log('bench-suggester-multimodel');
console.log(`Models tested: ${MODELS.length} × N=${N_RUNS} runs`);
console.log(`Memory model (constant): ${MEMORY_MODEL}`);
console.log(`Judge model (constant): ${JUDGE_MODEL}`);
console.log('═'.repeat(72));
console.log('\nPre-computing memory DAG snapshots…');

const memSnapshots: Dag[] = [];   // snapshot AT START of each turn (i.e., previous turn's state)
let memDag: Dag = { nodes: [], edges: [] };
let totalMemCost = 0, totalMemTok = 0;
const tailHistory: Utt[] = [];

for (let i = 0; i < TRANSCRIPT.length; i++) {
  memSnapshots.push(structuredClone(memDag));
  const utt = TRANSCRIPT[i];
  const tail = tailHistory.slice(-4);
  const r = await streamCall(MEMORY_MODEL, { effort: 'low' }, MEMORY_SYSTEM, buildMemoryUser(utt, tail, memDag));
  if (r.ok) {
    const delta = tryParseJSON(r.content) ?? { newNodes: [], newEdges: [] };
    memDag = applyDelta(memDag, delta);
    totalMemCost += r.cost;
    totalMemTok += r.inputTokens + r.outputTokens;
  }
  tailHistory.push(utt);
}
console.log(`Memory pre-compute done. Final DAG: ${memDag.nodes.length} nodes, ${memDag.edges.length} edges. Total memory cost: $${totalMemCost.toFixed(4)}`);

// ─── Bench each model ───────────────────────────────────────────────────────

type ModelStats = {
  model: string;
  runs: number;
  ok: boolean;
  error?: string;
  ttftMean: number; ttftP50: number; ttftP95: number; ttftMin: number; ttftMax: number;
  ttltMean: number; ttltP50: number; ttltP95: number; ttltMin: number; ttltMax: number;
  costPerGen: number;   // $ per single suggester call
  costPer1k: number;    // $ per 1000 suggester calls
  totalInTok: number; totalOutTok: number;
  precision: number; recall: number; f1: number;  // strict label match
  precisionLenient: number; recallLenient: number; f1Lenient: number;
  judgeAvg: number;
  parseFailures: number;
  fires: number;
};

const allStats: ModelStats[] = [];

for (const model of MODELS) {
  console.log(`\n── Benchmarking ${model.id} ──`);
  const runTTFTs: number[] = [];
  const runTTLTs: number[] = [];
  const runCosts: number[] = [];
  let allInTok = 0, allOutTok = 0;
  let allFires = 0, allParseFail = 0, allErr = 0;
  const labelOutcomes: { id: string; gold: Gold; fired: boolean; play: string; markdown: string }[] = [];
  const judgeScores: number[] = [];
  let modelError: string | undefined;

  for (let run = 0; run < N_RUNS; run++) {
    const recent: any[] = [];
    for (let i = 0; i < TRANSCRIPT.length; i++) {
      const utt = TRANSCRIPT[i];
      const prevDag = memSnapshots[i];
      const tail = TRANSCRIPT.slice(Math.max(0, i - 4), i);
      const user = buildSuggesterUser(utt, tail, prevDag, i + 1, recent);

      const r = await streamCall(model.id, model.reasoning, SUGGESTER_SYSTEM, user, true);
      if (!r.ok) {
        allErr++;
        if (!modelError) modelError = r.error;
        labelOutcomes.push({ id: utt.id, gold: GOLD[utt.id], fired: false, play: 'error', markdown: '' });
        recent.push({ turn: utt.id, fired: false, play: 'error' });
        if (recent.length > 5) recent.shift();
        continue;
      }
      runTTFTs.push(r.ttftMs);
      runTTLTs.push(r.ttltMs);
      runCosts.push(r.cost);
      allInTok += r.inputTokens;
      allOutTok += r.outputTokens;
      const parsed = tryParseJSON(r.content);
      if (!parsed) {
        allParseFail++;
        labelOutcomes.push({ id: utt.id, gold: GOLD[utt.id], fired: false, play: 'parse-fail', markdown: '' });
        recent.push({ turn: utt.id, fired: false, play: 'parse-fail' });
        if (recent.length > 5) recent.shift();
        continue;
      }
      const fired = !!parsed.shouldFire;
      const play = parsed.play ?? 'none';
      const markdown = parsed.markdown ?? '';
      if (fired) allFires++;
      labelOutcomes.push({ id: utt.id, gold: GOLD[utt.id], fired, play, markdown });
      recent.push({ turn: utt.id, fired, play, markdown });
      if (recent.length > 5) recent.shift();
    }
  }

  // If model has too many errors, skip judge
  const ok = allErr < TRANSCRIPT.length * N_RUNS / 2;
  if (ok) {
    // Judge: judge ONLY the second run's results (or first if N=1) to keep judge cost manageable
    const judgeRunStart = (N_RUNS - 1) * TRANSCRIPT.length;
    for (let i = 0; i < TRANSCRIPT.length; i++) {
      const r = labelOutcomes[judgeRunStart + i];
      const j = await streamCall(JUDGE_MODEL, { enabled: false }, JUDGE_SYSTEM, buildJudgeUser(i, r), true);
      if (j.ok) {
        const p = tryParseJSON(j.content);
        if (p && typeof p.score === 'number') judgeScores.push(p.score);
      }
    }
  }

  // Label scoring (strict + lenient)
  const norm = (s: string) => (s || '').toLowerCase().replace(/[_\s]/g, '');
  let tp = 0, fp = 0, fn = 0, wrongPlay = 0, tn = 0;
  for (const o of labelOutcomes) {
    if (o.gold.fire === false) {
      if (!o.fired) tn++; else fp++;
    } else {
      if (!o.fired) { fn++; continue; }
      const m = norm(o.play).includes(norm(o.gold.play)) || norm(o.gold.play).includes(norm(o.play));
      if (m) tp++; else wrongPlay++;
    }
  }
  const goldFires = labelOutcomes.filter((o) => o.gold.fire === true).length;
  const precision = (tp + fp + wrongPlay) > 0 ? tp / (tp + fp + wrongPlay) : 0;
  const recall = goldFires > 0 ? tp / goldFires : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const precisionLenient = (tp + wrongPlay + fp) > 0 ? (tp + wrongPlay) / (tp + wrongPlay + fp) : 0;
  const recallLenient = goldFires > 0 ? (tp + wrongPlay) / goldFires : 0;
  const f1Lenient = (precisionLenient + recallLenient) > 0 ? 2 * precisionLenient * recallLenient / (precisionLenient + recallLenient) : 0;

  const ttfts = runTTFTs.length > 0 ? runTTFTs : [0];
  const ttlts = runTTLTs.length > 0 ? runTTLTs : [0];
  const costs = runCosts.length > 0 ? runCosts : [0];
  const costPerGen = costs.reduce((s, c) => s + c, 0) / Math.max(1, costs.length);

  const stats: ModelStats = {
    model: model.id, runs: N_RUNS, ok, error: modelError,
    ttftMean: ttfts.reduce((s, t) => s + t, 0) / ttfts.length, ttftP50: pct(ttfts, 50), ttftP95: pct(ttfts, 95), ttftMin: Math.min(...ttfts), ttftMax: Math.max(...ttfts),
    ttltMean: ttlts.reduce((s, t) => s + t, 0) / ttlts.length, ttltP50: pct(ttlts, 50), ttltP95: pct(ttlts, 95), ttltMin: Math.min(...ttlts), ttltMax: Math.max(...ttlts),
    costPerGen, costPer1k: costPerGen * 1000,
    totalInTok: allInTok, totalOutTok: allOutTok,
    precision, recall, f1, precisionLenient, recallLenient, f1Lenient,
    judgeAvg: judgeScores.length > 0 ? judgeScores.reduce((s, x) => s + x, 0) / judgeScores.length : 0,
    parseFailures: allParseFail,
    fires: allFires,
  };
  allStats.push(stats);

  console.log(`  TTFT mean ${stats.ttftMean.toFixed(0)}ms p50 ${stats.ttftP50.toFixed(0)}ms p95 ${stats.ttftP95.toFixed(0)}ms | TTLT mean ${stats.ttltMean.toFixed(0)}ms p95 ${stats.ttltP95.toFixed(0)}ms | cost/gen $${stats.costPerGen.toFixed(5)} | F1 ${stats.f1.toFixed(2)} | judge ${stats.judgeAvg.toFixed(2)} | parsefail ${stats.parseFailures} | err ${allErr}`);
  if (modelError) console.log(`  first error: ${modelError.slice(0, 120)}`);
}

// ─── Print results table ────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(145));
console.log('RESULTS TABLE');
console.log('═'.repeat(145));

const headerCols = [
  'model'.padEnd(32),
  'ok'.padEnd(4),
  'ttft_mean'.padEnd(10),
  'ttft_p50'.padEnd(9),
  'ttft_p95'.padEnd(9),
  'ttlt_mean'.padEnd(10),
  'ttlt_p95'.padEnd(9),
  '$/gen'.padEnd(10),
  '$/1k'.padEnd(8),
  'P'.padEnd(5),
  'R'.padEnd(5),
  'F1'.padEnd(5),
  'F1len'.padEnd(6),
  'judge'.padEnd(6),
  'pf'.padEnd(4),
];
console.log(headerCols.join(' '));
console.log('─'.repeat(145));

// Sort by F1 desc (then by judge desc, then cost asc)
const sorted = [...allStats].sort((a, b) => {
  if (b.f1 !== a.f1) return b.f1 - a.f1;
  if (b.judgeAvg !== a.judgeAvg) return b.judgeAvg - a.judgeAvg;
  return a.costPerGen - b.costPerGen;
});

for (const s of sorted) {
  const cols = [
    s.model.padEnd(32),
    (s.ok ? '✓' : '✗').padEnd(4),
    (s.ttftMean.toFixed(0) + 'ms').padEnd(10),
    (s.ttftP50.toFixed(0) + 'ms').padEnd(9),
    (s.ttftP95.toFixed(0) + 'ms').padEnd(9),
    (s.ttltMean.toFixed(0) + 'ms').padEnd(10),
    (s.ttltP95.toFixed(0) + 'ms').padEnd(9),
    ('$' + s.costPerGen.toFixed(5)).padEnd(10),
    ('$' + s.costPer1k.toFixed(2)).padEnd(8),
    s.precision.toFixed(2).padEnd(5),
    s.recall.toFixed(2).padEnd(5),
    s.f1.toFixed(2).padEnd(5),
    s.f1Lenient.toFixed(2).padEnd(6),
    s.judgeAvg.toFixed(2).padEnd(6),
    String(s.parseFailures).padEnd(4),
  ];
  console.log(cols.join(' '));
}

console.log('\nLegend:');
console.log('  ttft/ttlt: time to first/last token (ms). mean = average; p50 = median; p95 = worst 1-in-20.');
console.log('  $/gen: avg cost per single generation (from OpenRouter usage.cost)');
console.log('  $/1k: cost per 1000 generations');
console.log('  P/R/F1: strict (play label must match exactly); Plen/Rlen/F1len: lenient (fire-on-fire-turn counts)');
console.log('  judge: deepseek-v4-flash usefulness score, 1-5 (only second run scored to save cost)');
console.log('  parse_fail: count of JSON parse failures');
console.log(`  fires: total fires across N=${N_RUNS} runs (${TRANSCRIPT.length} turns each)`);

// Errors
const errored = allStats.filter((s) => s.error);
if (errored.length > 0) {
  console.log('\nModels with errors:');
  for (const s of errored) console.log(`  ${s.model}: ${s.error?.slice(0, 150)}`);
}

console.log(`\nMemory pre-compute (gpt-oss-20b, ${TRANSCRIPT.length} calls): $${totalMemCost.toFixed(4)}`);
