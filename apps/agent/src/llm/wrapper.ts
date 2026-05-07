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

// Provider routing: both fallback paths prefer throughput-sorted gateway dispatch.
// Post-call fallback also drops reasoning effort since prose quality tolerates it.
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

// Wall-clock budget per call. Hot path must abort fast; post-call gets longer.
function timeoutFor(key: ModelKey): number {
  return key === 'postCall' ? 20_000 : 5_000;
}

// Rough per-token cost estimates (USD) — update when Vercel publishes rates
const COST_PER_TOKEN: Record<string, { in: number; out: number }> = {
  'openai/gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
  // gpt-5.4-mini placeholder — confirm against Vercel's published rates
  'openai/gpt-5.4-mini': { in: 0.00000030, out: 0.0000012 },
  'openai/gpt-oss-120b': { in: 0.0000008, out: 0.0000032 },
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
  const providerOpts = providerOptionsFor(opts.modelKey);

  try {
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
    // routing). postCall is prose, so it falls to oss-120b. Already-fallback
    // paths give up rather than recurse.
    const fallbackKey: ModelKey | null =
      opts.modelKey === 'hotPath' || opts.modelKey === 'extractor'
        ? 'hotPathFallback'
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
  }).catch(() => { clearTimeout(timer); });

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
