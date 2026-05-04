#!/usr/bin/env bun
/**
 * Test 5 proposed extractor optimizations against the current baseline.
 * For each variant: run two parallel pipelines (baseline + variant) through the
 * full Jordan fixture, with separate memory stores. Compare suggester firing.
 *
 * Usage:
 *   bun run scripts/bench-extractor-variants.ts             # run all 5
 *   VARIANT=v1 bun run scripts/bench-extractor-variants.ts  # one only
 */

import { streamText, createGateway } from 'ai';
import { z } from 'zod';
import { resolve } from 'node:path';
import { SUGGESTER_SYSTEM } from '../src/agents/suggester';
import { MEMORY_AGENT_SYSTEM } from '../src/agents/memoryAgent';
import { llmGenerateObject } from '../src/llm/wrapper';
import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { renderMemoryMarkdown } from '../src/memory/render';
import { detectAnchorContradictions } from '../src/memory/anchors';
import { FlowTagSchema, AnchorAxisSchema, AxisStateSchema, AxisKeySchema } from '@atlas/types';
import type { MeetingMemory } from '@atlas/types';
import type { HotTailEntry } from '../src/memory/hotTail';

if (!process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.AI_GATEWAY_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log('bench — skipped (no gateway key)');
  process.exit(0);
}

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_TOKEN ?? process.env.OPENAI_API_KEY ?? '',
});

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(FIXTURE_PATH).text());

// ─── Shared memory-patch sub-schemas ──────────────────────────────────────────
const FactPatchSchema = z.object({
  op: z.enum(['upsert']),
  key: z.string(),
  category: z.enum(['budget', 'timeline', 'tech_stack', 'team', 'process', 'competitor', 'other']),
  content: z.string(),
  confidence: z.number().min(0).max(1),
});
const ConcernBaseSchema = z.object({
  op: z.enum(['upsert', 'append']),
  topic: z.string(),
  verbatim: z.string(),
  severity: z.enum(['mentioned', 'pressed', 'blocking']),
});
const OpenLoopPatchSchema = z.object({
  op: z.enum(['append', 'close']),
  description: z.string(),
  owner: z.enum(['rep', 'customer']),
  closeDescription: z.string().optional(),
});
const QualSignalPatchSchema = z.object({
  op: z.enum(['append']),
  direction: z.enum(['positive', 'negative']),
  meddic: z.enum(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'budget']),
  bantBucket: z.enum(['budget', 'authority', 'need', 'timeline']),
  content: z.string(),
});
const DecisionGeographyPatchSchema = z.object({
  op: z.enum(['upsert']),
  name: z.string(),
  role: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
});
const AxisFlipSchema = z.object({ axis: AxisKeySchema, state: AxisStateSchema });
const AnchorBaseSchema = z.object({ axis: AnchorAxisSchema, verbatim: z.string() });
const FlowBaseSchema = z.object({ tag: FlowTagSchema, content: z.string() });

function buildSchema(opts: {
  concern?: z.ZodType<any>;
  anchor?: z.ZodType<any>;
  flow?: z.ZodType<any>;
}): z.ZodType<any> {
  return z.object({
    facts: z.array(FactPatchSchema).optional(),
    concerns: z.array(opts.concern ?? ConcernBaseSchema).optional(),
    openLoops: z.array(OpenLoopPatchSchema).optional(),
    qualSignals: z.array(QualSignalPatchSchema).optional(),
    decisionGeography: z.array(DecisionGeographyPatchSchema).optional(),
    flow: (opts.flow ?? FlowBaseSchema).optional(),
    anchor: (opts.anchor ?? AnchorBaseSchema).optional(),
    axisFlips: z.array(AxisFlipSchema).optional(),
  });
}

const BASELINE_SCHEMA = buildSchema({});

// ─── Variant-specific schemas ────────────────────────────────────────────────
// V1: concern resolution
const ConcernV1Schema = z.object({
  op: z.enum(['upsert', 'append', 'resolve']),
  topic: z.string(),
  verbatim: z.string(),
  severity: z.enum(['mentioned', 'pressed', 'blocking']),
});
const V1_SCHEMA = buildSchema({ concern: ConcernV1Schema });

