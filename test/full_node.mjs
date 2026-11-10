// renut_nx_ultimate_installer: the page's whole build (lib/install.js) in Node, on a game folder, into a zip:
//   node test/full_node.mjs <game folder> <out.zip> [--dlc=<folder>] [--no-compile] [--threads=N] [--glsl-threads=N]
//        [--native-glsl=<the port's glsl_opt folder>] [--reference]
// --native-glsl counts the shaders whose GLSL is the native chain's byte for byte (the rest differ by DXC's version:
// the page's DXC is v2025.1, the native build's 1.8.2407). --reference writes the shader files' SHA-256 into the build's
// entry of release/manifest.json (the page then says whether the player's are the release's).
// The zip and everything in it are game data: never commit or share them.
import fs from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackage, findBuild } from '../lib/install.js';
import { glslMaker, uamCompile, workerPool } from '../lib/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const [gameDir, outZip] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes(`--${k}`);
if (!gameDir || !outZip) {
  console.error('usage: node test/full_node.mjs <game folder> <out.zip> [--dlc=<folder>] [--no-compile] [--native-glsl=<folder>] [--reference]');
  process.exit(2);
}
const T0 = performance.now();
const stamp = () => `[${((performance.now() - T0) / 1000).toFixed(0).padStart(4)} s]`;
let shown = 0;

// the files of a folder as the page sees them: { path (with /), size, read(offset, length) }
function folderFiles(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => fs.statSync(path.join(dir, p)).isFile()).sort()
    .map((p) => {
      const full = path.join(dir, p);
      return {
        path: p.split(path.sep).join('/'),
        size: fs.statSync(full).size,
        read: async (offset, length) => {
          const fd = fs.openSync(full, 'r');
          try {
            const buf = Buffer.alloc(length);
            const n = fs.readSync(fd, buf, 0, length, offset);
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
          } finally { fs.closeSync(fd); }
        },
      };
    });
}

// count workers of a test/*_node.mjs script, each started and ready, as lib/install.js takes them
async function tool(script, count, wrap) {
  const workers = await Promise.all(Array.from({ length: count }, async () => {
    const w = new Worker(path.join(here, script));
    const ready = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    return { post: (m, t) => w.postMessage(m, t), onMessage: (cb) => w.on('message', cb), w, version: ready.version };
  }));
  return { run: wrap(workerPool(workers)), version: workers[0].version, stop: () => workers.forEach((x) => x.w.terminate()) };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const game = readJson(path.join(root, 'game.json'));
const manifestPath = path.join(root, 'release', 'manifest.json');
const manifest = readJson(manifestPath);
const imp = async (f) => (await import(pathToFileURL(path.join(root, 'wasm', f)).href)).default;
const quiet = () => ({ print: () => {}, printErr: () => {} });
const cores = Number(opt('threads', Math.max(1, availableParallelism() - 1)));
const tools = {
  cores,
  glslThreads: Number(opt('glsl-threads', Math.min(cores, 8))),
  translator: game.shaders ? await (await imp('renut_hlsl.mjs'))(quiet()) : null,
  lzx: game.shaders ? await (await imp('lzx.mjs'))(quiet()) : null,
  startGlsl: (n) => tool('glsl_worker_node.mjs', n, glslMaker),
  startUam: (n) => tool('uam_worker_node.mjs', n, uamCompile),
  startLz4: (n) => tool('lz4_worker_node.mjs', n, (pool) => (bytes, level) =>
    pool.run({ bytes, level }, [bytes.buffer]).then((r) => r.bytes)),
};
const fetchRelease = async (name, hash) => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(root, 'release', name)));
  const got = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  if (hash && got !== hash) throw new Error(`release/${name} is not the one the manifest names (${got})`);
  return bytes;
};
const fd = fs.openSync(outZip, 'w');
const sink = { write: async (bytes) => { fs.writeSync(fd, bytes); }, close: async () => {} };
// the shader files as they go into the zip, for the native comparison
const files = folderFiles(gameDir);
const dlcDir = opt('dlc', '');
const report = await buildPackage({
  game, manifest, files, dlc: dlcDir ? folderFiles(dlcDir) : [], fetchRelease, tools, sink, compile: !flag('no-compile'),
  events: {
    log: (t) => console.log(`${stamp()} ${t}`),
    progress: (f) => { const now = performance.now(); if (now - shown > 20000 || f === 1) { shown = now; console.log(`${stamp()} ${(100 * f).toFixed(0)} %`); } },
  },
});
fs.closeSync(fd);
const { glsl, ...summary } = report;
console.log(`${stamp()} ${outZip}: ${report.size.toLocaleString()} bytes; ${JSON.stringify(summary)}`);

const nativeGlsl = opt('native-glsl', '');
if (nativeGlsl && glsl) {
  // the GLSL the page made against the native chain's (the port's out/deko3d_shaders/glsl_opt)
  const dec = new TextDecoder();
  let same = 0, absent = 0;
  const differ = [];
  for (const s of glsl) {
    const p = path.join(nativeGlsl, `${s.name}.glsl`);
    if (!fs.existsSync(p)) { absent++; continue; }
    if (fs.readFileSync(p, 'utf8') === dec.decode(s.glsl)) same++; else differ.push(s.name);
  }
  console.log(`native GLSL (${nativeGlsl}): ${same} the same, ${differ.length} differ, ${absent} not there` +
              (differ.length ? ` (${differ.slice(0, 6).join(', ')}${differ.length > 6 ? ', ...' : ''})` : ''));
  const keep = opt('keep-glsl', '');
  if (keep) {
    fs.mkdirSync(keep, { recursive: true });
    for (const s of glsl) fs.writeFileSync(path.join(keep, `${s.name}.glsl`), s.glsl);
  }
}
if (flag('reference')) {
  const { build } = await findBuild(manifest, files);
  build.deko3d_glsl_sha256 = report.glslSha256;
  if (report.cacheSha256) build.deko3d_shaders_sha256 = report.cacheSha256;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`release/manifest.json: the reference shader files of ${build.edition} written`);
}
process.exit(0);
