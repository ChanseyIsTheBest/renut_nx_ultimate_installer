// renut_nx_ultimate_installer: one LZ4 HC compressor (wasm/lz4.mjs) on a Node worker thread, for test/full_node.mjs
// (the page's is lz4_worker.js on a Web Worker). Answers { id, bytes } with { id, bytes }.
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: createLz4Module } = await import(pathToFileURL(path.join(root, 'wasm', 'lz4.mjs')).href);
const lz4 = await createLz4Module();
let capacity = 0, src = 0, dst = 0;
parentPort.on('message', ({ id, bytes, level }) => {
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
  parentPort.postMessage({ id, bytes: out }, [out.buffer]);
});
parentPort.postMessage({ ready: true, version: lz4._lz4_version() });
