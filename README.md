# renut_nx_ultimate_installer

The web installer for ports made from the ultimate base ([renut_nx_ultimate_base](https://github.com/ChanseyIsTheBest/renut_nx_ultimate_base)).
A port forks it, edits `game.json` (and the page's colours and `icon.png`), fills `release/` with its NRO, and publishes it
on GitHub Pages. The page makes the whole Switch package from the player's own copy of the game, in their browser:

- **The shaders**, from the game's own files, so the NRO carries none of them: the containers in `default.xex` and in
  the game's files, Renut's translator, DXC, SPIRV-Cross and the base's own Python passes (run unchanged in Pyodide),
  into `deko3d_glsl.bin`; and optionally every shader variant compiled by uam, the console's compiler, into
  `deko3d_shaders.bin`, so the game starts with no compile stutters.
- **LZ4 packing** of the large archives `game.json` names: LZ4 HC level 9 in 256 KB blocks, as `NAME.lz4b`, which the
  base's SDK reads as `NAME` (port 61). Beautiful Katamari's archives go from 2.1 GB to 0.9 GB.
- **The zip**, streamed to a download as it is written (it can be bigger than the browser's memory).

The example in this repository is Beautiful Katamari, the base's own game: the base's NRO built with
`-DBANJO_RENUT_RELEASE_SHADERS=ON`, its 195 shaders (111 in `default.xex`, 84 in the models of `d02.dat`-`d05.dat`).

## Making a port's installer

1. **`game.json`**: the game's title, the port's folder on the SD card (`package`: `switch/<package>/`), the NRO's name,
   whether the page makes the shaders (`shaders`), which files are packed with LZ4 (`lz4`, case-insensitive regular
   expressions on paths in the game folder), which are left out (`skip`), which must be there (`needs`), whether it takes
   DLC packages (`dlc`, copied whole to `switch/<package>/dlc/`, which the base installs at the first start), and the
   page's texts.
2. **The NRO**: build the port with `-DBANJO_RENUT_RELEASE_SHADERS=ON` (no game shader in it). A shader the game makes
   at runtime (one no game file holds) must stay in the NRO: `tools/make_release.py` stops when the port's shader dump
   has one that is neither in `default.xex` nor in a record.
3. **Shaders in the game's files** (if any): write the records, a list of where each container is (file, offset, stored
   size, coding, and the container's offset, length and SHA-256 in the decoded bytes), with a tool of the port's own
   (katamari-nx's `tools/katamari_shader_files.py` is the example). The codings are in `lib/sources.js` (`raw`, `zlib`,
   `cpdb`); a new one goes there.
4. **The release**:

   ```bash
   python tools/make_release.py --port <port root> --nro <NRO> --game <game folder> --records <records.json> --pipeline-list <pipeline_list.bin> --version 1.0.0
   ```

   `--pipeline-list` (a console's or Ryujinx's `pipeline_list.bin`) gives `variants.txt`, the variants the page compiles,
   and ships the list itself (the console prebuilds those pipelines). `--file <src>[:<name>]` adds a release file (a
   settings file, for example). Then make the reference shader files and check the whole package:

   ```bash
   node test/full_node.mjs <game folder> <out.zip> --reference --native-glsl=<port>/out/deko3d_shaders/glsl_opt
   ```

   ```bash
   python test/check_zip.py <out.zip> <game folder>
   ```

5. **The tools**: when the port's shader tools differ from the base's, copy them in with
   `python tools/sync_from_base.py --base <port root>`, and rebuild `wasm/renut_hlsl` and `wasm/uam` from the port
   (`BANJO_NX=<port root> bash wasm/src/translator/build_wasm_translator.sh`, the same for
   `wasm/src/uam/build_wasm_uam.sh`; Emscripten 6.0.11, the emsdk named in the scripts).

The NRO reads a `deko3d_glsl.bin` only with its own tag (`kInstalledTag` in the base's `banjo_renut_deko3d.cpp`,
`INSTALLED_TAG` in `lib/package.js`), and a DKSH cache only with its compiler's tag (`CACHE_TAG` in `lib/variants.js`):
change both sides together.

## How the page works

| Path | What it does |
|---|---|
| `index.html`, `app.js` | the page: the game (a disc image, `lib/xiso.js`, or a folder), the DLC, the options |
| `worker.js` | runs `lib/install.js` off the page's thread and streams the zip to `sw.js` |
| `lib/install.js` | the whole build: the release files, the shaders, the zip (the page and `test/full_node.mjs` both run it) |
| `lib/sources.js` | the shader containers: `default.xex` (`lib/xex.js`, LZX in `wasm/lzx`) and the records' codings |
| `lib/build.js`, `lib/chain.js`, `lib/glsl_job.js`, `glsl_worker.js` | the translator and the GLSL chain on worker threads |
| `lib/package.js` | `deko3d_glsl.bin` (version 2: the GLSL and the shader table's numbers) |
| `lib/variants.js`, `lib/uam.js`, `uam_worker.js` | the variants and the DKSH cache (`deko3d_shaders.bin`) |
| `lib/lz4b.js`, `lz4_worker.js` | the LZ4 block files (`wasm/lz4`: LZ4 1.10.0 HC) |
| `lib/zip.js`, `sw.js` | the zip writer and the download stream |
| `py/` | the base's Python shader tools, unchanged (`tools/sync_from_base.py`) |
| `release/` | the NRO, `shader_common.h`, `variants.txt`, `pipeline_list.bin`, `manifest.json` |

## Testing locally

```bash
python serve.py 8193 .
```

Then open http://127.0.0.1:8193/ in a Chromium browser. The browser test makes a zip from a served game folder with no
file dialogs:

```bash
python serve.py 8193 . --test-files <game folder> --test-out test/out_zip/package.zip
```

and open http://127.0.0.1:8193/test/browser.html (`?compile=0` leaves the DKSH cache out), then
`python test/check_zip.py test/out_zip/package.zip <game folder>`.

Outputs of the tests (zips, shader files) are game data: never commit or share them.

## License

GPL-3.0 (see [LICENSE](LICENSE)). Third-party components are listed in [NOTICES.md](NOTICES.md).
