#!/usr/bin/env bash
# sasrt-nx-installer (2026-11-21): culdcept-nx-installer's build (credit culdcept-nx), against sasrt-nx's FFmpeg 4.4
# (the port's own xmaframes decoder), with xma_open_raw (SASRT's XMA2 WEM data chunks).
# culdcept-nx-installer (2026-11-20): builds wasm/xma.mjs + wasm/xma.wasm, the XMA frame walk and FFmpeg's xmaframes
# decoder for the audio's Opus re-encode (lib/audio.js), from:
#   xma_wasm.c  this folder: the exports (xma_open, xma_info, xma_frames, xma_decode, xma_close, xma_malloc, xma_free)
#   FFmpeg 4.4  culdcept-nx's sdk/thirdparty/FFmpeg (FFMPEG_SRC, with its xmaframes decoder: WMA Pro's, LGPL-2.1-or-
#               later), configured out of its tree (BUILD) with that decoder only: no assembly, no threads, no programs
#
#   EMSDK       an emsdk folder (used when emcc is not on PATH; default: D:/sonic adventure 2/_tools/emsdk)
#   FFMPEG_SRC  FFmpeg's source (default: D:/sonic transformed/sasrt-nx/sdk/thirdparty/FFmpeg)
#   BUILD       the build folder (default: D:/sasrt_wasm_xma; no spaces)
#   MAKE        make (default: devkitPro's MSYS2 make)
#   OUT         output folder (default: the installer's wasm/)
# usage: wasm/src/xma/build.sh   (Git Bash)
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$(cd "$HERE/../../.." && pwd)
OUT=${OUT:-$INSTALLER/wasm}
FFMPEG_SRC=${FFMPEG_SRC:-"/d/sonic transformed/sasrt-nx/sdk/thirdparty/FFmpeg"}
BUILD=${BUILD:-/d/sasrt_wasm_xma}
MAKE=${MAKE:-/c/devkitPro/msys2/usr/bin/make}

if ! command -v emcc >/dev/null 2>&1; then
  EMSDK=${EMSDK:-"D:/sonic adventure 2/_tools/emsdk"}
  command -v cygpath >/dev/null 2>&1 && EMSDK=$(cygpath -u "$EMSDK")
  [ -f "$EMSDK/.emscripten" ] || { echo "emcc not found and no emsdk at $EMSDK: set EMSDK" >&2; exit 1; }
  export EM_CONFIG="$EMSDK/.emscripten"
  for d in "$EMSDK"/python/*/ "$EMSDK"/node/*/; do PATH="$d:$PATH"; done
  PATH="$EMSDK/upstream/emscripten:$PATH"
  export PATH
fi
echo "emcc: $(emcc --version | head -1)"

# As wmv3/build.sh: the SDK's FFmpeg folder holds its own config.h, so a copy of the source without it, configured in
# place.
if [ ! -f "$BUILD/src/configure" ]; then
  mkdir -p "$BUILD"
  cp -r "$FFMPEG_SRC" "$BUILD/src"
  rm -f "$BUILD/src/config.h"
fi
mkdir -p "$BUILD/tmp"
export TMPDIR="$BUILD/tmp"
cd "$BUILD/src"
FFMPEG_SRC="$BUILD/src"
BUILD="$BUILD/src"
if [ ! -f ffbuild/config.mak ]; then
  ./configure --target-os=none --arch=x86_32 --enable-cross-compile --cc=emcc --cxx=em++ \
    --ar=emar --ranlib=emranlib --nm=emnm --dep-cc=emcc \
    --disable-x86asm --disable-inline-asm --disable-asm --disable-stripping --disable-programs --disable-doc \
    --disable-debug --disable-runtime-cpudetect --disable-autodetect --disable-network --disable-pthreads \
    --disable-w32threads --disable-os2threads --disable-everything --enable-decoder=xmaframes \
    --disable-avdevice --disable-avformat --disable-swresample --disable-swscale --disable-postproc \
    --disable-avfilter --extra-cflags="-O3"
fi
"$MAKE" -j8 libavcodec/libavcodec.a libavutil/libavutil.a

emcc -O3 -I"$BUILD" -I"$FFMPEG_SRC" "$HERE/xma_wasm.c" "$BUILD/libavcodec/libavcodec.a" "$BUILD/libavutil/libavutil.a" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 -s EXPORT_NAME=createXmaModule -o "$OUT/xma.mjs"
ls -la "$OUT/xma.mjs" "$OUT/xma.wasm"
