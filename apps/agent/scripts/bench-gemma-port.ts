#!/usr/bin/env bun
/**
 * Quick A/B comparison: main-before-changes vs main-after-changes.
 *
 * - OLD: gpt-5.4-mini + the previous (pre-edit) MEMORY_AGENT_SYSTEM and
 *   prospectSuggester SYSTEM (loaded from git HEAD).
 * - NEW: google/gemma-4-26b-a4b-it + current files (with V2 memory additions
 *   and fresh-evidence suggester rule).
 *
 * 5 hand-picked Jordan-fixture utterances that exercise different scenarios:
 *   t4  — prospect pain with quantification
 *   t6  — competitor + objection (Marketo gun-shy)
 *   t12 — budget + first stakeholder name
 *   t16 — multi-stakeholder turn (Marcus + Priya)
 *   t18 — explicit buying signal (agree to demo)
 *
 * 2 variants × 5 turns × 2 agents (memory + suggester) = 20 parallel calls,
 * <20s wall.
 *
 * Usage:
 *   VERCEL_AI_GATEWAY_TOKEN=xxx bun apps/agent/scripts/bench-gemma-port.ts
 */

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOKEN = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN;
if (!TOKEN) { console.log('skipped — no gateway token'); process.exit(0); }

process.on('unhandledRejection', (r) => console.error('[unhandled]', r));

const ROOT = resolve(import.meta.dir, '..', '..', '..');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-transcript.json')).text());
const brief = JSON.parse(await Bun.file(resolve(ROOT, 'fixtures/jordan-brief.json')).text());

// Pick 5 representative turns
const PICKED_TURNS = [4, 6, 12, 16, 18];

// ─── Load OLD prompts from git HEAD (pre-edit) ───────────────────────────────

