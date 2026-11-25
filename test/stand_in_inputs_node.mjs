// renut_nx_ultimate_installer (2026-11-25, pacman-nx's finding; the user: "Yes fix"): a game folder this page made
// before, given back as the game's source, holds stand-ins already made (NAME.lz4b, NAME.xmop...). lib/install.js copies
// them as they are and indexes each with the size its header says it stands for (lib/vfs_index.js heldSizeOf), or leaves
// the index out when the header does not say. This checks heldSizeOf and the index entries on made-up headers.
//   node test/stand_in_inputs_node.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VfsIndex, heldSizeOf, standIn, KIND } = await import(pathToFileURL(path.join(root, 'lib', 'vfs_index.js')).href);

const file = (p, magic, held, size = 4096) => {
  const b = new Uint8Array(size);
  for (let i = 0; i < magic.length; i++) b[i] = magic.charCodeAt(i);
  if (size >= 24) new DataView(b.buffer).setBigUint64(16, BigInt(held), true);
  return { path: p, size, read: async (o, n) => b.slice(o, o + n) };
};

// the stand-ins this page makes, and what their headers say
assert.equal(await heldSizeOf(file('data/d02.dat.lz4b', 'RXLZ4BLK', 77246464)), 77246464);
assert.equal(await heldSizeOf(file('sound/bgm.xma.xmop', 'RXXMAPK1', 5000000)), 5000000);
// a header that is not the name's kind: not trusted
assert.equal(await heldSizeOf(file('data/x.bin.lz4b', 'RXXMAPK1', 1)), null);
// packed stand-ins hold their header packed, and kinds this page never makes: unknown, so no index
assert.equal(await heldSizeOf(file('sound/bgm.xma.xmop.lz4b', 'RXLZ4BLK', 123)), null);
assert.equal(await heldSizeOf(file('movie/a.usm.hevc.lz4b', 'RXLZ4BLK', 123)), null);
assert.equal(await heldSizeOf(file('music/a.xwb.opcm', 'RXOPCM01', 123)), null);
assert.equal(await heldSizeOf(file('short.lz4b', 'RXLZ4BLK', 5, 16)), null);

// lib/install.js's test for an input that is already a stand-in: by its last component only
const already = (p) => standIn(p.slice(p.lastIndexOf('/') + 1)) !== null;
assert.equal(already('data/d02.dat.lz4b'), true);
assert.equal(already('data.lz4b/d02.dat'), false);
assert.equal(already('sound/bgm.xma.xmop'), true);
assert.equal(already('default.xex'), false);

// the index gets the entry as the page's own packing would have written it: the SD size, the kind, the size and name
// the game sees
const index = new VfsIndex();
index.add('data/d02.dat.lz4b', 56937216, await heldSizeOf(file('data/d02.dat.lz4b', 'RXLZ4BLK', 77246464)));
index.add('sound/bgm.xma.xmop', 2000000, await heldSizeOf(file('sound/bgm.xma.xmop', 'RXXMAPK1', 5000000)));
const d = index.root.children.get('data').children.get('d02.dat.lz4b');
assert.deepEqual([d.size, d.kinds, d.held, d.guestName], [56937216, KIND.lz4b, 77246464, 'd02.dat']);
const s = index.root.children.get('sound').children.get('bgm.xma.xmop');
assert.deepEqual([s.size, s.kinds, s.held, s.guestName], [2000000, KIND.xmop, 5000000, 'bgm.xma']);
assert.ok(index.bytes('/switch/katamari-nx/game_root').length > 0);
console.log('stand-in inputs: OK');
