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
│   │   ├── lib/            agent.ts (sidecar HTTP client), cn.ts, types.ts
│   │   └── styles/         globals.css
│   └── src-tauri/
│       ├── src/
│       │   ├── atlas_bridge.rs   ← spawns sidecar + forwards transcripts
│       │   ├── lib.rs            (registers atlas_bridge)
│       │   └── ...               (Meetily's audio + Whisper + Parakeet pipeline)
│       ├── tauri.conf.json (atlas-agent declared in externalBin + shell:allow-execute)
│       ├── binaries/       ← atlas-agent-<target-triple> binaries (gitignored)
│       └── ...
└── scripts/
    └── build-sidecar.sh    cross-compile apps/agent into Tauri sidecar binaries
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

### Step 3 — Tauri Rust integration (Cargo deps + atlas_bridge module + setup hooks)
- Added `tauri-plugin-shell = "2.2.0"` to Cargo.toml (used to spawn the sidecar)
- New module `src-tauri/src/atlas_bridge.rs`:
  - `AtlasState` (active_call_id + sidecar_handle in mutexes)
  - `spawn_sidecar(app)` — spawns the bundled `atlas-agent` binary with `ATLAS_DATA_DIR` set to `app_data_dir()/atlas-agent` and `PORT=3001`. Forwards stdout/stderr to logs.
  - `install_event_forwarder(app)` — listens for `transcript-update` events, drops partials, maps `source` → `participantId` + speaker, and POSTs to `/calls/{callId}/utterance`.
  - Tauri commands: `set_active_atlas_call`, `clear_active_atlas_call`, `atlas_sidecar_base_url`
- `lib.rs` registers `atlas_bridge` module, `tauri_plugin_shell::init()`, `AtlasState`, the three commands, calls `spawn_sidecar` + `install_event_forwarder` in `setup()`
- `tauri.conf.json` updates:
  - `bundle.externalBin` includes `binaries/atlas-agent`
  - Capability now allows `shell:allow-execute` on the atlas-agent sidecar
  - CSP `connect-src` includes `http://127.0.0.1:3001`

## Source → speaker mapping (current heuristic)

`atlas_bridge.rs::participant_for_source()` maps Meetily's audio source label:
- `"Microphone"` (case-insensitive substring) → `participantId="microphone"`, `speaker="founder"`
- everything else (system audio) → `participantId="system_audio"`, `speaker="customer"`

The user can override mid-call via `PATCH /calls/:callId/participants/:participantId` from the UI; the sidecar's `SpeakerMap` updates and subsequent utterances are tagged accordingly.

## How a call flows end-to-end

```
1. User: clicks "New call" → /call/new (frontend)
2. Frontend: POST http://127.0.0.1:3001/calls → { callId }
3. Frontend: invoke('set_active_atlas_call', { callId })
4. Frontend: navigate to /call/[id], opens SSE to /calls/:id/stream
5. User: starts Meetily's recording (existing Meetily commands)
6. Meetily Rust: emits transcript-update events as Whisper/Parakeet finalize chunks
7. atlas_bridge: filters partials, POSTs to /calls/:id/utterance
8. Atlas sidecar: pipeline → SSE → frontend renders memory + suggestions
9. User: "End call" → POST /calls/:id/end → Tauri's clear_active_atlas_call → /coaching view
```

## How to build the Atlas sidecar binaries

```bash
bun run build:sidecar
```

Drops `atlas-agent-<target-triple>` binaries into `apps/desktop/frontend/src-tauri/binaries/`. Tauri's externalBin loader picks them up at build time based on the host's target triple.

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

All endpoints bind to `127.0.0.1` — no auth needed because the sidecar is only reachable from inside the Tauri app process tree.
