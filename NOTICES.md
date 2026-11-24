# Third-party notices

renut_nx_ultimate_installer is built from kameo-nx-installer, rr6-nx-installer and katamari-nx-installer, themselves
built on [renut-nx-webinstaller](https://github.com/ChanseyIsTheBest/renut-nx-webinstaller) (GPL-3.0).

| Component | Where | License |
|---|---|---|
| [kameo-nx-installer](https://github.com/ChanseyIsTheBest/kameo-nx-installer), [rr6-nx-installer](https://github.com/ChanseyIsTheBest/rr6-nx-installer), [katamari-nx-installer](https://github.com/ChanseyIsTheBest/katamari-nx-installer), [bejeweled3-nx-installer](https://github.com/ChanseyIsTheBest/bejeweled3-nx-installer) and [sa2-nx-installer](https://github.com/ChanseyIsTheBest/sa2-nx-installer) by ChanseyIsTheBest: the page, the worker, the shader chain, the zip writer, the disc image, XEX and CPDB readers, the worker pools, the LZ4 block files, the test server | throughout | GPL-3.0 |
| [nfsmw-nx-installer](https://github.com/StevensND/nfsmw-nx-installer) by StevensND: the download service worker and the worker's download stream, the zip writer | `sw.js`, `worker.js`, `lib/zip.js` | GPL-3.0 |
| The ultimate base's shader tools (from banjo-nx and katamari-nx), run unchanged in Pyodide: `tools/deko3d_glsl.py`, `tools/deko3d_glsl_opt.py` (and its shader lists), `tools/early_alpha.py`, `tools/renut_early_alpha.py` | `py/` | GPL-3.0 |
| [reNut](https://github.com/masterspike52/reNut) by masterspike52: the renderer whose shader chain this page runs, reused with its author's permission | throughout the chain | as its repository states |
| XenosRecomp ([hedge-dev](https://github.com/hedge-dev/XenosRecomp) and contributors), in reNut's version as the ultimate base carries it | `wasm/renut_hlsl.*`, `release/shader_common.h` | MIT |
| [uam](https://github.com/devkitPro/uam) by fincs (with Mesa's GLSL compiler and the nouveau codegen), with SwitchWakerHD's patches and banjo-nx's passes, as the ultimate base's `app/thirdparty/uam` | `wasm/uam.*`, `wasm/src/uam/` | uam: zlib License; Mesa: MIT and others (see its sources) |
| [DirectXShaderCompiler](https://github.com/microsoft/DirectXShaderCompiler) v2025.1 with SPIRV-Tools and SPIRV-Headers, and the `dxc_web.cpp` wrapper, as built by nfsmw-nx-installer (from bejeweled3-nx-installer) | `wasm/dxc_web.*` | NCSA (LLVM); SPIRV-Tools: Apache-2.0; SPIRV-Headers: MIT; the wrapper: GPL-3.0 |
| [SPIRV-Cross](https://github.com/KhronosGroup/SPIRV-Cross) (commit `22b22f56`), unmodified | `wasm/spirv_cross.*` | Apache-2.0 |
| [Pyodide](https://pyodide.org) 0.27.7 (CPython 3.12 for WebAssembly) and its numpy 2.0.2 wheel, unmodified | `vendor/pyodide/` | Pyodide: MPL-2.0; CPython: PSF License; numpy: BSD-3-Clause |
| [LZ4](https://github.com/lz4/lz4) 1.10.0 by Yann Collet: `lz4.c`, `lz4.h`, `lz4hc.c`, `lz4hc.h`, unmodified | `wasm/src/lz4/`, `wasm/lz4.*` | BSD 2-Clause (`wasm/src/lz4/LICENSE`) |
| [vivapinata-nx-installer](https://github.com/ChanseyIsTheBest/vivapinata-nx-installer) by ChanseyIsTheBest (2026-11-23), with the pieces it took from sasrt-nx-installer, banjo-nx-installer and [culdcept-nx-installer](https://github.com/ChanseyIsTheBest/culdcept-nx-installer): the packing worker with ZXC, the movies' H.265 re-encode (the ASF reader and writer, the WMV3 decoder's WebAssembly), the XMA-to-Opus method (`NAME.xmop`, the XMA decoder's WebAssembly, the resampler) and its tests | `pack_worker.js`, `lib/lz4b.js`, `lib/movies.js`, `lib/asf.js`, `lib/audio.js`, `lib/xmop.js`, `lib/resample.js`, `wasm/src/wmv3/`, `wasm/src/xma/`, `wasm/src/zxc/`, `test/xmop_node.mjs`, `test/xmop_check.mjs` | GPL-3.0 |
| [ZXC](https://github.com/hellobertrand/zxc) 0.15.0 by Bertrand Lebonnois: its library, unmodified but for `zxc_driver.c` left out (through rr6-nx-installer and vivapinata-nx-installer) | `wasm/src/zxc/`, `wasm/zxc.*` | BSD 3-Clause (`wasm/src/zxc/LICENSE`) |
| [rapidhash](https://github.com/Nicoshev/rapidhash) by Nicolas De Carli, bundled with ZXC | `wasm/src/zxc/src/lib/vendors/rapidhash.h`, `wasm/zxc.*` | MIT (`wasm/src/zxc/THIRD_PARTY_NOTICES`) |
| [FFmpeg](https://ffmpeg.org) 4.4 (sasrt-nx's `sdk/thirdparty/FFmpeg`, through vivapinata-nx-installer): libavcodec's xmaframes decoder (WMA Pro's, with the ReXGlue ports' frame-by-frame XMA entry) and libavutil, built with that decoder only | `wasm/xma.*` | LGPL-2.1-or-later |
| [FFmpeg](https://ffmpeg.org) (culdcept-nx-installer's build, through banjo-nx-installer and vivapinata-nx-installer): libavcodec's WMV3 decoder and libavutil, built with that decoder only | `wasm/wmv3.*` | LGPL-2.1-or-later |
| [libmspack](https://www.cabextract.org.uk/libmspack/) by Stuart Caie: the LZX decoder (through katamari-nx-installer; `lzxd.c` from the base's SDK in `wasm/xexp`) | `wasm/lzx.*`, `wasm/xexp.*` | LGPL-2.1 |
| The title update's reader and patch (`lib/stfs.js`, `lib/update.js`, `lib/xexp.js`, `wasm/src/xexp/xexp_wasm.c`), from blur-nx-installer (ChanseyIsTheBest, 2026-11-18); `lib/xexp.js` and `xexp_wasm.c` follow [Xenia](https://github.com/xenia-project/xenia)'s XexModule::ApplyPatch and LZX delta records as the base's SDK has them | `lib/`, `wasm/src/xexp/` | GPL-3.0 (Xenia's parts: BSD-3-Clause) |
| [xxHash](https://github.com/Cyan4973/xxHash) and [{fmt}](https://github.com/fmtlib/fmt), in the translator | `wasm/renut_hlsl.*` | BSD-2-Clause; MIT |
| [Emscripten](https://emscripten.org) 6.0.11 runtime and the musl libc it links | `wasm/*.mjs`, `wasm/*.wasm` | MIT and NCSA |

`wasm/renut_hlsl.*` is built by `wasm/src/translator/build_wasm_translator.sh`, `wasm/uam.*` by
`wasm/src/uam/build_wasm_uam.sh` (both from the ultimate base's sources) and `wasm/lz4.*` by `wasm/src/lz4/build.sh`
(Emscripten 6.0.11). `wasm/zxc.*`, `wasm/xma.*` and `wasm/wmv3.*` are vivapinata-nx-installer's, built by
`wasm/src/zxc/build.sh`, `wasm/src/xma/build.sh` and `wasm/src/wmv3/build.sh` (Emscripten).

The licenses of the software in the NRO are listed in the port's repository, with its source code. The example's
`icon.png` is Beautiful Katamari's artwork, © Bandai Namco Entertainment.
