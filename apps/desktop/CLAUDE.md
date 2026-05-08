# Atlas Desktop (Tauri)

Forked from [Meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) on 2026-05-06. The fork is a flat one-time import — no submodule, no upstream tracking. Free to edit anything.

## Layout

```
apps/desktop/
├── CLAUDE.md
├── frontend/
│   ├── package.json        @atlas/desktop, depends on @atlas/types workspace
│   ├── src/
│   │   ├── app/            Atlas pages (page, call/new, call/[id], call/[id]/coaching)
│   │   ├── components/     MemoryPanel, SuggestionBar, TranscriptView, PreCallBrief
│   │   ├── lib/            agent.ts (remote agent HTTP client), cn.ts, types.ts
│   │   └── styles/         globals.css
│   └── src-tauri/
│       ├── src/
│       │   ├── atlas_bridge.rs   ← forwards transcripts to remote Atlas agent
│       │   ├── lib.rs            (registers atlas_bridge)
│       │   └── ...               (Meetily's audio + Whisper + Parakeet pipeline)
│       ├── tauri.conf.json (no sidecar; CSP allows Railway + Supabase)
│       └── ...
```

## What's done

### Step 1 — Fork foundation (commit 8d3978a)
- Meetily upstream copied verbatim under `frontend/`
- Removed Windows-only `vs_buildtools.exe`
- Rebranded: `productName="Atlas"`, `identifier="com.atlas.desktop"`, `title="Atlas"`
- `package.json` renamed to `@atlas/desktop`
- Workspace registered in root `package.json`

### Step 2 — UI ported
- Stripped Meetily's `frontend/src/{app,components,contexts,services,hooks,types,config,constants}` and `frontend/src/lib/*` (except not retained — replaced wholesale)
- Copied Atlas web components: `MemoryPanel`, `SuggestionBar`, `TranscriptView`, `PreCallBrief`
- Created `frontend/src/lib/agent.ts` — typed HTTP/SSE client wrapping `http://127.0.0.1:3001`
- New pages:
  - `app/page.tsx` — call list / landing
  - `app/call/new/page.tsx` — pre-call brief form
  - `app/call/[id]/page.tsx` — live coaching view with SSE subscription
  - `app/call/[id]/coaching/page.tsx` — post-call artifact view
- `tailwind.config.ts` mirrors web's; `styles/globals.css` ports the warm-paper palette
- Added `@atlas/types` as a workspace dependency
- Added `typecheck` script; `tsc --noEmit` is clean

### Step 3 — Tauri Rust integration (atlas_bridge module + remote agent)
- Module `src-tauri/src/atlas_bridge.rs`:
  - `AtlasState` (active_call_id + auth_token in mutexes)
  - `agent_base_url()` reads `ATLAS_AGENT_URL` env var at runtime (baked at build time), falls back to `https://atlas-agent.up.railway.app`
  - `install_event_forwarder(app)` — listens for `transcript-update` events, drops partials, maps `source` → `participantId` + speaker, and POSTs to `${agent_base_url}/calls/{callId}/utterance` with the user's JWT in the `Authorization: Bearer <token>` header. If no token is set, logs a warning and skips.
  - Tauri commands: `set_active_atlas_call`, `clear_active_atlas_call`, `atlas_agent_base_url`, `set_atlas_auth_token`, `clear_atlas_auth_token`
- `lib.rs` registers `atlas_bridge` module, `AtlasState`, the five commands, and calls `install_event_forwarder` in `setup()`. No more `tauri-plugin-shell` and no sidecar spawn.
- `tauri.conf.json`:
  - No more `binaries/atlas-agent` in `externalBin`
  - No more `shell:allow-execute` capability
  - CSP `connect-src` includes `http://127.0.0.1:3001` (dev), `https://atlas-agent.up.railway.app` (prod), and `https://*.supabase.co` (auth)

## Source → speaker mapping (current heuristic)

`atlas_bridge.rs::participant_for_source()` maps Meetily's audio source label:
- `"Microphone"` (case-insensitive substring) → `participantId="microphone"`, `speaker="founder"`
- everything else (system audio) → `participantId="system_audio"`, `speaker="customer"`

