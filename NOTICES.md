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
| [libmspack](https://www.cabextract.org.uk/libmspack/) by Stuart Caie: the LZX decoder (through katamari-nx-installer) | `wasm/lzx.*` | LGPL-2.1 |
| [xxHash](https://github.com/Cyan4973/xxHash) and [{fmt}](https://github.com/fmtlib/fmt), in the translator | `wasm/renut_hlsl.*` | BSD-2-Clause; MIT |
| [Emscripten](https://emscripten.org) 6.0.11 runtime and the musl libc it links | `wasm/*.mjs`, `wasm/*.wasm` | MIT and NCSA |

`wasm/renut_hlsl.*` is built by `wasm/src/translator/build_wasm_translator.sh`, `wasm/uam.*` by
`wasm/src/uam/build_wasm_uam.sh` (both from the ultimate base's sources) and `wasm/lz4.*` by `wasm/src/lz4/build.sh`
(Emscripten 6.0.11).

The licenses of the software in the NRO are listed in the port's repository, with its source code. The example's
`icon.png` is Beautiful Katamari's artwork, © Bandai Namco Entertainment.
