#!/usr/bin/env bun
/**
 * Systematically test each of 5 proposed schema/render changes against the baseline
 * suggester to determine if each genuinely improves suggestion quality.
 *
 * Approach:
 *   1. Run the Jordan fixture turn-by-turn, building real MemoryStore state via the
 *      production memory agent (same model, same prompt — faithful state).
 *   2. For each turn, run the suggester with BOTH the baseline render and the
 *      candidate change render, in parallel.
 *   3. Print side-by-side comparison for qualitative evaluation.
 *
 * Usage:
 *   bun run scripts/bench-suggester-changes.ts
 *   CHANGE=0 bun run scripts/bench-suggester-changes.ts   # test only change 0
 *   KEEP_RAW=1 bun run ...                                # dump full raw text
 */

import { streamText, createGateway } from 'ai';
import { resolve } from 'node:path';
import { SUGGESTER_SYSTEM } from '../src/agents/suggester';
import { runMemoryAgent, MEMORY_AGENT_SYSTEM } from '../src/agents/memoryAgent';
import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { renderMemoryMarkdown } from '../src/memory/render';
import { detectAnchorContradictions } from '../src/memory/anchors';
import type { MeetingMemory } from '@atlas/types';
import type { HotTailEntry } from '../src/memory/hotTail';

if (!process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.AI_GATEWAY_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log('bench — skipped (no gateway key in env)');
  process.exit(0);
}

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN ?? process.env.OPENAI_API_KEY ?? '',
});

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');

type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(FIXTURE_PATH).text());

// ─── Change definitions ────────────────────────────────────────────────────
// Each change is a render-level modification tested against the current baseline
// (which already includes change #0 — facts+concerns).

type RenderFn = (opts: { memory: MeetingMemory; hotTail: HotTailEntry[]; leadName?: string; callGoal?: string }) => string;

// Baseline: the current renderMemoryMarkdown (already includes facts+concerns from change #0)
const renderBaseline: RenderFn = renderMemoryMarkdown;

// Build a speaker lookup from fixture: turnId 't4' → speaker of utterance at index 3
const turnSpeaker = new Map<string, 'rep' | 'customer'>();
for (let i = 0; i < fixture.length; i++) {
  turnSpeaker.set(`t${i + 1}`, fixture[i].speaker);
}

// Change 1: Add speaker attribution to verbatim anchors in render
function renderWithAnchorSpeaker(opts: Parameters<RenderFn>[0]): string {
  const { memory } = opts;
  // Rebuild the anchor section with speaker attribution
  const enrichedLines: string[] = [];
  enrichedLines.push('## Verbatim anchors (load-bearing details)');
  if (memory.verbatimAnchors.length === 0) {
    enrichedLines.push('(none)');
  } else {
    for (const a of memory.verbatimAnchors) {
      const spk = turnSpeaker.get(a.turnId);
      const spkLabel = spk ? (spk === 'rep' ? 'REP' : 'PROSPECT') : '?';
      enrichedLines.push(`- [${a.turnId} / ${a.axis} / ${spkLabel}] "${a.verbatim}"`);
    }
  }

  // Replace the anchor section in the base render
  const base = renderMemoryMarkdown(opts);
  const anchorHeader = '## Verbatim anchors (load-bearing details)';
  const idx = base.indexOf(anchorHeader);
  if (idx === -1) return base + '\n' + enrichedLines.join('\n') + '\n';

  const nextSection = base.indexOf('\n## ', idx + anchorHeader.length);
  const before = base.slice(0, idx);
  const after = nextSection === -1 ? '' : base.slice(nextSection);
  return before + enrichedLines.join('\n') + '\n' + after;
}

// Change 2: Filter pushQueue to BANT+champion only (drop pure MEDDIC keys)
const BANT_PLUS_CHAMPION = new Set(['need', 'budget', 'authority', 'timeline', 'champion']);

function renderWithSimplePushQueue(opts: Parameters<RenderFn>[0]): string {
  const { memory } = opts;
  // Clone memory with filtered pushQueue
  const filtered: MeetingMemory = {
    ...memory,
    scorecard: {
      ...memory.scorecard,
      pushQueue: memory.scorecard.pushQueue.filter((k) => BANT_PLUS_CHAMPION.has(k)),
    },
  };
  return renderMemoryMarkdown({ ...opts, memory: filtered });
}

// Change 3: Both changes #1 and #2 together (cumulative)
function renderCombined(opts: Parameters<RenderFn>[0]): string {
  const { memory } = opts;
  const filtered: MeetingMemory = {
    ...memory,
    scorecard: {
      ...memory.scorecard,
      pushQueue: memory.scorecard.pushQueue.filter((k) => BANT_PLUS_CHAMPION.has(k)),
    },
  };
  return renderWithAnchorSpeaker({ ...opts, memory: filtered });
}

