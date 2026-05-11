#!/usr/bin/env bun
/**
 * Probe: verify model IDs and reasoning args before the full bench.
 * Sends a trivial 1-turn prompt and checks for HTTP errors / parse issues.
 *
 * Usage:  OPENROUTER_API_KEY=... bun apps/agent/scripts/probe-reasoning.ts
 */

const TOKEN = process.env.OPENROUTER_API_KEY;
if (!TOKEN) { console.log('skipped — no OPENROUTER_API_KEY'); process.exit(0); }

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TINY_PROMPT = 'Reply with exactly the word PONG and nothing else.';

type ReasoningParam =
  | { effort: 'low' | 'minimal' | 'none' }
  | { enabled: false };

type Probe = {
  label: string;
  orId: string;
  reasoning?: ReasoningParam;
  note: string;          // what we expect / what we're testing
};

const PROBES: Probe[] = [
  // ── Qwen3.6 MoE (35B) ──────────────────────────────────────────────────────
  {
    label: 'qwen3.6-35b-a3b [enabled:false]',
    orId:  'qwen/qwen3.6-35b-a3b',
    reasoning: { enabled: false },
    note: 'Qwen3 reasoning model — testing enabled:false to disable thinking',
  },
  {
    label: 'qwen3.6-35b-a3b [effort:none]',
    orId:  'qwen/qwen3.6-35b-a3b',
    reasoning: { effort: 'none' },
    note: 'Same model — testing effort:none as alternative',
  },

  // ── Qwen3.6 dense (27B) ────────────────────────────────────────────────────
  {
    label: 'qwen3.6-27b [enabled:false]',
    orId:  'qwen/qwen3.6-27b',
    reasoning: { enabled: false },
    note: 'Qwen3.6 dense — testing enabled:false',
  },

  // ── Qwen3.5 9B ─────────────────────────────────────────────────────────────
  {
    label: 'qwen3.5-9b [enabled:false]',
    orId:  'qwen/qwen3.5-9b',
    reasoning: { enabled: false },
    note: 'Smaller Qwen model — also checking if model ID is valid',
  },

  // ── Gemma 4 31B ────────────────────────────────────────────────────────────
  {
    label: 'gemma-4-31b-it [enabled:false]',
    orId:  'google/gemma-4-31b-it',
    reasoning: { enabled: false },
    note: 'Gemma 4 31B — same param as gemma-4-26b which we confirmed works',
  },

  // ── Gemma 4 26B MoE (already confirmed) ────────────────────────────────────
  {
    label: 'gemma-4-26b-a4b-it [enabled:false]',
    orId:  'google/gemma-4-26b-a4b-it',
    reasoning: { enabled: false },
    note: 'Control — already confirmed working in prior bench',
  },

  // ── GLM 4.7 Flash (non-reasoning model) ────────────────────────────────────
  {
    label: 'glm-4.7-flash [no reasoning]',
    orId:  'z-ai/glm-4.7-flash',
    reasoning: undefined,
    note: 'Non-reasoning model — no reasoning param needed',
  },

  // ── GPT-OSS-20B (only supports effort, user wants low) ─────────────────────
  {
    label: 'gpt-oss-20b [effort:low]',
    orId:  'openai/gpt-oss-20b',
    reasoning: { effort: 'low' },
    note: 'Confirmed in prior bench — effort:low is the only supported mode',
  },

  // ── Nemotron 3 Nano (non-reasoning MoE) ────────────────────────────────────
  {
    label: 'nemotron-3-nano-30b [no reasoning]',
    orId:  'nvidia/nemotron-3-nano-30b-a3b',
    reasoning: undefined,
    note: 'Non-reasoning model — no reasoning param needed',
  },

  // ── DeepSeek Chat V3.1 (hybrid: supports enabled bool) ─────────────────────
  {
    label: 'deepseek-chat-v3.1 [enabled:false]',
    orId:  'deepseek/deepseek-chat-v3.1',
    reasoning: { enabled: false },
    note: 'Hybrid reasoning model — enabled:false should force non-thinking mode',
  },

  // ── DeepSeek V3.1 Terminus (hybrid: supports enabled bool) ─────────────────
  {
    label: 'deepseek-v3.1-terminus [enabled:false]',
    orId:  'deepseek/deepseek-v3.1-terminus',
    reasoning: { enabled: false },
    note: 'Hybrid reasoning model — same approach as V3.1',
  },

  // ── DeepSeek V4 Flash (reasoning: only high/xhigh documented) ──────────────
  // Test both enabled:false and no-param to see which produces non-thinking output
  {
    label: 'deepseek-v4-flash [enabled:false]',
    orId:  'deepseek/deepseek-v4-flash',
    reasoning: { enabled: false },
    note: 'Model docs only mention high/xhigh — testing if enabled:false is accepted',
  },
  {
    label: 'deepseek-v4-flash [no reasoning]',
    orId:  'deepseek/deepseek-v4-flash',
    reasoning: undefined,
    note: 'Testing omitting reasoning param entirely — may default to non-thinking',
  },

  // ── Llama 4 Maverick (non-reasoning) ───────────────────────────────────────
  {
    label: 'llama-4-maverick [no reasoning]',
    orId:  'meta-llama/llama-4-maverick',
    reasoning: undefined,
    note: 'Non-reasoning model — user confirmed: no reasoning params',
  },

  // ── Llama 3.3 70B (non-reasoning) ──────────────────────────────────────────
  {
    label: 'llama-3.3-70b-instruct [no reasoning]',
    orId:  'meta-llama/llama-3.3-70b-instruct',
    reasoning: undefined,
    note: 'Non-reasoning model — user confirmed: no reasoning params',
  },
];

