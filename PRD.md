# Atlas — Live Sales Call Agent (v1)

**Take-home for Artisan AI "Builder" role.**
A deployed demo URL the hiring panel can play with in 30 seconds.

> **v1 scope:** Mode 1 (scripted audio playback) only. Interactive mode (Mode 2, voice AI customer) and real-meeting mode (Mode 3, Vexa) are explicit v0.2 follow-ups, shipped via a second email with an updated link.

---

## TL;DR

Atlas is a real-time AI agent that processes a sales qualification call and produces three things:

1. **Live coaching for the rep** — streams suggestions, qualification signals, and objection responses as the call unfolds.
2. **Structured deal intelligence** — typed memory of facts, concerns, qualification signals, open commitments, and decision-process geography, with full provenance back to verbatim utterances.
3. **A Training Delta artifact** — the centerpiece. Surfaces signals Ava (Artisan's AI BDR) cannot currently see: verbatim objection language, value-prop resonance, lead-attribute upweight/downweight recommendations, decision-actor names with sentiment, silence patterns. Closes Artisan's training loop end-to-end.

**Strategic frame:** A fully autonomous AI doing 30-minute discovery calls isn't credible today. Ava-the-AE will arrive. Atlas is the **bridge product** that accelerates the data collection required to get there. Every human-led call generates structured training signal for Ava.

---

## Strategic positioning

### What Ava already sees (today's feedback loop)

| Signal | Source |
|---|---|
| Email open / reply rates | Outbound platform |
| Meeting booked yes/no | Calendar integration |
| Post-call disposition (qualified / DQ / recycle) | AE clicks a button |
| CRM fields the AE fills in | Salesforce / HubSpot writes |

Coarse: a binary outcome and a few human-typed fields. The AE typing "qualified, $50k budget" 30 minutes after the call is a low-fidelity training signal.

### What Atlas extracts that Ava cannot currently see

| Atlas signal | Why Ava is blind to it | Why it matters for training |
|---|---|---|
| **Verbatim objection language** | CRM has "pricing objection: yes/no" — not the phrasing | "We tried Marketo, took 9 months" requires a different response than "it's expensive" |
| **Value-prop resonance** | AE doesn't log "they liked X, ignored Y" | "Save 10hrs/week" was ignored. "Scale outbound 3x" engaged. A/B signal for next campaign. |
| **Silence patterns** | Ava sees what was said, not what wasn't | Ava emphasized AI personalization; customer never asked. Wrong wedge for this segment. |
| **Conviction tone** | Text fields can't carry confidence vs. hesitation | Hesitant "yes we have budget" predicts deal slippage Ava could weight against |
| **Decision-process geography** | CRM might say "needs CFO approval" — won't say "Marcus in RevOps, knows our space" | Real org map for Ava's multi-threading |
| **Lead-attribute true-positives & noise** | Ava knows attributes; CRM only tells qualified/not | Atlas tells *which* attributes drove outcome. "Used HubSpot" upweighted. "Recent Series B" was noise. |

This table is the spine of the product. Every Atlas surface should map to at least one row.

> Engagement-timing inflections were considered and cut from v1 (detection unreliable, see "Out of scope" below). The five rows above carry the artifact.

---

## Demo strategy

### Mode 1: Scripted audio playback (v1, this version)

The hiring manager opens the demo URL, clicks play, watches Atlas process a pre-recorded sales call in real-time-paced fashion.

- Audio file is pre-generated (ElevenLabs voices for AE + customer) — committed to the repo
- Transcript is pre-generated **offline** with Whisper v3 turbo on Fireworks (word-level timestamps + speaker diarization). Stored in `fixtures/{script}-transcript.json`.
- During demo: HTML5 `<audio>` plays the file; `timeupdate` events fire transcript events into the Atlas pipeline at their original timestamps
- UI populates as if it were live: memory panel fills, whisper bar streams, transcript scrolls
- At end: post-call view with verdict, draft follow-up, **Training Delta**

**Number of scripts:** Plan for 3 (Maya / Sarah / Tom — see scenarios below); ship with at least 1 if time-constrained.

### Mode 2: Interactive voice AI customer (v0.2 — deferred)

Hiring manager IS the AE; OpenAI Realtime API plays the customer; Atlas helps in real-time. Mode 2 deferred to v0.2 follow-up email.

### Mode 3: Real meeting via Vexa (v0.2 — deferred)

Atlas joins a real Zoom/Meet/Teams call as a silent bot. Deferred to v0.2 follow-up email.

---

## Scripted scenarios (v1 content)

| Script | Outcome | Training Delta theme |
|---|---|---|
| **Maya** — VP Marketing, MidCo (50-200 person co) | Qualified → demo booked | Lead-attribute true-positives ("VP Marketing", "uses HubSpot"); objection language ("we tried Marketo, 9 months"); decision geography ("Marcus from RevOps") |
| **Sarah** — Head of Growth, EarlyCo (Series A) | Qualified-out cleanly | Negative qual signals (no budget, no timeline); silence patterns (Ava-emphasized features got no engagement); lead-attribute noise ("recent Series A" was wrong fit-stage signal) |
| **Tom** — Director of Sales Ops, MidCo | Needs more info | Authority gap (decision-maker not on call); positive product fit; conviction-tone hesitation on budget; open loop (follow up with VP Sales) |

These are also the **fixture content** that powers the demo. The audio file generation step produces a single `.wav` per script.

---

## Core experiences

### 1. Pre-call brief (pre-baked)

Each script has a pre-baked brief object that's fed to the suggestion LLM as cold context. Not loaded from a real CRM — committed as `fixtures/{script}-brief.json`.

```ts
type PreCallBrief = {
  lead: { name: string; title: string; company: string; companySize: string };
  avaContext: {
    campaignId: string;
    leadScore: number;        // 0-1, what Ava scored this lead
    scoringSignals: Array<{ signal: string; weight: number }>;  // what Ava used
  };
  pastInteractions: Array<{ type: 'email' | 'meeting'; date: string; summary: string }>;
  callGoal: string;           // "qualify", in v1 always
  suggestedQuestions: string[];  // 2-3 starter qualification questions
  productSnippets: string[];  // 2-3 hardcoded battlecard lines (positioning, objection responses)
};
```

The `avaContext` powers the Training Delta's "lead-attribute upweight/downweight" — without it, that section of the artifact is blank.

### 2. Live memory panel (hero shot)

Right-rail panel. Sections: **Facts**, **Concerns**, **Open Loops**, **Qualification Signals (+/−)**.

Behavior:
- Items animate in within ~600ms of the utterance that produced them
- Hovering an item shows the **verbatim source utterance** (provenance, not paraphrase)
- Color-coded by qualification dimension — see "Qualification framework" below
- Updates (not duplicates) when the customer revises a fact; revision history preserved
- Empty state shows the pre-call brief summary

### 3. Whisper bar + "Atlas is listening" pulse

Bottom of the screen.
- On every customer utterance: subtle pulse animation appears within 50ms ("Atlas is listening")
- If the unified suggestion+classifier model returns `shouldSuggest: false` → pulse fades, no text
- If `shouldSuggest: true` → suggestion text streams in place of the pulse, ~250-300ms after pulse appears
- Optional expandable "why" / supporting fact (cites memory item by id)
- Glanceable, dismissible, non-blocking
- Includes explicit "qualify out" suggestions when negative signals accumulate

### 4. Post-call view

Shareable URL per call. Contains:
- Full transcript with speaker labels and timestamps
- Structured memory snapshot
- **Qualification verdict** (qualified / not qualified / needs more info) with reasoning grounded in extracted MEDDIC + BANT signals
- **Training Delta** (the centerpiece — see below)
- Draft follow-up email (one real action: button opens Gmail compose with prefilled body)
- Suggested CRM updates (mocked — "would update Salesforce: stage=Demo, ICP fit=High")
- **Cost / latency footer:** "This call: 47 LLM calls, 823 tokens, $0.07 total, p50 critical-path latency 412ms"

### 5. Training Delta (the differentiator)

Generated post-call. Side-by-side asymmetric layout: 4 lines of "what Ava already sees" against a full screen of "what Atlas adds." The visual asymmetry *is* the demo.

```
ATLAS TRAINING DELTA — Ava Campaign #47

Lead: Maya Chen, VP Marketing, MidCo (Ava-generated, scored 0.62)
Outcome: Qualified → Demo booked

═══════════════════════════════════════════════════════════════
WHAT AVA ALREADY HAS:
  CRM disposition: qualified
  AE notes: "Good fit, $50k budget, urgent Q2 timeline"
  Meeting booked: yes
═══════════════════════════════════════════════════════════════
WHAT ATLAS ADDS (the training delta):

OBJECTION LANGUAGE (verbatim, with disposition):
  ⚠ [00:04:12] "We tried Marketo and it took 9 months to roll out"
    → Implementation-time concern, NOT pricing
    → Rep handled with: "we deploy in 2 weeks" — customer satisfied
    → AVA: add 'implementation-time' as distinct objection class.
      Current handler conflates with pricing. Recommend split + A/B.

VALUE-PROP RESONANCE:
  ▲ "no implementation help required" → engaged
    → AVA: outbound undersells implementation ease for marketing-VP
      segment. Test opening: "deploys in 2 weeks, no SE required."
  ▼ "AI-powered automation" → no engagement
    → AVA: this segment is fatigued by AI buzzwords. Use concrete
      capability language.

LEAD-ATTRIBUTE TRUE-POSITIVES (upweight in Ava's scoring):
  ✓ Title: "VP Marketing" — confirmed buyer, fast
  ✓ Tech: "Uses HubSpot" — drove the workflow-pain conversation

LEAD-ATTRIBUTE NOISE (downweight in Ava's scoring):
  ✗ Recent Series B — Ava weighted this; turned out irrelevant
  ✗ "AI tools" LinkedIn post — vague, didn't predict fit

SILENCE PATTERNS:
  Ava emphasized: email personalization, AI sequences
  Customer mentioned: workflow automation, multi-tool integration
  → AVA: wrong-wedge risk. Test outbound for marketing-VPs at
    50-200 person co's, leading with workflow-integration pain.

DECISION GEOGRAPHY:
  "I'd need to loop in Marcus from RevOps before signing"
  → CRM-typed: "needs RevOps approval"
  → Atlas-extracted: name=Marcus, role=RevOps, customer-sentiment=positive
  → AVA: multi-threading target identified, sentiment pre-loaded.

CONFIDENCE: 0.78 (single call — hold for batch confirmation across ≥5 similar)
═══════════════════════════════════════════════════════════════
```

---

## Qualification framework — MEDDIC + BANT

Both, used differently:
- **MEDDIC dimensions used internally** as the schema for `QualSignal.dimension`. Six dimensions: Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion. More rigorous, what serious sales orgs use.
- **BANT-style color coding in the UI** to keep visual parsing simple. Four colors: Budget (green), Authority (blue), Need (orange), Timeline (purple).
- Each MEDDIC dimension maps to a BANT bucket for color:
  - Metrics → Need (orange)
  - Economic Buyer → Authority (blue)
  - Decision Criteria → Need (orange)
  - Decision Process → Timeline (purple)
  - Identify Pain → Need (orange)
  - Champion → Authority (blue)
  - (Budget green is a 7th implicit dimension — it's MEDDIC's hidden "B")

This gives reviewers MEDDIC's analytical depth in the data + BANT's cognitive simplicity in the UI.

---

## Architecture

### High-level shape

```
┌──────────────────────────────────────────────────────────────────────┐
│                       apps/web (Next.js + Bun)                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Demo landing → Script picker → Playback view → Post-call view │  │
│  │                                                                │  │
│  │  HTML5 <audio> drives playback. timeupdate events trigger      │  │
│  │  transcript replay. SSE feeds memory diffs + suggestion stream.│  │
│  └────────────────────────────────────────────────────────────────┘  │
│         ▲                                              ▲              │
│         │ SSE: utterance, memory diff,                 │ HTTP fetch    │
│         │      suggestion stream, verdict              │ (artifact)    │
└─────────┼──────────────────────────────────────────────┼──────────────┘
          │                                              │
          ▼                                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       apps/agent (Hono on Bun)                       │
│                                                                      │
│  /demo/start   → loads transcript fixture, starts replay timer       │
│  /stream/:id   → SSE endpoint, pushes pipeline events                │
│  /post-call/:id → returns verdict + Training Delta JSON              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ UNIFIED PER-UTTERANCE PIPELINE                                  │  │
│  │                                                                 │  │
│  │ Customer utterance arrives                                      │  │
│  │   ↓                                                             │  │
│  │ Append to transcript, broadcast to UI                           │  │
│  │   ↓                                                             │  │
│  │ Speaker == customer?                                            │  │
│  │   ↓                                                             │  │
│  │ ┌───────────────┐  ┌──────────────────────────────────────┐    │  │
│  │ │ UI: pulse     │  │ Unified Suggestion+Classifier         │    │  │
│  │ │ animation     │  │ (Groq Llama-3.3-70b via Vercel AI SDK)│    │  │
│  │ │ <50ms         │  │ Returns: {category, shouldSuggest,    │    │  │
│  │ │               │  │           suggestion, reasoning,      │    │  │
│  │ │               │  │           groundedInUtteranceIds}     │    │  │
│  │ │               │  │ Uses memory state from PREVIOUS turn  │    │  │
│  │ │               │  └──────────────────────────────────────┘    │  │
│  │ │               │           ↓                                  │  │
│  │ │               │  category arrives ~80ms                      │  │
│  │ │               │           ↓                                  │  │
│  │ │               │  if SMALL_TALK | NONE:                       │  │
│  │ │               │    abort stream, no UI render                │  │
│  │ │               │    feed category to Training Delta only      │  │
│  │ │               │  else:                                       │  │
│  │ │               │    fire extractor in parallel                │  │
│  │ │               │    if shouldSuggest: stream tokens to UI     │  │
│  │ └───────────────┘                                               │  │
│  │                                                                 │  │
│  │ Extractor (Groq Llama-3.1-70b, off critical path)              │  │
│  │   ↓                                                             │  │
│  │ JSON patches → patchQueue (FIFO by utteranceId)                 │  │
│  │   ↓                                                             │  │
│  │ Memory store applies → SSE memory diff to UI                    │  │
│  │   ↓                                                             │  │
│  │ Memory panel animates new items in                              │  │
│  │                                                                 │  │
│  │ Post-call (one-shot, OpenAI GPT-5-mini):                        │  │
│  │   - Verdict generation                                          │  │
│  │   - Training Delta synthesis                                    │  │
│  │   - Draft follow-up email                                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Persistence: bun:sqlite (durability log) + in-memory mirror (live)  │
│  All LLM calls via Vercel AI SDK + Vercel AI Gateway                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Architectural principles

1. **Event-driven on utterance boundaries.** No polling. Transcript replay events drive the pipeline.
2. **Unified suggestion+classifier model** (NOT a separate cheap classifier). Single LLM call per customer utterance returns both classification and conditional suggestion. Self-aborts when no suggestion warranted. Saves a stage from the critical path.
3. **Extractor off the critical path.** Runs in parallel, gated by category (skips on SMALL_TALK / NONE), patches apply async to memory.
4. **Suggestion uses memory state from PREVIOUS utterance.** The customer's current utterance hasn't been "absorbed" yet — the rep is reacting to it in real time. Extractor's patch for the current utterance applies async, surfaces in the panel ~400ms later, available for the next suggestion.
5. **Structured working memory, not prose.** Typed memory grows incrementally via JSON patches with deterministic merge.
6. **Hybrid memory merge.** Typed-key dedup for canonical facts (`budget.amount`, `timeline.target_date`, `decision_makers[]`). Append for free-form `concerns` and `observations`. Revision history preserved on overwrite.
7. **Layered context.** Suggestion model never sees raw transcript. Receives:
   - **Cold:** pre-call brief (cached, same all call)
   - **Warm:** rendered memory view filtered for this agent
   - **Hot:** last 2-3 exchanges + new utterance verbatim
8. **In-memory state mirror.** Sub-microsecond reads. SQLite is the durability log, debounced snapshot writes (every 2s or 5 patches).

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | `apps/web`, `apps/agent` + shared `packages/types` | Zod schemas shared across boundary |
| Web UI | Next.js (App Router) on Bun, shadcn/ui, Tailwind v4 | |
| Agent service | Hono on Bun | ~3x faster than Next.js route handlers for streaming |
| LLM client | **Vercel AI SDK** (`ai` + `@ai-sdk/groq` + `@ai-sdk/openai` + `@ai-sdk/fireworks`) | TypeScript-native, multi-provider, Zod schemas, streaming structured outputs |
| LLM gateway | **Vercel AI Gateway** | Routing + observability + Groq → OpenAI fallback |
| Models — hot path | **Groq Llama-3.3-70b-versatile** (unified suggestion+classifier), **Groq Llama-3.1-70b-versatile** (extractor) | Fast, cheap |
| Models — post-call | **OpenAI GPT-5-mini** (verdict, Training Delta synth, follow-up email) | Quality > speed; one-shot calls |
| STT (Mode 1) | **Whisper v3 turbo on Fireworks**, batch, **offline** | Run once at fixture-build time. No live STT cost during demo. |
| Voice gen | **ElevenLabs** | One-time generation per script, audio committed |
| Streaming | **SSE** via Hono on Bun | One direction (agent → web), simpler than WebSockets |
| DB | **`bun:sqlite`** durability log + in-memory mirror | |
| Schema | **Zod** | Shared types web ↔ agent |
| Hosting | **Vercel** (web) + **Railway** (agent, min-instance=1 during demo period, ~$5/mo) | No cold starts for hiring panel |
| Telemetry | Hand-rolled per-LLM-call logging | Powers cost/latency footer |

**Skipped:** LangChain, LangGraph, LangSmith, mem0, zep, hindsight, Deepgram, OpenAI Realtime API (Mode 2 deferred), Vexa (Mode 3 deferred), separate classifier stage.

### Memory shape

```ts
type MeetingMemory = {
  facts: Fact[];
  concerns: Concern[];
  openLoops: OpenLoop[];
  qualSignals: QualSignal[];
  decisionGeography: DecisionActor[];   // for Training Delta
  silenceTopics: SilenceTopic[];        // for Training Delta — populated post-call
  narrative: string;                    // optional connective prose, debounced rebuild
};

type Fact = {
  id: string;
  key: string;                  // canonical key for dedup, e.g. "budget.amount"
  category: 'budget' | 'timeline' | 'tech_stack' | 'team' | 'process' | 'competitor' | 'other';
  content: string;
  utteranceIds: string[];       // provenance
  confidence: number;
  extractedAt: number;
  revisions: Array<{            // overwrite history
    previousContent: string;
    overwrittenAt: number;
    utteranceIds: string[];
  }>;
};

type Concern = {
  id: string;
  topic: string;
  verbatim: string;             // verbatim quote — Training Delta uses this
  severity: 'mentioned' | 'pressed' | 'blocking';
  addressed: boolean;
  utteranceIds: string[];
};

type OpenLoop = {
  id: string;
  description: string;
  owner: 'rep' | 'customer';
  status: 'open' | 'addressed';
};

type QualSignal = {
  id: string;
  direction: 'positive' | 'negative';
  meddic: 'metrics' | 'economic_buyer' | 'decision_criteria' | 'decision_process' | 'identify_pain' | 'champion' | 'budget';
  bantBucket: 'budget' | 'authority' | 'need' | 'timeline';  // derived for UI color
  content: string;
  utteranceIds: string[];
};

type DecisionActor = {
  name: string;
  role: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  utteranceIds: string[];
};

type SilenceTopic = {
  topic: string;
  emphasizedByAva: boolean;     // came from pre-call brief
  customerMentioned: boolean;
};
```

### Unified model — output schema

```ts
import { z } from 'zod';

export const SuggestionSchema = z.object({
  category: z.enum([
    'QUESTION', 'OBJECTION', 'POSITIVE_QUAL_SIGNAL',
    'NEGATIVE_QUAL_SIGNAL', 'SMALL_TALK', 'NONE',
  ]),
  shouldSuggest: z.boolean(),
  suggestion: z.string().nullable(),  // null when shouldSuggest is false
  reasoning: z.string(),
  groundedInUtteranceIds: z.array(z.string()),
});
```

Streamed via Vercel AI SDK's `streamObject`. `category` arrives first (~80ms), then `shouldSuggest` (~30ms after). UI aborts the stream on `shouldSuggest === false`. Net per-utterance cost: ~$0.0006.

### Per-utterance loop

```
1. Replay timer fires (or, in v0.2 Mode 2, Realtime utterance arrives)
2. Append utterance to in-memory transcript; persist (debounced) to SQLite
3. Broadcast utterance event to UI over SSE
4. If speaker == customer:
     a. UI: render "Atlas is listening" pulse within 50ms
     b. Fire unified suggestion+classifier (Groq Llama-3.3-70b, streaming structured output)
     c. As tokens stream:
          - On `category` arrival: if SMALL_TALK | NONE → abort stream, fade pulse
          - Else: in parallel, fire Extractor (Groq Llama-3.1-70b) — off critical path
          - On `shouldSuggest === true`: stream `suggestion` tokens to UI (replaces pulse)
     d. Extractor patches → patchQueue → memory store → SSE memory diff → UI animates
5. On call end: fire Verdict + Training Delta + Email (OpenAI GPT-5-mini, one-shot each)
```

### Latency budget (target)

| Step | Target | Notes |
|---|---|---|
| Transcript replay event → "Atlas is listening" pulse | ≤50ms | UI render only |
| Replay event → suggestion text starts streaming | ≤400ms p50 | Groq + structured output preamble |
| Replay event → memory panel update (extractor) | ≤500ms p50 | Off critical path; also feeds next suggestion |
| Cost per 30-min call | ~$0.07 | Groq hot path + GPT-5-mini post-call |
| Daily spend ceiling | $20 | Hard cap with "demo capacity reached" fallback |

### Cost protection

- Per-IP daily session cap: 5 / day
- Per-session hard cap: 15 minutes (in v1 Mode 1, calls are <10min so this is overflow protection)
- Global daily spend ceiling: $20/day
- Behavior on hit: UI shows "Demo capacity reached, try again tomorrow"

---

## Build invariants (enforce as code conventions)

1. **One agent = one file = one Zod schema = one prompt template.** Files: `agents/unified.ts`, `agents/extractor.ts`, `agents/verdict.ts`, `agents/trainingDelta.ts`, `agents/email.ts`. Same shape, same exports.
2. **Memory store has a single `applyPatch(patch)` method.** All mutations go through it. No direct field writes anywhere else.
3. **SSE events are a discriminated union.** `type SSEEvent = UtteranceEvent | MemoryDiffEvent | SuggestionTokenEvent | VerdictEvent | ErrorEvent`. Web client switches on `type` field, type-safe end-to-end.
4. **No catch-all error handlers.** Specific paths for: STT/transcript parse error, LLM JSON parse failure (retry once with error in prompt), patch validation failure (log + skip patch).
5. **All LLM calls go through one wrapper.** Tracks cost, applies cache, enforces timeouts, logs latency. ~60 lines, one place to change.
6. **Speaker label adapter.** Per-mode adapter normalizes to canonical `Utterance` shape. Pipeline is mode-agnostic. (v0.2 modes plug in here.)

---

## Design system

### Color palette (Artisan-inspired — approximate, refine with their tokens)

CSS variables on `:root`. Easy to swap once you eyedropper their actual values.

```css
:root {
  /* Backgrounds */
  --bg-base: #F5F0E8;        /* warm cream — primary background */
  --bg-elevated: #FFFFFF;     /* cards, panels */
  --bg-muted: #E8DFD2;        /* sidebar, secondary surfaces */

  /* Text */
  --fg-primary: #1A1A1A;      /* near-black */
  --fg-secondary: #4A4A4A;    /* body text */
  --fg-muted: #8A8A8A;        /* timestamps, helper text */

  /* Brand accent (Artisan-recognizable purple/violet) */
  --accent: #5B3FBE;
  --accent-hover: #4A32A0;
  --accent-glow: #E8E0FA;     /* soft purple background for highlights */

  /* Qualification dimension colors (BANT, used for memory items) */
  --qual-budget: #10B981;     /* green */
  --qual-authority: #3B82F6;  /* blue */
  --qual-need: #F59E0B;       /* amber */
  --qual-timeline: #8B5CF6;   /* purple */

  /* Signal direction */
  --signal-positive: #10B981;
  --signal-negative: #EF4444;

  /* States */
  --warning: #F59E0B;
  --error: #EF4444;
  --success: #10B981;

  /* Subtle */
  --border: #E5DFD0;
  --shadow: 0 1px 3px rgba(26, 26, 26, 0.04), 0 1px 2px rgba(26, 26, 26, 0.06);
}
```

### Typography
- Sans-serif primary: **Inter** or **Söhne** (system fallback to `-apple-system, BlinkMacSystemFont, sans-serif`)
- Monospace (transcript timestamps, code in Training Delta artifact): **JetBrains Mono**

### Motion
- Memory items animate in: 240ms ease-out, `transform: translateY(8px) → 0` + `opacity: 0 → 1` (GPU-accelerated)
- "Atlas is listening" pulse: 1.6s loop, `opacity: 0.6 → 1.0 → 0.6` + subtle radial glow
- Suggestion text: token streaming via incremental rendering, no separate animation
- All animations respect `prefers-reduced-motion`

### Visual hierarchy
- **Memory panel is the visual anchor.** Right rail, ~360px wide, sticky.
- **Transcript** in center column, scrollable, `useDeferredValue` so panel updates don't block reading.
- **Whisper bar** fixed at bottom, max ~80px tall, mostly empty whitespace until it has something to say.
- **Pre-call brief** collapsed-by-default header strip, expands on click.

---

## Test plan (Mode 1 only — see TEST-PLAN.md)

Coverage targets aligned to demo scope:

- **Unit:** memory store merge logic (typed-key dedup + revision history), patchQueue FIFO ordering, agent prompts on fixture utterances
- **Golden replay:** each scripted call → identical Training Delta on rerun (this is THE test — submission email screenshot must match what reviewers see)
- **Smoke E2E:** open demo URL → click play on Maya → wait 30s → memory panel has ≥3 facts visible

Skipped (out of scope for take-home):
- Mode 2 / Mode 3 integration tests
- Component visual regression
- Load / chaos tests (cost ceiling provides containment)

---

## Out of scope (v1)

| Cut | Substitute / rationale |
|---|---|
| Mode 2 (interactive voice AI customer) | v0.2 follow-up email |
| Mode 3 (Vexa real meetings) | v0.2 follow-up email |
| Engagement-timing inflections in Training Delta | Detection unreliable. v0.2+ when we have signal data. |
| Real CRM integration | Mocked: "would update Salesforce: stage=Demo, ICP fit=High" |
| Real product knowledge base | 2-3 hardcoded battlecard snippets in pre-call brief |
| Real auth / multi-tenancy | Single-user demo |
| Mobile / responsive | Desktop only |
| Mid-call ad-hoc retrieval | Front-loaded into pre-call brief |
| Voice matching for follow-up email | Generic, well-prompted |
| "Similar accounts" pre-call insight | Marginal value, eats hours |
| Multi-action "complete this" buttons | One real action: draft email opens Gmail compose |
| Last-Event-ID SSE resume | Snapshot + stream-forward sufficient at demo scale |
| Speculative suggestion drafting on STT interim | Stretch, only if Block 6 ships fast |
| Component visual regression | Out of scope for take-home |
| Mem0 / Zep / Graphiti | Wrong shape for in-call memory. v0.3 cross-call training data layer. |

---

## Build sequence

| Block | Output | Time | Cumulative |
|---|---|---|---|
| 0 | Generate scripts (text), record audio (ElevenLabs), pre-transcribe (Whisper v3 turbo on Fireworks). Commit `fixtures/{script}-{audio.mp3, transcript.json, brief.json}`. | 2-3h | 3h |
| 1 | Pipeline skeleton — replay timer fires transcript events, SSE wired up, in-memory mirror + bun:sqlite | 3-4h | 7h |
| 2 | Unified suggestion+classifier (Groq), Extractor (Groq), Memory store with hybrid merge, patchQueue | 3-4h | 11h |
| 3 | Web UI: live memory panel + whisper bar + transcript view + "Atlas is listening" pulse | 3-4h | 15h |
| 4 | Post-call view: verdict + Training Delta + draft follow-up email + cost/latency footer | 2-3h | 18h |
| 5 | Deploy: Vercel (web) + Railway (agent, min-instance=1) + Vercel AI Gateway + cost ceilings | 2-3h | 21h |
| **🚩 v1 submittable.** | | | |
| Future v0.2 | Mode 2: OpenAI Realtime API + persona prompts + VAD-triggered parallel pipeline | 4-6h | |
| Future v0.2 | Mode 3: Vexa self-hosted + adapter | 3-5h | |

---

## Submission

Deployed URL points at the demo. Email to hiring team:

- One paragraph: strategic frame ("Atlas is the bridge product that accelerates Ava's training data — every human-led call generates signals Ava can't currently see")
- One sentence: how to try it ("click play on any of the three scripts")
- One screenshot: the Training Delta side-by-side ("what Ava sees" vs. "what Atlas adds")

No README ceremony. The deployed product is the artifact.

---

## Resolved engineering decisions log

| # | Decision | Resolution |
|---|---|---|
| 1 | Memory patch merge | Hybrid: typed-key dedup + free-form append + revision history |
| 2 | Race conditions on parallel agents | Per-meeting FIFO patchQueue, single-threaded drain |
| 3 | SSE replay on reconnect | Snapshot + stream-forward |
| 4 | Cost ceilings | $20/day global + 5 sessions/IP/day + 15-min/session cap |
| 5 | Demo determinism | Pre-recorded audio + pre-generated transcript = inherently deterministic |
| 6 | OpenAI Realtime failure modes | N/A in v1 (Mode 2 deferred) |
| 7 | JSON parse failures | Vercel AI SDK structured outputs (Zod) + retry-once on parse error + skip-patch fallback |
| 8 | Engagement inflections | Cut from v1 (unreliable detection); the 5 other Training Delta signals carry the artifact |
| 9 | Vexa deployment | N/A in v1 (Mode 3 deferred) |
| 10 | Speaker label unification | Adapter layer (only one adapter needed in v1: scripted-replay) |
| 11 | Latency target | ~400ms p50 critical path, ~200ms perceived (pulse) — via Groq + unified model + parallel extractor |
| 12 | LLM client | Vercel AI SDK + Vercel AI Gateway (Groq primary, OpenAI fallback) |
| 13 | LangChain / LangGraph | Skipped — wrong abstraction for fixed DAG |
| 14 | Mem0 / Zep | Skipped for in-call memory; flagged as v0.3 cross-call layer |
| 15 | Classifier as separate stage | Removed — unified suggestion model self-classifies |
| 16 | Qualification framework | MEDDIC schema internally, BANT-style colors in UI |
| 17 | Mode 1 audio playback | HTML5 `<audio>` + `timeupdate` event triggers |
| 18 | Pre-call brief | Pre-baked JSON fixture, fed to suggestion LLM as cold context |
| 19 | Color palette | Artisan-inspired warm cream + sophisticated dark accents (CSS variables, easy to refine) |
| 20 | Domain | Defer — `atlas.vercel.app` or similar for now |
