// renut_nx_ultimate_installer: pack_worker.js on a Node worker thread, for test/full_node.mjs (the page's runs on a Web
// Worker): LZ4 HC (wasm/lz4.mjs) and ZXC (wasm/zxc.mjs). Answers { id, bytes, codec, level, block } with { id, bytes }.
// 2026-11-23: in place of lz4_worker_node.mjs (LZ4 only); an LZ4 block comes out as that one made it.
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (f) => (await import(pathToFileURL(path.join(root, 'wasm', f)).href)).default;
const [lz4, zxc] = await Promise.all([(await load('lz4.mjs'))(), (await load('zxc.mjs'))()]);
const room = { lz4: { size: 0, src: 0, dst: 0 }, zxc: { size: 0, src: 0, dst: 0 } };

function buffers(name, m, size, dstSize) {
  const r = room[name];
  if (size > r.size) {
    if (r.src) { m[`_${name}_free`](r.src); m[`_${name}_free`](r.dst); }
    r.size = size;
    r.src = m[`_${name}_malloc`](size);
    r.dst = m[`_${name}_malloc`](dstSize);
  }
  return r;
}

parentPort.on('message', ({ id, bytes, codec, level, block }) => {
  let n, m, r;
  if (codec === 'zxc') {
    m = zxc;
    r = buffers('zxc', zxc, bytes.length, zxc._zxc_bound(Math.max(bytes.length, block)));
    zxc.HEAPU8.set(bytes, r.src);
    n = zxc._zxc_pack(r.src, bytes.length, r.dst, zxc._zxc_bound(bytes.length), level, block);
  } else {
    m = lz4;
    r = buffers('lz4', lz4, bytes.length, bytes.length);
    lz4.HEAPU8.set(bytes, r.src);
    // room for one byte less than the block: 0 back means it does not get smaller, and the block is stored as it is
    n = lz4._lz4_compress(r.src, bytes.length, r.dst, bytes.length - 1, level);
  }
  const out = n > 0 ? m.HEAPU8.slice(r.dst, r.dst + n) : bytes;
  parentPort.postMessage({ id, bytes: out }, [out.buffer]);
});
parentPort.postMessage({ ready: true, version: lz4._lz4_version(), zxcVersion: zxc._zxc_version() });
