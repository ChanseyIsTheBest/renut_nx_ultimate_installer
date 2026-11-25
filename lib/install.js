// renut_nx_ultimate_installer: the whole package, from the player's game to the zip, for any port of the ultimate base.
// The page's worker (worker.js) and the Node test (test/full_node.mjs) both run this, so what the test checks is what
// the page does. What is the game's own comes from game.json (the port's settings for this page) and the build's entry
// in release/manifest.json (tools/make_release.py):
//   1. the build: default.xex's SHA-256 names it; the NRO and the release files are checked by theirs;
//   2. the shaders (game.json "shaders"): the containers (lib/sources.js), Renut's translator (wasm/renut_hlsl), the
//      GLSL chain on worker threads (lib/chain.js: early alpha, DXC, SPIRV-Cross and the base's own passes in Pyodide)
//      -> deko3d_glsl.bin (version 2, lib/package.js: the GLSL and the shader table, so the NRO carries no game shader);
//      with compile, every variant of release/variants.txt compiled by uam (wasm/uam) -> deko3d_shaders.bin, the
//      console's DKSH cache, and pipeline_list.bin from the release (without the cache the list would make the console
//      compile everything at start);
//   3. the zip: the NRO, the release files, the shader files, the game's files under game_root/ (those game.json "lz4"
//      names packed as NAME.lz4b, LZ4 HC in 256 KB blocks, which the base's SDK reads as NAME: lib/lz4b.js) and the DLC
//      packages under dlc/, streamed to `sink` as it is written (its size is known only at the end);
//   4. (blur-nx, 2026-11-18) the title update, when the build names one (its "update", lib/update.js): its default.xexp
//      to game_root/, its other files to update/;
//   5. (2026-11-23, the user: "re-encoding katamari's audio and video (ZXC compress the video) and L4Z/ZXC compressing
//      the other files") the smaller game files of the base's port 259 (lib/media.js): game.json "movies" as H.265,
//      "audio" as Opus (NAME.xmop), each when the page's option is on and the browser has the encoder; every other file
//      by game.json's lists (lib/lz4b.js codecFor: "asis", "lz4_small", "zxc", "lz4", "min_pack_size").
import { compileVariants, makeGlsl, packageShaders, variantJobs } from './build.js';
import { checkGameFiles, describeProblems, optionalPaths } from './game_check.js';
import { codecFor, pack, SUFFIX } from './lz4b.js';
import { KEPT, mediaSetup, reencodeInto } from './media.js';
import { nroShaders } from './nro.js';
import { gameContainers, sha256 } from './sources.js';
import { checkUpdate, updatePlacement } from './update.js';
import { parseVariants } from './variants.js';
import { heldSizeOf, standIn, VfsIndex } from './vfs_index.js';
import { ZipWriter } from './zip.js';

// The game.json patterns: case-insensitive regular expressions on a file's path in the game folder.
const patterns = (list) => (list || []).map((p) => new RegExp(`^(?:${p})$`, 'i'));
const matches = (res, path) => res.some((re) => re.test(path));

async function* chunks(file, size = 8 << 20) {
  for (let at = 0; at < file.size; at += size) yield await file.read(at, Math.min(size, file.size - at));
}

// The build of release/manifest.json this default.xex is, or throws. 2026-11-18: also throws when the copy is not
// whole (the build's "game_files", lib/game_check.js), as the page refuses it when it is chosen (app.js); game:
// game.json, for the files that may be absent (without it, only the disc's own extras may).
export async function findBuild(manifest, files, game = {}) {
  const xex = files.find((f) => f.path.toLowerCase() === 'default.xex');
  if (!xex) throw new Error('no default.xex in the folder: choose the folder the game was extracted to, or the disc image');
  const bytes = await xex.read(0, xex.size);
  const hash = await sha256(bytes);
  const build = manifest.builds.find((b) => b.xex_sha256 === hash);
  if (!build) throw new Error(`this default.xex is not one this release supports (SHA-256 ${hash})`);
  const problems = describeProblems(checkGameFiles(files, build.game_files, optionalPaths(game)));
  if (problems) throw new Error(problems);
  return { build, xex: bytes };
}

