#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/helpers/MacSpeechTranscriber.app"
OUT="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
mkdir -p "$OUT" "$RES"
cp "$ROOT/native/macos-speech/Info.plist" "$APP/Contents/Info.plist"

swiftc \
  "$ROOT/native/macos-speech/MacSpeechTranscriber.swift" \
  -framework Foundation \
  -framework Speech \
  -o "$OUT/MacSpeechTranscriber"
