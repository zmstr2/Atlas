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
  hotPath: 'openai/gpt-5.4-mini',
  // Hot-path/extractor fallback: same model under throughput-sorted gateway
  // routing. Switching to a different model whose json_schema support is
  // unverified would risk silent schema-parse failure on the rep's critical
  // path — a worse failure mode than retrying the same model under different
  // load. See providerOptionsFor below.
  hotPathFallback: 'openai/gpt-5.4-mini',
  extractor: 'openai/gpt-5.4-mini',
  // Suggester: prospect-suggester / rep-watcher / merged suggester. Switched
  // from Gemma (which over-fired — 55% silent precision on the 40-turn fixture)
  // to gpt-oss-20b at reasoning_effort='low'. bench-suggester-40turn-v3 measured
  // 80% precision / 80% recall, ~2s p50 latency through OR throughput-sort,
  // at $0.067/1k calls (Gemma was $0.124 with worse precision). The smaller
  // recall delta vs gpt-5.4-mini (-10pts) is the right trade for this product
  // since alert-fatigue from false fires hurts trust more than missed nudges.
  // Per-token: $0.03/M in, $0.14/M out (OpenRouter).
  suggester: 'openai/gpt-oss-20b',
  // Suggester fallback: gpt-5.4-mini with reasoning DISABLED (effort='none' is
  // the gateway-supported equivalent of OpenRouter's `reasoning.enabled=false`).
  // Reasoning-off is strictly better than reasoning='low' for this role:
  // bench-suggester-40turn-v3 showed avg score 3.27→3.42, p95 latency 11.75s→6.08s,
  // cost $1.89→$1.57/1k. Used as fallback because it covers the rare cases where
  // gpt-oss-20b under-fires (notably rep_watcher mistakes — 5.4-mini caught
  // u17/u25 where oss-20b stayed silent). Per-token: $0.75/M in, $4.50/M out.
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

// Vercel AI SDK provider options. Used for hotPath/extractor/postCall.
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
// routes gpt-oss-20b to Groq at ~2s p50 — Vercel's tps sort had higher tail
// variance (smoke-tested 4-7s). (2) AI SDK's openai.responses provider rejects
// reasoningEffort='none' for gpt-5.4-mini with a warning even though the
// gateway accepts it; OR's unified API takes `reasoning: { enabled: false }`
// cleanly without the validation noise.
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
//   - hotPath / extractor: 5s — must abort fast on the rep's critical path.
//   - suggester / suggesterFallback: 8s — gpt-oss-20b's p95 through the gateway
//     can hit ~6-8s under load (bench showed p95=14s direct on OR; gateway is
//     more variable). 5s forced ~50% of calls to fall through to fallback,
//     doubling effective latency. 8s lets ~85% complete on primary; the 15%
//     that time out still get fallback within ~10s total.
//   - postCall: 20s — quality > speed, ~5-10s typical on oss-120b.
function timeoutFor(key: ModelKey): number {
  if (key === 'postCall') return 20_000;
  if (key === 'suggester' || key === 'suggesterFallback') return 8_000;
  return 5_000;
}

