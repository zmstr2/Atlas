import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText, streamObject, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import { getCostContext } from './context';
import { incrementUserSpend, incrementCallCost, DEMO_USER_ID } from '../db/sqlite';

// Permissive provider options — narrowed at call sites by AI SDK's SharedV3ProviderOptions.
type ProviderOptionsLite = Record<string, Record<string, string | number | boolean>>;

export type LLMCallRecord = {
  step: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

const callLog: LLMCallRecord[] = [];

// Vercel AI Gateway — all models routed through one endpoint
// Model strings use provider/model format per the gateway docs
const gateway = createOpenAI({
  baseURL: process.env.VERCEL_AI_GATEWAY_URL ?? 'https://ai-gateway.vercel.sh/v1',
  apiKey: process.env.VERCEL_AI_GATEWAY_TOKEN ?? '',
});

export const MODELS = {
  // Primary hot-path model: must support json_schema structured outputs.
  // gpt-5.4-mini chosen via scripts/bench-models.ts — best TTFT (478ms p50)
  // and ~87% precision on the Jordan fixture vs gpt-4o-mini's ~40%.
  hotPath: 'openai/gpt-5.4-mini',
  // Hot-path/extractor fallback: same model under throughput-sorted gateway
  // routing. Switching to a different model whose json_schema support is
  // unverified would risk silent schema-parse failure on the rep's critical
  // path — a worse failure mode than retrying the same model under different
  // load. See providerOptionsFor below.
  hotPathFallback: 'openai/gpt-5.4-mini',
  extractor: 'openai/gpt-5.4-mini',
  // Suggester: prospect-suggester / rep-watcher. Switched from Gemma (which
  // over-fired — 55% silent precision on the 40-turn fixture) to gpt-oss-20b
  // at reasoning_effort='low'. bench-suggester-40turn-v3 measured 80%
  // precision / 80% recall via OpenRouter throughput-sort to Groq, ~0.5-1s
  // p50 latency, $0.067/1k calls. Routed DIRECT to OpenRouter (see
  // callOpenRouterDirect below) — Vercel Gateway's tps sort had higher tail
  // variance for this model. Per-token: $0.03/M in, $0.14/M out.
  suggester: 'openai/gpt-oss-20b',
  // Suggester fallback: gpt-5.4-mini with reasoning DISABLED. Reasoning-off
  // is strictly better than 'low' for this structured-output role (bench
  // showed avg score 3.27→3.42, p95 latency 11.75s→6.08s, cost $1.89→$1.57).
  // Used as fallback because it covers cases where gpt-oss-20b under-fires
  // (notably some rep_watcher mistakes — 5.4-mini caught u17/u25 where
  // oss-20b stayed silent). Routed direct to OpenRouter with
  // `reasoning: { enabled: false }` (cleaner than AI SDK's 'minimal' which
  // emits a validation warning). Per-token: $0.75/M in, $4.50/M out.
  suggesterFallback: 'openai/gpt-5.4-mini',
  // Post-call synthesis (quality > speed)
  postCall: 'openai/gpt-oss-120b',
  // Post-call fallback only — large prose-friendly model. Not safe for
  // structured-output paths because schema support via this gateway is unverified.
  fallback: 'openai/gpt-oss-120b',
} as const;

export type ModelKey = keyof typeof MODELS;

function getModel(key: ModelKey): LanguageModel {
  return gateway(MODELS[key]) as LanguageModel;
}

// Vercel AI SDK provider options. Used for hotPath / extractor / postCall.
// Suggester paths bypass AI SDK entirely (see callOpenRouterDirect below).
function providerOptionsFor(key: ModelKey): ProviderOptionsLite | undefined {
  if (key === 'hotPathFallback') {
    return {
      gateway: { sort: 'tps' },
    };
  }
  if (key === 'fallback') {
    return {
      gateway: { sort: 'tps' },
      openai: { reasoningEffort: 'low' },
    };
  }
  return undefined;
}

// Suggester paths route DIRECT to OpenRouter (bypassing Vercel Gateway + AI SDK).
// Two reasons: (1) OpenRouter's `provider: { sort: 'throughput' }` reliably
// routes gpt-oss-20b to Groq at ~0.5-1s p50 — Vercel's tps sort had higher
// tail variance (smoke-tested 4-7s for the same model). (2) AI SDK's
// openai.responses provider rejects reasoningEffort='none' for gpt-5.4-mini
// with a warning even though the gateway accepts it; OR's unified API takes
// `reasoning: { enabled: false }` cleanly without validation noise.
const OR_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
type OrReasoning = { effort: 'minimal' | 'low' | 'medium' | 'high' } | { enabled: false };
function reasoningForOpenRouter(key: ModelKey): OrReasoning | undefined {
  if (key === 'suggester') return { effort: 'low' };
  if (key === 'suggesterFallback') return { enabled: false };
  return undefined;
}
function shouldRouteDirect(key: ModelKey): boolean {
  return key === 'suggester' || key === 'suggesterFallback';
}

// Wall-clock budget per call. Tuned per role:
//   - hotPath / extractor: 5s — must abort fast on the founder's critical path.
//   - suggester / suggesterFallback: 8s — direct OR routing typically returns
//     in <1s for gpt-oss-20b, but we keep 8s headroom for tail latency. The
//     prior 15s budget was sized for the Vercel Gateway's higher variance;
//     direct OR removes that.
//   - postCall: 20s — quality > speed.
function timeoutFor(key: ModelKey): number {
  if (key === 'postCall') return 20_000;
  if (key === 'suggester' || key === 'suggesterFallback') return 8_000;
  return 5_000;
}

// Rough per-token cost estimates (USD) — update when Vercel publishes rates.
// Gemma rate sourced from OpenRouter public model registry (2026-05-08).
const COST_PER_TOKEN: Record<string, { in: number; out: number }> = {
  'openai/gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
  // gpt-5.4-mini: $0.75/M in, $4.50/M out (OpenRouter rate, 2026-05-08).
  // Higher than the original placeholder — actual production cost was being
  // under-reported by ~2.5×.
  'openai/gpt-5.4-mini': { in: 0.00000075, out: 0.0000045 },
  'openai/gpt-oss-120b': { in: 0.0000008, out: 0.0000032 },
  // gpt-oss-20b: $0.03/M in, $0.14/M out (OpenRouter, 2026-05-08). Current
  // MODELS.suggester — ~28× cheaper than 5.4-mini at the same precision on
  // the 40-turn fixture, ~4× cheaper than the prior Gemma wiring.
  'openai/gpt-oss-20b': { in: 0.00000003, out: 0.00000014 },
  // Kept for historical sessions / migration analytics.
  'google/gemma-4-26b-a4b-it': { in: 0.00000006, out: 0.00000033 },
  'cerebras/glm-4-7': { in: 0.0000004, out: 0.00000175 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const rates = COST_PER_TOKEN[model] ?? { in: 0.000001, out: 0.000002 };
  return tokensIn * rates.in + tokensOut * rates.out;
}

/**
 * Attribute a completed LLM call's cost to the active user + call. Read from
 * AsyncLocalStorage so we don't have to thread userId/callId through every
 * agent signature. No-op when there's no active context (scripts, tests, the
 * web demo's DEMO_USER_ID path is allowed).
 *
 * Fire-and-forget: DB writes happen synchronously here (Bun sqlite is sync),
 * but we wrap in try/catch so a write failure can never break the LLM path.
 */
function recordCostFromContext(costUsd: number): void {
  const ctx = getCostContext();
  if (!ctx) return;
  try {
    // Demo flow uses DEMO_USER_ID — still increment so the demo $/day cap
    // continues to reflect actual spend.
    if (ctx.userId && ctx.userId !== '') {
      incrementUserSpend(ctx.userId, costUsd);
    }
    if (ctx.callId) {
      incrementCallCost(ctx.callId, costUsd);
    }
  } catch (err) {
    console.error('[llm wrapper] recordCostFromContext failed', err);
  }
}

// Suppress unused-import warning when DEMO_USER_ID isn't referenced directly.
void DEMO_USER_ID;

export function getCallLog(): LLMCallRecord[] {
  return [...callLog];
}

export function getSessionCost(): number {
  return callLog.reduce((sum, r) => sum + r.costUsd, 0);
}

export function clearCallLog(): void {
  callLog.length = 0;
}

// Direct OpenRouter call — used for suggester paths. Mirrors the bench-script
// approach (bench-suggester-40turn-v3, bench-suggester-10way-v2). Returns
// `{ object, promptTokens, completionTokens }` so the surrounding wrapper can
// route logging + cost-context recording uniformly. Throws on HTTP error,
// JSON parse failure, or schema mismatch — all of which trigger the existing
// fallback-key chain in llmGenerateObject.
async function callOpenRouterDirect<T>(opts: {
  modelId: string;
  schema: ZodType<T>;
  prompt: string;
  system?: string;
  reasoning?: OrReasoning;
  signal: AbortSignal;
}): Promise<{ object: T; promptTokens: number; completionTokens: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set — required for suggester routing');

  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      // JSON-only contract reminder. Agent prompts already describe the schema;
      // this is the last thing the model sees and matches the bench's instruction.
      { role: 'user', content: `${opts.prompt}\n\nOutput ONLY a single JSON object matching the schema described above. No preamble, no markdown fences, no <think> blocks. Begin with { and end with }.` },
    ],
    max_tokens: 4000,
    provider: { sort: 'throughput' },
    response_format: { type: 'json_object' },
  };
  if (opts.reasoning) body.reasoning = opts.reasoning;

  const r = await fetch(OR_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = j.choices?.[0]?.message?.content ?? '';
  const promptTokens = j.usage?.prompt_tokens ?? 0;
  const completionTokens = j.usage?.completion_tokens ?? 0;

  // Parse first JSON object — robust to occasional preamble/fence wrapping.
  let raw: unknown;
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`OpenRouter response had no JSON: ${text.slice(0, 120)}`);
    raw = JSON.parse(m[0]);
  }

  return {
    object: opts.schema.parse(raw),
    promptTokens,
    completionTokens,
  };
}

