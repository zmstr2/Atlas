#!/usr/bin/env bun
/**
 * 3-way suggester bench — memory agent held constant (gemma).
 *
 * Suggester variants:
 *   1. openai/gpt-5.4-mini       (current incumbent quality bar)
 *   2. cerebras/glm-4-7          (current suggester fallback in MODELS)
 *   3. google/gemma-4-26b-a4b-it (current primary suggester in MODELS)
 *
 * Memory: always google/gemma-4-26b-a4b-it (primary extractor candidate).
 *
 * 5 hand-picked Jordan turns, all suggester calls in parallel (~20s wall).
 *
 * Usage:
 *   AI_GATEWAY_API_KEY=xxx bun apps/agent/scripts/bench-suggester-3way.ts
 */
import { resolve } from 'node:path';

const TOKEN = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN;
if (!TOKEN) { console.log('skipped — no gateway token'); process.exit(0); }
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));

const ROOT = resolve(import.meta.dir, '..', '..', '..');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-transcript.json')).text());
const brief = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-brief.json')).text());

const PICKED_TURNS = [4, 6, 12, 16, 18];

// Pull current suggester prompt (the one that lives in main with V2 + fresh-evidence)
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
const { MEMORY_AGENT_SYSTEM: MEM_SYS } = await import('../src/server/agents/memoryAgent');

console.log(`Suggester prompt: ${SUGG_SYS.length} chars`);
console.log(`Memory prompt:    ${MEM_SYS.length} chars\n`);

const SUGG_VARIANTS = [
  { label: 'gpt-5.4-mini', model: 'openai/gpt-5.4-mini' },
  { label: 'glm-4.7 (cerebras)', model: 'cerebras/glm-4-7' },
  { label: 'gemma-4-26b-a4b', model: 'google/gemma-4-26b-a4b-it' },
] as const;

const MEMORY_MODEL = 'google/gemma-4-26b-a4b-it';

const MEM_JSON_INSTR = `Output ONLY a compact JSON object (no markdown fences) with shape:
{"flow":{"tag":"<OTHER|R-Q|R-VP|R-OBJ-RESP|R-NS|R-MISTAKE|P-PAIN|P-METRIC|P-OBJ|P-STAKE|P-BUY|P-COMP|P-NEG|P-DQ>","content":"<3-10 words>"} OR null,"facts":[{"op":"upsert","key":"<...>","category":"<budget|timeline|tech_stack|team|process|competitor|other>","content":"<...>","confidence":<0-1>}] OR null,"concerns":[{"op":"<upsert|append|resolve>","topic":"<...>","verbatim":"<...>","severity":"<mentioned|pressed|blocking>"}] OR null,"openLoops":[{"op":"<append|close>","description":"<...>","owner":"<rep|customer>","closeDescription":"<text or null>"}] OR null,"decisionGeography":[{"op":"upsert","name":"<...>","role":"<...>","sentiment":"<positive|neutral|negative|unknown>"}] OR null,"evidence":[{"axis":"<need|budget|authority|timeline|metrics|economicBuyer|decisionCriteria|decisionProcess|identifyPain|champion>","direction":"<positive|negative>","verbatim":"<3-12 words>","specificity":"<mention|specific>"}] OR null}
Every key MUST be present. Use null for empty.`;

const SUG_JSON_INSTR = `Output ONLY a compact JSON object matching:
{"shouldFire":<bool>,"priority":"<critical|nudge|fyi>","play":"<one of taxonomy>","axis":"<need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder> OR null","markdown":"<≤15 words>","reasoning":"<one paragraph>","groundedInUtteranceIds":[],"groundedInAnchorTurnIds":[]}
Output ONE JSON object only.`;

