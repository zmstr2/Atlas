#!/usr/bin/env bun
/**
 * schema-fuzz.ts (Wave 3.2)
 *
 * Conformance fuzzer: runs the suggester against multiple model variants on a
 * fixed bank of 12 representative utterances. Parses each response with a
 * STRICT version of SuggestionSchema (no preprocessors, no defaults) and
 * reports drift per model.
 *
 * Purpose: the preprocessors in packages/types/src/agents.ts silently rescue
 * malformed outputs from production. This script reveals what each model is
 * actually emitting so we can update prompts (not just preprocessors) when
 * drift appears.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/schema-fuzz.ts
 */

import { z } from 'zod';

const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// ── Strict schema (no preprocessors, no defaults) ──────────────────────────
const SuggestionPlayStrict = z.enum([
  'drill_vague', 'quantify_pain', 'probe_stakeholder', 'reframe_objection',
  'surface_value_prop', 'competitor_handle', 'push_next_axis', 'trial_close',
  'multi_thread', 'anchor_next_step', 'qualify_out', 'correct_contradiction',
  'rep_leading_question', 'rep_feature_dump', 'rep_premature_discount',
  'rep_missed_buying_signal', 'rep_skipped_drill', 'rep_defended_objection',
  'rep_off_ladder', 'rep_no_next_step', 'rep_pitched_outside_anchor', 'none',
]);

const AxisStrict = z.enum([
  'need', 'budget', 'authority', 'timeline', 'metric', 'champion',
  'consequence', 'competitor', 'stakeholder',
]);

const SuggestionStrict = z.object({
  shouldFire: z.boolean(),
  priority: z.enum(['critical', 'nudge', 'fyi']),
  play: SuggestionPlayStrict,
  axis: AxisStrict.nullable().optional(),
  markdown: z.string(),
  reasoning: z.string(),
  groundedInUtteranceIds: z.array(z.string()),
  groundedInAnchorTurnIds: z.array(z.string()),
});

// ── Tiny prompt — we don't care about correctness, just shape ───────────────
const SYSTEM = `You are a sales coach. After each utterance, decide whether to whisper a one-sentence suggestion to the rep.

Output a JSON object with these fields:
- shouldFire (boolean)
- priority ('critical' | 'nudge' | 'fyi')
- play (one of: drill_vague, quantify_pain, probe_stakeholder, reframe_objection, surface_value_prop, competitor_handle, push_next_axis, trial_close, multi_thread, anchor_next_step, qualify_out, correct_contradiction, rep_leading_question, rep_feature_dump, rep_premature_discount, rep_missed_buying_signal, rep_skipped_drill, rep_defended_objection, rep_off_ladder, rep_no_next_step, rep_pitched_outside_anchor, none)
- axis (one of: need, budget, authority, timeline, metric, champion, consequence, competitor, stakeholder, or null)
- markdown (string, ≤15 words, action verb first)
- reasoning (string)
- groundedInUtteranceIds (string array)
- groundedInAnchorTurnIds (string array)

If shouldFire is false, set play to "none" and markdown to "".`;

// 12 representative utterances spanning intro, pain, objection, close
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string };
const BANK: Utt[] = [
  { id: 'u01', speaker: 'rep', text: "Hey Maya, thanks for jumping on. How's your week?" },
  { id: 'u02', speaker: 'customer', text: "Yeah I'm Maya, VP Marketing at MidCo. We're 130 people, B2B SaaS." },
  { id: 'u03', speaker: 'rep', text: "What's your current outbound motion looking like?" },
  { id: 'u04', speaker: 'customer', text: "Honestly it's a mess. Two SDRs in spreadsheets, nothing's connected." },
  { id: 'u05', speaker: 'customer', text: "We lose like six hours every Tuesday reconciling data between tools." },
  { id: 'u06', speaker: 'rep', text: "Got it. So we have AI sequences, native HubSpot sync, and 3x pipeline lift in 90 days." },
  { id: 'u07', speaker: 'customer', text: "I'm honestly skeptical — we tried Marketo and it didn't work for us either." },
  { id: 'u08', speaker: 'rep', text: "That's exactly where we're different. Our AI learns from your reply patterns." },
  { id: 'u09', speaker: 'customer', text: "Marcus from RevOps would have to sign off on any tooling decision." },
  { id: 'u10', speaker: 'customer', text: "Yeah I think we'd be ready to look at this seriously by Q3." },
  { id: 'u11', speaker: 'rep', text: "I'll circle back in Q3 then. Talk soon!" },
  { id: 'u12', speaker: 'customer', text: "Sounds good, looking forward to it." },
];

// ── Models to test ──────────────────────────────────────────────────────────
const MODELS = [
  { label: 'gpt-oss-20b (low)', orId: 'openai/gpt-oss-20b', reasoningEffort: 'low' as const },
  { label: 'gpt-5.4-mini (off)', orId: 'openai/gpt-5.4-mini', reasoningOff: true },
  { label: 'gpt-oss-120b (low)', orId: 'openai/gpt-oss-120b', reasoningEffort: 'low' as const },
];