async function probe(p: Probe): Promise<{
  label: string; orId: string; note: string;
  ok: boolean; httpStatus?: number; ttltMs: number;
  hasThinkBlock: boolean; rawLen: number; text: string; error?: string;
}> {
  const start = Date.now();
  const body: any = {
    model: p.orId,
    messages: [{ role: 'user', content: TINY_PROMPT }],
    max_tokens: 256,
    stream: false,
  };
  if (p.reasoning) body.reasoning = p.reasoning;

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const ttltMs = Date.now() - start;
    const json = await r.json();
    if (!r.ok) {
      return { label: p.label, orId: p.orId, note: p.note, ok: false, httpStatus: r.status, ttltMs, hasThinkBlock: false, rawLen: 0, text: '', error: JSON.stringify(json).slice(0, 200) };
    }
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    const hasThinkBlock = /<think>/i.test(text);
    return { label: p.label, orId: p.orId, note: p.note, ok: true, httpStatus: r.status, ttltMs, hasThinkBlock, rawLen: text.length, text: text.slice(0, 120).replace(/\n/g, '↵') };
  } catch (err) {
    return { label: p.label, orId: p.orId, note: p.note, ok: false, ttltMs: Date.now() - start, hasThinkBlock: false, rawLen: 0, text: '', error: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
  }
}

const results = await Promise.all(PROBES.map(probe));

const W = [36, 38, 8, 10, 14, 60];
const header = ['label', 'model-id', 'ok', 'TTLT(ms)', 'think-block?', 'text / error'];
console.log('\n' + header.map((h, i) => h.padEnd(W[i])).join('  '));
console.log(W.map(w => '─'.repeat(w)).join('  '));
for (const r of results) {
  const row = [
    r.label,
    r.orId,
    r.ok ? '✓' : '✗',
    String(r.ttltMs),
    r.hasThinkBlock ? 'YES ⚠' : 'no',
    r.ok ? r.text : `ERR: ${r.error ?? ''}`,
  ];
  console.log(row.map((c, i) => c.padEnd(W[i])).join('  '));
}

const failures = results.filter(r => !r.ok);
console.log(`\n${results.filter(r=>r.ok).length}/${results.length} probes succeeded.`);
if (failures.length) {
  console.log('\nFailed probes:');
  for (const f of failures) console.log(`  ✗ ${f.label}: ${f.error}`);
}