export async function llmGenerateObject<T>(opts: {
  step: string;
  modelKey: ModelKey;
  schema: ZodType<T>;
  prompt: string;
  system?: string;
  maxRetries?: number;
}): Promise<T> {
  const modelId = MODELS[opts.modelKey];
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(opts.modelKey));

  try {
    if (shouldRouteDirect(opts.modelKey)) {
      const { object, promptTokens, completionTokens } = await callOpenRouterDirect({
        modelId,
        schema: opts.schema,
        prompt: opts.prompt,
        system: opts.system,
        reasoning: reasoningForOpenRouter(opts.modelKey),
        signal: controller.signal,
      });
      const costUsd = estimateCost(modelId, promptTokens, completionTokens);
      callLog.push({
        step: opts.step,
        model: modelId,
        latencyMs: Date.now() - start,
        tokensIn: promptTokens,
        tokensOut: completionTokens,
        costUsd,
      });
      recordCostFromContext(costUsd);
      return object;
    }

    const providerOpts = providerOptionsFor(opts.modelKey);
    const result = await generateObject({
      output: 'object',
      model: getModel(opts.modelKey),
      schema: opts.schema,
      prompt: opts.prompt,
      system: opts.system,
      maxRetries: opts.maxRetries ?? 1,
      abortSignal: controller.signal,
      ...(providerOpts ? { providerOptions: providerOpts } : {}),
    });

    const latencyMs = Date.now() - start;
    const usage = result.usage;
    const tokensIn = usage.inputTokens ?? 0;
    const tokensOut = usage.outputTokens ?? 0;
    const costUsd = estimateCost(modelId, tokensIn, tokensOut);
    callLog.push({ step: opts.step, model: modelId, latencyMs, tokensIn, tokensOut, costUsd });
    recordCostFromContext(costUsd);

    return result.object;
  } catch (err) {
    // Retry once with capability-matched fallback. hotPath/extractor need
    // json_schema, so they fall to hotPathFallback (same model, throughput-sorted
    // routing). suggester (gpt-oss-20b) falls to suggesterFallback (gpt-5.4-mini)
    // — covers schema-validation failures, OpenRouter HTTP errors, and the
    // 8s timeout. postCall is prose, falls to oss-120b. Already-fallback paths
    // give up rather than recurse.
    const fallbackKey: ModelKey | null =
      opts.modelKey === 'hotPath' || opts.modelKey === 'extractor'
        ? 'hotPathFallback'
        : opts.modelKey === 'suggester'
          ? 'suggesterFallback'
          : opts.modelKey === 'postCall'
            ? 'fallback'
            : null;
    if (fallbackKey) {
      return llmGenerateObject({ ...opts, modelKey: fallbackKey });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function llmStreamObject<T>(opts: {
  step: string;
  modelKey: ModelKey;
  schema: ZodType<T>;
  prompt: string;
  system?: string;
}) {
  const modelId = MODELS[opts.modelKey];
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(opts.modelKey));
  const providerOpts = providerOptionsFor(opts.modelKey);

  const stream = streamObject({
    output: 'object',
    model: getModel(opts.modelKey),
    schema: opts.schema,
    prompt: opts.prompt,
    system: opts.system,
    abortSignal: controller.signal,
    ...(providerOpts ? { providerOptions: providerOpts } : {}),
  });

  // Log on completion (non-blocking) and clear timeout. We capture the
  // cost-context HERE (synchronously, while the AsyncLocalStorage frame is
  // still active) — by the time `usage` resolves the caller may have
  // returned and the ALS store is gone.
  const ctxAtCallTime = getCostContext();
  stream.usage.then((usage) => {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const tokensIn = usage.inputTokens ?? 0;
    const tokensOut = usage.outputTokens ?? 0;
    const costUsd = estimateCost(modelId, tokensIn, tokensOut);
    callLog.push({ step: opts.step, model: modelId, latencyMs, tokensIn, tokensOut, costUsd });
    if (ctxAtCallTime) {
      try {
        if (ctxAtCallTime.userId) incrementUserSpend(ctxAtCallTime.userId, costUsd);
        if (ctxAtCallTime.callId) incrementCallCost(ctxAtCallTime.callId, costUsd);
      } catch (err) {
        console.error('[llm wrapper] streamObject cost record failed', err);
      }
    }
  }).catch((err) => {
    clearTimeout(timer);
    console.error('[llm wrapper] streamObject usage promise rejected', opts.step, err);
  });

  return stream;
}

/**
 * Free-form text completion. Used by the follow-up email agent — the output
 * is prose, so structured output isn't appropriate. Cost is tracked the
 * same way as llmGenerateObject.
 */
export async function llmGenerateText(opts: {
  step: string;
  modelKey: ModelKey;
  prompt: string;
  system?: string;
  maxRetries?: number;
}): Promise<string> {
  const modelId = MODELS[opts.modelKey];
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(opts.modelKey));
  const providerOpts = providerOptionsFor(opts.modelKey);

  try {
    const result = await generateText({
      model: getModel(opts.modelKey),
      prompt: opts.prompt,
      system: opts.system,
      maxRetries: opts.maxRetries ?? 1,
      abortSignal: controller.signal,
      ...(providerOpts ? { providerOptions: providerOpts } : {}),
    });

    const latencyMs = Date.now() - start;
    const usage = result.usage;
    const tokensIn = usage.inputTokens ?? 0;
    const tokensOut = usage.outputTokens ?? 0;
    const costUsd = estimateCost(modelId, tokensIn, tokensOut);
    callLog.push({ step: opts.step, model: modelId, latencyMs, tokensIn, tokensOut, costUsd });
    recordCostFromContext(costUsd);

    return result.text;
  } finally {
    clearTimeout(timer);
  }
}
