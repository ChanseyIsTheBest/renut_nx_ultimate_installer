// rr6-nx-installer (2026-11-11): one packing worker, both codecs in WebAssembly: LZ4 HC (wasm/lz4.mjs, LZ4 1.10.0) and
// ZXC (wasm/zxc.mjs, ZXC 0.15.0); lib/lz4b.js has the codecs and game.json picks a file's. Answers
// { id, bytes, codec, level, block } with { id, bytes }: the block compressed, or the block itself when that is not
// smaller ('lz4' and 'lz4s' are LZ4 at `level`, 'zxc' ZXC at `level` in `block`-byte blocks).
// renut_nx_ultimate_installer (2026-11-23): vivapinata-nx-installer's (credit it and rr6-nx-installer) in place of
// lz4_worker.js (LZ4 only); an LZ4 block comes out byte for byte as lz4_worker.js made it.
import createLz4Module from './wasm/lz4.mjs';
import createZxcModule from './wasm/zxc.mjs';

const [lz4, zxc] = await Promise.all([createLz4Module(), createZxcModule()]);
const room = { lz4: { size: 0, src: 0, dst: 0 }, zxc: { size: 0, src: 0, dst: 0 } };

// The module's source and destination buffers for a block of `size` bytes, grown as needed.
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

self.onmessage = ({ data }) => {
  const { id, bytes, codec, level, block } = data;
  let n;
  let m;
  let r;
  if (codec === 'zxc') {
    m = zxc;
    r = buffers('zxc', zxc, bytes.length, zxc._zxc_bound(Math.max(bytes.length, block)));
    zxc.HEAPU8.set(bytes, r.src);
    // 0 back: it failed or is not smaller, and the block is stored as it is
    n = zxc._zxc_pack(r.src, bytes.length, r.dst, zxc._zxc_bound(bytes.length), level, block);
  } else {
    m = lz4;
    r = buffers('lz4', lz4, bytes.length, bytes.length);
    lz4.HEAPU8.set(bytes, r.src);
    // room for one byte less than the block: 0 back means it does not get smaller, and the block is stored as it is
    n = lz4._lz4_compress(r.src, bytes.length, r.dst, bytes.length - 1, level);
  }
  const out = n > 0 ? m.HEAPU8.slice(r.dst, r.dst + n) : bytes;
  self.postMessage({ id, bytes: out }, [out.buffer]);
};
self.postMessage({ ready: true, version: lz4._lz4_version(), zxcVersion: zxc._zxc_version() });
