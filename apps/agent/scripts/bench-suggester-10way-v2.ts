#!/usr/bin/env bun
/**
 * 10-way suggester bench, direct OpenRouter, throughput-sorted providers.
 * For each turn we also include the gold-standard play + markdown the
 * bench author thinks is best, so model outputs can be scored against it.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun apps/agent/scripts/bench-suggester-10way-v2.ts
 */
import { resolve } from 'node:path';

const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-transcript.json')).text());
const brief = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-brief.json')).text());

const PICKED_TURNS = [4, 6, 12, 16, 18];

// ── Bench-author gold standard (what I'd want the suggester to fire) ────────
type Gold = { play: string; markdown: string; rationale: string };
const GOLD: Record<number, Gold> = {
  4: {
    play: 'quantify_pain',
    markdown: 'Anchor on the two hours a day — confirm rep count and total weekly waste.',
    rationale: 'Concrete number was dropped (2hr/day). The next move is to multiply across the team to make the cost real, not to drill which integration broke.',
  },
  6: {
    play: 'reframe_objection',
    markdown: 'Acknowledge the Marketo trauma — ask what specifically made the rollout slip past month three.',
    rationale: 'Past failure with named tool + months figure → LAER, anchored on the "nine months" verbatim. Generic "explore concerns" wastes the specific.',
  },
  12: {
    play: 'probe_stakeholder',
    markdown: 'Ask when Marcus typically gets pulled in — early discovery or only at proposal stage.',
    rationale: 'Marcus first named, with explicit authority ("holds the keys on RevTech spend"). Process question beats criteria question — it determines whether a single demo or two-stage approach is needed.',
  },
  16: {
    play: 'multi_thread',
    markdown: 'Pull Priya into the next call — she runs day-to-day so she\'ll surface integration gaps Marcus won\'t.',
    rationale: 'Two stakeholders with different roles (Marcus = gate, Priya = user). Multi-thread the user, not the gate, because user objections kill deals after signature.',
  },
  18: {
    play: 'anchor_next_step',
    markdown: 'Propose Tuesday 2 PM and confirm Priya\'s calendar before sending the invite.',
    rationale: 'Buying signal + named limiting stakeholder (Priya). Specific time + the gating dependency in one sentence.',
  },
};

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
  { label: 'gpt-5.4-mini (low)',     orId: 'openai/gpt-5.4-mini', reasoningEffort: 'low' },
  { label: 'gpt-oss-20b (low)',      orId: 'openai/gpt-oss-20b',  reasoningEffort: 'low' },
  { label: 'mistral-medium-3-5',     orId: 'mistralai/mistral-medium-3-5' },
  { label: 'mercury-2',              orId: 'inception/mercury-2' },
  { label: 'qwen3.6-35b-a3b',        orId: 'qwen/qwen3.6-35b-a3b' },
  { label: 'qwen3.5-35b-a3b',        orId: 'qwen/qwen3.5-35b-a3b' },
  { label: 'qwen3.5-27b',            orId: 'qwen/qwen3.5-27b' },
  { label: 'qwen3.6-27b',            orId: 'qwen/qwen3.6-27b' },
  { label: 'qwen3.6-plus',           orId: 'qwen/qwen3.6-plus' },
  { label: 'qwen3-vl-32b-instruct',  orId: 'qwen/qwen3-vl-32b-instruct' },
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

async function callOR(v: Variant, system: string, userMsg: string): Promise<{
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
      provider: { sort: 'throughput' },
    };
    if (v.reasoningEffort) body.reasoning = { effort: v.reasoningEffort };
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    if (!r.ok) {
      return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 150)}` };
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
    if (promptTokens === 0 && (system.length + userMsg.length) > 0) promptTokens = Math.ceil((system.length + userMsg.length) / 4);
    if (completionTokens === 0 && text.length > 0) completionTokens = Math.ceil(text.length / 4);
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
  console.log(`Bench: ${VARIANTS.length} variants × ${PICKED_TURNS.length} turns = ${VARIANTS.length * PICKED_TURNS.length} parallel calls\n`);

  const tasks: Promise<CellResult>[] = [];
  for (const v of VARIANTS) {
    for (const t of PICKED_TURNS) {
      const utt = fixture[t - 1];
      const hotTail = fixture.slice(Math.max(0, t - 6), t - 1);
      tasks.push((async () => {
        const r = await callOR(v, SUGG_SYS, buildSuggesterUserMsg(utt, hotTail));
        return { variantLabel: v.label, orId: v.orId, turn: t, utt, ...r, result: tryParseFirstJson(r.text) };
      })());
    }
  }
  const results = await Promise.all(tasks);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  const pricingRes = await fetch('https://openrouter.ai/api/v1/models');
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { prompt: number; completion: number }>();
  for (const m of pricingJson.data) pricing.set(m.id, { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') });

  // ── Per-utterance side-by-side, GOLD shown first ─────────────────────────
  console.log('═'.repeat(160));
  console.log('PER-UTTERANCE COMPARISON (★ = bench-author gold standard)');
  console.log('═'.repeat(160));
  for (const t of PICKED_TURNS) {
    const utt = fixture[t - 1];
    const gold = GOLD[t];
    console.log(`\n• t${t}  ${utt.speaker.toUpperCase()}: ${utt.text.slice(0, 200)}${utt.text.length > 200 ? '…' : ''}`);
    console.log(`  ★ GOLD                       —      —              [${gold.play}] "${gold.markdown}"`);
    console.log(`     rationale: ${gold.rationale}`);
    for (const v of VARIANTS) {
      const r = results.find(x => x.variantLabel === v.label && x.turn === t)!;
      const sBits = r.result
        ? (r.result.shouldFire
            ? `[${(r.result.play ?? '?').padEnd(22)}] "${(r.result.markdown ?? '').slice(0, 130)}"`
            : `🤐 silent`)
        : `ERR: ${r.error ?? 'parse_fail'}`;
      console.log(`  ${v.label.padEnd(28)} ${(r.ttltMs/1000).toFixed(2)}s in=${String(r.promptTokens).padEnd(5)}out=${String(r.completionTokens).padEnd(5)} ${sBits}`);
    }
  }

  // ── Aggregate summary ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(160));
  console.log('AGGREGATE SUMMARY (sorted by avg cost per call asc)');
  console.log('═'.repeat(160));

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

  const cols = ['variant', 'ok', 'fires', 'TTLT avg', 'TTLT p95', 'tok in', 'tok out', 'test cost', 'avg/call', '$/1k calls'];
  const widths = [29, 5, 6, 10, 10, 8, 8, 12, 11, 12];
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
  console.log(`\nGrand total cost of this entire bench (${VARIANTS.length * PICKED_TURNS.length} calls):  $${grandTotalCost.toFixed(5)}`);
}

await main();
