// renut_nx_ultimate_installer: where the page finds the game's shader containers (the 0x102A11xx blobs
// D3DDevice_Create*Shader receives, which Renut's translator turns into the NRO's shaders), as the build's manifest
// entry lists them ("shaders": tools/make_release.py writes it from the port's out/renut_shader_dump):
//   image_sha256  the containers stored in default.xex: found by scanning its decrypted, decompressed image (lib/xex.js,
//                 the LZX step in wasm/lzx), kept when their SHA-256 is listed;
//   records       the containers inside the game's own files: per record, the file, where it is (offset, stored size),
//                 how it is coded (CODECS) and where each container sits in the decoded bytes, with its SHA-256. A port
//                 whose game keeps shaders in its files writes these with a tool of its own (katamari-nx's
//                 tools/katamari_shader_files.py) and adds its coding here if it is a new one.
// From katamari-nx-installer's lib/installer.js and lib/shaders.js (gameContainers, imageContainers), GPL-3.0.
import { decompressCpdb } from './cpdb.js';
import { readXexImage } from './xex.js';

function be32(data, offset) {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The containers of an executable image: aligned to 4 bytes, signature 0x102A1101 (vertex) or 0x102A1100 (pixel), then
// the sizes of the header and of the microcode. Candidates only: the manifest lists the real ones by SHA-256.
export function imageContainers(image) {
  const found = [];
  for (let off = 0; off < image.length - 12; off += 4) {
    const magic = be32(image, off);
    if (magic !== 0x102a1101 && magic !== 0x102a1100) continue;
    const header = be32(image, off + 4);
    const ucode = be32(image, off + 8);
    if (header < 12 || header > 1 << 16 || ucode === 0 || ucode > 1 << 20 || ucode % 4) continue;
    if (off + header + ucode > image.length) continue;
    found.push(image.slice(off, off + header + ucode));
  }
  return found;
}

// The LZX step of readXexImage, by libmspack in WebAssembly (wasm/lzx.mjs).
export function lzxStep(lzx) {
  return async (compressed, bits, size) => {
    lzx.FS.writeFile('/image.lzx', compressed);
    const rc = lzx.callMain(['/image.lzx', '/image.bin', String(bits), String(size)]);
    if (rc) throw new Error(`LZX decompression failed (${rc})`);
    const out = lzx.FS.readFile('/image.bin');
    lzx.FS.unlink('/image.lzx');
    lzx.FS.unlink('/image.bin');
    return out;
  };
}

// How a record's stored bytes become the bytes its containers sit in. (stored, record) -> Promise<Uint8Array>.
export const CODECS = {
  raw: async (stored, r) => stored.subarray(0, r.size),
  // Beautiful Katamari's CPDB blocks (katamari-nx's tools/cpdb.py; lib/cpdb.js)
  cpdb: async (stored) => decompressCpdb(stored),
  // a zlib stream (Kameo's CAFF sections and many others)
  zlib: async (stored) => new Uint8Array(await new Response(new Blob([stored]).stream()
    .pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()),
};

// files: [{ path, size, read(offset, length) }] (the game folder); xex: default.xex's bytes; shaders: the build's
// "shaders" entry; lzx: the LZX module. Returns [Uint8Array] (each container once), or throws when one is missing.
export async function gameContainers(files, xex, shaders, lzx, log = () => {}) {
  const containers = [];
  const seen = new Set();
  const wanted = new Set(shaders.image_sha256 || []);
  if (wanted.size) {
    const { image } = await readXexImage(xex, lzxStep(lzx));
    for (const c of imageContainers(image)) {
      const hash = await sha256(c);
      if (wanted.has(hash) && !seen.has(hash)) {
        seen.add(hash);
        containers.push(c);
      }
    }
    log(`default.xex: ${seen.size} of its ${wanted.size} shaders`);
  }
  let inFiles = 0;
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  for (const r of shaders.records || []) {
    const file = byPath.get(r.file.toLowerCase());
    if (!file) continue;
    const codec = CODECS[r.codec || 'raw'];
    if (!codec) throw new Error(`release/manifest.json names a coding this page does not know: ${r.codec}`);
    const data = await codec(await file.read(r.offset, r.stored), r);
    for (const c of r.containers) {
      const bytes = data.slice(c.at, c.at + c.length);
      const hash = await sha256(bytes);
      if (hash === c.sha256 && !seen.has(hash)) {
        seen.add(hash);
        containers.push(bytes);
        inFiles++;
      } else if (hash === c.sha256) {
        inFiles++;  // listed twice (two records hold it): found
      }
    }
  }
  if ((shaders.records || []).length) log(`the game's files: ${inFiles} shaders`);
  const found = seen.size;
  const distinct = new Set([...(shaders.image_sha256 || []),
                            ...(shaders.records || []).flatMap((r) => r.containers.map((c) => c.sha256))]).size;
  if (found !== distinct) {
    throw new Error(`${distinct - found} of the game's ${distinct} shaders were not found in its files: is this the ` +
                    'whole game, as the disc has it?');
  }
  return containers;
}
