import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, streamObject, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';

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
    callLog.push({
      step: opts.step,
      model: modelId,
      latencyMs,
      tokensIn: (usage.inputTokens ?? 0),
      tokensOut: (usage.outputTokens ?? 0),
      costUsd: estimateCost(modelId, (usage.inputTokens ?? 0), (usage.outputTokens ?? 0)),
    });

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

  // Log on completion (non-blocking) and clear timeout
  stream.usage.then((usage) => {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    callLog.push({
      step: opts.step,
      model: modelId,
      latencyMs,
      tokensIn: (usage.inputTokens ?? 0),
      tokensOut: (usage.outputTokens ?? 0),
      costUsd: estimateCost(modelId, (usage.inputTokens ?? 0), (usage.outputTokens ?? 0)),
    });
  }).catch(() => { clearTimeout(timer); });

  return stream;
}
