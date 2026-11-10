// renut_nx_ultimate_installer: the shader chain (lib/build.js makeGlsl on test/glsl_worker_node.mjs threads) on a few of a
// port's dumped containers, against its native GLSL: a quick check after rebuilding wasm/renut_hlsl or syncing py/.
//   node test/chain_sample_node.mjs <port's out/renut_shader_dump> <port's native glsl_opt> [count] [--threads=N]
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeGlsl } from '../lib/build.js';
import { glslMaker, workerPool } from '../lib/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const [dumpDir, nativeDir, countArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const threads = Number((process.argv.find((a) => a.startsWith('--threads=')) || '--threads=4').slice(10));
const names = fs.readdirSync(dumpDir).filter((n) => /^(vs|ps)_[0-9a-f]{16}\.bin$/.test(n)).sort();
const step = Math.max(1, Math.floor(names.length / Number(countArg || 12)));
const picked = names.filter((_, i) => i % step === 0).slice(0, Number(countArg || 12));
const containers = picked.map((n) => new Uint8Array(fs.readFileSync(path.join(dumpDir, n))));

const workers = await Promise.all(Array.from({ length: threads }, async () => {
  const w = new Worker(path.join(here, 'glsl_worker_node.mjs'));
  await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
  return { post: (m, t) => w.postMessage(m, t), onMessage: (cb) => w.on('message', cb), w };
}));
const tr = await (await import(pathToFileURL(path.join(root, 'wasm', 'renut_hlsl.mjs')).href)).default({ print: () => {}, printErr: () => {} });
const errors = [];
const t0 = performance.now();
const { shaders, failed } = await makeGlsl(containers, tr, glslMaker(workerPool(workers)),
                                           fs.readFileSync(path.join(root, 'release', 'shader_common.h')), console.log, null,
                                           (e) => errors.push(e));
workers.forEach((x) => x.w.terminate());
let same = 0;
const differ = [];
for (const s of shaders) {
  const native = path.join(nativeDir, `${s.name}.glsl`);
  if (fs.existsSync(native) && fs.readFileSync(native, 'utf8') === new TextDecoder().decode(s.glsl)) same++;
  else differ.push(s.name);
}
console.log(`${picked.length} containers in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${shaders.length} made, ${failed} failed` +
            `${errors.length ? ` (${errors.slice(0, 3).join('; ')})` : ''}; ${same} the native GLSL byte for byte, ${differ.length} differ` +
            (differ.length ? ` (${differ.join(', ')})` : ''));
process.exit(0);
