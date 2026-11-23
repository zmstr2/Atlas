import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, streamObject, type LanguageModel } from 'ai';
import { ZodError, type ZodType } from 'zod';

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
  // 2026-11: moved to gpt-6-luna (cheap, json_schema, reasoning can be turned off).
  // It defaults to MEDIUM reasoning, which would blow the 5s budget, so
  // providerOptionsFor() pins reasoningEffort to 'none' for these keys.
  hotPath: process.env.EXTRACTOR_MODEL ?? 'openai/gpt-6-luna',
  // Hot-path/extractor fallback: same model under throughput-sorted gateway
  // routing. Switching to a different model whose json_schema support is
  // unverified would risk silent schema-parse failure on the rep's critical
  // path — a worse failure mode than retrying the same model under different
  // load. See providerOptionsFor below.
  hotPathFallback: process.env.EXTRACTOR_MODEL ?? 'openai/gpt-6-luna',
  extractor: process.env.EXTRACTOR_MODEL ?? 'openai/gpt-6-luna',
  // Suggester: prospect-suggester / rep-watcher. gpt-6-luna with reasoning off,
  // through the same Gateway as everything else (no OpenRouter key needed).
  suggester: process.env.SUGGESTER_MODEL ?? 'openai/gpt-6-luna',
  // Same model, routed by throughput, used when the primary times out or errors.
  suggesterFallback: process.env.SUGGESTER_FALLBACK_MODEL ?? 'openai/gpt-6-luna',
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

// Vercel AI SDK provider options.
function providerOptionsFor(key: ModelKey): ProviderOptionsLite | undefined {
  if (key === 'extractor' || key === 'hotPath' || key === 'suggester') {
    // forceReasoning: the SDK doesn't know 'gpt-6-luna' is a reasoning model and
    // would silently drop reasoningEffort, leaving it at the default (medium).
    return { openai: { reasoningEffort: 'none', forceReasoning: true } };
  }
  if (key === 'hotPathFallback' || key === 'suggesterFallback') {
    return {
      gateway: { sort: 'tps' },
      openai: { reasoningEffort: 'none', forceReasoning: true },
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

// Wall-clock budget per call. Tuned per role:
//   - hotPath / extractor: 5s — must abort fast on the rep's critical path.
//   - suggester / suggesterFallback: 8s — gpt-oss-20b's p95 through the gateway
//     can hit ~6-8s under load (bench showed p95=14s direct on OR; gateway is
//     more variable). 5s forced ~50% of calls to fall through to fallback,
//     doubling effective latency. 8s lets ~85% complete on primary; the 15%
//     that time out still get fallback within ~10s total.
//   - postCall: 20s — quality > speed, ~5-10s typical on oss-120b.
function timeoutFor(key: ModelKey): number {
  if (key === 'postCall') return 20_000;
  if (key === 'suggester' || key === 'suggesterFallback') return 4_000;
  return 5_000;
}

// Per-token cost estimates (USD). Source: OpenRouter public model registry
// (https://openrouter.ai/api/v1/models), 2026-05-08.
const COST_PER_TOKEN: Record<string, { in: number; out: number }> = {
  'openai/gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
  // gpt-5.4-mini: $0.75/M in, $4.50/M out. Was $0.30/$1.20 placeholder before
  // — production cost was being under-reported by ~2.5×.
  'openai/gpt-5.4-mini': { in: 0.00000075, out: 0.0000045 },
  // gpt-6-luna: $0.10/M in, $0.50/M out.
  'openai/gpt-6-luna': { in: 0.0000001, out: 0.0000005 },
  'openai/gpt-oss-120b': { in: 0.0000008, out: 0.0000032 },
  // gpt-oss-20b: $0.03/M in, $0.14/M out. Current MODELS.suggester — ~28× cheaper
  // than 5.4-mini at the same precision on the 40-turn fixture.
  'openai/gpt-oss-20b': { in: 0.00000003, out: 0.00000014 },
  // glm-5.1: $1.15/1M tokens (bench note 2026-05-12). Split ~70/30 in/out.
  'z-ai/glm-5.1': { in: 0.0000008, out: 0.00000035 },
  // kimi-k2.6: $0.92/1M tokens (bench note 2026-05-12). Split ~70/30 in/out.
  'moonshotai/kimi-k2.6': { in: 0.00000064, out: 0.00000028 },
  // Kept for historical sessions / migration analytics.
  'google/gemma-4-26b-a4b-it': { in: 0.00000006, out: 0.00000033 },
  'cerebras/glm-4-7': { in: 0.0000004, out: 0.00000175 },
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

  try {
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
    // routing). suggester (Gemma) falls to suggesterFallback (glm-4.7) — covers
    // the silent-empty-stream failure mode some non-OpenAI models hit through
    // the gateway's openai-compat path. postCall is prose, falls to oss-120b.
    // Already-fallback paths give up rather than recurse.
    const fallbackKey: ModelKey | null =
      opts.modelKey === 'hotPath' || opts.modelKey === 'extractor'
        ? 'hotPathFallback'
        : opts.modelKey === 'suggester'
          ? 'suggesterFallback'
          : opts.modelKey === 'postCall'
            ? 'fallback'
            : null;
    if (fallbackKey) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const isSchema = err instanceof Error && err.message.startsWith('LLM schema mismatch');
      console.error('[llm-fallback] primary failed, retrying with fallback', {
        step: opts.step,
        primaryKey: opts.modelKey,
        fallbackKey,
        isTimeout,
        isSchema,
        message: err instanceof Error ? err.message.slice(0, 120) : String(err),
      });
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