// Per-token cost estimates (USD). Source: OpenRouter public model registry
// (https://openrouter.ai/api/v1/models), 2026-05-08.
const COST_PER_TOKEN: Record<string, { in: number; out: number }> = {
  'openai/gpt-4o-mini': { in: 0.00000015, out: 0.0000006 },
  // gpt-5.4-mini: $0.75/M in, $4.50/M out. Was $0.30/$1.20 placeholder before
  // — production cost was being under-reported by ~2.5×.
  'openai/gpt-5.4-mini': { in: 0.00000075, out: 0.0000045 },
  'openai/gpt-oss-120b': { in: 0.0000008, out: 0.0000032 },
  // gpt-oss-20b: $0.03/M in, $0.14/M out. Current MODELS.suggester — ~28× cheaper
  // than 5.4-mini at the same precision on the 40-turn fixture.
  'openai/gpt-oss-20b': { in: 0.00000003, out: 0.00000014 },
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

// Direct OpenRouter call — used for suggester paths. Mirrors what the bench
// scripts (bench-suggester-40turn-v3, bench-suggester-10way-v2) ran. Returns
// `{ object, usage }` matching AI SDK's shape so the surrounding wrapper code
// stays uniform. Throws on HTTP error, parse failure, or schema mismatch — all
// of which trigger the existing fallback-key chain in llmGenerateObject.
// Hand-written JSON Schema for SuggestionSchema.omit({ agent: true }). Used in
// json_schema strict mode where models support it (gpt-5.4-mini definitely;
// gpt-oss-20b's various OR providers vary — body is sent and ignored if the
// provider doesn't honor it, falling back to json_object behavior). Kept in
// sync with packages/types/src/agents.ts manually; the schema-fuzz script
// (Wave 3.2) will catch drift.
const SUGGESTER_JSON_SCHEMA = {
  name: 'Suggestion',
  strict: false, // strict=true requires `additionalProperties:false` everywhere; relax for now
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['shouldFire', 'play', 'markdown', 'reasoning'],
    properties: {
      shouldFire: { type: 'boolean' },
      priority: { type: 'string', enum: ['critical', 'nudge', 'fyi'] },
      play: {
        type: 'string',
        enum: [
          'drill_vague', 'quantify_pain', 'probe_stakeholder', 'reframe_objection',
          'surface_value_prop', 'competitor_handle', 'push_next_axis', 'trial_close',
          'multi_thread', 'anchor_next_step', 'qualify_out', 'correct_contradiction',
          'rep_leading_question', 'rep_feature_dump', 'rep_premature_discount',
          'rep_missed_buying_signal', 'rep_skipped_drill', 'rep_defended_objection',
          'rep_off_ladder', 'rep_no_next_step', 'rep_pitched_outside_anchor', 'none',
        ],
      },
      axis: {
        type: ['string', 'null'],
        enum: ['need', 'budget', 'authority', 'timeline', 'metric', 'champion',
               'consequence', 'competitor', 'stakeholder', null],
      },
      markdown: { type: 'string' },
      reasoning: { type: 'string' },
      groundedInUtteranceIds: { type: 'array', items: { type: 'string' } },
      groundedInAnchorTurnIds: { type: 'array', items: { type: 'string' } },
    },
  },
};

// Models known to honor OpenAI-style json_schema response_format. Others get
// the legacy json_object format. List grows as we verify.
const JSON_SCHEMA_CAPABLE = new Set<string>([
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
]);

async function callOpenRouterDirect<T>(opts: {
  modelId: string;
  schema: ZodType<T>;
  prompt: string;
  system?: string;
  reasoning?: OrReasoning;
  signal: AbortSignal;
  useJsonSchema?: boolean;
}): Promise<{ object: T; promptTokens: number; completionTokens: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set — required for suggester routing');

  const useSchema = opts.useJsonSchema && JSON_SCHEMA_CAPABLE.has(opts.modelId);
  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      // Append a JSON-only contract reminder. The agent prompts already
      // describe the schema in their # Output rules section, but this is the
      // last thing the model sees and matches what the bench used.
      { role: 'user', content: `${opts.prompt}\n\nOutput ONLY a single JSON object matching the schema described above. No preamble, no markdown fences, no <think> blocks. Begin with { and end with }.` },
    ],
    max_tokens: 4000,
    provider: { sort: 'throughput' },
    response_format: useSchema
      ? { type: 'json_schema', json_schema: SUGGESTER_JSON_SCHEMA }
      : { type: 'json_object' },
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
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`OpenRouter response had no JSON: ${text.slice(0, 120)}`);
    raw = JSON.parse(m[0]);
  }

  try {
    return {
      object: opts.schema.parse(raw),
      promptTokens,
      completionTokens,
    };
  } catch (err) {
    if (err instanceof ZodError) {
      const fields = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw new Error(`LLM schema mismatch — ${fields}`);
    }
    throw err;
  }
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
        // Suggester paths use json_schema where the model supports it. Falls
        // back to json_object inside callOpenRouterDirect when not capable.
        useJsonSchema: opts.modelKey === 'suggester' || opts.modelKey === 'suggesterFallback',
      });
      callLog.push({
        step: opts.step,
        model: modelId,
        latencyMs: Date.now() - start,
        tokensIn: promptTokens,
        tokensOut: completionTokens,
        costUsd: estimateCost(modelId, promptTokens, completionTokens),
      });
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