async function callModel(modelOrId: string, opts: { reasoningEffort?: 'low' | 'high'; reasoningOff?: boolean }, utt: Utt): Promise<{ raw: string; latencyMs: number }> {
  const start = Date.now();
  const body: Record<string, unknown> = {
    model: modelOrId,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `New utterance: [${utt.id}] ${utt.speaker.toUpperCase()}: ${utt.text}\n\nOutput ONLY a JSON object.` },
    ],
    max_tokens: 1000,
    provider: { sort: 'throughput' },
    response_format: { type: 'json_object' },
  };
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
  if (opts.reasoningOff) body.reasoning = { enabled: false };

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    return { raw: `HTTP ${r.status}: ${(await r.text()).slice(0, 100)}`, latencyMs: Date.now() - start };
  }
  const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { raw: j.choices?.[0]?.message?.content ?? '', latencyMs: Date.now() - start };
}

type DriftEvent = {
  field: string;
  issue: string;
  rawValue?: string;
};

function analyzeDrift(raw: string): { parsed: boolean; drift: DriftEvent[] } {
  const drift: DriftEvent[] = [];
  let obj: unknown;
  try {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    obj = JSON.parse(trimmed);
  } catch {
    return { parsed: false, drift: [{ field: '_root', issue: 'invalid JSON' }] };
  }

  const o = obj as Record<string, unknown>;

  // Field presence
  const required = ['shouldFire', 'priority', 'play', 'markdown', 'reasoning'];
  for (const f of required) {
    if (!(f in o)) drift.push({ field: f, issue: 'missing' });
  }

  // Type checks
  if (typeof o.shouldFire !== 'boolean') drift.push({ field: 'shouldFire', issue: 'not boolean', rawValue: String(o.shouldFire) });
  if (typeof o.markdown !== 'string') drift.push({ field: 'markdown', issue: 'not string', rawValue: String(o.markdown) });

  // Enum drift
  if (o.play && !SuggestionPlayStrict.options.includes(o.play as any)) {
    drift.push({ field: 'play', issue: 'unknown enum value', rawValue: String(o.play) });
  }
  if (o.priority && !['critical', 'nudge', 'fyi'].includes(o.priority as string)) {
    drift.push({ field: 'priority', issue: 'unknown enum value', rawValue: String(o.priority) });
  }
  if (o.axis !== undefined && o.axis !== null && !AxisStrict.options.includes(o.axis as any)) {
    drift.push({ field: 'axis', issue: 'unknown enum value', rawValue: String(o.axis) });
  }

  // ID arrays — should be string arrays
  if (Array.isArray(o.groundedInUtteranceIds)) {
    for (const v of o.groundedInUtteranceIds) {
      if (typeof v !== 'string') drift.push({ field: 'groundedInUtteranceIds[]', issue: 'non-string element', rawValue: `${typeof v} ${v}` });
    }
  }

  // Fire-with-empty-markdown
  if (o.shouldFire === true && typeof o.markdown === 'string' && o.markdown.trim().length === 0) {
    drift.push({ field: 'markdown', issue: 'empty on fire' });
  }

  // Try strict parse
  const parsed = SuggestionStrict.safeParse(obj);
  return { parsed: parsed.success, drift };
}

async function main() {
  console.log('Schema conformance fuzzer — strict parse drift report\n');
  console.log(`Models: ${MODELS.length} × Utterances: ${BANK.length} = ${MODELS.length * BANK.length} calls\n`);

  const results: Array<{
    model: string;
    utteranceId: string;
    parsed: boolean;
    drift: DriftEvent[];
    latencyMs: number;
  }> = [];

  for (const m of MODELS) {
    for (const utt of BANK) {
      const { raw, latencyMs } = await callModel(m.orId, m, utt);
      const { parsed, drift } = analyzeDrift(raw);
      results.push({ model: m.label, utteranceId: utt.id, parsed, drift, latencyMs });
      process.stdout.write(parsed ? '.' : 'x');
    }
    process.stdout.write(' ' + m.label + '\n');
  }

  // ─── Per-model summary ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('PER-MODEL SUMMARY');
  console.log('═'.repeat(70));

  for (const m of MODELS) {
    const cells = results.filter((r) => r.model === m.label);
    const ok = cells.filter((c) => c.parsed && c.drift.length === 0).length;
    const withDrift = cells.filter((c) => c.drift.length > 0).length;
    const avgLatency = cells.reduce((s, c) => s + c.latencyMs, 0) / cells.length;
    console.log(`\n${m.label}: ${ok}/${cells.length} clean parses, ${withDrift} with drift (avg ${(avgLatency / 1000).toFixed(1)}s)`);

    const driftByField = new Map<string, number>();
    for (const c of cells) {
      for (const d of c.drift) {
        driftByField.set(d.field, (driftByField.get(d.field) ?? 0) + 1);
      }
    }
    for (const [field, count] of [...driftByField.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field}: ${count} events`);
    }
  }

  // ─── Detailed drift events ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('DRIFT DETAIL (first 30 events)');
  console.log('═'.repeat(70));
  let shown = 0;
  for (const r of results) {
    if (r.drift.length === 0) continue;
    for (const d of r.drift) {
      if (shown >= 30) break;
      console.log(`[${r.model}/${r.utteranceId}] ${d.field}: ${d.issue}${d.rawValue ? ` (got: ${d.rawValue.slice(0, 60)})` : ''}`);
      shown++;
    }
    if (shown >= 30) break;
  }

  console.log('\nDone.');
}

await main();
