#!/usr/bin/env bun
/**
 * Benchmark candidate models on the Jordan fixture for the suggester role.
 *
 * Measures per call:
 *   - TTFT (time to first token of streamed response)
 *   - TTLT (time to last token / total wall time)
 *   - Output JSON parse (shouldFire, priority, play, markdown)
 *
 * For each model, processes the full Jordan fixture sequentially, tracking
 * recentSuggestions across turns so the cadence rule has its real input.
 *
 * Usage:
 *   bun run scripts/bench-suggester-models.ts
 *   KEEP_RAW=1 bun run scripts/bench-suggester-models.ts   # also dump raw text
 */

import { streamText, createGateway } from 'ai';
import { resolve } from 'node:path';
import { SUGGESTER_SYSTEM } from '../src/agents/suggester';

if (!process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.AI_GATEWAY_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log('bench — skipped (no gateway key in env)');
  process.exit(0);
}

// Native AI Gateway provider — knows the gateway's model registry, so reasoning
// options on gpt-5.4-mini are honored instead of dropped by the OpenAI provider.
const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN ?? process.env.OPENAI_API_KEY ?? '',
});

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');

type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(FIXTURE_PATH).text());

type ProviderOpts = Record<string, Record<string, string | number | boolean>>;
type Variant = {
  label: string;
  model: string;
  providerOpts?: ProviderOpts;
};

// gpt-5.4 / 5.4-mini require BOTH reasoningEffort and reasoningSummary per Vercel docs.
const reasoningOpts = (effort: 'minimal' | 'low' | 'medium' | 'high'): ProviderOpts => ({
  openai: { reasoningEffort: effort, reasoningSummary: 'detailed' },
});

// gemini-3-flash vs gpt-5.4-mini baseline. Try a couple of "disable reasoning"
// shapes for Google since the provider syntax differs from OpenAI.
const VARIANTS: Variant[] = [
  { label: 'gpt-5.4-mini (baseline)',                model: 'openai/gpt-5.4-mini' },
  { label: 'gemini-3-flash (no param)',              model: 'google/gemini-3-flash' },
  { label: 'gemini-3-flash (reasoningEffort=minimal)', model: 'google/gemini-3-flash',
    providerOpts: { google: { reasoningEffort: 'minimal' } } },
  { label: 'gemini-3-flash (thinkingBudget=0)',      model: 'google/gemini-3-flash',
    providerOpts: { google: { thinkingBudget: 0 } } },
];

type Decision = {
  shouldFire: boolean;
  priority: string;
  play: string;
  markdown: string;
  reasoning: string;
};

type CallResult = {
  turn: number;
  speaker: 'rep' | 'customer';
  ttftMs: number;
  ttltMs: number;
  decision: Decision | null;
  rawText: string;
  error?: string;
};

const JSON_INSTR = `Output ONLY a JSON object with these fields, no prose, no markdown fences:
{"shouldFire": boolean, "priority": "critical"|"nudge"|"fyi", "play": string, "markdown": string, "reasoning": string, "groundedInUtteranceIds": string[], "groundedInAnchorTurnIds": string[]}`;

