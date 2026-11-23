#!/usr/bin/env bun
/**
 * Benchmark candidate models for the memory/extractor agent role.
 *
 * Each variant runs the full Jordan fixture sequentially, maintaining real
 * MemoryStore state across turns so later-turn prompts reflect genuine
 * accumulated memory (as the production agent experiences it).
 *
 * Measures per call:
 *   - TTFT: time to first token of streamed partial object
 *   - TTLT: time to last token / total wall time
 *
 * Qualitative output:
 *   - Per-turn: flow tag, anchor emitted, fact/qualSignal/decisionGeo counts
 *   - End: side-by-side flow sequence, all anchors, all facts per model
 *
 * Usage:
 *   bun run scripts/bench-memory-models.ts
 *   KEEP_RAW=1 bun run scripts/bench-memory-models.ts   # dump raw partial streams
 */

import { streamText, createGateway } from 'ai';
import { resolve } from 'node:path';
import { MemoryPatchSchema } from '@atlas/types';
import type { MemoryPatch, MeetingMemory } from '@atlas/types';
import { MemoryStore } from '../src/lib/memory/store';
import { HotTail } from '../src/lib/memory/hotTail';
import { MEMORY_AGENT_SYSTEM } from '../src/server/agents/memoryAgent';

if (!process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
  console.log('bench — skipped (no gateway key in env)');
  process.exit(0);
}

// Native AI Gateway provider — knows the gateway's model registry, so reasoning
// options on gpt-5.4-mini are honored instead of dropped by the OpenAI provider.
// (Strict-JSON-Schema only mattered for streamObject; we use streamText here.)
const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN ?? '',
});

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');

type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(FIXTURE_PATH).text());

type ProviderOpts = Record<string, Record<string, string | number | boolean>>;
type Variant = {
  label: string;
  model: string;
  system: string;
  providerOpts?: ProviderOpts;
};

// OLD_SYSTEM: the version that existed before this round of prompt-engineering changes.
// Snapshotted here so the bench can compare against the new MEMORY_AGENT_SYSTEM.
const OLD_SYSTEM = `You are Atlas's call memorizer. Your job: update the structured memory after each utterance so downstream agents have minimum useful state. DO NOT TRANSCRIBE.

EMIT EXACTLY ONE FLOW ENTRY per utterance, picking the best tag:
- R-Q: rep asked a question
- R-VP: rep pitched a value prop / talking point
- R-OBJ-RESP: rep responded to an objection
- R-NS: rep proposed a concrete next step
- R-MISTAKE: rep made a mistake (leading question, feature dump, premature discount, missed cue, defended objection)
- P-PAIN: prospect named a pain
- P-METRIC: prospect quantified (number, %, hours, $)
- P-OBJ: prospect objected / hesitated
- P-STAKE: prospect named a stakeholder (person or role)
- P-BUY: prospect buying signal (asked implementation, pricing, rollout, integration)
- P-COMP: prospect mentioned a competitor / current vendor
- P-NEG: prospect said they DON'T track / DON'T have / WON'T do something on a BANT/MEDDIC axis (confirmed-negative)
- P-DQ: prospect disqualify signal ("send me info", scope creep, sole-DM at scale)
- OTHER: small talk, filler, unclear

Flow content: 3-10 words, paraphrased, specific (cite a number/name/topic). Never verbatim unless it's an anchor.

EMIT A VERBATIM ANCHOR ONLY when the quote contains:
- a number ($amount, hours, %, count)
- a name + authority/role ("CFO Diane", "Marcus runs RevOps")
- a date or timeline ("end of Q2", "by next quarter")
- a confirmed-negative on a BANT/MEDDIC axis ("we don't track NPS")
- a stated consequence ("if we don't fix this we lose the segment")
Anchors are SPARSE. If unsure → don't anchor.

Anchor axis options: need, budget, authority, timeline, metric, champion, consequence, competitor, stakeholder.

NEGATIVE SIGNAL RULE: when the prospect explicitly says they don't/won't/can't on an axis, append a qualSignal with direction='negative' AND record an axisFlip with state='confirmed_negative' for that axis.

Update structured fields (facts, concerns, qualSignals, decisionGeography, openLoops) where warranted. For named people, ALWAYS upsert decisionGeography with sentiment='unknown' if not yet expressed.

Diagnostic fact keys to prefer: pain.cost_*, pain.consequence_*, pain.frequency_*, trigger.*, champion.<name>, process.<step>, competitor.<name>.`;

