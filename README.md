<p align="center">
  <img src="apps/web/public/atlas-banner.png" alt="Atlas: win more calls" width="100%" />
</p>

# Atlas

**A live coach for sales calls.** Atlas listens to a discovery call as it happens and, in real time, suggests what the rep should say next, tracks what has actually been learned about the deal, and flags what is still missing.

> 🎯 **Try it:** open the demo, click **Join now** on the Meet-style screen, and talk to an AI prospect (a skeptical startup CTO) with Atlas coaching you on the side. You need a microphone and a desktop browser. Calls are capped at 5 minutes.
>
> **Live demo:** _add your deployed URL here_

## What you'll see in a call

| Area | What it does |
|---|---|
| **Voice prospect** | An AI persona (OpenAI Realtime, over WebRTC) with its own agenda, backstory and mood that shifts with how good your questions are. |
| **Coach chat** | Shows suggestions as the conversation unfolds, grounded in what the prospect actually said. You can also ask it questions. |
| **Live deal memory** | A structured side panel (BANT / MEDDIC style) that fills in as facts, concerns and commitments surface, each traced back to the exact utterance. |
| **Post-call rating** | A short feedback step when you hang up. |

## How it works

One Next.js app, deployed as a single Vercel project. No separate backend, no database.

```
Browser ──WebRTC audio──► OpenAI Realtime (the prospect's voice)
   │  ▲
   │  └── 60s client secret ◄── POST /api/realtime/session
   │
   ├── each finalized utterance + a snapshot of the call's memory
   │        ──► POST /api/coach/turn ──► suggester ∥ memory extractor ──► panel agent
   │◄── streamed patches (suggestion, memory.patch, panel.patch) ───────────┘
   └── coach chat ──► POST /api/chat
```

- **The server is stateless.** The browser owns the call's memory (the same `MemoryStore` code runs on both sides). Each turn it sends a snapshot; the server streams back patches and the browser applies them. Nothing is stored server-side, which is what lets this run on Vercel Functions.
- **Audio never touches the backend.** The browser talks to OpenAI directly with a short-lived client secret, and the coach only reacts after the prospect's audio has finished playing.
- **Every memory fact keeps an anchor** back to the transcript line it came from.

Code map: `src/app` (pages and API routes), `src/server` (LLM agents and prompts), `src/lib/memory` (memory store, shared by browser and server), `src/lib/coach` (client hook and wire protocol), `packages/types` (shared Zod schemas), `fixtures/` (pre-call briefs and sample transcripts).

### Models

| Job | Model | Via |
|---|---|---|
| Prospect voice | `gpt-realtime-2.1` | OpenAI Realtime |
| Mic transcription | `gpt-live-transcribe` | OpenAI Realtime |
| Live suggestions | `gpt-6-luna` (reasoning off) | Vercel AI Gateway |
| Memory extractor and panel | `gpt-6-luna` (reasoning off) | Vercel AI Gateway |
| Chat coach | `gpt-oss-120b` | Vercel AI Gateway |

All overridable with env vars; see `apps/web/.env.example`.

## Run it locally

Requires [Bun](https://bun.sh) 1.x, plus two API keys: OpenAI and the Vercel AI Gateway.

```bash
bun install
cp apps/web/.env.example apps/web/.env.local   # fill in the two keys
bun run dev                                    # http://localhost:3000
```

Other scripts: `bun run typecheck`, `bun run test`, `bun run build`.

## Deploying (Vercel)

1. Import the repo in Vercel and set the **Root Directory** to `apps/web`.
2. Add the env vars from `apps/web/.env.example` (`OPENAI_API_KEY`, `VERCEL_AI_GATEWAY_TOKEN`).
3. Add the **Upstash Redis** integration from the Vercel Marketplace so the daily caps persist.

### Cost protection

The voice demo bills real money per call, so every API route enforces:

- a same-origin check
- per-IP and global daily caps (`REALTIME_IP_DAILY_CAP` default 5 sessions, `REALTIME_DAILY_SESSION_CAP` default 150, plus separate caps for coach turns and chat)
- a 5-minute maximum call length, enforced client-side

Also set a hard monthly spend limit on the OpenAI key and a budget on the AI Gateway.

## Project docs

[`PRD.md`](PRD.md) (product spec) · [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md) · [`TEST-PLAN.md`](TEST-PLAN.md)