function buildUserPrompt(turn: number, utt: Utt, hotTail: Utt[], recent: Array<{turn: number; agent: string; fired: boolean; priority: string; play: string; markdown: string}>): string {
  const isProspect = utt.speaker === 'customer';
  const speakerLabel = isProspect ? 'PROSPECT' : 'REP';
  const modeLabel = isProspect ? 'PROSPECT MODE' : 'REP MODE';
  const priorOpposite = [...hotTail].reverse().find(h => h.speaker !== utt.speaker);
  const firedCount = recent.filter(r => r.fired).slice(-5).length;
  const recentLines = recent.length === 0
    ? '(none yet)'
    : recent.map(r => `- t${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.agent}/${r.priority}/${r.play}] ${r.markdown || '(no text)'}`).join('\n');

  const hotTailLines = hotTail.map(h => `[${h.id}] ${h.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${h.text}`).join('\n');

  return `# CALL CONTEXT
Lead: Jordan Hayes, VP Marketing @ MidCo
Call goal: discovery + qualify outbound automation fit
Recent transcript (oldest first):
${hotTailLines || '(none)'}

# ${isProspect ? 'IMMEDIATE PRIOR REP UTTERANCE' : 'IMMEDIATE PRIOR PROSPECT UTTERANCE'}
${priorOpposite ? `[${priorOpposite.id}] ${priorOpposite.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${priorOpposite.text}` : '(none)'}

# NEW ${speakerLabel} UTTERANCE — you are in ${modeLabel}
[${utt.id}] ${speakerLabel}: ${utt.text}

# RECENT SUGGESTIONS (your last decisions, oldest first; ${firedCount} of last 5 fired)
${recentLines}

# CONTRADICTIONS DETECTED
(none)

Decide. ${JSON_INSTR}`;
}

function tryParseJson(text: string): Decision | null {
  // strip ```json fences if present
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  // grab first {...} block
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

async function callModel(
  model: string,
  system: string,
  prompt: string,
  providerOpts?: ProviderOpts,
  timeoutMs = 30_000,
): Promise<{
  ttftMs: number;
  ttltMs: number;
  text: string;
  error?: string;
}> {
  const start = Date.now();
  let ttft = -1;
  let text = '';
  try {
    const stream = streamText({
      model: gateway(model),
      system,
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
      ...(providerOpts ? { providerOptions: providerOpts } : {}),
    });
    for await (const chunk of stream.textStream) {
      if (ttft === -1) ttft = Date.now() - start;
      text += chunk;
    }
    const ttlt = Date.now() - start;
    return { ttftMs: ttft, ttltMs: ttlt, text };
  } catch (err) {
    const ttlt = Date.now() - start;
    return { ttftMs: ttft, ttltMs: ttlt, text, error: err instanceof Error ? err.message : String(err) };
  }
}

async function benchOne(variant: Variant): Promise<{ label: string; model: string; calls: CallResult[]; firstError?: string; bailed?: boolean }> {
  const { label, model, providerOpts } = variant;
  const calls: CallResult[] = [];
  const recent: Array<{turn: number; agent: string; fired: boolean; priority: string; play: string; markdown: string}> = [];
  let firstError: string | undefined;
  let consecutiveFailures = 0;
  let bailed = false;
  const startedAt = Date.now();

  for (let i = 0; i < fixture.length; i++) {
    const utt = fixture[i];
    const turn = i + 1;
    const hotTail = fixture.slice(Math.max(0, i - 5), i);
    const userPrompt = buildUserPrompt(turn, utt, hotTail, recent);

    // Reasoning models think before emitting — bump per-call timeout.
    const effort = providerOpts?.openai?.reasoningEffort;
    const timeoutMs = effort === 'high' ? 90_000 : effort === 'medium' ? 60_000 : 30_000;
    const r = await callModel(model, SUGGESTER_SYSTEM, userPrompt, providerOpts, timeoutMs);
    if (r.error && !firstError) firstError = r.error;
    const decision = r.text ? tryParseJson(r.text) : null;

    calls.push({
      turn,
      speaker: utt.speaker,
      ttftMs: r.ttftMs,
      ttltMs: r.ttltMs,
      decision,
      rawText: r.text,
      error: r.error,
    });

    if (r.error || !decision) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        bailed = true;
        console.log(`[${model}] bailed after ${consecutiveFailures} consecutive failures (turn ${turn})`);
        break;
      }
    } else {
      consecutiveFailures = 0;
      const agent = utt.speaker === 'customer' ? 'prospect_suggester' : 'rep_watcher';
      recent.push({
        turn,
        agent,
        fired: decision.shouldFire && decision.priority !== 'fyi',
        priority: decision.priority,
        play: decision.play,
        markdown: decision.markdown,
      });
      if (recent.length > 6) recent.splice(0, recent.length - 6);
    }
  }
  const wallSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${label}] done (${calls.length}/${fixture.length} turns, wall=${wallSec}s${bailed ? ', bailed' : ''})`);
  return { label, model, calls, firstError, bailed };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(model: string, calls: CallResult[], firstError?: string) {
  const ok = calls.filter(c => !c.error && c.decision);
  const errs = calls.filter(c => c.error || !c.decision);
  if (ok.length === 0) {
    console.log(`  ${model}: NO SUCCESSFUL CALLS (${errs.length} failed). first error: ${firstError ?? '(none)'}`);
    return null;
  }
  const ttftAll = ok.map(c => c.ttftMs).filter(n => n >= 0);
  const ttltAll = ok.map(c => c.ttltMs);
  const fired = ok.filter(c => c.decision!.shouldFire && c.decision!.priority !== 'fyi');
  const summary = {
    model,
    ok: ok.length,
    failed: errs.length,
    fired: fired.length,
    ttftP50: pct(ttftAll, 0.5),
    ttftP95: pct(ttftAll, 0.95),
    ttltP50: pct(ttltAll, 0.5),
    ttltP95: pct(ttltAll, 0.95),
    firstFireTurn: fired.length > 0 ? fired[0].turn : null,
  };
  return summary;
}

async function main() {
  console.log(`Benching ${VARIANTS.length} variants in parallel on ${fixture.length}-turn fixture (bail at 3 consecutive failures)\n`);
  const t0 = Date.now();
  const allResults = await Promise.all(VARIANTS.map(v => benchOne(v)));
  console.log(`\nAll variants done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall.`);

  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log('SUMMARY (per-model aggregates)');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log(
    'variant'.padEnd(46) +
    'ok'.padStart(4) +
    'err'.padStart(5) +
    'fired'.padStart(7) +
    'firstFire'.padStart(11) +
    ' ttft p50/p95'.padStart(16) +
    ' ttlt p50/p95'.padStart(16)
  );
  for (const r of allResults) {
    const s = summarize(r.label, r.calls, r.firstError);
    if (!s) {
      console.log(`${r.label.padEnd(46)} -- all failed -- (${r.firstError?.slice(0, 80) ?? ''})`);
      continue;
    }
    console.log(
      r.label.padEnd(46) +
      String(s.ok).padStart(4) +
      String(s.failed).padStart(5) +
      String(s.fired).padStart(7) +
      String(s.firstFireTurn ?? '-').padStart(11) +
      `  ${s.ttftP50}/${s.ttftP95}ms`.padStart(16) +
      `  ${s.ttltP50}/${s.ttltP95}ms`.padStart(16)
    );
  }

  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log('FIRED-SUGGESTION COMPARISON (per turn, only fires shown)');
  console.log('────────────────────────────────────────────────────────────────────');

  const TURN_LABELS: Record<number, string> = {};
  for (let i = 0; i < fixture.length; i++) {
    const u = fixture[i];
    const t = `t${i + 1}`;
    TURN_LABELS[i + 1] = `${t} ${u.speaker === 'customer' ? 'PROSPECT' : 'REP'}: ${u.text.slice(0, 80)}${u.text.length > 80 ? '…' : ''}`;
  }

  for (let turn = 1; turn <= fixture.length; turn++) {
    let header = false;
    for (const r of allResults) {
      const c = r.calls.find(x => x.turn === turn);
      if (!c?.decision?.shouldFire || c.decision.priority === 'fyi') continue;
      if (!header) {
        console.log(`\n${TURN_LABELS[turn]}`);
        header = true;
      }
      console.log(`  ${r.label.padEnd(46)} [${c.decision.priority}/${c.decision.play}] ${c.decision.markdown}`);
    }
  }

  if (process.env.KEEP_RAW) {
    console.log('\n[KEEP_RAW set — raw outputs not implemented in this version]');
  }
}

await main();