// Reasoning effort options — honored by createGateway (the native AI Gateway provider)
// for reasoning-capable models. Per gateway error response: gpt-5.4-mini accepts
// 'none' | 'low' | 'medium' | 'high' | 'xhigh' (NOT 'minimal').
// Per Vercel docs both reasoningEffort and reasoningSummary should be set together.
const reasoning = (effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh'): ProviderOpts => ({
  openai: { reasoningEffort: effort, reasoningSummary: 'detailed' },
});

const VARIANTS: Variant[] = [
  // gpt-5.4-mini — sweep reasoning effort on NEW prompt; compare prompts at r=low
  { label: '5.4-mini · NEW · r=none',  model: 'openai/gpt-5.4-mini',   system: MEMORY_AGENT_SYSTEM, providerOpts: reasoning('none') },
  { label: '5.4-mini · NEW · r=low',   model: 'openai/gpt-5.4-mini',   system: MEMORY_AGENT_SYSTEM, providerOpts: reasoning('low') },
  { label: '5.4-mini · NEW · r=medium',model: 'openai/gpt-5.4-mini',   system: MEMORY_AGENT_SYSTEM, providerOpts: reasoning('medium') },
  { label: '5.4-mini · OLD · r=low',   model: 'openai/gpt-5.4-mini',   system: OLD_SYSTEM,          providerOpts: reasoning('low') },
  // gpt-oss-120b via cerebras — try reasoning, but cerebras may not honor it
  { label: 'oss-120b · NEW · r=low',   model: 'cerebras/gpt-oss-120b', system: MEMORY_AGENT_SYSTEM, providerOpts: reasoning('low') },
  { label: 'oss-120b · NEW · r=none',  model: 'cerebras/gpt-oss-120b', system: MEMORY_AGENT_SYSTEM, providerOpts: reasoning('none') },
  { label: 'oss-120b · OLD · r=low',   model: 'cerebras/gpt-oss-120b', system: OLD_SYSTEM,          providerOpts: reasoning('low') },
];

// Validation schema — used only to parse + validate streamed text output.
const PATCH_SCHEMA = MemoryPatchSchema.omit({ utteranceId: true, turnId: true, speaker: true });

type PatchCore = Omit<MemoryPatch, 'utteranceId' | 'turnId' | 'speaker'>;

// Appended to each prompt to instruct free-text models to output valid JSON.
// IMPORTANT: enum values must be exact — schema validation will reject anything else.
const JSON_INSTR = `Output ONLY a compact JSON object (no whitespace, no markdown fences) matching:
{"flow":{"tag":"<ONE OF: OTHER|R-Q|R-VP|R-OBJ-RESP|R-NS|R-MISTAKE|P-PAIN|P-METRIC|P-OBJ|P-STAKE|P-BUY|P-COMP|P-NEG|P-DQ>","content":"<3-10 words paraphrase>"},"anchor":{"axis":"<ONE OF: need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder>","verbatim":"<exact quote>"},"facts":[{"op":"upsert","key":"<dot.notation.key>","category":"<ONE OF: budget|timeline|tech_stack|team|process|competitor|other>","content":"<value>","confidence":<0.0-1.0>}],"concerns":[{"op":"<upsert|append>","topic":"<topic>","verbatim":"<quote>","severity":"<mentioned|pressed|blocking>"}],"openLoops":[{"op":"<append|close>","description":"<desc>","owner":"<rep|customer>"}],"qualSignals":[{"op":"append","direction":"<positive|negative>","meddic":"<metrics|economic_buyer|decision_criteria|decision_process|identify_pain|champion|budget>","bantBucket":"<budget|authority|need|timeline>","content":"<summary>"}],"decisionGeography":[{"op":"upsert","name":"<person name>","role":"<title/role>","sentiment":"<positive|neutral|negative|unknown>"}],"axisFlips":[{"axis":"<need|budget|authority|timeline|metrics|economicBuyer|decisionCriteria|decisionProcess|identifyPain|champion>","state":"<unknown|vague|soft|partial|firm|confirmed|confirmed_negative>"}]}
Omit "anchor" if no verbatim anchor. Omit any array field if empty. All enum values must match exactly.`;

