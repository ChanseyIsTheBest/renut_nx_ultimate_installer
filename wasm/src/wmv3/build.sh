#!/usr/bin/env bash
# culdcept-nx-installer (2026-11-20): builds wasm/wmv3.mjs + wasm/wmv3.wasm, FFmpeg's WMV3 decoder for the movies' H.265
# re-encode (lib/movies.js), from:
#   wmv3_wasm.c   this folder: the exports (wmv3_open, wmv3_decode, wmv3_picture, wmv3_close, wmv3_malloc, wmv3_free,
#                 wmv3_version)
#   FFmpeg 4.4    culdcept-nx's sdk/thirdparty/FFmpeg (FFMPEG_SRC), configured out of its tree (BUILD) with the WMV3
#                 decoder only: no assembly, no threads, no programs (LGPL-2.1-or-later: the WMV3 / VC-1 decoder)
#
#   EMSDK       an emsdk folder (used when emcc is not on PATH; default: D:/sonic adventure 2/_tools/emsdk)
#   FFMPEG_SRC  FFmpeg's source (default: D:/culdceptsaga/culdcept-nx/sdk/thirdparty/FFmpeg)
#   BUILD       the build folder (default: D:/culdceptsaga/tmp_wasm_ffmpeg; no spaces)
#   MAKE        make (default: devkitPro's MSYS2 make)
#   OUT         output folder (default: the installer's wasm/)
# usage: wasm/src/wmv3/build.sh   (Git Bash)
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$(cd "$HERE/../../.." && pwd)
OUT=${OUT:-$INSTALLER/wasm}
FFMPEG_SRC=${FFMPEG_SRC:-/d/culdceptsaga/culdcept-nx/sdk/thirdparty/FFmpeg}
BUILD=${BUILD:-/d/culdceptsaga/tmp_wasm_ffmpeg}
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

# culdcept-nx's FFmpeg folder holds the SDK's own config.h, so configure will not build out of its tree: a copy of the
# source in $BUILD/src without it, configured in place.
if [ ! -f "$BUILD/src/configure" ]; then
  mkdir -p "$BUILD"
  cp -r "$FFMPEG_SRC" "$BUILD/src"
  rm -f "$BUILD/src/config.h"
fi
mkdir -p "$BUILD/tmp"
export TMPDIR="$BUILD/tmp"  # configure's own test files (Windows' %TEMP% loses its backslashes in Git Bash)
cd "$BUILD/src"
FFMPEG_SRC="$BUILD/src"
BUILD="$BUILD/src"
if [ ! -f ffbuild/config.mak ]; then
  ./configure --target-os=none --arch=x86_32 --enable-cross-compile --cc=emcc --cxx=em++ \
    --ar=emar --ranlib=emranlib --nm=emnm --dep-cc=emcc \
    --disable-x86asm --disable-inline-asm --disable-asm --disable-stripping --disable-programs --disable-doc \
    --disable-debug --disable-runtime-cpudetect --disable-autodetect --disable-network --disable-pthreads \
    --disable-w32threads --disable-os2threads --disable-everything --enable-decoder=wmv3 \
    --disable-avdevice --disable-avformat --disable-swresample --disable-swscale --disable-postproc \
    --disable-avfilter --extra-cflags="-O3"
fi
"$MAKE" -j8 libavcodec/libavcodec.a libavutil/libavutil.a

emcc -O3 -I"$BUILD" -I"$FFMPEG_SRC" "$HERE/wmv3_wasm.c" "$BUILD/libavcodec/libavcodec.a" "$BUILD/libavutil/libavutil.a" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS=HEAPU8 -s EXPORT_NAME=createWmv3Module -o "$OUT/wmv3.mjs"
ls -la "$OUT/wmv3.mjs" "$OUT/wmv3.wasm"
