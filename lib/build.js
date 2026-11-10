// renut_nx_ultimate_installer (from kameo-nx-installer's, banjo-nx-installer's): the game shaders from the player's
// files, as the ultimate base's native build makes them (its tools/switch_shaders.ps1), for an NRO that carries none:
//   1. lib/sources.js finds the containers (default.xex and the records of release/manifest.json);
//   2. the translator (wasm/renut_hlsl) writes each one's HLSL and the numbers of the NRO's shader table;
//   3. renut_early_alpha.py rewrites the pixel shaders (in Pyodide, as the native build's first run);
//   4. DXC, SPIRV-Cross, deko3d_glsl.py and deko3d_glsl_opt.py turn the HLSL into uam's GLSL (lib/chain.js);
//   5. lib/package.js writes deko3d_glsl.bin (version 2), and the variants of release/variants.txt (plus each shader as
//      it is, the console's fallback while a variant compiles) are compiled by uam (lib/uam.js) into the console's
//      DKSH cache, deko3d_shaders.bin (lib/variants.js).
// Used by lib/install.js (the page's worker and test/full_node.mjs alike).
import { parseNumbers, writeInstalledPackage } from './package.js';
import { declaredPairs, fnv1a64, variantText, writeCache } from './variants.js';

const BATCH = 400;  // containers translated at a time: the HLSL of all of them is about 200 MB

// containers -> [{ name, glsl (UTF-8 bytes), numbers }]. tr: the translator (Emscripten module; fast, so one here),
// shaderCommon: its shader_common.h (bytes), glsl(name, hlsl) -> Promise<UTF-8 GLSL>: steps 3-4 on a pool of workers
// (lib/glsl_job.js, about 0.9 s a shader each).
export async function makeGlsl(containers, tr, glsl, shaderCommon, log, progress, onError) {
  const shaders = [];
  let failed = 0, done = 0;
  tr.FS.writeFile('/shader_common.h', shaderCommon);
  for (let b = 0; b * BATCH < containers.length; ++b) {
    const batch = containers.slice(b * BATCH, (b + 1) * BATCH);
    const inDir = `/in${b}`, outDir = `/out${b}`;
    tr.FS.mkdir(inDir);
    batch.forEach((c, i) => tr.FS.writeFile(`${inDir}/${i}.bin`, c));
    tr.callMain([inDir, outDir, '/shader_common.h']);
    const names = tr.FS.readdir(outDir).filter((f) => f.endsWith('.hlsl')).map((f) => f.slice(0, -5)).sort();
    if (names.length !== batch.length) {
      failed += batch.length - names.length;
      onError?.(`translator: ${batch.length - names.length} of ${batch.length} not translated`);
    }
    const jobs = names.map((n) => {
      const hlsl = tr.FS.readFile(`${outDir}/${n}.hlsl`, { encoding: 'utf8' });
      const numbers = parseNumbers(tr.FS.readFile(`${outDir}/${n}.txt`, { encoding: 'utf8' }));
      tr.FS.unlink(`${outDir}/${n}.hlsl`);
      tr.FS.unlink(`${outDir}/${n}.txt`);
      return glsl(n, hlsl).then(
        (bytes) => shaders.push({ name: n, glsl: bytes, numbers }),
        (e) => { failed++; onError?.(`${n}: ${e.message}`); },
      ).finally(() => progress?.(++done / containers.length));
    });
    batch.forEach((_, i) => tr.FS.unlink(`${inDir}/${i}.bin`));
    tr.FS.rmdir(inDir);
    tr.FS.rmdir(outDir);
    await Promise.all(jobs);
  }
  shaders.sort((a, b) => (a.name < b.name ? -1 : 1));
  log?.(`${shaders.length} shaders made${failed ? `, ${failed} failed` : ''}`);
  return { shaders, failed };
}

export function packageShaders(shaders) {
  const dec = new TextDecoder();
  return writeInstalledPackage(shaders.map((s) => ({ name: s.name, glsl: dec.decode(s.glsl), numbers: s.numbers })));
}

// The compile jobs: every variant of release/variants.txt whose shader there is, and each shader as it is.
// glslOf: Map(stem -> UTF-8 GLSL) (the shaders made, and the NRO's own: release/runtime_glsl.json).
// Returns [{ key (BigInt), stage, text }] in a stable order, each key once.
export function variantJobs(variants, glslOf) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  const jobs = [];
  const keys = new Set();
  let skipped = 0;
  const add = (stem, stage, pairs) => {
    const glsl = glslOf.get(stem);
    if (!glsl) { skipped++; return; }
    const source = dec.decode(glsl);
    const text = variantText(source, declaredPairs(source, pairs));  // renut-nx (2026-11-01): as the console does
    const key = fnv1a64(enc.encode(text));
    if (keys.has(key)) return;
    keys.add(key);
    jobs.push({ key, stage, text });
  };
  for (const v of variants) add(v.stem, v.stage, v.pairs);
  for (const stem of [...glslOf.keys()].sort()) add(stem, stem.startsWith('ps_') ? 4 : 0, []);
  return { jobs, skipped };
}

// Compiles the jobs with compile(stage, text) -> Promise<{ dksh } | { error }> (one uam, or a pool of workers), at
// most `parallel` at a time. Returns the cache file and the failures.
export async function compileVariants(jobs, compile, parallel, progress) {
  const cache = new Map();
  const failures = [];
  let next = 0, done = 0;
  const run = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await compile(job.stage, job.text);
      if (r.error) failures.push({ key: job.key, error: r.error });
      else cache.set(job.key, r.dksh);
      progress?.(++done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: parallel }, run));
  return { cache: writeCache(cache), compiled: cache.size, failures };
}