type TurnResult = {
  turn: number;
  speaker: 'rep' | 'customer';
  text: string;
  ttftMs: number;
  ttltMs: number;
  patch: PatchCore | null;
  error?: string;
};

function buildPrompt(utt: Utt, turnId: string, prevMemory: MeetingMemory, hotTail: Array<{ id: string; speaker: string; text: string }>): string {
  const existingFacts = prevMemory.facts.slice(-15).map((f) => `${f.key}: ${f.content}`).join('\n');
  const existingAnchors = prevMemory.verbatimAnchors.slice(-10).map((a) => `[${a.axis}] "${a.verbatim}"`).join('\n');
  const recentFlow = prevMemory.flow.slice(-10).map((f) => `[${f.turnId}] ${f.tag} ${f.content}`).join('\n');
  const tail = hotTail.map((h) => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');

  return `TURN ID: ${turnId}
SPEAKER: ${utt.speaker}
NEW UTTERANCE [${utt.id}]:
${utt.speaker.toUpperCase()}: ${utt.text}

HOT TAIL (last raw utterances, for context — do not re-extract):
${tail || '(empty)'}

RECENT FLOW (last 10):
${recentFlow || '(empty)'}

EXISTING FACTS (last 15, do not re-extract unless changed):
${existingFacts || '(none)'}

EXISTING ANCHORS (last 10):
${existingAnchors || '(none)'}

Emit the memory patch.`;
}

type ParseResult = { patch: PatchCore } | { error: string };

function tryParseJson(text: string): ParseResult {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { error: `no_json_block [${text.length}chars] (${text.slice(0, 150)})` };
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { error: `json_syntax [${text.length}chars] (${text.slice(0, 150)})` };
  }
  const result = PATCH_SCHEMA.safeParse(obj);
  if (result.success) return { patch: result.data };
  // Schema failed — show which fields are wrong
  const issues = result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { error: `schema [${text.length}chars] ${issues}` };
}

