#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/helpers"
mkdir -p "$OUT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

swiftc \
  "$ROOT/native/hotkey-watcher/HotkeyWatcher.swift" \
  -framework Foundation \
  -framework ApplicationServices \
  -o "$OUT/HotkeyWatcher"
