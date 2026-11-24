#!/usr/bin/env bun
/**
 * 9-way OpenRouter suggester bench, providers sorted by throughput.
 *
 * Variants:
 *   1.  openai/gpt-oss-20b              reasoning_effort=low
 *   2.  openai/gpt-oss-20b              reasoning_effort=high
 *   3.  qwen/qwen3.6-35b-a3b
 *   4.  nvidia/nemotron-3-nano-30b-a3b
 *   5.  inception/mercury-2
 *   6.  liquid/lfm-2-24b-a2b
 *   7.  nvidia/llama-3.3-nemotron-super-49b-v1.5
 *   8.  qwen/qwen3.5-flash-02-23
 *   9.  mistralai/mistral-medium-3-5
 *
 * Routed through Vercel Gateway with `openrouter/<id>` prefix; provider sort
 * pinned to "throughput" via OpenRouter passthrough.
 *
 * 5 hand-picked Jordan turns × 9 variants = 45 parallel calls.
 *
 * Usage:
 *   AI_GATEWAY_API_KEY=xxx bun apps/agent/scripts/bench-suggester-openrouter-9way.ts
 */
import { resolve } from 'node:path';

// Route DIRECT to OpenRouter (Vercel Gateway doesn't carry these models).
const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));

const ROOT = resolve(import.meta.dir, '..', '..', '..');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-transcript.json')).text());
const brief = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-brief.json')).text());

const PICKED_TURNS = [4, 6, 12, 16, 18];

