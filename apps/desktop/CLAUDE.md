# Atlas Desktop (Tauri)

Forked from [Meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) on 2026-05-06. The fork is a flat one-time import — no submodule, no upstream tracking. Free to edit anything.

## Layout

```
apps/desktop/
├── CLAUDE.md               (this file)
├── frontend/
│   ├── package.json        (@atlas/desktop)
│   ├── src/                ← Meetily's Next.js UI — TO BE REPLACED with Atlas UI (Step 2)
│   └── src-tauri/          ← Tauri Rust core (Meetily's audio + Whisper pipeline)
│       ├── src/
│       ├── tauri.conf.json (rebranded: productName=Atlas, identifier=com.atlas.desktop)
│       ├── binaries/       ← Built atlas-agent sidecar binaries land here (gitignored)
│       └── ...
└── scripts/
    └── build-sidecar.sh    ← cross-compile apps/agent into Tauri sidecar binaries
```

## What's done

- Meetily upstream cloned and copied verbatim under `frontend/`
- Removed Windows-specific binary `vs_buildtools.exe` (4.4 MB)
- Rebranded: `productName: "Atlas"`, `identifier: "com.atlas.desktop"`, `title: "Atlas"`
- `package.json` renamed to `@atlas/desktop`
- Workspace registered in root `package.json` (`apps/desktop/frontend`)
- `scripts/build-sidecar.sh` cross-compiles the Atlas Bun agent into platform-suffixed sidecar binaries

## What's NOT done (planned in /Users/zacmasters/.claude/plans/1-atlas-2-ok-mighty-sky.md)

### Step 2 — Replace Meetily UI with Atlas UI
- Delete `frontend/src/app/*` (Meetily pages) and `frontend/src/components/*` (Meetily components)
- Copy in from `apps/web/src/`:
  - `components/MemoryPanel.tsx`, `SuggestionBar.tsx`, `TranscriptView.tsx`, `PreCallBrief.tsx`, `voice/*`
  - `lib/cn.ts`, `lib/sse.ts`, `lib/types.ts`
- New pages:
  - `frontend/src/app/page.tsx` — landing / call list
  - `frontend/src/app/call/new/page.tsx` — pre-call setup
  - `frontend/src/app/call/[id]/page.tsx` — live coaching
  - `frontend/src/app/call/[id]/coaching/page.tsx` — post-call artifact
- New `frontend/src/lib/agent.ts` — wraps fetch against `http://127.0.0.1:3001` (the Atlas Bun sidecar)
- Rename `voice/TrainingDeltaPanel` → `voice/CoachingArtifactPanel`; strip Ava/Artisan copy
- Delete unused Meetily-only components (model selection, transcription server config UI)

### Step 3 — Wire Tauri Rust core to sidecar + forward audio
- In `frontend/src-tauri/tauri.conf.json` add:
  ```json
  "tauri": {
    "bundle": { "externalBin": ["binaries/atlas-agent"] },
    "allowlist": {
      "shell": { "scope": [{ "name": "binaries/atlas-agent", "sidecar": true, "args": [] }] }
    }
  }
  ```
- In `frontend/src-tauri/src/main.rs` (or wherever Tauri's setup lives), spawn the sidecar via `tauri::api::process::Command::new_sidecar("atlas-agent")` and capture stderr.
- Set `ATLAS_DATA_DIR` env var on the sidecar to Tauri's `app_data_dir()` so SQLite lands in the OS-standard location.
- After each finalized utterance from Meetily's audio + Whisper pipeline, POST to `http://127.0.0.1:3001/calls/{callId}/utterance` with `{ participantId, text, startMs, endMs, confidence }`. The Atlas pipeline runs unchanged from there.
- On call end, POST to `http://127.0.0.1:3001/calls/{callId}/end`.
- On app shutdown, kill the sidecar gracefully.

### Step 8 — Distribution
- `frontend/src-tauri/tauri.conf.json` `bundle.macOS.signingIdentity` for Apple notarization
- Windows code-signing certificate in `bundle.windows.certificateThumbprint`
- `.github/workflows/release.yml` to cross-build + sign + upload to GitHub Releases

## How to build the Atlas sidecar binaries

```bash
bun run build:sidecar
```

Drops `atlas-agent-<target-triple>` binaries into `apps/desktop/frontend/src-tauri/binaries/`. Tauri's `externalBin` config picks them up automatically based on the build host's target triple.

## Reference: Atlas agent endpoints the desktop app calls

```
POST   /calls                            { brief, meetingUrl? } → { callId }
POST   /calls/:callId/utterance          { participantId, text, startMs, endMs, ... }
PATCH  /calls/:callId/participants/:pid  { role, displayName? }
POST   /calls/:callId/end                {} → broadcasts call_end SSE
GET    /calls                            → list of recent calls
GET    /calls/:callId                    → full call detail + coaching artifact
GET    /calls/:callId/stream             → SSE stream of pipeline events
```

All endpoints bind to `127.0.0.1` — no auth needed because the sidecar is only reachable from inside the Tauri app process tree.