async function callGateway(model: string, system: string, userMsg: string): Promise<{
  text: string; ttltMs: number; promptTokens: number; completionTokens: number; error?: string;
}> {
  const start = Date.now();
  let text = ''; let promptTokens = 0; let completionTokens = 0;
  try {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        max_tokens: 4000,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const errText = await r.text();
      return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${errText.slice(0, 100)}` };
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
    return { text, ttltMs: Date.now() - start, promptTokens, completionTokens };
  } catch (err) {
    return { text, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
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

function buildMemoryUserMsg(utt: Utt, hotTail: Utt[], turnIdx: number): string {
  const tailStr = hotTail.map(h => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');
  return `TURN ID: t${turnIdx + 1}
SPEAKER: ${utt.speaker}
NEW UTTERANCE [${utt.id}]:
${utt.speaker.toUpperCase()}: ${utt.text}

HOT TAIL:
${tailStr || '(empty)'}

EXISTING FACTS: (none)
EXISTING ANCHORS: (none)
EXISTING ACTIVE CONCERNS: (none)
RECENT FLOW: (empty)

Emit the extractor patch.

${MEM_JSON_INSTR}`;
}

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

type CellResult = {
  variantLabel: string; model: string; turn: number; utt: Utt;
  ttltMs: number; promptTokens: number; completionTokens: number;
  error?: string; result: any | null;
};
type MemResult = {
  turn: number; utt: Utt;
  ttltMs: number; promptTokens: number; completionTokens: number;
  error?: string; patch: any | null;
};

async function main() {
  const t0 = Date.now();
  const totalCalls = SUGG_VARIANTS.length * PICKED_TURNS.length + PICKED_TURNS.length;
  console.log(`Bench: ${SUGG_VARIANTS.length} sugg variants × ${PICKED_TURNS.length} turns + ${PICKED_TURNS.length} mem = ${totalCalls} parallel calls\n`);

  const memTasks = PICKED_TURNS.map(async (t) => {
    const utt = fixture[t - 1];
    const hotTail = fixture.slice(Math.max(0, t - 6), t - 1);
    const r = await callGateway(MEMORY_MODEL, MEM_SYS, buildMemoryUserMsg(utt, hotTail, t - 1));
    return { turn: t, utt, ...r, patch: tryParseFirstJson(r.text) } as MemResult;
  });

  const suggTasks: Promise<CellResult>[] = [];
  for (const v of SUGG_VARIANTS) {
    for (const t of PICKED_TURNS) {
      const utt = fixture[t - 1];
      const hotTail = fixture.slice(Math.max(0, t - 6), t - 1);
      suggTasks.push((async () => {
        const r = await callGateway(v.model, SUGG_SYS, buildSuggesterUserMsg(utt, hotTail));
        return { variantLabel: v.label, model: v.model, turn: t, utt, ...r, result: tryParseFirstJson(r.text) };
      })());
    }
  }

  const [memResults, suggResults] = await Promise.all([
    Promise.all(memTasks),
    Promise.all(suggTasks),
  ]);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  // pricing from OpenRouter
  const pricingRes = await fetch('https://openrouter.ai/api/v1/models');
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { prompt: number; completion: number }>();
  for (const m of pricingJson.data) pricing.set(m.id, { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') });
  // GLM via Cerebras isn't OpenRouter-priced — use the wrapper.ts cost (in $/token).
  pricing.set('cerebras/glm-4-7', { prompt: 0.0000004, completion: 0.00000175 });

  // ── Per-utterance side-by-side ────────────────────────────────────────────
  console.log('═'.repeat(140));
  console.log('PER-UTTERANCE COMPARISON');
  console.log('═'.repeat(140));
  for (const t of PICKED_TURNS) {
    const utt = fixture[t - 1];
    console.log(`\n• t${t}  ${utt.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${utt.text.slice(0, 160)}${utt.text.length > 160 ? '…' : ''}`);

    const mem = memResults.find(m => m.turn === t);
    if (mem) {
      const memBits = mem.patch
        ? `[${mem.patch.flow?.tag ?? '?'}] ev=${mem.patch.evidence?.length ?? 0} f=${mem.patch.facts?.length ?? 0} c=${mem.patch.concerns?.length ?? 0} ol=${mem.patch.openLoops?.length ?? 0} dg=${mem.patch.decisionGeography?.length ?? 0}`
        : `ERR:${mem.error ?? 'parse_fail'}`;
      console.log(`  memory(gemma)             ${(mem.ttltMs/1000).toFixed(2)}s  in=${mem.promptTokens}/out=${mem.completionTokens}   ${memBits}`);
    }

    for (const v of SUGG_VARIANTS) {
      const r = suggResults.find(x => x.variantLabel === v.label && x.turn === t)!;
      const sBits = r.result
        ? (r.result.shouldFire
            ? `🔥 [${r.result.priority}/${r.result.play}] "${(r.result.markdown ?? '').slice(0, 100)}"`
            : `🤐 silent`)
        : `ERR:${r.error ?? 'parse_fail'}`;
      console.log(`  sugg(${v.label.padEnd(20)}) ${(r.ttltMs/1000).toFixed(2)}s  in=${r.promptTokens}/out=${r.completionTokens}   ${sBits}`);
    }
  }

  // ── Aggregate summary ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(140));
  console.log('AGGREGATE SUMMARY');
  console.log('═'.repeat(140));

  // Memory aggregate
  {
    const ok = memResults.filter(r => r.patch);
    const ttlt = memResults.map(r => r.ttltMs);
    const pIn = memResults.reduce((s, r) => s + r.promptTokens, 0);
    const pOut = memResults.reduce((s, r) => s + r.completionTokens, 0);
    const price = pricing.get(MEMORY_MODEL);
    const cost = price ? pIn * price.prompt + pOut * price.completion : 0;
    console.log(`\nmemory: ${MEMORY_MODEL}`);
    console.log(`  ok:                    ${ok.length}/${memResults.length}`);
    console.log(`  TTLT avg/p95:          ${(ttlt.reduce((a,b)=>a+b,0)/ttlt.length/1000).toFixed(2)}s / ${(Math.max(...ttlt)/1000).toFixed(2)}s`);
    console.log(`  total tokens:          ${pIn.toLocaleString()} in / ${pOut.toLocaleString()} out`);
    console.log(`  cost (5 turns):        $${cost.toFixed(5)}`);
  }

  // Suggester per-variant aggregate
  for (const v of SUGG_VARIANTS) {
    const cells = suggResults.filter(r => r.variantLabel === v.label);
    const ok = cells.filter(r => r.result);
    const ttlt = cells.map(r => r.ttltMs);
    const pIn = cells.reduce((s, r) => s + r.promptTokens, 0);
    const pOut = cells.reduce((s, r) => s + r.completionTokens, 0);
    const fired = cells.filter(r => r.result?.shouldFire).length;
    const price = pricing.get(v.model);
    const cost = price ? pIn * price.prompt + pOut * price.completion : 0;
    console.log(`\nsugg: ${v.model}`);
    console.log(`  ok:                    ${ok.length}/${cells.length}`);
    console.log(`  fires:                 ${fired}/${cells.length}`);
    console.log(`  TTLT avg/p95:          ${(ttlt.reduce((a,b)=>a+b,0)/ttlt.length/1000).toFixed(2)}s / ${(Math.max(...ttlt)/1000).toFixed(2)}s`);
    console.log(`  total tokens:          ${pIn.toLocaleString()} in / ${pOut.toLocaleString()} out`);
    console.log(`  cost (5 turns):        $${cost.toFixed(5)}`);
    console.log(`  extrap 1k full calls:  $${(cost * 4 * 1000).toFixed(2)}  (×4 to scale 5→~20 turns)`);
  }
}

await main();
