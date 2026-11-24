// renut_nx_ultimate_installer (2026-11-24): lib/vfs_index.js run on a game_root folder already made (an extracted
// package), for comparing with the index the console wrote for that same folder (test/vfs_index_dump.py A B).
//   node test/vfs_index_node.mjs <game_root folder> <original game folder> <out.bin> [host path]
// A stand-in's held size comes from its own header (u64 at byte 16 of a .lz4b or .xmop: the size of the file it stands
// for); a .xmop.lz4b's from the original game file of its name (its .lz4b holds the .xmop, which stands for NAME).
// Folders are walked as Python's os.walk copies them (a folder's files, then its subfolders, by name).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VfsIndex, standIn } = await import(pathToFileURL(path.join(root, 'lib', 'vfs_index.js')).href);
const [dir, original, out, host = '/switch/katamari-nx/game_root'] = process.argv.slice(2);

const index = new VfsIndex();
const heldAt16 = (p) => {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(8);
  fs.readSync(fd, b, 0, 8, 16);
  fs.closeSync(fd);
  return Number(b.readBigUInt64LE(0));
};
function walk(rel) {
  const here = path.join(dir, rel);
  const names = fs.readdirSync(here).sort();
  const files = names.filter((n) => fs.statSync(path.join(here, n)).isFile());
  const dirs = names.filter((n) => fs.statSync(path.join(here, n)).isDirectory());
  for (const n of files) {
    const p = path.join(here, n);
    const r = rel ? `${rel}/${n}` : n;
    const s = standIn(n);
    let held = null;
    if (s) held = n.toLowerCase().endsWith('.xmop.lz4b')
      ? fs.statSync(path.join(original, rel, s.guestName)).size : heldAt16(p);
    index.add(r, fs.statSync(p).size, held);
  }
  for (const d of dirs) walk(rel ? `${rel}/${d}` : d);
}
walk('');
const bytes = index.bytes(host);
fs.writeFileSync(out, bytes);
console.log(`${out}: ${bytes.length} bytes`);
