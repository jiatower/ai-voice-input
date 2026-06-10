#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_DIR="$ROOT/vendor/whisper.cpp"
BUILD_DIR="$ROOT/build/whisper"
OUT_DIR="$ROOT/build/helpers"
COMPAT_DIR="$ROOT/build/compat"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone --depth 1 --branch v1.7.6 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
else
  git -C "$WHISPER_DIR" checkout v1.7.6 >/dev/null
fi

mkdir -p "$OUT_DIR" "$COMPAT_DIR" "$ROOT/build/models"

cat > "$COMPAT_DIR/clang_builtin_compat.h" <<'EOF'
#pragma once

#ifndef __has_builtin
#define __has_builtin(x) 0
#endif

#if !__has_builtin(__builtin_clzg)
#define __builtin_clzg(x, width) \
  ((x) == 0 ? (width) : \
   (sizeof(x) <= sizeof(unsigned int) ? (__builtin_clz((unsigned int)(x)) - (int)(sizeof(unsigned int) * 8 - (width))) : \
    (__builtin_clzll((unsigned long long)(x)) - (int)(sizeof(unsigned long long) * 8 - (width)))))
#endif

#if !__has_builtin(__builtin_ctzg)
#define __builtin_ctzg(x, width) \
  ((x) == 0 ? (width) : \
   (sizeof(x) <= sizeof(unsigned int) ? __builtin_ctz((unsigned int)(x)) : __builtin_ctzll((unsigned long long)(x))))
#endif
EOF

CFLAGS="-include $COMPAT_DIR/clang_builtin_compat.h" \
CXXFLAGS="-include $COMPAT_DIR/clang_builtin_compat.h" \
cmake -S "$WHISPER_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_COREML=OFF \
  -DWHISPER_METAL=ON \
  -DGGML_METAL=ON \
  -DGGML_ACCELERATE=OFF \
  -DGGML_BLAS=OFF \
  -DBUILD_SHARED_LIBS=OFF

cmake --build "$BUILD_DIR" --config Release --target whisper-cli whisper-server -j "$(sysctl -n hw.ncpu)"
cp "$BUILD_DIR/bin/whisper-cli" "$OUT_DIR/whisper-cli"
cp "$BUILD_DIR/bin/whisper-server" "$OUT_DIR/whisper-server"
chmod +x "$OUT_DIR/whisper-cli" "$OUT_DIR/whisper-server"

if [ ! -f "$ROOT/build/models/ggml-small.bin" ]; then
  "$WHISPER_DIR/models/download-ggml-model.sh" small "$ROOT/build/models"
fi
