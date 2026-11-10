// rr6-nx-installer (2026-11-10): one LZ4 HC compressor (wasm/lz4.mjs, LZ4 1.10.0) on a worker of its own. Answers
// { id, bytes } with { id, bytes }: the block compressed at `level`, or the block itself when that is not smaller.
import createLz4Module from './wasm/lz4.mjs';

const lz4 = await createLz4Module();
let capacity = 0, src = 0, dst = 0;

self.onmessage = ({ data }) => {
  const { id, bytes, level } = data;
  if (bytes.length > capacity) {
    if (src) { lz4._lz4_free(src); lz4._lz4_free(dst); }
    capacity = bytes.length;
    src = lz4._lz4_malloc(capacity);
    dst = lz4._lz4_malloc(capacity);
  }
  lz4.HEAPU8.set(bytes, src);
  // room for one byte less than the block: 0 back means it does not get smaller, and the block is stored as it is
  const n = lz4._lz4_compress(src, bytes.length, dst, bytes.length - 1, level);
  const out = n > 0 ? lz4.HEAPU8.slice(dst, dst + n) : bytes;
  self.postMessage({ id, bytes: out }, [out.buffer]);
};
self.postMessage({ ready: true, version: lz4._lz4_version() });
