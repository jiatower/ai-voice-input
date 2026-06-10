#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-fast}"

cd "$ROOT"
ELECTRON_BUILDER="$ROOT/node_modules/.bin/electron-builder"

usage() {
  cat <<'EOF'
Usage: scripts/package.sh <mode>

Modes:
  check       Run TypeScript checks only.
  build       Build renderer/main/helper assets only; no Electron package.
  app         Build an unsigned local .app directory in release/mac-*.
  fast        Build an unsigned DMG quickly; no signing or notarization.
  dmg         Alias for fast.
  signed      Build a signed DMG using electron-builder's configured identity.

Examples:
  scripts/package.sh check
  scripts/package.sh fast
  scripts/package.sh signed
EOF
}

run_build() {
  npm run build
}

copy_dmg_as() {
  local suffix="$1"
  local source="release/AI Voice Input-0.1.0-arm64.dmg"
  local blockmap="release/AI Voice Input-0.1.0-arm64.dmg.blockmap"
  local target="release/AI Voice Input-0.1.0-arm64-${suffix}.dmg"
  local target_blockmap="${target}.blockmap"

  if [[ -f "$source" ]]; then
    cp "$source" "$target"
  fi
  if [[ -f "$blockmap" ]]; then
    cp "$blockmap" "$target_blockmap"
  fi
}

unsigned_builder() {
  if [[ ! -x "$ELECTRON_BUILDER" ]]; then
    echo "electron-builder not found. Run npm install first." >&2
    exit 127
  fi
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    "$ELECTRON_BUILDER" --mac "$@" --publish never --config.mac.identity=null
}

case "$MODE" in
  check)
    npm run typecheck
    ;;
  build)
    run_build
    ;;
  app)
    run_build
    unsigned_builder dir
    ;;
  fast | dmg)
    run_build
    unsigned_builder dmg
    copy_dmg_as fast
    ;;
  signed)
    run_build
    if [[ ! -x "$ELECTRON_BUILDER" ]]; then
      echo "electron-builder not found. Run npm install first." >&2
      exit 127
    fi
    "$ELECTRON_BUILDER" --mac dmg --publish never
    copy_dmg_as signed
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
