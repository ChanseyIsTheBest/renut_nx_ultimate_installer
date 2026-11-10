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
//      packages under dlc/, streamed to `sink` as it is written (its size is known only at the end).
import { compileVariants, makeGlsl, packageShaders, variantJobs } from './build.js';
import { pack, SUFFIX } from './lz4b.js';
import { nroShaders } from './nro.js';
import { gameContainers, sha256 } from './sources.js';
import { parseVariants } from './variants.js';
import { ZipWriter } from './zip.js';

// The game.json patterns: case-insensitive regular expressions on a file's path in the game folder.
const patterns = (list) => (list || []).map((p) => new RegExp(`^(?:${p})$`, 'i'));
const matches = (res, path) => res.some((re) => re.test(path));

async function* chunks(file, size = 8 << 20) {
  for (let at = 0; at < file.size; at += size) yield await file.read(at, Math.min(size, file.size - at));
}

// The build of release/manifest.json this default.xex is, or throws.
export async function findBuild(manifest, files) {
  const xex = files.find((f) => f.path.toLowerCase() === 'default.xex');
  if (!xex) throw new Error('no default.xex in the folder: choose the folder the game was extracted to, or the disc image');
  const bytes = await xex.read(0, xex.size);
  const hash = await sha256(bytes);
  const build = manifest.builds.find((b) => b.xex_sha256 === hash);
  if (!build) throw new Error(`this default.xex is not one this release supports (SHA-256 ${hash})`);
  return { build, xex: bytes };
}

// game: game.json; manifest: release/manifest.json; files, dlc: [{ path, size, read(offset, length) }];
// fetchRelease(name, sha256) -> bytes (checked); sink: { write(bytes), close() }; compile: make the DKSH cache;
// tools: { translator, lzx (Emscripten modules), cores, glslThreads, startGlsl(n), startUam(n), startLz4(n) }, each
// start returning { run, version?, stop() } over n workers (lib/pool.js): glsl run(name, hlsl) -> UTF-8 GLSL,
// uam run(stage, text) -> { dksh } | { error }, lz4 run(bytes, level) -> bytes.
// events: { log(text), progress(fraction), start(estimate of the zip's size) }. Returns what it did.
export async function buildPackage({ game, manifest, files, dlc = [], fetchRelease, tools, sink, compile = true, events }) {
  const { log = () => {}, progress = () => {}, start = () => {} } = events || {};
  const began = performance.now();
  const seconds = () => Math.round((performance.now() - began) / 1000);
  const root = `switch/${game.package}`;
  const report = {};
  const running = [];
  const stopAll = () => { for (const r of running.splice(0)) r.stop(); };
  try {
    const { build, xex } = await findBuild(manifest, files);
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
      const containers = await gameContainers(files, xex, shaders, tools.lzx, log);
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
    const lz4 = patterns(game.lz4), skip = patterns(game.skip);
    const game_ = files.filter((f) => !matches(skip, f.path));
    const toPack = game_.filter((f) => matches(lz4, f.path));
    let lz4Pool = null;
    if (toPack.length) {
      lz4Pool = await tools.startLz4(tools.cores);
      running.push(lz4Pool);
      const v = lz4Pool.version;
      log(`LZ4 ${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100} on ${tools.cores} threads for ${toPack.length} file${toPack.length === 1 ? '' : 's'}.`);
    }
    const totalIn = nro.length + extras.reduce((n, f) => n + f.bytes.length, 0) + made.reduce((n, [, b]) => n + b.length, 0) +
                    game_.reduce((n, f) => n + f.size, 0) + dlc.reduce((n, f) => n + f.size, 0);
    let doneIn = 0;
    const zipStep = step('zip');
    const counted = (n) => { doneIn += n; zipStep(doneIn / totalIn); };
    start(totalIn - toPack.reduce((n, f) => n + f.size, 0) * 0.4);  // a guess: packing saves 20-65 %
    const zip = new ZipWriter(sink);
    await zip.addBytes(`${root}/${game.nro}`, nro); counted(nro.length);
    for (const f of extras) { await zip.addBytes(`${root}/${f.path}`, f.bytes); counted(f.bytes.length); }
    for (const [name, bytes] of made) { await zip.addBytes(`${root}/${name}`, bytes); counted(bytes.length); }
    let packedIn = 0, packedOut = 0;
    for (const f of game_) {
      if (lz4Pool && matches(lz4, f.path)) {
        const t0 = performance.now();
        log(`Packing ${f.path} (${(f.size / 1048576).toFixed(0)} MB)...`);
        const size = await zip.addStream(`${root}/game_root/${f.path}${SUFFIX}`,
                                         pack(f, lz4Pool.run, { inFlight: tools.cores * 4, onRaw: counted }));
        packedIn += f.size;
        packedOut += size;
        const s = (performance.now() - t0) / 1000;
        log(`  ${f.path}${SUFFIX}: ${(size / 1048576).toFixed(0)} MB (${(size / f.size * 100).toFixed(1)} %), ${s.toFixed(0)} s`);
      } else {
        await zip.addFile(`${root}/game_root/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
      }
    }
    for (const f of dlc) await zip.addFile(`${root}/dlc/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
    report.size = await zip.finish();
    stopAll();
    if (packedIn) {
      log(`Packed ${(packedIn / 1048576).toFixed(0)} MB to ${(packedOut / 1048576).toFixed(0)} MB: ` +
          `${((packedIn - packedOut) / 1048576).toFixed(0)} MB smaller on the SD card.`);
    }
    Object.assign(report, { build: build.edition, packedIn, packedOut, seconds: seconds() });
    return report;
  } catch (error) {
    stopAll();
    throw error;
  }
}
