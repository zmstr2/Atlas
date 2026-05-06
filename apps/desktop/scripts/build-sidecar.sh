#!/usr/bin/env bash
# Cross-compile the Atlas Bun agent into platform-suffixed sidecar binaries
# that Tauri's externalBin loader can pick up. Run from the monorepo root via
# `bun run build:sidecar`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_ENTRY="$ROOT/apps/agent/src/index.ts"
OUT_DIR="$ROOT/apps/desktop/frontend/src-tauri/binaries"
mkdir -p "$OUT_DIR"

# Tauri's externalBin convention: <name>-<rust-target-triple>[.exe]
# Bun's --target maps to runtimes; the binary name suffix has to match the
# Rust toolchain target triple of whichever platform is invoking `tauri build`.
declare -a TARGETS=(
  "bun-darwin-arm64:atlas-agent-aarch64-apple-darwin"
  "bun-darwin-x64:atlas-agent-x86_64-apple-darwin"
  "bun-linux-x64:atlas-agent-x86_64-unknown-linux-gnu"
  "bun-windows-x64:atlas-agent-x86_64-pc-windows-msvc.exe"
)

for entry in "${TARGETS[@]}"; do
  bun_target="${entry%%:*}"
  out_name="${entry#*:}"
  echo "→ $bun_target → $out_name"
  bun build "$AGENT_ENTRY" \
    --compile \
    --target="$bun_target" \
    --outfile="$OUT_DIR/$out_name"
done

echo "✓ sidecar binaries written to $OUT_DIR"