async function callModel(
  model: string,
  system: string,
  prompt: string,
  providerOpts?: ProviderOpts,
  timeoutMs = 30_000,
): Promise<{ ttftMs: number; ttltMs: number; patch: PatchCore | null; error?: string }> {
  const start = Date.now();
  let ttft = -1;
  let text = '';

  try {
    const stream = streamText({
      model: gateway(model),
      system,
      prompt: `${prompt}\n\n${JSON_INSTR}`,
      maxTokens: 3000,
      abortSignal: AbortSignal.timeout(timeoutMs),
      ...(providerOpts ? { providerOptions: providerOpts } : {}),
    });

    for await (const chunk of stream.textStream) {
      if (ttft === -1) ttft = Date.now() - start;
      text += chunk;
    }

    const ttlt = Date.now() - start;
    const parsed = tryParseJson(text);
    return {
      ttftMs: ttft,
      ttltMs: ttlt,
      patch: 'patch' in parsed ? parsed.patch : null,
      error: 'error' in parsed ? parsed.error : undefined,
    };
  } catch (err) {
    const ttlt = Date.now() - start;
    return {
      ttftMs: ttft,
      ttltMs: ttlt,
      patch: null,
      error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
  }
}

async function benchOne(variant: Variant): Promise<{ label: string; calls: TurnResult[] }> {
  const { label, model, system, providerOpts } = variant;
  const store = new MemoryStore();
  const hotTail = new HotTail(5);
  const calls: TurnResult[] = [];
  let consecutiveFailures = 0;
  const startedAt = Date.now();

  for (let i = 0; i < fixture.length; i++) {
    const utt = fixture[i];
    const turn = i + 1;
    const turnId = `t${turn}`;

    const prompt = buildPrompt(utt, turnId, store.snapshot, hotTail.snapshot());
    const r = await callModel(model, system, prompt, providerOpts);

    calls.push({ turn, speaker: utt.speaker, text: utt.text, ...r });

    if (r.patch) {
      consecutiveFailures = 0;
      // Apply patch to advance state for subsequent turns
      const fullPatch: MemoryPatch = {
        ...r.patch,
        utteranceId: utt.id,
        turnId,
        speaker: utt.speaker,
      };
      try { store.applyMemoryPatch(fullPatch); } catch { /* non-fatal */ }
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.log(`[${label}] bailed after ${consecutiveFailures} consecutive failures at turn ${turn}`);
        break;
      }
    }

    // Always advance hot tail so context window stays accurate
    hotTail.push({ id: utt.id, speaker: utt.speaker, text: utt.text, startMs: utt.startMs, endMs: utt.endMs, confidence: 0.99, derivedFromLowConfidence: false });
  }

  const wallSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${label}] done (${calls.length}/${fixture.length} turns, wall=${wallSec}s)`);
  return { label, calls };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function printSummary(results: { label: string; calls: TurnResult[] }[]) {
  console.log('\n' + '─'.repeat(90));
  console.log('SUMMARY (latency + extraction counts)');
  console.log('─'.repeat(90));
  console.log(
    'variant'.padEnd(32) +
    'ok'.padStart(4) + 'err'.padStart(5) +
    'flow'.padStart(6) + 'anchors'.padStart(9) + 'facts'.padStart(7) + 'quals'.padStart(7) + 'decGeo'.padStart(8) +
    ' ttft p50/p95(ms)'.padStart(20) +
    ' ttlt p50/p95(ms)'.padStart(20)
  );

  for (const { label, calls } of results) {
    const ok = calls.filter(c => c.patch);
    const errs = calls.filter(c => !c.patch);
    const ttftAll = ok.map(c => c.ttftMs).filter(n => n >= 0);
    const ttltAll = ok.map(c => c.ttltMs);
    const flowCount = ok.filter(c => c.patch?.flow).length;
    const anchorCount = ok.filter(c => c.patch?.anchor).length;
    const factsTotal = ok.reduce((s, c) => s + (c.patch?.facts?.length ?? 0), 0);
    const qualsTotal = ok.reduce((s, c) => s + (c.patch?.qualSignals?.length ?? 0), 0);
    const decGeoTotal = ok.reduce((s, c) => s + (c.patch?.decisionGeography?.length ?? 0), 0);

    console.log(
      label.padEnd(32) +
      String(ok.length).padStart(4) + String(errs.length).padStart(5) +
      String(flowCount).padStart(6) + String(anchorCount).padStart(9) + String(factsTotal).padStart(7) + String(qualsTotal).padStart(7) + String(decGeoTotal).padStart(8) +
      `  ${pct(ttftAll, 0.5)}/${pct(ttftAll, 0.95)}`.padStart(20) +
      `  ${pct(ttltAll, 0.5)}/${pct(ttltAll, 0.95)}`.padStart(20)
    );
  }
}

function printFlowComparison(results: { label: string; calls: TurnResult[] }[]) {
  console.log('\n' + '─'.repeat(90));
  console.log('FLOW SEQUENCE COMPARISON (all turns, tag + content)');
  console.log('─'.repeat(90));

  const maxTurns = Math.max(...results.map(r => r.calls.length));
  for (let i = 0; i < maxTurns; i++) {
    const turn = i + 1;
    // Get utterance text from first result that has this turn
    const anyCall = results.flatMap(r => r.calls).find(c => c.turn === turn);
    if (!anyCall) continue;
    const uttPreview = `${anyCall.speaker === 'customer' ? 'P' : 'R'}: ${anyCall.text.slice(0, 70)}${anyCall.text.length > 70 ? '…' : ''}`;
    console.log(`\nt${turn} ${uttPreview}`);
    for (const { label, calls } of results) {
      const c = calls.find(x => x.turn === turn);
      if (!c) { console.log(`  ${label.padEnd(32)} (missing turn)`); continue; }
      if (!c.patch) { console.log(`  ${label.padEnd(32)} ERROR: ${c.error ?? '?'}`); continue; }
      const flow = c.patch.flow ? `[${c.patch.flow.tag}] ${c.patch.flow.content}` : '(no flow)';
      const anchor = c.patch.anchor ? ` ⚓[${c.patch.anchor.axis}] "${c.patch.anchor.verbatim.slice(0, 60)}"` : '';
      console.log(`  ${label.padEnd(32)} ${flow}${anchor}`);
    }
  }
}

function printAnchors(results: { label: string; calls: TurnResult[] }[]) {
  console.log('\n' + '─'.repeat(90));
  console.log('VERBATIM ANCHORS EMITTED (per model)');
  console.log('─'.repeat(90));
  for (const { label, calls } of results) {
    const anchors = calls.filter(c => c.patch?.anchor);
    console.log(`\n${label} (${anchors.length} anchors):`);
    for (const c of anchors) {
      console.log(`  t${c.turn} [${c.patch!.anchor!.axis}] "${c.patch!.anchor!.verbatim}"`);
    }
  }
}

function printFacts(results: { label: string; calls: TurnResult[] }[]) {
  console.log('\n' + '─'.repeat(90));
  console.log('FACTS EXTRACTED (per model, grouped by key)');
  console.log('─'.repeat(90));
  for (const { label, calls } of results) {
    const allFacts = calls.flatMap(c => (c.patch?.facts ?? []).map(f => ({ turn: c.turn, ...f })));
    const byKey = new Map<string, typeof allFacts>();
    for (const f of allFacts) {
      const existing = byKey.get(f.key) ?? [];
      existing.push(f);
      byKey.set(f.key, existing);
    }
    console.log(`\n${label} (${allFacts.length} fact ops, ${byKey.size} unique keys):`);
    for (const [key, entries] of [...byKey.entries()].slice(0, 25)) {
      const last = entries[entries.length - 1];
      const revs = entries.length > 1 ? ` (${entries.length}x)` : '';
      console.log(`  ${key}${revs}: ${last.content} [conf=${last.confidence.toFixed(2)}]`);
    }
    if (byKey.size > 25) console.log(`  … and ${byKey.size - 25} more keys`);
  }
}

function printQualSignals(results: { label: string; calls: TurnResult[] }[]) {
  console.log('\n' + '─'.repeat(90));
  console.log('QUAL SIGNALS (per model)');
  console.log('─'.repeat(90));
  for (const { label, calls } of results) {
    const sigs = calls.flatMap(c => (c.patch?.qualSignals ?? []).map(q => ({ turn: c.turn, ...q })));
    console.log(`\n${label} (${sigs.length} signals):`);
    for (const q of sigs) {
      const dir = q.direction === 'positive' ? '+' : '-';
      console.log(`  t${q.turn} ${dir} [${q.bantBucket}/${q.meddic}] ${q.content}`);
    }
  }
}

function printErrors(results: { label: string; calls: TurnResult[] }[]) {
  const anyErrors = results.some(r => r.calls.some(c => c.error));
  if (!anyErrors) return;
  console.log('\n' + '─'.repeat(90));
  console.log('ERRORS');
  console.log('─'.repeat(90));
  for (const { label, calls } of results) {
    const errs = calls.filter(c => c.error);
    if (errs.length === 0) continue;
    console.log(`\n${label}:`);
    for (const c of errs) console.log(`  t${c.turn}: ${c.error}`);
  }
}

async function main() {
  console.log(`Benching ${VARIANTS.length} variants in parallel on ${fixture.length}-turn Jordan fixture\n`);
  const t0 = Date.now();
  const allResults = await Promise.all(VARIANTS.map(v => benchOne(v)));
  console.log(`\nAll variants done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall.\n`);

  printSummary(allResults);
  printFlowComparison(allResults);
  printAnchors(allResults);
  printFacts(allResults);
  printQualSignals(allResults);
  printErrors(allResults);
}

await main();
