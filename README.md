# renut_nx_ultimate_installer

The web installer for ports made from the ultimate base ([renut_nx_ultimate_base](https://github.com/ChanseyIsTheBest/renut_nx_ultimate_base)).
A port forks it, edits `game.json` (and the page's colours and `icon.png`), fills `release/` with its NRO, and publishes it
on GitHub Pages. The page makes the whole Switch package from the player's own copy of the game, in their browser:

- **The shaders**, from the game's own files, so the NRO carries none of them: the containers in `default.xex` and in
  the game's files, Renut's translator, DXC, SPIRV-Cross and the base's own Python passes (run unchanged in Pyodide),
  into `deko3d_glsl.bin`; and optionally every shader variant compiled by uam, the console's compiler, into
  `deko3d_shaders.bin`, so the game starts with no compile stutters.
- **Packing** of the game's files as `NAME.lz4b`, which the base's SDK reads as `NAME` (ports 61 and 259): LZ4 HC
  level 9 in 256 KB blocks for what a load screen reads (Beautiful Katamari's archives go from 2.1 GB to 0.9 GB), ZXC
  level 7 in 512 KB blocks for what is read while playing (the movies), each by `game.json`'s lists.
- **Re-encodes** (2026-11-23, optional and on by default): the movies (ASF with WMV3) as H.265 in the same file, which
  the Switch's video hardware plays through the port's movie hook, and the XMA sounds as Opus (`NAME.xmop`), with the
  browser's own encoders (WebCodecs). The base's `docs/media-compression.md` has the method and every port's figures.
- **The zip**, streamed to a download as it is written (it can be bigger than the browser's memory).

The example in this repository is Beautiful Katamari, the base's own game: the base's NRO built with
`-DBANJO_RENUT_RELEASE_SHADERS=ON`, its 195 shaders (111 in `default.xex`, 84 in the models of `d02.dat`-`d05.dat`).

## Making a port's installer

1. **`game.json`**: the game's title, the port's folder on the SD card (`package`: `switch/<package>/`), the NRO's name,
   whether the page makes the shaders (`shaders`), which files are packed with LZ4 (`lz4`, case-insensitive regular
   expressions on paths in the game folder), which are left out (`skip`), which must be there (`needs`), which may be
   absent from a player's copy (`optional`; see step 4), whether it takes DLC packages (`dlc`, copied whole to
   `switch/<package>/dlc/`, which the base reads in place from there since 2026-11-24: an install writes only each
   package's header), whether the port is recompiled from a title
   update's code (`update`, below), and the page's texts.

   **Packing and re-encodes** (2026-11-23, vivapinata-nx-installer's keys): each file's codec is the first of these
   lists that names it (`lib/lz4b.js` codecFor): `asis` (never packed: `default.xex`), `lz4_small` (LZ4 in 64 KB
   blocks, for a file read a few KB at a time), `zxc`, `lz4`; a file under `min_pack_size` bytes is copied as it is.
   `movies: { match, fraction, gop, zxc }` re-encodes the ASF movies `match` names to H.265 at `fraction` of their
   video bitrate, a keyframe every `gop` frames, ZXC-packed when `zxc` (the port's hook needs their decoder's addresses:
   culdcept-nx's `culdcept_wmv_ffmpeg.cpp` is the model). `audio: { match, container, bitrates, rates, near_hz, ids,
   pack, min_saving }` re-encodes the XMA sounds of the files `match` names: `container` the reader (`riff`: one RIFF
   WAVE XMA sound a file, `lib/riffxma.js`), `bitrates` the first rule whose `match` (and `rate`, if given) fits
   (`stereo`, `mono` in bit/s), `rates` the XMA rates the port plays from Opus and the Opus rate of each (the base's:
   48000 and 44100 from 48 kHz, 24000 from 24 kHz), `near_hz` how close another rate may be to be played as one of
   them (the frames keep their samples: Katamari's 47,996-47,999 Hz music as 48000), `ids` the sound ids (`top` byte,
   `pack_bits` for the file's index), `pack` / `min_saving` the codec of `NAME.xmop.lz4b` when it saves that much. A
   sound that cannot be played this way (more than one stream, another rate) or is not smaller stays XMA, and its file
   is packed as any other. Beautiful Katamari's `game.json` is the example.

   **A port of a title update's code** (blur-nx-installer, 2026-11-18) sets `"update": { "title": "title update 2" }`
   and a `texts.update` note. The page then asks for that update too: the Xbox 360 package the player has (a LIVE,
   PIRS or CON file, read in the browser by `lib/stfs.js`), the folder that holds it, or the folder it was extracted to.
   It is checked against the build's `update` (`make_release.py --update`: its `default.xexp`'s SHA-256 and its other
   files with their sizes, `lib/update.js`). Its `default.xexp` goes next to `default.xex` in `game_root/` (the runtime
   applies the patch) and its other files to `update/` (mounted as the console's `UPDATE:`). The shaders of
   `default.xex` are read from the image with the patch applied, as the runtime loads it (`lib/xexp.js`: Xenia's
   XexModule::ApplyPatch, the LZX delta step in `wasm/xexp`, built by `wasm/src/xexp/build.sh` from the SDK's own
   libmspack): a patch can change every one of them (all 519 of Blur's).
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
   settings file, for example; a Windows path's drive is not taken for the name). `--update <folder>`, the title update
   extracted, records it for a port of its code (step 1); then pass the update to the tests too
   (`full_node.mjs --update=<package or folder>`, `check_zip.py <zip> <game> <update folder>`).

   The build also records the game's files with their sizes (`game_files`, from `--game`, less what `skip` leaves out).
   The page refuses a copy missing any of them, or with one of another size, and names what is wrong
   (`lib/game_check.js`): "data/ (all 1384 files)", "cse/ (12 of 40 files: ...)". So a copy with `default.xex` (and
   `default.xexp`) and little else is caught when it is chosen, not at the console. The disc's own extras
   (`$SystemUpdate`, `$TitleUpdate`, `nxeart`, `AvatarAssetPack`) and what `optional` names are never required. For a
   manifest made before this, add the list with `python tools/game_files.py <game folder>`; check it with
   `node test/game_check_node.mjs <game folder>`.

   Then make the reference shader files and check the whole package:

   ```bash
   node test/full_node.mjs <game folder> <out.zip> --reference --native-glsl=<port>/out/deko3d_shaders/glsl_opt
   ```

   ```bash
   python test/check_zip.py <out.zip> <game folder>
   ```

   The page fetches the release files as GitHub Pages serves them, which is what git stores, not the working copy
   these tests read. `.gitattributes` keeps `release/` byte for byte (`release/** -text`: with `core.autocrlf` git
   would store a text file such as a `--file` README with other line ends than make_release.py hashed, and the page
   would refuse it, as blur-nx-installer's did). So test the published bytes too: after the commit, and again on the
   page after the push,

   ```bash
   python test/check_release.py [https://<user>.github.io/<repo>/]
   ```

   checks every release file the page fetches against the manifest (with no URL, as git stores it at `HEAD`).

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
| `lib/game_check.js` | whether the chosen copy is whole: the build's `game_files`, what is missing named |
| `lib/stfs.js`, `lib/update.js`, `lib/xexp.js`, `wasm/xexp` | a title update: its package read, checked and placed; its patch applied to `default.xex`'s image |
| `worker.js` | runs `lib/install.js` off the page's thread and streams the zip to `sw.js` |
| `lib/install.js` | the whole build: the release files, the shaders, the zip (the page and `test/full_node.mjs` both run it) |
| `lib/sources.js` | the shader containers: `default.xex` (`lib/xex.js`, LZX in `wasm/lzx`) and the records' codings |
| `lib/build.js`, `lib/chain.js`, `lib/glsl_job.js`, `glsl_worker.js` | the translator and the GLSL chain on worker threads |
| `lib/package.js` | `deko3d_glsl.bin` (version 2: the GLSL and the shader table's numbers) |
| `lib/variants.js`, `lib/uam.js`, `uam_worker.js` | the variants and the DKSH cache (`deko3d_shaders.bin`) |
| `lib/lz4b.js`, `pack_worker.js` | the block files (`wasm/lz4`: LZ4 1.10.0 HC; `wasm/zxc`: ZXC 0.15.0) and each file's codec |
| `lib/media.js` | the re-encodes `game.json` asks for, and what this browser can do |
| `lib/movies.js`, `lib/asf.js`, `wasm/wmv3` | a WMV3 movie as H.265 in its ASF file (FFmpeg's WMV3 decoder, the browser's H.265 encoder) |
| `lib/audio.js`, `lib/xmop.js`, `lib/riffxma.js`, `lib/resample.js`, `wasm/xma` | XMA sounds as Opus in `NAME.xmop` (FFmpeg's XMA decoder, the browser's Opus encoder) |
| `lib/vfs_index.js` | `cache/vfs_index_game_root.bin`: the console's index of `game_root/` (the base's VFS index, version 4), made from what the zip holds, so the first start skips the folder scan; the console checks it against the card and scans as before when anything differs. `game.json` `"vfs_index": false` leaves it out. `test/vfs_index_node.mjs` and `test/vfs_index_dump.py` make one from an extracted folder and compare it with the console's |
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

Run it in Chrome (or Edge, or Firefox), not in an embedded browser that cannot start a worker from inside a worker
(the Claude app's browser pane fails at "./glsl_worker.js: undefined": the GLSL, uam and LZ4 workers are started by
`worker.js`). A headless Chrome with a scratch profile works (blur-nx-installer, 2026-11-19); the page sets its title
to `DONE` or `FAILED`, which `http://127.0.0.1:9333/json` shows:

```bash
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<scratch folder> --no-first-run --disable-extensions http://127.0.0.1:8193/test/browser.html
```

The re-encodes on a PC: `node test/full_node.mjs <game folder> <out.zip> --opus` also re-encodes the sounds, with
ffmpeg's libopus in place of the browser's encoder (`test/opus_node.mjs`; `FFMPEG`, default `C:/ffmpeg/ffmpeg.exe`);
Node has no H.265 encoder, so the movies are only packed there. `node test/xmop_node.mjs <game folder> <out folder>
[regex]` writes the `.xmop` files alone and prints their sizes, and `node test/xmop_check.mjs NAME NAME.xmop` checks
one (every byte outside the sounds, every header, frame length, last bit and tag). `test/check_zip.py` checks a ZXC
entry through the base's block reader test (`tools/test_lz4_blocks.cpp`, built: `LZ4B_TEST`) and every `.xmop` with
`xmop_check.mjs`; a re-encoded movie is found, not compared.

`python test/check_release.py` checks the release files as the commit holds them, and with a URL (serve.py's, or the
published page) as that serves them: test the published bytes, not the working copy.

Outputs of the tests (zips, shader files) are game data: never commit or share them.

## License

GPL-3.0 (see [LICENSE](LICENSE)). Third-party components are listed in [NOTICES.md](NOTICES.md).