// game: game.json; manifest: release/manifest.json; files, dlc, update: [{ path, size, read(offset, length) }];
// fetchRelease(name, sha256) -> bytes (checked); sink: { write(bytes), close() }; compile: make the DKSH cache;
// tools: { translator, lzx, xexp (Emscripten modules; xexp when the build has a title update), cores, glslThreads, startGlsl(n), startUam(n), startPack(n) }, each
// start returning { run, version?, stop() } over n workers (lib/pool.js): glsl run(name, hlsl) -> UTF-8 GLSL,
// uam run(stage, text) -> { dksh } | { error }, pack run(bytes, codec) -> bytes (pack_worker.js: LZ4 or ZXC, lib/lz4b.js);
// for the re-encodes (lib/media.js) loadWmv3(), loadXma() (the WebAssembly modules) and, in the Node tests, encodeOpus.
// options: { movies, audio } (the page's ticks; both on by default).
// events: { log(text), progress(fraction), start(estimate of the zip's size) }. Returns what it did.
export async function buildPackage({ game, manifest, files, dlc = [], update = [], fetchRelease, tools, sink, compile = true,
                                     options = {}, events }) {
  const { log = () => {}, progress = () => {}, start = () => {} } = events || {};
  const began = performance.now();
  const seconds = () => Math.round((performance.now() - began) / 1000);
  const root = `switch/${game.package}`;
  const report = {};
  const running = [];
  const stopAll = () => { for (const r of running.splice(0)) r.stop(); };
  try {
    const { build, xex } = await findBuild(manifest, files, game);
    const updateProblem = await checkUpdate(build, update, game.update?.title);
    if (updateProblem) throw new Error(updateProblem);
    const updateFiles = updatePlacement(build, update);
    const shaders = game.shaders && build.shaders;
    if (!shaders) compile = false;
    // the shares of the bar: the shaders take the time, the zip the bytes
    const steps = shaders ? (compile ? { glsl: [0, 0.45], uam: [0.45, 0.65], zip: [0.65, 1] } : { glsl: [0, 0.5], zip: [0.5, 1] })
      : { zip: [0, 1] };
    const step = (s) => (f) => progress(steps[s][0] + (steps[s][1] - steps[s][0]) * f);

    log('Downloading the program and its files...');
    const nro = await fetchRelease(build.nro, build.nro_sha256);
    const extras = [];
    for (const f of build.files || []) {
      if (f.with_cache && !compile) continue;  // pipeline_list.bin: only with deko3d_shaders.bin (see above)
      extras.push({ ...f, bytes: await fetchRelease(f.source, f.sha256) });
    }
    const made = [];  // [path, bytes] of the shader files
    if (shaders) {
      const shaderCommon = await fetchRelease('shader_common.h', manifest.shader_common_sha256);
      // a port of a title update's code: its shaders in the patched image (lib/xexp.js)
      const xexpFile = updateFiles.find((u) => u.to === 'game_root/default.xexp')?.file;
      const patch = xexpFile ? { xexp: await xexpFile.read(0, xexpFile.size), mod: tools.xexp } : null;
      if (patch && !patch.mod) throw new Error('this release needs wasm/xexp (for the title update patch)');
      const containers = await gameContainers(files, xex, shaders, tools.lzx, log, patch);
      log(`Making the GLSL of ${containers.length} shaders on ${tools.glslThreads} threads...`);
      const glsl = await tools.startGlsl(tools.glslThreads);
      running.push(glsl);
      const errors = [];
      const { shaders: list, failed } = await makeGlsl(containers, tools.translator, glsl.run, shaderCommon, log,
                                                       step('glsl'), (e) => errors.push(e));
      glsl.stop();
      if (failed) throw new Error(`${failed} shaders could not be made: ${errors.slice(0, 3).join('; ')}`);
      const glslPackage = packageShaders(list);
      made.push(['deko3d_glsl.bin', glslPackage]);
      report.shaders = list.length;
      report.glslSha256 = await sha256(glslPackage);
      report.glsl = list;  // [{ name, glsl (UTF-8), numbers }]: for the tests' comparisons
      if (compile) {
        // every variant the game uses, and the NRO's own shaders' (the ones the game makes at runtime)
        // (a release without a pipeline list has no variants.txt: each shader is compiled as it is)
        const variants = build.variants_sha256
          ? parseVariants(new TextDecoder().decode(await fetchRelease('variants.txt', build.variants_sha256))) : [];
        const glslOf = new Map(list.map((s) => [s.name, s.glsl]));
        for (const [stem, text] of nroShaders(nro)) if (!glslOf.has(stem)) glslOf.set(stem, text);
        const { jobs } = variantJobs(variants, glslOf);
        log(`Compiling ${jobs.length} shader variants for the Switch on ${tools.cores} threads...`);
        const uam = await tools.startUam(tools.cores);
        running.push(uam);
        const compiled = await compileVariants(jobs, uam.run, tools.cores * 2, step('uam'));
        uam.stop();
        if (compiled.failures.length) {
          throw new Error(`${compiled.failures.length} shader variants did not compile: ${compiled.failures[0].error.slice(0, 200)}`);
        }
        made.push(['deko3d_shaders.bin', compiled.cache]);
        report.variants = jobs.length;
        report.cacheSha256 = await sha256(compiled.cache);
      }
      const reference = build.deko3d_glsl_sha256 === report.glslSha256 &&
                        (!compile || build.deko3d_shaders_sha256 === report.cacheSha256);
      log(`Shaders done in ${seconds()} s: ${report.shaders} shaders` + (compile ? `, ${report.variants} variants` : ', left for the Switch to compile') +
          (build.deko3d_glsl_sha256 ? (reference ? ', the same as the release\'s reference build' : ' (not the reference build\'s)') : ''));
    }

    // the zip
    const skip = patterns(game.skip);
    const game_ = files.filter((f) => !matches(skip, f.path));
    const media = await mediaSetup(game, options, tools, log);
    const codecOf = (f) => codecFor(f.path, game, f.size);
    // 2026-11-25 (pacman-nx's finding; the user: "Yes fix"): a file that is already a stand-in (NAME.lz4b, NAME.xmop...:
    // a game folder this page made before, given back as the game's source) is copied as it is. Packed or re-encoded
    // again it would hide NAME behind a second layer (NAME.lz4b.lz4b), and indexed as a plain file the console would
    // find NAME.lz4b, not NAME.
    const already = (f) => standIn(f.path.slice(f.path.lastIndexOf('/') + 1)) !== null;
    const kindOf = (f) => (already(f) ? null : media.kind(f.path) || codecOf(f));
    let packPool = null;
    if (game_.some(kindOf)) {
      packPool = await tools.startPack(tools.cores);
      running.push(packPool);
      const v = (n) => `${Math.floor(n / 10000)}.${Math.floor(n / 100) % 100}.${n % 100}`;
      log(`LZ4 ${v(packPool.version)}` + (packPool.zxcVersion ? ` and ZXC ${v(packPool.zxcVersion)}` : '') +
          ` on ${tools.cores} threads for ${game_.filter(kindOf).length} files.`);
    }
    const compress = packPool ? packPool.run : null;
    const audioFiles = game.audio
      ? game_.map((f) => f.path).filter((p) => new RegExp(`^(?:${game.audio.match})$`, 'i').test(p)).sort() : [];
    const totalIn = nro.length + extras.reduce((n, f) => n + f.bytes.length, 0) + made.reduce((n, [, b]) => n + b.length, 0) +
                    game_.reduce((n, f) => n + f.size, 0) + dlc.reduce((n, f) => n + f.size, 0) +
                    updateFiles.reduce((n, u) => n + u.file.size, 0);
    let doneIn = 0;
    const zipStep = step('zip');
    const counted = (n) => { doneIn += n; zipStep(doneIn / totalIn); };
    // a guess at the zip's size (it is known only at the end): each re-encode's or codec's share (lib/media.js KEPT)
    start(totalIn - game_.reduce((n, f) => n + (kindOf(f) ? f.size * (1 - KEPT[kindOf(f)]) : 0), 0));
    const zip = new ZipWriter(sink);
    await zip.addBytes(`${root}/${game.nro}`, nro); counted(nro.length);
    for (const f of extras) { await zip.addBytes(`${root}/${f.path}`, f.bytes); counted(f.bytes.length); }
    for (const [name, bytes] of made) { await zip.addBytes(`${root}/${name}`, bytes); counted(bytes.length); }
    let packedIn = 0, packedOut = 0;
    const index = new VfsIndex();  // game_root's VFS index (lib/vfs_index.js), as the zip writes it
    const re = { hevc: { in: 0, out: 0, files: 0 }, xmop: { in: 0, out: 0, files: 0, sounds: 0 } };
    const keptWhy = new Map();
    let asIs = 0;
    const unsized = [];  // stand-ins whose header does not give the size they stand for: no index then
    for (const f of game_) {
      if (already(f)) {
        await zip.addFile(`${root}/game_root/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
        const held = await heldSizeOf(f);
        if (held === null) unsized.push(f.path); else index.add(f.path, f.size, held);
        asIs++;
        continue;
      }
      const kind = media.kind(f.path);
      if (kind) {
        const t0 = performance.now();
        const big = f.size > (8 << 20);
        if (big || kind === 'hevc') {
          log(`Re-encoding ${f.path} (${(f.size / 1048576).toFixed(0)} MB) to ${kind === 'xmop' ? 'Opus' : 'H.265'}...`);
        }
        let r;
        try {
          r = await reencodeInto(zip, `${root}/game_root`, f, kind, { game, setup: media, compress, cores: tools.cores,
                                                                       audioFiles, tools });
        } catch (e) {
          r = { why: e.message || String(e) };
        }
        if (r.name) {
          index.add(r.name, r.size, r.held);
          counted(f.size);
          re[kind].in += f.size;
          re[kind].out += r.size;
          re[kind].files++;
          if (kind === 'xmop') re.xmop.sounds += r.made;
          if (big || kind === 'hevc') {
            log(`  ${r.name}: ${(r.size / 1048576).toFixed(1)} MB (${(r.size / f.size * 100).toFixed(1)} %), ` +
                `${((performance.now() - t0) / 1000).toFixed(0)} s`);
          }
          continue;
        }
        const why = `${kind === 'xmop' ? 'sound files' : 'movies'} kept as they are: ${r.why}`;
        keptWhy.set(why, (keptWhy.get(why) || 0) + 1);
        if (kind === 'hevc') log(`  ${f.path} is kept as it is: ${r.why}`);
      }
      const codec = codecOf(f);
      if (codec) {
        const t0 = performance.now();
        const named = f.size > 50 * 1048576;
        if (named) log(`Packing ${f.path} (${(f.size / 1048576).toFixed(0)} MB, ${codec === 'zxc' ? 'ZXC' : 'LZ4'})...`);
        const size = await zip.addStream(`${root}/game_root/${f.path}${SUFFIX}`,
                                         pack(f, compress, { codec, inFlight: tools.cores * 4, onRaw: counted }));
        index.add(`${f.path}${SUFFIX}`, size, f.size);
        packedIn += f.size;
        packedOut += size;
        if (named) {
          const s = (performance.now() - t0) / 1000;
          log(`  ${f.path}${SUFFIX}: ${(size / 1048576).toFixed(0)} MB (${(size / f.size * 100).toFixed(1)} %), ${s.toFixed(0)} s`);
        }
      } else {
        await zip.addFile(`${root}/game_root/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
        index.add(f.path, f.size);
      }
    }
    // 2026-11-24 (the user: "why can't the installer build the folder scan index itself"): game_root's VFS index, so the
    // first start skips the full scan (the console checks it against the card and scans if anything differs). game.json
    // "vfs_index": false leaves it out (a port whose NRO is older than the base's port 264 cannot read it anyway).
    if (asIs) log(`${asIs} files of the game folder were already packed or re-encoded (a folder this page made before): copied as they are.`);
    if (game.vfs_index !== false && unsized.length) {
      log(`The game folder's index is left out: ${unsized.length} already-made file${unsized.length > 1 ? 's' : ''} ` +
          `(${unsized[0]}${unsized.length > 1 ? ', ...' : ''}) do${unsized.length > 1 ? '' : 'es'} not give the size ` +
          'they stand for in their headers, so the first start scans the folder instead.');
    } else if (game.vfs_index !== false) {
      const bytes = index.bytes(`/switch/${game.package}/game_root`);
      await zip.addBytes(`${root}/cache/vfs_index_game_root.bin`, bytes);
      report.vfsIndexBytes = bytes.length;
      log(`The game folder's index: ${(bytes.length / 1024).toFixed(0)} KB (the first start skips the folder scan).`);
    }
    for (const [why, n] of keptWhy) log(`${n} ${why}`);
    for (const u of updateFiles) await zip.addFile(`${root}/${u.to}`, u.file.size, chunks(u.file), (c) => counted(c.length));
    if (updateFiles.length) log(`${game.update?.title || 'The title update'}: ${updateFiles.length} files.`);
    for (const f of dlc) await zip.addFile(`${root}/dlc/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
    report.size = await zip.finish();
    stopAll();
    if (packedIn) {
      log(`Packed ${(packedIn / 1048576).toFixed(0)} MB to ${(packedOut / 1048576).toFixed(0)} MB: ` +
          `${((packedIn - packedOut) / 1048576).toFixed(0)} MB smaller on the SD card.`);
    }
    if (re.hevc.files) {
      log(`The movies as H.265: ${re.hevc.files} files, ${(re.hevc.in / 1048576).toFixed(0)} MB to ` +
          `${(re.hevc.out / 1048576).toFixed(0)} MB.`);
    }
    if (re.xmop.files) {
      log(`The sounds as Opus: ${re.xmop.files} files (${re.xmop.sounds} sounds), ${(re.xmop.in / 1048576).toFixed(0)} MB to ` +
          `${(re.xmop.out / 1048576).toFixed(0)} MB.`);
    }
    Object.assign(report, { build: build.edition, packedIn, packedOut, reencoded: re, seconds: seconds() });
    return report;
  } catch (error) {
    stopAll();
    throw error;
  }
}