The user can override mid-call via `PATCH /calls/:callId/participants/:participantId` from the UI; the sidecar's `SpeakerMap` updates and subsequent utterances are tagged accordingly.

## How a call flows end-to-end

```
1. User: signs into Supabase in the desktop app → frontend invokes
   set_atlas_auth_token with the JWT
2. User: clicks "New call" → /call/new (frontend)
3. Frontend: POST ${ATLAS_AGENT_URL}/calls (Authorization: Bearer <jwt>) → { callId }
4. Frontend: invoke('set_active_atlas_call', { callId })
5. Frontend: navigate to /call/[id], opens SSE to /calls/:id/stream
6. User: starts Meetily's recording (existing Meetily commands)
7. Meetily Rust: emits transcript-update events as Whisper/Parakeet finalize chunks
8. atlas_bridge: filters partials, POSTs to ${ATLAS_AGENT_URL}/calls/:id/utterance
   with Authorization: Bearer <jwt>
9. Atlas agent (Railway): pipeline → SSE → frontend renders memory + suggestions
10. User: "End call" → POST /calls/:id/end → Tauri's clear_active_atlas_call → /coaching view
```

## Configuring the agent URL

`ATLAS_AGENT_URL` (Rust) and `NEXT_PUBLIC_AGENT_URL` (frontend) point at the
remote agent. In CI both are set from the `ATLAS_AGENT_URL` repo secret and
baked into the desktop build via `tauri-action`. For local dev, set them in
your shell or a `.env.local` to e.g. `http://127.0.0.1:3001` and run
`bun run dev:agent` alongside `bun run dev:desktop`.

## Failure modes

- **No auth token set** — `install_event_forwarder` logs a warning and drops
  the utterance. The user needs to log in first.
- **Agent unreachable / 5xx** — logged + emitted as `atlas-bridge-error`
  Tauri event for the frontend to surface. No retry queue yet.
- **JWT expired mid-call** — agent returns 401; surfaced via `atlas-bridge-error`.
  Frontend (Lane C) should refresh the token and re-call `set_atlas_auth_token`.

## What's still TODO

### Recording lifecycle hookup
The current Meetily UI starts/stops recording via its own commands (`start_recording`, `stop_recording`). The Atlas frontend's `/call/[id]` page does NOT yet invoke them — it just opens an SSE stream and waits. To make audio actually flow, one of:
- Have `/call/[id]` invoke `start_recording` after `set_active_atlas_call`, and `stop_recording` before `clear_active_atlas_call`. Easiest path.
- Replace Meetily's recording commands with a thin wrapper that does both at once.

### Post-call agent chain
`POST /calls/:id/end` currently broadcasts `call_end` and finalizes the DB row. The verdict / coaching artifact / follow-up email agents from the demo flow are not yet wired. Hook them up in `apps/agent/src/routes/ingest.ts::ingestRoutes.post('/:callId/end', ...)` — see the existing `apps/agent/src/routes/demo.ts onEnd` handler for the pattern.

### Code signing + notarization
- macOS: replace `signingIdentity: "-"` (ad-hoc) with a real Developer ID. Add notarization step.
- Windows: `scripts/sign-windows.ps1` already referenced; needs a code-signing cert to be useful.

### Auto-updater public key
`tauri.conf.json` updater plugin still has Meetily's pubkey. Run `cargo tauri signer generate` to create Atlas's keypair before first release.

### Permissions onboarding
Meetily already prompts for screen recording + mic; verify the flow still works post-rebrand. Surface the prompt in `/call/new` if not granted.

## Reference: Atlas agent endpoints

```
POST   /calls                            { brief, meetingUrl? } → { callId }
POST   /calls/:callId/utterance          { participantId, text, startMs, endMs, speaker?, ... }
PATCH  /calls/:callId/participants/:pid  { role, displayName? }
POST   /calls/:callId/end                {} → broadcasts call_end SSE
GET    /calls                            → list of recent calls
GET    /calls/:callId                    → full call detail + coaching artifact
GET    /calls/:callId/stream             → SSE stream of pipeline events
```

All endpoints now require `Authorization: Bearer <supabase-jwt>` since the agent is deployed remotely on Railway. The Tauri Rust core attaches the header on every utterance POST using the token cached via `set_atlas_auth_token`.