const CHANGE_TO_TEST = process.env.CHANGE !== undefined ? Number(process.env.CHANGE) : -1;

const CHANGES: Array<{ id: number; label: string; render: RenderFn; description: string }> = [
  {
    id: 1,
    label: 'change-1: anchor speaker attribution',
    render: renderWithAnchorSpeaker,
    description: 'Add REP/PROSPECT speaker label to each verbatim anchor in render',
  },
  {
    id: 2,
    label: 'change-2: simplified pushQueue (BANT+champion only)',
    render: renderWithSimplePushQueue,
    description: 'Drop pure MEDDIC keys (identifyPain, economicBuyer, etc.) from pushQueue display',
  },
  {
    id: 3,
    label: 'change-1+2 combined',
    render: renderCombined,
    description: 'Anchor speaker attribution + simplified pushQueue together',
  },
];

// ─── Suggester call ────────────────────────────────────────────────────────

type RecentEntry = { turn: number; fired: boolean; priority: string; play: string; markdown: string };

function buildSuggesterPrompt(
  utt: Utt,
  hotTail: HotTailEntry[],
  memory: MeetingMemory,
  recentSuggestions: RecentEntry[],
  renderFn: RenderFn,
): string {
  const memoryMarkdown = renderFn({
    memory,
    hotTail,
    leadName: 'Jordan Hayes',
    callGoal: 'discovery + qualify outbound automation fit',
  });

  const isProspect = utt.speaker === 'customer';
  const speakerLabel = isProspect ? 'PROSPECT' : 'REP';
  const priorLabel = isProspect ? 'IMMEDIATE PRIOR REP UTTERANCE' : 'IMMEDIATE PRIOR PROSPECT UTTERANCE';
  const modeLabel = isProspect ? 'PROSPECT MODE' : 'REP MODE';

  const priorOpposite = [...hotTail].reverse().find((h) => h.speaker !== utt.speaker);

  const contradictions = detectAnchorContradictions(memory, utt.text);
  const contradictionLines = contradictions.map(
    (c) => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`
  );

  const firedCount = recentSuggestions.filter((r) => r.fired).slice(-5).length;
  const recentLines = recentSuggestions.length === 0
    ? '(none yet)'
    : recentSuggestions
        .map((r) => `- t${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.priority}/${r.play}] ${r.markdown || '(no text)'}`)
        .join('\n');

  const JSON_INSTR = `Output ONLY a JSON object:
{"shouldFire": boolean, "priority": "critical"|"nudge"|"fyi", "play": string, "markdown": string, "reasoning": string, "groundedInUtteranceIds": string[], "groundedInAnchorTurnIds": string[]}`;

  return `# CALL CONTEXT
${memoryMarkdown}

# PRE-CALL BRIEF
Lead: Jordan Hayes, VP Marketing @ MidCo
Call goal: discovery + qualify outbound automation fit
Product snippets: AI-powered outbound automation | SDR productivity platform | Artisan AI

# ${priorLabel}
${priorOpposite ? `[${priorOpposite.id}] ${priorOpposite.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${priorOpposite.text}` : '(none)'}

# NEW ${speakerLabel} UTTERANCE — you are in ${modeLabel}
[${utt.id}] ${speakerLabel}: ${utt.text}

# RECENT SUGGESTIONS (your last decisions, oldest first; ${firedCount} of last 5 fired)
${recentLines}

# CONTRADICTIONS DETECTED (deterministic anchor checks)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide. ${JSON_INSTR}`;
}

type Decision = {
  shouldFire: boolean;
  priority: string;
  play: string;
  markdown: string;
  reasoning: string;
};

function tryParseJson(text: string): Decision | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    return {
      shouldFire: !!obj.shouldFire,
      priority: String(obj.priority ?? 'nudge'),
      play: String(obj.play ?? 'none'),
      markdown: String(obj.markdown ?? ''),
      reasoning: String(obj.reasoning ?? ''),
    };
  } catch {
    return null;
  }
}

