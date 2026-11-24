// rr6-nx-installer (2026-11-10): a game file as compressed blocks (.lz4b), written as a stream. The base's
// sdk/include/rex/filesystem/lz4_blocks.h has the format and reads it on the console (port 61: version 1, LZ4; port 259:
// version 2, ZXC); the base's tools/lz4b_pack.py (LZ4) and tools/zxcb_pack.cpp (ZXC) make the same files on a PC,
// tools/test_lz4_blocks.cpp checks either. Little-endian:
//   header, 32 bytes:  "RXLZ4BLK", u32 version (1: LZ4 blocks, 2: ZXC blocks), u32 block size, u64 size of the file,
//                      u32 block count, u32 0
//   the blocks:        each block's LZ4 or ZXC data back to back; a block that does not get smaller is stored as it is
//                      (its stored size then equals its length)
//   the index:         u32 per block, its stored size
//   footer, 16 bytes:  u64 offset of the index, "RXLZ4END"
// The blocks are compressed on several workers (pack_worker.js: LZ4 1.10.0's HC and ZXC 0.15.0 in WebAssembly) and
// written in order.
//
// renut_nx_ultimate_installer (2026-11-23, the user: "re-encoding katamari's audio and video (ZXC compress the video)
// and L4Z/ZXC compressing the other files"): rr6-nx-installer's and vivapinata-nx-installer's codecs (credit both; the
// base's docs/media-compression.md section 4 has the measurements). game.json picks a file's codec (codecFor):
//   lz4   LZ4 HC level 9 in 256 KB blocks (version 1): what a load screen reads (LZ4's decoder: ~590 MB/s on the
//         console). Byte for byte what this page wrote before ZXC was added (port 61's files).
//   lz4s  LZ4 HC level 9 in 64 KB blocks: a large file the game reads a few KB at a time at random places.
//   zxc   ZXC level 7 in 512 KB blocks (version 2): what is read while playing, or rarely: the movies (~200 MB/s).
export const CODECS = {
  lz4: { version: 1, block: 256 * 1024, level: 9 },
  lz4s: { version: 1, block: 64 * 1024, level: 9 },
  zxc: { version: 2, block: 512 * 1024, level: 7 },
};
export const BLOCK = CODECS.lz4.block;  // the user's choice: 256 KB blocks
export const LEVEL = CODECS.lz4.level;  // LZ4 HC level 9
export const SUFFIX = '.lz4b';

const fitsAny = (list, path) => (list || []).some((m) => new RegExp(`^(?:${m})$`, 'i').test(path));

// The codec for a file of the game folder ('lz4', 'lz4s', 'zxc'), or null to copy it as it is, by game.json's lists
// (RegExp sources of paths in the game folder, '/' separators, case-insensitive): `asis` first (never packed), then
// `lz4_small`, `zxc`, `lz4`; and none for a file under `min_pack_size` bytes (sasrt-nx-installer's and
// vivapinata-nx-installer's rules, credit both).
export function codecFor(path, config, size = Infinity) {
  if (fitsAny(config.asis, path)) return null;
  if (size < (config.min_pack_size ?? 0)) return null;
  if (fitsAny(config.lz4_small, path)) return 'lz4s';
  if (fitsAny(config.zxc, path)) return 'zxc';
  if (fitsAny(config.lz4, path)) return 'lz4';
  return null;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function header(size, block = BLOCK, version = 1) {
  const h = new Uint8Array(32);
  const v = new DataView(h.buffer);
  h.set(ascii('RXLZ4BLK'), 0);
  v.setUint32(8, version, true);
  v.setUint32(12, block, true);
  v.setBigUint64(16, BigInt(size), true);
  v.setUint32(24, Math.ceil(size / block), true);
  return h;
}

export function trailer(sizes, indexOffset) {
  const t = new Uint8Array(sizes.length * 4 + 16);
  const v = new DataView(t.buffer);
  sizes.forEach((s, i) => v.setUint32(i * 4, s, true));
  v.setBigUint64(sizes.length * 4, BigInt(indexOffset), true);
  t.set(ascii('RXLZ4END'), sizes.length * 4 + 8);
  return t;
}

// The .lz4b file of `file` ({ size, read(offset, length) -> Promise<Uint8Array> }) as an async iterable of chunks.
// compress(bytes, codec) -> Promise<Uint8Array>: the block compressed with that codec (CODECS), or the block itself
// when that is not smaller. onRaw(n): n more bytes of the original read and packed (for a progress bar).
export async function* pack(file, compress, { codec = 'lz4', inFlight = 64, onRaw = null } = {}) {
  const { block, version } = CODECS[codec];
  const count = Math.ceil(file.size / block);
  const sizes = [];
  let offset = 32;
  yield header(file.size, block, version);
  const queue = [];
  // The original is read in runs of READ blocks (8 MB of LZ4's), the next run always on its way while the workers
  // compress: one block at a time, the reads were the limit (2 MB/s through the test server).
  const READ = 32;
  inFlight = Math.max(inFlight, READ * 2);
  let nextRead = 0;
  let pending = null;
  const readAhead = () => {
    if (pending || nextRead >= count) return;
    const first = nextRead;
    const last = Math.min(count, first + READ);
    const start = first * block;
    pending = file.read(start, Math.min(file.size, last * block) - start).then((bytes) => ({ first, last, bytes }));
    nextRead = last;
  };
  readAhead();
  while (sizes.length < count) {
    // keep up to inFlight blocks at the workers
    while (pending && queue.length + READ <= inFlight) {
      const { first, last, bytes } = await pending;
      pending = null;
      readAhead();
      for (let b = first; b < last; ++b) {
        const raw = bytes.slice((b - first) * block, Math.min(bytes.length, (b - first + 1) * block));
        const length = raw.length;  // before compress(): it may hand raw's buffer to a worker
        queue.push(compress(raw, codec).then((out) => ({ out, length })));
      }
    }
    const { out, length } = await queue.shift();
    if (out.length > length) throw new Error('a compressed block came back larger than the block');
    sizes.push(out.length);
    offset += out.length;
    if (onRaw) onRaw(length);
    yield out;
  }
  yield trailer(sizes, offset);
}

// The packed size is only known once packed: the zip entry takes the chunks as they come (lib/zip.js addStream).