function extractStringLiteral(source: string, exportName: string): string {
  const re = new RegExp(`(?:export )?const ${exportName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`couldn't extract ${exportName}`);
  return m[1];
}
const SUGG_SYS = extractStringLiteral(
  await Bun.file(resolve(ROOT, 'apps/agent/src/agents/prospectSuggester.ts')).text(),
  'SYSTEM',
);
console.log(`Suggester prompt: ${SUGG_SYS.length} chars\n`);

type Variant = { label: string; orId: string; reasoningEffort?: 'low' | 'high' };
const VARIANTS: Variant[] = [
  { label: 'gpt-oss-20b (low)',      orId: 'openai/gpt-oss-20b', reasoningEffort: 'low' },
  { label: 'gpt-oss-20b (high)',     orId: 'openai/gpt-oss-20b', reasoningEffort: 'high' },
  { label: 'qwen3.6-35b-a3b',        orId: 'qwen/qwen3.6-35b-a3b' },
  { label: 'nemotron-3-nano-30b',    orId: 'nvidia/nemotron-3-nano-30b-a3b' },
  { label: 'mercury-2',              orId: 'inception/mercury-2' },
  { label: 'lfm-2-24b-a2b',          orId: 'liquid/lfm-2-24b-a2b' },
  { label: 'llama-3.3-nemo-49b',     orId: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' },
  { label: 'qwen3.5-flash-02-23',    orId: 'qwen/qwen3.5-flash-02-23' },
  { label: 'mistral-medium-3-5',     orId: 'mistralai/mistral-medium-3-5' },
];

const SUG_JSON_INSTR = `Output ONLY a compact JSON object matching:
{"shouldFire":<bool>,"priority":"<critical|nudge|fyi>","play":"<one of taxonomy>","axis":"<need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder> OR null","markdown":"<≤15 words>","reasoning":"<one paragraph>","groundedInUtteranceIds":[],"groundedInAnchorTurnIds":[]}
Output ONE JSON object only. No <think> blocks, no preamble, no markdown fences. Begin with { and end with }.`;

function buildSuggesterUserMsg(utt: Utt, hotTail: Utt[]): string {
  const priorRep = [...hotTail].reverse().find(h => h.speaker === 'rep');
  return `# CALL CONTEXT
(empty for this scenario)

# PRE-CALL BRIEF
Lead: ${brief.lead.name}, ${brief.lead.title} @ ${brief.lead.company}
Call goal: ${brief.callGoal}

# IMMEDIATE PRIOR REP UTTERANCE
${priorRep ? `[${priorRep.id}] REP: ${priorRep.text}` : '(none)'}

# NEW PROSPECT UTTERANCE
[${utt.id}] PROSPECT: ${utt.text}

# CONTRADICTIONS DETECTED
(none)

Decide whether to fire a suggestion.

${SUG_JSON_INSTR}`;
}

async function callGateway(v: Variant, system: string, userMsg: string): Promise<{
  text: string; ttltMs: number; promptTokens: number; completionTokens: number; error?: string;
}> {
  const start = Date.now();
  let text = ''; let promptTokens = 0; let completionTokens = 0;
  try {
    const body: any = {
      model: v.orId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      max_tokens: 4000,
      stream: true,
      stream_options: { include_usage: true },
      // OpenRouter native: sort underlying providers by throughput
      provider: { sort: 'throughput' },
    };
    if (v.reasoningEffort) {
      // OpenRouter unified reasoning controls; falls back to provider-specific equiv
      body.reasoning = { effort: v.reasoningEffort };
    }
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const errText = await r.text();
      return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${errText.slice(0, 150)}` };
    }
    if (!r.body) return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: 'no body' };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6).trim();
          if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            const d = j?.choices?.[0]?.delta?.content;
            if (typeof d === 'string') text += d;
            if (j?.usage) { promptTokens = j.usage.prompt_tokens ?? 0; completionTokens = j.usage.completion_tokens ?? 0; }
          } catch {}
        }
      }
    }
    // Fallback usage estimate when gateway doesn't expose tokens (e.g. Inception/Mercury).
    // Rough rule: ~4 chars/token for English-ish content; slight underestimate for JSON.
    if (promptTokens === 0 && (system.length + userMsg.length) > 0) {
      promptTokens = Math.ceil((system.length + userMsg.length) / 4);
    }
    if (completionTokens === 0 && text.length > 0) {
      completionTokens = Math.ceil(text.length / 4);
    }
    return { text, ttltMs: Date.now() - start, promptTokens, completionTokens };
  } catch (err) {
    return { text, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 150) };
  }
}

function tryParseFirstJson(text: string): any | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

type CellResult = {
  variantLabel: string; orId: string; turn: number; utt: Utt;
  ttltMs: number; promptTokens: number; completionTokens: number;
  error?: string; result: any | null;
};

async function main() {
  const t0 = Date.now();
  const total = VARIANTS.length * PICKED_TURNS.length;
  console.log(`Bench: ${VARIANTS.length} variants × ${PICKED_TURNS.length} turns = ${total} parallel calls\n`);

  const tasks: Promise<CellResult>[] = [];
  for (const v of VARIANTS) {
    for (const t of PICKED_TURNS) {
      const utt = fixture[t - 1];
      const hotTail = fixture.slice(Math.max(0, t - 6), t - 1);
      tasks.push((async () => {
        const r = await callGateway(v, SUGG_SYS, buildSuggesterUserMsg(utt, hotTail));
        return { variantLabel: v.label, orId: v.orId, turn: t, utt, ...r, result: tryParseFirstJson(r.text) };
      })());
    }
  }

  const results = await Promise.all(tasks);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  // pricing
  const pricingRes = await fetch('https://openrouter.ai/api/v1/models');
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { prompt: number; completion: number }>();
  for (const m of pricingJson.data) pricing.set(m.id, { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') });

  // ── Per-utterance side-by-side ────────────────────────────────────────────
  console.log('═'.repeat(150));
  console.log('PER-UTTERANCE COMPARISON');
  console.log('═'.repeat(150));
  for (const t of PICKED_TURNS) {
    const utt = fixture[t - 1];
    console.log(`\n• t${t}  ${utt.speaker.toUpperCase()}: ${utt.text.slice(0, 180)}${utt.text.length > 180 ? '…' : ''}`);
    for (const v of VARIANTS) {
      const r = results.find(x => x.variantLabel === v.label && x.turn === t)!;
      const sBits = r.result
        ? (r.result.shouldFire
            ? `🔥 [${r.result.priority}/${r.result.play}] "${(r.result.markdown ?? '').slice(0, 120)}"`
            : `🤐 silent`)
        : `ERR: ${r.error ?? 'parse_fail'}`;
      console.log(`  ${v.label.padEnd(26)} ${(r.ttltMs/1000).toFixed(2)}s  in=${String(r.promptTokens).padEnd(5)} out=${String(r.completionTokens).padEnd(5)}  ${sBits}`);
    }
  }

  // ── Aggregate summary ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(150));
  console.log('AGGREGATE SUMMARY (sorted by avg cost per call asc)');
  console.log('═'.repeat(150));

  const rows = VARIANTS.map(v => {
    const cells = results.filter(r => r.variantLabel === v.label);
    const ok = cells.filter(r => r.result);
    const fired = cells.filter(r => r.result?.shouldFire).length;
    const ttlt = cells.map(r => r.ttltMs).sort((a,b) => a-b);
    const avgTtlt = ttlt.reduce((a,b)=>a+b,0)/ttlt.length;
    const p95Ttlt = ttlt[Math.min(ttlt.length-1, Math.floor(ttlt.length*0.95))];
    const pIn = cells.reduce((s,r) => s+r.promptTokens, 0);
    const pOut = cells.reduce((s,r) => s+r.completionTokens, 0);
    const price = pricing.get(v.orId);
    const totalCost = price ? pIn*price.prompt + pOut*price.completion : 0;
    const avgCostPerCall = totalCost / cells.length;
    const costPer1k = avgCostPerCall * 1000;
    return { v, cells, ok: ok.length, fired, avgTtlt, p95Ttlt, pIn, pOut, totalCost, avgCostPerCall, costPer1k };
  }).sort((a,b) => a.avgCostPerCall - b.avgCostPerCall);

  // table header
  const cols = ['variant', 'ok', 'fires', 'TTLT avg', 'TTLT p95', 'tok in', 'tok out', 'test cost', 'avg/call', '$/1k calls'];
  const widths = [27, 5, 6, 9, 9, 8, 8, 11, 10, 11];
  console.log('\n' + cols.map((c,i) => c.padEnd(widths[i])).join(''));
  console.log(widths.map(w => '─'.repeat(w)).join(''));
  for (const r of rows) {
    const row = [
      r.v.label,
      `${r.ok}/${r.cells.length}`,
      `${r.fired}/${r.cells.length}`,
      `${(r.avgTtlt/1000).toFixed(2)}s`,
      `${(r.p95Ttlt/1000).toFixed(2)}s`,
      r.pIn.toLocaleString(),
      r.pOut.toLocaleString(),
      `$${r.totalCost.toFixed(5)}`,
      `$${r.avgCostPerCall.toFixed(5)}`,
      `$${r.costPer1k.toFixed(3)}`,
    ];
    console.log(row.map((c,i) => c.padEnd(widths[i])).join(''));
  }

  const grandTotalCost = rows.reduce((s,r) => s + r.totalCost, 0);
  console.log(`\nGrand total cost of this entire bench (45 calls):  $${grandTotalCost.toFixed(5)}`);
}

await main();