// V2: anchor supersession
const AnchorV2Schema = z.object({
  axis: AnchorAxisSchema,
  verbatim: z.string(),
  supersedes: z.string().optional(),
});
const V2_SCHEMA = buildSchema({ anchor: AnchorV2Schema });

// V5: R-MISTAKE split into specific subtypes
const FlowTagV5Schema = z.enum([
  'R-Q', 'R-VP', 'R-OBJ-RESP', 'R-NS',
  'R-DEFEND', 'R-DUMP', 'R-DISCOUNT', 'R-LEAD', 'R-MISS',
  'P-PAIN', 'P-METRIC', 'P-OBJ', 'P-STAKE', 'P-BUY', 'P-COMP', 'P-NEG', 'P-DQ',
  'OTHER',
]);
const FlowV5Schema = z.object({ tag: FlowTagV5Schema, content: z.string() });
const V5_SCHEMA = buildSchema({ flow: FlowV5Schema });

// ─── Variant prompts ─────────────────────────────────────────────────────────

const V1_PROMPT_ADDITIONS = `

CONCERN RESOLUTION (NEW):
- When a rep utterance addresses an active concern (acknowledges + answers + prospect engages constructively without re-raising it), emit concerns: [{op: 'resolve', topic: '<existing topic>', verbatim: '<rep's response>', severity: '<original>'}].
- Use the EXACT topic string from the EXISTING ACTIVE CONCERNS list; do not paraphrase the topic.
- Only resolve if the response was substantive — boilerplate "I hear you" doesn't count.`;

const V2_PROMPT_ADDITIONS = `

ANCHOR SUPERSESSION (NEW):
- If your anchor restates or updates a prior anchor on the same axis, set anchor.supersedes='<priorTurnId>'. The prior anchor stays in the record but is marked inactive.
- E.g., prior anchor: t12 budget "$50k". New utterance says "$80k actually" → emit anchor with axis='budget', verbatim='$80k actually', supersedes='t12'.
- Don't supersede if the new statement is on a different axis or is a clarification, not a contradiction.`;

const V3_PROMPT_ADDITIONS = `

OUTPUT MINIMALISM (NEW):
- OMIT optional fields entirely when there is nothing to emit. Do NOT emit "facts": [], "concerns": [], etc.
- Required fields are: flow only (anchor and structured fields are all optional).
- This saves tokens and reduces parse errors. Empty arrays = wasted output.`;

const V4_PROMPT_ADDITIONS = `

FACT KEY CONVENTIONS (speaker-aware, NEW):
- REP-spoken facts → use commit.* prefix (commit.implementation_2_weeks, commit.no_dedicated_se, commit.price_quoted_X, commit.scope_offered_Y).
- PROSPECT-spoken facts → use pain.*, stack.*, budget.*, process.*, competitor.*, champion.* prefixes for revealed state.
- Never emit a commit.* fact for a PROSPECT utterance. Never emit pain.* for a REP utterance.
- This makes contradiction detection across speakers explicit (rep commit vs prospect requirement).`;

const V5_PROMPT_ADDITIONS = `

REP MISTAKE TAXONOMY (NEW — replaces R-MISTAKE):
Choose the most specific rep-mistake tag instead of generic R-MISTAKE:
- R-DEFEND: rep argued/justified instead of LAER-ing an objection
- R-DUMP: rep delivered a feature dump or value prop without grounding in pain
- R-DISCOUNT: rep offered price/scope concession before being asked
- R-LEAD: rep asked a leading question (suggested the answer)
- R-MISS: rep moved on past a buying signal, drill opportunity, or stakeholder mention
Pick exactly ONE if a mistake occurred. Use other R-* tags (R-Q, R-VP, etc.) for non-mistake rep moves.`;

// ─── Variant state (bench-side bookkeeping for schema extensions) ─────────────
interface VState {
  addressedTopics: Set<string>;
  supersededTurnIds: Set<string>;
  flowTagOverrides: Map<string, string>;
  memoryAgentTokensOut: number[];
  memoryAgentLatencies: number[];
}
const newVState = (): VState => ({
  addressedTopics: new Set(),
  supersededTurnIds: new Set(),
  flowTagOverrides: new Map(),
  memoryAgentTokensOut: [],
  memoryAgentLatencies: [],
});