function gitShow(path: string): string {
  const r = spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git show failed for ${path}: ${r.stderr}`);
  return r.stdout;
}
function extractStringLiteral(source: string, exportName: string): string {
  // Match: export const NAME = `...`;  (handles backtick template literal)
  const re = new RegExp(`export const ${exportName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
  const m = source.match(re);
  if (!m) {
    // Try non-export const
    const re2 = new RegExp(`const ${exportName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
    const m2 = source.match(re2);
    if (!m2) throw new Error(`couldn't extract ${exportName}`);
    return m2[1];
  }
  return m[1];
}

const OLD_MEMORY_SYSTEM = extractStringLiteral(gitShow('apps/agent/src/agents/memoryAgent.ts'), 'MEMORY_AGENT_SYSTEM');
const OLD_SUGG_SYSTEM = extractStringLiteral(gitShow('apps/agent/src/agents/prospectSuggester.ts'), 'SYSTEM');

// ─── Load NEW prompts from current source (with edits) ───────────────────────

const { MEMORY_AGENT_SYSTEM: NEW_MEMORY_SYSTEM } = await import('../src/agents/memoryAgent');
// SYSTEM in prospectSuggester isn't exported; fetch via filesystem.
const NEW_SUGG_SYSTEM = extractStringLiteral(
  await Bun.file(resolve(ROOT, 'apps/agent/src/agents/prospectSuggester.ts')).text(),
  'SYSTEM',
);

console.log(`OLD memory: ${OLD_MEMORY_SYSTEM.length} chars   NEW memory: ${NEW_MEMORY_SYSTEM.length} chars (Δ=${NEW_MEMORY_SYSTEM.length - OLD_MEMORY_SYSTEM.length})`);
console.log(`OLD sugg:   ${OLD_SUGG_SYSTEM.length} chars   NEW sugg:   ${NEW_SUGG_SYSTEM.length} chars (Δ=${NEW_SUGG_SYSTEM.length - OLD_SUGG_SYSTEM.length})\n`);

// ─── Variants ────────────────────────────────────────────────────────────────

type Variant = {
  label: string;
  memoryModel: string;
  memorySystem: string;
  suggesterModel: string;
  suggesterSystem: string;
};

const VARIANTS: Variant[] = [
  {
    label: 'OLD (gpt-5.4-mini + main pre-edit)',
    memoryModel: 'openai/gpt-5.4-mini',
    memorySystem: OLD_MEMORY_SYSTEM,
    suggesterModel: 'openai/gpt-5.4-mini',
    suggesterSystem: OLD_SUGG_SYSTEM,
  },
  {
    label: 'NEW (gemma + V2 + fresh-evidence)',
    memoryModel: 'google/gemma-4-26b-a4b-it',
    memorySystem: NEW_MEMORY_SYSTEM,
    suggesterModel: 'google/gemma-4-26b-a4b-it',
    suggesterSystem: NEW_SUGG_SYSTEM,
  },
];

// ─── JSON schemas (lightweight inline; we don't need full validation) ────────

const MEM_JSON_INSTR = `Output ONLY a compact JSON object (no markdown fences) with shape:
{"flow":{"tag":"<OTHER|R-Q|R-VP|R-OBJ-RESP|R-NS|R-MISTAKE|P-PAIN|P-METRIC|P-OBJ|P-STAKE|P-BUY|P-COMP|P-NEG|P-DQ>","content":"<3-10 words>"} OR null,"facts":[{"op":"upsert","key":"<...>","category":"<budget|timeline|tech_stack|team|process|competitor|other>","content":"<...>","confidence":<0-1>}] OR null,"concerns":[{"op":"<upsert|append|resolve>","topic":"<...>","verbatim":"<...>","severity":"<mentioned|pressed|blocking>"}] OR null,"openLoops":[{"op":"<append|close>","description":"<...>","owner":"<rep|customer>","closeDescription":"<text or null>"}] OR null,"decisionGeography":[{"op":"upsert","name":"<...>","role":"<...>","sentiment":"<positive|neutral|negative|unknown>"}] OR null,"evidence":[{"axis":"<need|budget|authority|timeline|metrics|economicBuyer|decisionCriteria|decisionProcess|identifyPain|champion>","direction":"<positive|negative>","verbatim":"<3-12 words>","specificity":"<mention|specific>"}] OR null}
Every key MUST be present. Use null for empty.`;

const SUG_JSON_INSTR = `Output ONLY a compact JSON object matching:
{"shouldFire":<bool>,"priority":"<critical|nudge|fyi>","play":"<one of taxonomy>","axis":"<need|budget|authority|timeline|metric|champion|consequence|competitor|stakeholder> OR null","markdown":"<≤15 words>","reasoning":"<one paragraph>","groundedInUtteranceIds":[],"groundedInAnchorTurnIds":[]}
Output ONE JSON object only.`;

// ─── Direct-fetch wrappers with token-usage capture ──────────────────────────

async function callGateway(model: string, system: string, userMsg: string, includeUsage: boolean): Promise<{
  text: string;
  ttltMs: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}> {
  const start = Date.now();
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        max_tokens: 4000,
        stream: includeUsage, // streaming gives us TTFT but for simplicity use non-streaming when usage is captured otherwise
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const errText = await r.text();
      return { text: '', ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: `HTTP ${r.status}: ${errText.slice(0, 100)}` };
    }
    if (includeUsage && r.body) {
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
    } else {
      const j = await r.json();
      text = j?.choices?.[0]?.message?.content ?? '';
      promptTokens = j?.usage?.prompt_tokens ?? 0;
      completionTokens = j?.usage?.completion_tokens ?? 0;
    }
    return { text, ttltMs: Date.now() - start, promptTokens, completionTokens };
  } catch (err) {
    return { text, ttltMs: Date.now() - start, promptTokens: 0, completionTokens: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 100) };
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

// ─── Build prompts ───────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

type CellResult = {
  variant: string;
  turn: number;
  utt: Utt;
  mem: Awaited<ReturnType<typeof callGateway>> & { patch: any | null };
  sugg: Awaited<ReturnType<typeof callGateway>> & { result: any | null };
};

async function main() {
  const t0 = Date.now();
  console.log(`Bench: ${VARIANTS.length} variants × ${PICKED_TURNS.length} turns × 2 agents = ${VARIANTS.length * PICKED_TURNS.length * 2} parallel calls\n`);

  const cells: { v: Variant; turn: number; utt: Utt; hotTail: Utt[] }[] = [];
  for (const v of VARIANTS) {
    for (const t of PICKED_TURNS) {
      const utt = fixture[t - 1];
      const hotTail = fixture.slice(Math.max(0, t - 6), t - 1);
      cells.push({ v, turn: t, utt, hotTail });
    }
  }

  const results: CellResult[] = await Promise.all(
    cells.map(async ({ v, turn, utt, hotTail }) => {
      // Memory + suggester in parallel for this cell
      const [mem, sugg] = await Promise.all([
        callGateway(v.memoryModel, v.memorySystem, buildMemoryUserMsg(utt, hotTail, turn - 1), true),
        callGateway(v.suggesterModel, v.suggesterSystem, buildSuggesterUserMsg(utt, hotTail), false),
      ]);
      return {
        variant: v.label,
        turn,
        utt,
        mem: { ...mem, patch: tryParseFirstJson(mem.text) },
        sugg: { ...sugg, result: tryParseFirstJson(sugg.text) },
      };
    }),
  );
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s wall\n`);

  // Pricing
  const pricingRes = await fetch('https://openrouter.ai/api/v1/models');
  const pricingJson = await pricingRes.json();
  const pricing = new Map<string, { prompt: number; completion: number }>();
  for (const m of pricingJson.data) pricing.set(m.id, { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') });

  // ── Per-utterance side-by-side ────────────────────────────────────────────
  console.log('═'.repeat(140));
  console.log('PER-UTTERANCE COMPARISON');
  console.log('═'.repeat(140));
  for (const t of PICKED_TURNS) {
    const utt = fixture[t - 1];
    console.log(`\n• t${t}  ${utt.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${utt.text.slice(0, 140)}${utt.text.length > 140 ? '…' : ''}`);
    for (const v of VARIANTS) {
      const r = results.find(x => x.variant === v.label && x.turn === t)!;
      const m = r.mem;
      const memBits = m.patch
        ? `[${m.patch.flow?.tag ?? '?'}] ev=${m.patch.evidence?.length ?? 0} f=${m.patch.facts?.length ?? 0} c=${m.patch.concerns?.length ?? 0} ol=${m.patch.openLoops?.length ?? 0} dg=${m.patch.decisionGeography?.length ?? 0}`
        : `ERR:${m.error ?? 'parse_fail'}`;
      const s = r.sugg;
      const sugBits = s.result
        ? (s.result.shouldFire ? `🔥 [${s.result.priority}/${s.result.play}] "${s.result.markdown ?? ''}"` : '🤐 silent')
        : `ERR:${s.error ?? 'parse_fail'}`;
      console.log(`  ${v.label.padEnd(40)}`);
      console.log(`    memory   ${(m.ttltMs/1000).toFixed(2)}s  in=${m.promptTokens}/out=${m.completionTokens}   ${memBits}`);
      console.log(`    sugg     ${(s.ttltMs/1000).toFixed(2)}s  in=${s.promptTokens}/out=${s.completionTokens}   ${sugBits}`);
    }
  }

  // ── Aggregate summary ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(140));
  console.log('AGGREGATE SUMMARY');
  console.log('═'.repeat(140));
  for (const v of VARIANTS) {
    const cells = results.filter(r => r.variant === v.label);
    const memOk = cells.filter(r => r.mem.patch);
    const sugOk = cells.filter(r => r.sugg.result);
    const memTtlt = cells.map(r => r.mem.ttltMs);
    const sugTtlt = cells.map(r => r.sugg.ttltMs);
    const memPromptToks = cells.reduce((s, r) => s + r.mem.promptTokens, 0);
    const memCompToks = cells.reduce((s, r) => s + r.mem.completionTokens, 0);
    const sugPromptToks = cells.reduce((s, r) => s + r.sugg.promptTokens, 0);
    const sugCompToks = cells.reduce((s, r) => s + r.sugg.completionTokens, 0);
    const orId = v.memoryModel === 'openai/gpt-5.4-mini' ? 'openai/gpt-5.4-mini' : v.memoryModel === 'google/gemma-4-26b-a4b-it' ? 'google/gemma-4-26b-a4b-it' : v.memoryModel;
    const price = pricing.get(orId);
    const memCost = price ? memPromptToks * price.prompt + memCompToks * price.completion : 0;
    const sugCost = price ? sugPromptToks * price.prompt + sugCompToks * price.completion : 0;
    const fired = cells.filter(r => r.sugg.result?.shouldFire).length;

    console.log(`\n${v.label}:`);
    console.log(`  memory ok / sugg ok:    ${memOk.length}/${cells.length}  ·  ${sugOk.length}/${cells.length}`);
    console.log(`  fires:                  ${fired}/${cells.length}`);
    console.log(`  memory TTLT avg/p95:    ${(memTtlt.reduce((a,b)=>a+b,0)/memTtlt.length/1000).toFixed(2)}s / ${(Math.max(...memTtlt)/1000).toFixed(2)}s`);
    console.log(`  sugg TTLT avg/p95:      ${(sugTtlt.reduce((a,b)=>a+b,0)/sugTtlt.length/1000).toFixed(2)}s / ${(Math.max(...sugTtlt)/1000).toFixed(2)}s`);
    console.log(`  total tokens (mem):     ${memPromptToks.toLocaleString()} in / ${memCompToks.toLocaleString()} out`);
    console.log(`  total tokens (sugg):    ${sugPromptToks.toLocaleString()} in / ${sugCompToks.toLocaleString()} out`);
    console.log(`  cost (5 turns):         memory $${memCost.toFixed(5)}  sugg $${sugCost.toFixed(5)}  total $${(memCost+sugCost).toFixed(5)}`);
    console.log(`  extrapolated 1k calls (×4 to roughly map 5→20 turns):  total $${((memCost+sugCost) * 4 * 1000).toFixed(2)}`);
  }
}

await main();
