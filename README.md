<p align="center">
  <img src="apps/web/public/atlas-banner.png" alt="Atlas: win more calls" width="100%" />
</p>

# Atlas

**A live coach for sales calls.** Atlas listens to a discovery call as it happens and, in real time, suggests what the rep should say next, tracks what has actually been learned about the deal, and flags what is still missing.

> 🎯 **Try it:** open the demo, click **Join Zoom** on the highlighted calendar event, and talk to an AI prospect (a skeptical startup CTO) with Atlas coaching you on the side. You need a microphone and a desktop browser. Calls are capped at 5 minutes.
>
> **Live demo:** _add your deployed URL here_

## What you'll see in a call

| Area | What it does |
|---|---|
| **Voice prospect** | An AI persona (OpenAI Realtime, over WebRTC) with its own agenda, backstory and mood that shifts with how good your questions are. |
| **Coach chat** | Streams suggestions as the conversation unfolds, grounded in what the prospect actually said. |
| **Live deal memory** | A structured side panel (BANT / MEDDIC style) that fills in as facts, concerns and commitments surface, each traced back to the exact utterance. |
| **Post-call rating** | A short feedback step when you hang up. |

There is also a no-microphone mode: [`/scripted`](apps/web/src/app/scripted/page.tsx) replays pre-recorded calls through the same pipeline so you can watch Atlas work without talking.

## How it works

```
Browser ──WebRTC audio──► OpenAI Realtime (the prospect's voice)
   │  ▲
   │  └── short-lived client secret ◄── POST /realtime/session ──┐
   │                                                              │
   ├── transcript events ──WebSocket──► Atlas agent (Bun + Hono) ─┤
   │                                      │  trigger detector     │
   │◄── suggestions (stream) ─────────────┤  suggester agents     │
   │◄── memory diffs (SSE) ───────────────┘  memory + facts UI    │
                                           SQLite (calls, usage)  ┘
```

- **`apps/web`**: Next.js 14 (App Router), Tailwind, Vercel AI SDK hooks, PostHog analytics.
- **`apps/agent`**: Bun + Hono API with a WebSocket coach channel and SSE stream. Runs the coaching pipeline (trigger detection → suggestion → memory extraction → UI facts) through the Vercel AI Gateway.
- **`packages/types`**: shared Zod schemas and TypeScript types, so the wire format is checked on both sides.
- **`fixtures/`**: scripted calls and pre-call briefs used by the replay mode and tests.

Design notes worth skimming: audio never touches the backend (the browser talks to OpenAI directly with a 60-second client secret), the coach only fires after the prospect's audio has finished playing, and every memory fact keeps an anchor back to the transcript.

## Run it locally

Requires [Bun](https://bun.sh) 1.x, an OpenAI API key, and a Vercel AI Gateway token.

```bash
bun install

cp apps/agent/.env.example apps/agent/.env   # add OPENAI_API_KEY and VERCEL_AI_GATEWAY_TOKEN
cp apps/web/.env.example apps/web/.env.local # add NEXT_PUBLIC_POSTHOG_TOKEN (optional)

bun run dev          # web on :3000, agent on :3001
```

Open <http://localhost:3000>.

Other scripts: `bun run typecheck`, `bun run test`, `bun run smoke`.

## Deploying

| Service | Where | Required env |
|---|---|---|
| Web | Vercel (root dir `apps/web`) | `NEXT_PUBLIC_AGENT_URL` (the build **fails** if it's missing), `NEXT_PUBLIC_POSTHOG_TOKEN` |
| Agent | Railway (`railway.toml`) | `OPENAI_API_KEY`, `VERCEL_AI_GATEWAY_TOKEN`, `WEB_ORIGIN` (the agent **refuses to start** in production without it) |

### Cost protection

The voice demo bills real money per call, so the agent enforces:

- an `Origin` allow-list (`WEB_ORIGIN`, comma-separated) on `/realtime/session`
- a per-IP daily cap (`REALTIME_IP_DAILY_CAP`, default 5) and a global daily cap (`REALTIME_DAILY_SESSION_CAP`, default 150)
- a 5-minute maximum call length, enforced client-side
- the scripted-replay endpoint has its own per-IP and daily-spend limits

Also set a hard monthly spend limit on the OpenAI key itself.

## Project docs

[`PRD.md`](PRD.md) (product spec) · [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md) · [`TEST-PLAN.md`](TEST-PLAN.md)