// ─── Variants ─────────────────────────────────────────────────────────────────
interface Variant {
  id: string;
  label: string;
  description: string;
  system: string;
  schema: z.ZodType<any>;
  /** Apply the (variant-shaped) patch to the production-shaped store + bench-side state. */
  applyPatch: (patch: any, utt: Utt, turnId: string, store: MemoryStore, state: VState) => void;
  /** Optional render override for the suggester (default: production renderMemoryMarkdown). */
  renderForSuggester?: (memory: MeetingMemory, hotTail: HotTailEntry[], state: VState) => string;
  /** Whether this variant needs concerns surfaced in the memory agent's input prompt. */
  showActiveConcernsInPrompt?: boolean;
}

const VARIANTS: Variant[] = [
  {
    id: 'v1',
    label: 'concern resolution lifecycle',
    description: 'Concerns can be marked op=resolve when rep addresses them; render filters resolved out.',
    system: MEMORY_AGENT_SYSTEM + V1_PROMPT_ADDITIONS,
    schema: V1_SCHEMA,
    showActiveConcernsInPrompt: true,
    applyPatch: (patch, utt, turnId, store, state) => {
      // Separate resolve ops; track in state. Only upsert/append go to store.
      const cleaned = (patch.concerns ?? []).filter((c: any) => {
        if (c.op === 'resolve') {
          state.addressedTopics.add(c.topic);
          return false;
        }
        return true;
      });
      store.applyMemoryPatch({
        utteranceId: utt.id, turnId, speaker: utt.speaker,
        facts: patch.facts, concerns: cleaned, openLoops: patch.openLoops,
        qualSignals: patch.qualSignals, decisionGeography: patch.decisionGeography,
        flow: patch.flow, anchor: patch.anchor, axisFlips: patch.axisFlips,
      });
    },
    renderForSuggester: (memory, hotTail, state) => {
      // Filter out addressed concerns by topic (state.addressedTopics)
      const filtered: MeetingMemory = {
        ...memory,
        concerns: memory.concerns.map((c) =>
          state.addressedTopics.has(c.topic) ? { ...c, addressed: true } : c
        ),
      };
      return renderMemoryMarkdown({ memory: filtered, hotTail });
    },
  },
  {
    id: 'v2',
    label: 'anchor supersession',
    description: 'Anchors can declare supersedes=priorTurnId; render filters out superseded anchors.',
    system: MEMORY_AGENT_SYSTEM + V2_PROMPT_ADDITIONS,
    schema: V2_SCHEMA,
    applyPatch: (patch, utt, turnId, store, state) => {
      if (patch.anchor?.supersedes) state.supersededTurnIds.add(patch.anchor.supersedes);
      const cleanedAnchor = patch.anchor ? { axis: patch.anchor.axis, verbatim: patch.anchor.verbatim } : undefined;
      store.applyMemoryPatch({
        utteranceId: utt.id, turnId, speaker: utt.speaker,
        facts: patch.facts, concerns: patch.concerns, openLoops: patch.openLoops,
        qualSignals: patch.qualSignals, decisionGeography: patch.decisionGeography,
        flow: patch.flow, anchor: cleanedAnchor, axisFlips: patch.axisFlips,
      });
    },
    renderForSuggester: (memory, hotTail, state) => {
      const filtered: MeetingMemory = {
        ...memory,
        verbatimAnchors: memory.verbatimAnchors.filter((a) => !state.supersededTurnIds.has(a.turnId)),
      };
      return renderMemoryMarkdown({ memory: filtered, hotTail });
    },
  },
  {
    id: 'v3',
    label: 'empty-array suppression',
    description: 'Memory agent omits optional fields entirely when empty (token efficiency).',
    system: MEMORY_AGENT_SYSTEM + V3_PROMPT_ADDITIONS,
    schema: BASELINE_SCHEMA,
    applyPatch: (patch, utt, turnId, store, _state) => {
      store.applyMemoryPatch({ utteranceId: utt.id, turnId, speaker: utt.speaker, ...patch });
    },
  },
  {
    id: 'v4',
    label: 'speaker-bifurcated facts',
    description: 'REP utterances → commit.* keys; PROSPECT utterances → pain./stack./budget.* keys.',
    system: MEMORY_AGENT_SYSTEM + V4_PROMPT_ADDITIONS,
    schema: BASELINE_SCHEMA,
    applyPatch: (patch, utt, turnId, store, _state) => {
      store.applyMemoryPatch({ utteranceId: utt.id, turnId, speaker: utt.speaker, ...patch });
    },
  },
  {
    id: 'v5',
    label: 'R-MISTAKE flow tag split',
    description: 'R-MISTAKE replaced with R-DEFEND, R-DUMP, R-DISCOUNT, R-LEAD, R-MISS.',
    system: MEMORY_AGENT_SYSTEM + V5_PROMPT_ADDITIONS,
    schema: V5_SCHEMA,
    applyPatch: (patch, utt, turnId, store, state) => {
      const newTags = ['R-DEFEND', 'R-DUMP', 'R-DISCOUNT', 'R-LEAD', 'R-MISS'];
      let storeFlow = patch.flow;
      if (patch.flow && newTags.includes(patch.flow.tag)) {
        // Track override; remap to R-MISTAKE for store compat
        state.flowTagOverrides.set(turnId, patch.flow.tag);
        storeFlow = { tag: 'R-MISTAKE', content: patch.flow.content };
      }
      store.applyMemoryPatch({
        utteranceId: utt.id, turnId, speaker: utt.speaker,
        facts: patch.facts, concerns: patch.concerns, openLoops: patch.openLoops,
        qualSignals: patch.qualSignals, decisionGeography: patch.decisionGeography,
        flow: storeFlow, anchor: patch.anchor, axisFlips: patch.axisFlips,
      });
    },
    renderForSuggester: (memory, hotTail, state) => {
      const filtered: MeetingMemory = {
        ...memory,
        flow: memory.flow.map((f) => {
          const override = state.flowTagOverrides.get(f.turnId);
          return override ? { ...f, tag: override as any } : f;
        }),
      };
      return renderMemoryMarkdown({ memory: filtered, hotTail });
    },
  },
];