async function callSuggester(
  prompt: string,
  timeoutMs = 30_000,
): Promise<{ ttftMs: number; ttltMs: number; text: string; error?: string }> {
  const start = Date.now();
  let ttft = -1;
  let text = '';
  try {
    const stream = streamText({
      model: gateway('openai/gpt-5.4-mini'),
      system: SUGGESTER_SYSTEM,
      prompt,
      maxTokens: 1000,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    for await (const chunk of stream.textStream) {
      if (ttft === -1) ttft = Date.now() - start;
      text += chunk;
    }
    return { ttftMs: ttft, ttltMs: Date.now() - start, text };
  } catch (err) {
    return { ttftMs: ttft, ttltMs: Date.now() - start, text, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Main bench ───────────────────────────────────────────────────────────

interface TurnResult {
  turn: number;
  utt: Utt;
  baseline: { decision: Decision | null; ttltMs: number; error?: string; rawText: string };
  candidate: { decision: Decision | null; ttltMs: number; error?: string; rawText: string };
  memoryFactCount: number;
  memoryConcernCount: number;
}

async function runBench(change: (typeof CHANGES)[0]): Promise<TurnResult[]> {
  const store = new MemoryStore();
  const hotTail = new HotTail(6);
  const baselineRecent: RecentEntry[] = [];
  const candidateRecent: RecentEntry[] = [];
  const results: TurnResult[] = [];

  for (let i = 0; i < fixture.length; i++) {
    const utt = fixture[i];
    const turn = i + 1;
    process.stdout.write(`  turn ${turn}/${fixture.length}...`);

    // Step 1: Update hot tail with current utterance
    hotTail.push({ id: utt.id, speaker: utt.speaker, text: utt.text, startMs: utt.startMs, endMs: utt.endMs });
    store.recordUtteranceStats(utt.speaker, utt.text);

    // Step 2: Snapshot memory BEFORE memory agent runs (so suggester sees prior state)
    const memSnapshot = store.snapshot;
    const hotSnap = hotTail.snapshot().slice(0, -1); // exclude current utt from hot tail for suggester

    // Step 3: Build both prompts
    const baselinePrompt = buildSuggesterPrompt(utt, hotSnap, memSnapshot, baselineRecent, renderBaseline);
    const candidatePrompt = buildSuggesterPrompt(utt, hotSnap, memSnapshot, candidateRecent, change.render);

    // Step 4: Run both suggesters in parallel
    const [baselineResult, candidateResult] = await Promise.all([
      callSuggester(baselinePrompt),
      callSuggester(candidatePrompt),
    ]);

    const bd = baselineResult.text ? tryParseJson(baselineResult.text) : null;
    const cd = candidateResult.text ? tryParseJson(candidateResult.text) : null;

    results.push({
      turn,
      utt,
      baseline: { decision: bd, ttltMs: baselineResult.ttltMs, error: baselineResult.error, rawText: baselineResult.text },
      candidate: { decision: cd, ttltMs: candidateResult.ttltMs, error: candidateResult.error, rawText: candidateResult.text },
      memoryFactCount: memSnapshot.facts.length,
      memoryConcernCount: memSnapshot.concerns.filter((c) => !c.addressed).length,
    });

    // Update recent suggestions (use baseline for both to keep comparison fair)
    if (bd) {
      const entry = { turn, fired: bd.shouldFire && bd.priority !== 'fyi', priority: bd.priority, play: bd.play, markdown: bd.markdown };
      baselineRecent.push(entry);
      if (baselineRecent.length > 6) baselineRecent.splice(0, baselineRecent.length - 6);
    }
    if (cd) {
      const entry = { turn, fired: cd.shouldFire && cd.priority !== 'fyi', priority: cd.priority, play: cd.play, markdown: cd.markdown };
      candidateRecent.push(entry);
      if (candidateRecent.length > 6) candidateRecent.splice(0, candidateRecent.length - 6);
    }

    // Step 5: Run memory agent to update state for NEXT turn
    try {
      const patch = await runMemoryAgent({
        utterance: { id: utt.id, speaker: utt.speaker, text: utt.text, startMs: utt.startMs, endMs: utt.endMs },
        turnId: `t${turn}`,
        prevMemory: memSnapshot,
        hotTail: hotTail.snapshot(),
      });
      store.applyMemoryPatch(patch);
    } catch {
      // memory agent failure — state unchanged for next turn
    }

    process.stdout.write(` baseline=${bd?.shouldFire ? 'FIRE' : 'silent'} candidate=${cd?.shouldFire ? 'FIRE' : 'silent'}\n`);
  }

  return results;
}

function printReport(change: (typeof CHANGES)[0], results: TurnResult[]) {
  const DIVIDER = '─'.repeat(80);

  console.log(`\n${DIVIDER}`);
  console.log(`CHANGE #${change.id}: ${change.label}`);
  console.log(`Description: ${change.description}`);
  console.log(DIVIDER);

  // Aggregate stats
  const bFired = results.filter((r) => r.baseline.decision?.shouldFire && r.baseline.decision.priority !== 'fyi');
  const cFired = results.filter((r) => r.candidate.decision?.shouldFire && r.candidate.decision.priority !== 'fyi');
  const bErrors = results.filter((r) => r.baseline.error || !r.baseline.decision);
  const cErrors = results.filter((r) => r.candidate.error || !r.candidate.decision);
  const avgBttlt = results.reduce((s, r) => s + r.baseline.ttltMs, 0) / results.length;
  const avgCttlt = results.reduce((s, r) => s + r.candidate.ttltMs, 0) / results.length;

  console.log('\nSUMMARY');
  console.log(`${''.padEnd(20)} ${'baseline'.padEnd(16)} ${'candidate'.padEnd(16)}`);
  console.log(`${'fires'.padEnd(20)} ${String(bFired.length).padEnd(16)} ${String(cFired.length).padEnd(16)}`);
  console.log(`${'errors'.padEnd(20)} ${String(bErrors.length).padEnd(16)} ${String(cErrors.length).padEnd(16)}`);
  console.log(`${'avg ttlt ms'.padEnd(20)} ${String(Math.round(avgBttlt)).padEnd(16)} ${String(Math.round(avgCttlt)).padEnd(16)}`);

  // Turns where they differ
  const diverged = results.filter((r) => {
    const bFire = r.baseline.decision?.shouldFire && r.baseline.decision.priority !== 'fyi';
    const cFire = r.candidate.decision?.shouldFire && r.candidate.decision.priority !== 'fyi';
    return bFire !== cFire || r.baseline.decision?.play !== r.candidate.decision?.play;
  });

  console.log(`\nDIVERGED TURNS (${diverged.length} of ${results.length})`);

  for (const r of diverged) {
    const bd = r.baseline.decision;
    const cd = r.candidate.decision;
    const uttLabel = `[t${r.turn}] ${r.utt.speaker === 'customer' ? 'PROSPECT' : 'REP'}: ${r.utt.text.slice(0, 100)}${r.utt.text.length > 100 ? '…' : ''}`;
    console.log(`\n${uttLabel}`);
    console.log(`  mem_facts=${r.memoryFactCount} mem_concerns=${r.memoryConcernCount}`);
    if (bd?.shouldFire) {
      console.log(`  BASELINE FIRED   [${bd.priority}/${bd.play}] ${bd.markdown}`);
      if (process.env.KEEP_RAW) console.log(`    reasoning: ${bd.reasoning}`);
    } else {
      console.log(`  BASELINE silent  ${bd ? `(play=${bd.play})` : '(no decision)'}`);
    }
    if (cd?.shouldFire) {
      console.log(`  CANDIDATE FIRED  [${cd.priority}/${cd.play}] ${cd.markdown}`);
      if (process.env.KEEP_RAW) console.log(`    reasoning: ${cd.reasoning}`);
    } else {
      console.log(`  CANDIDATE silent ${cd ? `(play=${cd.play})` : '(no decision)'}`);
    }
  }

  // All fired turns (both)
  console.log(`\n${DIVIDER}`);
  console.log('ALL FIRED TURNS (baseline | candidate)');
  console.log(DIVIDER);

  for (const r of results) {
    const bd = r.baseline.decision;
    const cd = r.candidate.decision;
    const bFire = bd?.shouldFire && bd.priority !== 'fyi';
    const cFire = cd?.shouldFire && cd.priority !== 'fyi';
    if (!bFire && !cFire) continue;

    const uttLabel = `[t${r.turn}] ${r.utt.speaker === 'customer' ? 'PROSPECT' : 'REP'}: ${r.utt.text.slice(0, 90)}${r.utt.text.length > 90 ? '…' : ''}`;
    console.log(`\n${uttLabel}`);
    console.log(`  baseline:  ${bFire ? `FIRED [${bd!.priority}/${bd!.play}] ${bd!.markdown}` : 'silent'}`);
    console.log(`  candidate: ${cFire ? `FIRED [${cd!.priority}/${cd!.play}] ${cd!.markdown}` : 'silent'}`);
    if (process.env.KEEP_RAW && (bFire || cFire)) {
      if (bFire) console.log(`    b.reasoning: ${bd!.reasoning.slice(0, 200)}`);
      if (cFire) console.log(`    c.reasoning: ${cd!.reasoning.slice(0, 200)}`);
    }
  }
}

async function main() {
  const changesToTest = CHANGE_TO_TEST === -1 ? CHANGES : CHANGES.filter((c) => c.id === CHANGE_TO_TEST);

  if (changesToTest.length === 0) {
    console.error(`No change with id=${CHANGE_TO_TEST} defined.`);
    process.exit(1);
  }

  for (const change of changesToTest) {
    console.log(`\nRunning bench for change #${change.id}: ${change.label}`);
    console.log(`(${fixture.length} turns, building real memory state + 2 suggester calls/turn)\n`);

    const t0 = Date.now();
    const results = await runBench(change);
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nDone in ${wallSec}s`);

    printReport(change, results);
  }
}

await main();