// ─── Memory agent caller ─────────────────────────────────────────────────────
async function runMemoryAgent(opts: {
  utt: Utt;
  turnId: string;
  prevMemory: MeetingMemory;
  hotTail: HotTailEntry[];
  system: string;
  schema: z.ZodType<any>;
  showActiveConcerns: boolean;
  state: VState;
}): Promise<{ patch: any | null; latencyMs: number; tokensOut: number; error?: string }> {
  const { utt, turnId, prevMemory, hotTail, system, schema, showActiveConcerns, state } = opts;

  const existingFacts = prevMemory.facts.slice(-15).map((f) => `${f.key}: ${f.content}`).join('\n');
  const existingAnchors = prevMemory.verbatimAnchors
    .filter((a) => !state.supersededTurnIds.has(a.turnId))
    .slice(-10)
    .map((a) => `[${a.turnId} / ${a.axis}] "${a.verbatim}"`).join('\n');
  const recentFlow = prevMemory.flow.slice(-10).map((f) => {
    const tag = state.flowTagOverrides.get(f.turnId) ?? f.tag;
    return `[${f.turnId}] ${tag} ${f.content}`;
  }).join('\n');
  const tail = hotTail.map((h) => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');

  let concernsBlock = '';
  if (showActiveConcerns) {
    const active = prevMemory.concerns
      .filter((c) => !c.addressed && !state.addressedTopics.has(c.topic))
      .slice(-10)
      .map((c) => `[${c.severity}] ${c.topic}: "${c.verbatim}"`).join('\n');
    concernsBlock = `\n\nEXISTING ACTIVE CONCERNS (may be resolvable):\n${active || '(none)'}`;
  }

  const prompt = `TURN ID: ${turnId}
SPEAKER: ${utt.speaker}
NEW UTTERANCE [${utt.id}]:
${utt.speaker.toUpperCase()}: ${utt.text}

HOT TAIL:
${tail || '(empty)'}

RECENT FLOW (last 10):
${recentFlow || '(empty)'}

EXISTING FACTS (last 15):
${existingFacts || '(none)'}

EXISTING ANCHORS (last 10, active only):
${existingAnchors || '(none)'}${concernsBlock}

Emit the memory patch.`;

  const start = Date.now();
  try {
    // Use production wrapper — it routes via createOpenAI which actually returns
    // populated objects (createGateway + generateObject silently returns {} for
    // schemas with optional fields).
    const obj = await llmGenerateObject({
      step: 'bench_memory_agent',
      modelKey: 'extractor',
      schema: schema as any,
      prompt,
      system,
      maxRetries: 1,
    });
    const latencyMs = Date.now() - start;
    return { patch: obj, latencyMs, tokensOut: 0 };
  } catch (err) {
    return { patch: null, latencyMs: Date.now() - start, tokensOut: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Suggester caller ────────────────────────────────────────────────────────
type RecentEntry = { turn: number; fired: boolean; priority: string; play: string; markdown: string };

function buildSuggesterPrompt(
  utt: Utt, hotTail: HotTailEntry[], memory: MeetingMemory,
  recent: RecentEntry[], renderFn: (m: MeetingMemory, h: HotTailEntry[]) => string,
): string {
  const memoryMarkdown = renderFn(memory, hotTail);
  const isProspect = utt.speaker === 'customer';
  const speakerLabel = isProspect ? 'PROSPECT' : 'REP';
  const priorLabel = isProspect ? 'IMMEDIATE PRIOR REP UTTERANCE' : 'IMMEDIATE PRIOR PROSPECT UTTERANCE';
  const modeLabel = isProspect ? 'PROSPECT MODE' : 'REP MODE';
  const priorOpposite = [...hotTail].reverse().find((h) => h.speaker !== utt.speaker);
  const contradictions = detectAnchorContradictions(memory, utt.text);
  const contradictionLines = contradictions.map((c) => `- [anchor=${c.anchor.turnId} axis=${c.axis}] ${c.reason}`);
  const firedCount = recent.filter((r) => r.fired).slice(-5).length;
  const recentLines = recent.length === 0 ? '(none yet)' :
    recent.map((r) => `- t${r.turn} ${r.fired ? 'FIRED' : 'silent'} [${r.priority}/${r.play}] ${r.markdown || '(no text)'}`).join('\n');

  return `# CALL CONTEXT
${memoryMarkdown}

# PRE-CALL BRIEF
Lead: Jordan Hayes, VP Marketing @ MidCo
Call goal: discovery + qualify outbound automation fit
Product snippets: AI-powered outbound automation | SDR productivity platform | Artisan AI

# ${priorLabel}
${priorOpposite ? `[${priorOpposite.id}] ${priorOpposite.speaker === 'rep' ? 'REP' : 'PROSPECT'}: ${priorOpposite.text}` : '(none)'}

# NEW ${speakerLabel} UTTERANCE — you are in ${modeLabel}
[${utt.id}] ${speakerLabel}: ${utt.text}

# RECENT SUGGESTIONS (your last decisions, oldest first; ${firedCount} of last 5 fired)
${recentLines}

# CONTRADICTIONS DETECTED (deterministic anchor checks)
${contradictionLines.length > 0 ? contradictionLines.join('\n') : '(none)'}

Decide. Output ONLY a JSON object:
{"shouldFire": boolean, "priority": "critical"|"nudge"|"fyi", "play": string, "markdown": string, "reasoning": string, "groundedInUtteranceIds": string[], "groundedInAnchorTurnIds": string[]}`;
}

type Decision = { shouldFire: boolean; priority: string; play: string; markdown: string; reasoning: string };

function tryParseJson(text: string): Decision | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    return {
      shouldFire: !!obj.shouldFire,
      priority: String(obj.priority ?? 'nudge'),
      play: String(obj.play ?? 'none'),
      markdown: String(obj.markdown ?? ''),
      reasoning: String(obj.reasoning ?? ''),
    };
  } catch { return null; }
}

async function callSuggester(prompt: string): Promise<{ text: string; latencyMs: number; error?: string }> {
  const start = Date.now();
  let text = '';
  try {
    const stream = streamText({
      model: gateway('openai/gpt-5.4-mini'),
      system: SUGGESTER_SYSTEM, prompt, maxTokens: 1000,
      abortSignal: AbortSignal.timeout(30_000),
    });
    for await (const chunk of stream.textStream) text += chunk;
    return { text, latencyMs: Date.now() - start };
  } catch (err) {
    return { text, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Main per-variant bench ──────────────────────────────────────────────────
interface TurnResult {
  turn: number; utt: Utt;
  baseline: { decision: Decision | null; error?: string };
  variant: { decision: Decision | null; error?: string };
  baselineMemFacts: number; baselineMemConcerns: number;
  variantMemFacts: number; variantMemConcerns: number;
}

async function runVariantBench(variant: Variant): Promise<{ results: TurnResult[]; bState: VState; vState: VState }> {
  const bStore = new MemoryStore();
  const bHot = new HotTail(6);
  const bState = newVState();
  const bRecent: RecentEntry[] = [];

  const vStore = new MemoryStore();
  const vHot = new HotTail(6);
  const vState = newVState();
  const vRecent: RecentEntry[] = [];

  const results: TurnResult[] = [];

  for (let i = 0; i < fixture.length; i++) {
    const utt = fixture[i];
    const turn = i + 1;
    const turnId = `t${turn}`;
    process.stdout.write(`  t${turn}/${fixture.length}…`);

    const hotEntry = { id: utt.id, speaker: utt.speaker, text: utt.text, startMs: utt.startMs, endMs: utt.endMs };
    bHot.push(hotEntry); vHot.push(hotEntry);
    bStore.recordUtteranceStats(utt.speaker, utt.text);
    vStore.recordUtteranceStats(utt.speaker, utt.text);

    const bMem = bStore.snapshot;
    const vMem = vStore.snapshot;
    const bHotSnap = bHot.snapshot().slice(0, -1);
    const vHotSnap = vHot.snapshot().slice(0, -1);

    // Build prompts
    const bPrompt = buildSuggesterPrompt(utt, bHotSnap, bMem, bRecent, (m, h) => renderMemoryMarkdown({ memory: m, hotTail: h }));
    const vPrompt = buildSuggesterPrompt(utt, vHotSnap, vMem, vRecent, (m, h) => variant.renderForSuggester
      ? variant.renderForSuggester(m, h, vState)
      : renderMemoryMarkdown({ memory: m, hotTail: h }));

    // Run suggesters in parallel
    const [bSugg, vSugg] = await Promise.all([callSuggester(bPrompt), callSuggester(vPrompt)]);
    const bd = bSugg.text ? tryParseJson(bSugg.text) : null;
    const vd = vSugg.text ? tryParseJson(vSugg.text) : null;

    results.push({
      turn, utt,
      baseline: { decision: bd, error: bSugg.error },
      variant: { decision: vd, error: vSugg.error },
      baselineMemFacts: bMem.facts.length, baselineMemConcerns: bMem.concerns.filter((c) => !c.addressed).length,
      variantMemFacts: vMem.facts.length,
      variantMemConcerns: vMem.concerns.filter((c) => !c.addressed && !vState.addressedTopics.has(c.topic)).length,
    });

    if (bd) {
      bRecent.push({ turn, fired: bd.shouldFire && bd.priority !== 'fyi', priority: bd.priority, play: bd.play, markdown: bd.markdown });
      if (bRecent.length > 6) bRecent.splice(0, bRecent.length - 6);
    }
    if (vd) {
      vRecent.push({ turn, fired: vd.shouldFire && vd.priority !== 'fyi', priority: vd.priority, play: vd.play, markdown: vd.markdown });
      if (vRecent.length > 6) vRecent.splice(0, vRecent.length - 6);
    }

    // Run memory agents (baseline + variant) in parallel
    const [bRes, vRes] = await Promise.all([
      runMemoryAgent({
        utt, turnId, prevMemory: bMem, hotTail: bHot.snapshot(),
        system: MEMORY_AGENT_SYSTEM, schema: BASELINE_SCHEMA,
        showActiveConcerns: false, state: bState,
      }),
      runMemoryAgent({
        utt, turnId, prevMemory: vMem, hotTail: vHot.snapshot(),
        system: variant.system, schema: variant.schema,
        showActiveConcerns: !!variant.showActiveConcernsInPrompt, state: vState,
      }),
    ]);

    bState.memoryAgentLatencies.push(bRes.latencyMs); bState.memoryAgentTokensOut.push(bRes.tokensOut);
    vState.memoryAgentLatencies.push(vRes.latencyMs); vState.memoryAgentTokensOut.push(vRes.tokensOut);

    if (bRes.patch) {
      try { bStore.applyMemoryPatch({ utteranceId: utt.id, turnId, speaker: utt.speaker, ...bRes.patch }); }
      catch {}
    }
    if (vRes.patch) {
      try { variant.applyPatch(vRes.patch, utt, turnId, vStore, vState); }
      catch {}
    }

    process.stdout.write(` b=${bd?.shouldFire ? 'F' : '·'} v=${vd?.shouldFire ? 'F' : '·'}\n`);
  }

  return { results, bState, vState };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function reportVariant(variant: Variant, run: { results: TurnResult[]; bState: VState; vState: VState }) {
  const { results, bState, vState } = run;
  const DIV = '─'.repeat(80);
  console.log(`\n${DIV}\nVARIANT ${variant.id}: ${variant.label}\n${variant.description}\n${DIV}`);

  const bFires = results.filter((r) => r.baseline.decision?.shouldFire && r.baseline.decision.priority !== 'fyi');
  const vFires = results.filter((r) => r.variant.decision?.shouldFire && r.variant.decision.priority !== 'fyi');
  const bErr = results.filter((r) => !r.baseline.decision || r.baseline.error).length;
  const vErr = results.filter((r) => !r.variant.decision || r.variant.error).length;

  console.log('\nMETRICS                  baseline         variant');
  console.log(`fires                    ${String(bFires.length).padEnd(16)} ${vFires.length}`);
  console.log(`suggester errors         ${String(bErr).padEnd(16)} ${vErr}`);
  console.log(`mem agent p50 latency ms ${String(pct(bState.memoryAgentLatencies, 0.5)).padEnd(16)} ${pct(vState.memoryAgentLatencies, 0.5)}`);
  console.log(`mem agent avg tokens out ${String(avg(bState.memoryAgentTokensOut)).padEnd(16)} ${avg(vState.memoryAgentTokensOut)}`);
  console.log(`final mem facts          ${String(results.at(-1)?.baselineMemFacts ?? 0).padEnd(16)} ${results.at(-1)?.variantMemFacts ?? 0}`);
  console.log(`final active concerns    ${String(results.at(-1)?.baselineMemConcerns ?? 0).padEnd(16)} ${results.at(-1)?.variantMemConcerns ?? 0}`);
  if (variant.id === 'v1') console.log(`addressed topic count    -                ${vState.addressedTopics.size}`);
  if (variant.id === 'v2') console.log(`superseded anchor count  -                ${vState.supersededTurnIds.size}`);
  if (variant.id === 'v5') console.log(`split flow tag count     -                ${vState.flowTagOverrides.size}`);

  // Diverged turns
  const diverged = results.filter((r) => {
    const b = r.baseline.decision?.shouldFire && r.baseline.decision.priority !== 'fyi';
    const v = r.variant.decision?.shouldFire && r.variant.decision.priority !== 'fyi';
    return b !== v || r.baseline.decision?.play !== r.variant.decision?.play;
  });
  console.log(`\nDIVERGED TURNS (${diverged.length}/${results.length})`);
  for (const r of diverged) {
    const b = r.baseline.decision; const v = r.variant.decision;
    const lbl = `[t${r.turn}] ${r.utt.speaker === 'customer' ? 'PROSPECT' : 'REP'}: ${r.utt.text.slice(0, 90)}${r.utt.text.length > 90 ? '…' : ''}`;
    console.log(`\n${lbl}`);
    console.log(`  BASELINE  ${b?.shouldFire ? `FIRED [${b.priority}/${b.play}] ${b.markdown}` : `silent (play=${b?.play ?? '-'})`}`);
    console.log(`  VARIANT   ${v?.shouldFire ? `FIRED [${v.priority}/${v.play}] ${v.markdown}` : `silent (play=${v?.play ?? '-'})`}`);
  }
}

async function main() {
  const onlyId = process.env.VARIANT;
  const toRun = onlyId ? VARIANTS.filter((v) => v.id === onlyId) : VARIANTS;
  if (toRun.length === 0) { console.error(`No variant id=${onlyId}`); process.exit(1); }

  for (const v of toRun) {
    console.log(`\n>>> Running ${v.id}: ${v.label}`);
    const t0 = Date.now();
    const run = await runVariantBench(v);
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    reportVariant(v, run);
  }
}

await main();
