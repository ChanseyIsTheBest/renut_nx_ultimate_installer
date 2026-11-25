// renut_nx_ultimate_installer (2026-11-24, the user: "why can't the installer build the folder scan index itself", "Yes,
// build it"): the console's VFS index of game_root/, made here, so the first start skips the full scan (on Beautiful
// Katamari's package of Opus and packed files, 20-40 s on the console: it opens every stand-in to read its header).
//
// The format is the base's sdk/src/filesystem/devices/host_path_index.cpp, version 4 (port 264), little-endian:
//   header  : "RXVFSIDX" | u32 version | u32 flags | u64 entry count | u64 body size | u64 FNV-1a(body)
//   body    : str host path | dir(root)
//   dir     : u8 children complete | u32 child count | child * count
//   child   : u8 type (0 file, 1 dir) | str name | u64 size | u8 kinds | [u64 guest size | str guest name]
//             | u64 create | u64 access | u64 write | dir (only when type == 1)
//   str     : u32 length | bytes (UTF-8)
// size is a file's size on the SD card (0 for a directory); kinds the HostPathEntry kIndex* flags of a stand-in (.lz4b
// 1, .xmo 2, .xmop 4, .opcm 8, .hevc 16), which then carries the size and the name the game sees. flags 1 (base port
// 265): made by an installer, for switch/<package>/game_root: a port with port 265 takes it from a folder of another
// name too (only the last component must match). Every start still lists the card's folders and compares them with the
// index (names, types, SD sizes): anything else on the card (a file added, removed or replaced, a different
// extraction) and the game drops the index and scans as before. The timestamps are not compared; the game sees these.
export const INDEX_VERSION = 4;
export const FLAG_INSTALLER = 1;
export const KIND = { lz4b: 1, xmo: 2, xmop: 4, opcm: 8, hevc: 16 };
const EPOCH_FILETIME = 116444736000000000n;  // 1970-01-01 as a FILETIME: what the console's index gives directories

const lower = (s) => s.toLowerCase();
const strip = (name, suffix) => name.slice(0, name.length - suffix.length);

// The stand-in a host name is, as HostPathEntry::Create decides: { kinds, guestName } or null (a plain file).
export function standIn(name) {
  const n = lower(name);
  if (n.endsWith('.hevc.lz4b')) return { kinds: KIND.hevc, guestName: strip(name, '.hevc.lz4b') };
  if (n.endsWith('.xmop.lz4b')) return { kinds: KIND.xmop, guestName: strip(name, '.xmop.lz4b') };
  if (n.endsWith('.lz4b')) return { kinds: KIND.lz4b, guestName: strip(name, '.lz4b') };
  if (n.endsWith('.xmop')) return { kinds: KIND.xmop, guestName: strip(name, '.xmop') };
  if (n.endsWith('.xmo')) return { kinds: KIND.xmo, guestName: strip(name, '.xmo') };
  if (n.endsWith('.opcm')) return { kinds: KIND.opcm, guestName: strip(name, '.opcm') };
  if (n.endsWith('.hevc')) return { kinds: KIND.hevc, guestName: strip(name, '.hevc') };
  return null;
}

// 2026-11-25 (pacman-nx's finding; the user: "Yes fix"): the size a stand-in that is already made stands for, read from
// its own header, for a game folder this page made before given back as the game's source. A .lz4b's is the u64 at
// byte 16 after "RXLZ4BLK" (the file it holds), a .xmop's the u64 at byte 16 after "RXXMAPK1" (the sound file it
// stands for), as test/vfs_index_node.mjs reads them. null where the header does not say: a .xmop.lz4b or .hevc.lz4b
// holds its stand-in packed, and this page makes no .xmo, .opcm or .hevc. The caller then leaves the index out.
// f: { path, size, read(offset, length) -> Uint8Array }.
export async function heldSizeOf(f) {
  const n = lower(f.path);
  const magic = n.endsWith('.xmop.lz4b') || n.endsWith('.hevc.lz4b') ? null
    : n.endsWith('.lz4b') ? 'RXLZ4BLK' : n.endsWith('.xmop') ? 'RXXMAPK1' : null;
  if (!magic || f.size < 24) return null;
  const h = await f.read(0, 24);
  for (let i = 0; i < 8; i++) if (h[i] !== magic.charCodeAt(i)) return null;
  return Number(new DataView(h.buffer, h.byteOffset, 24).getBigUint64(16, true));
}

// host_path_device.cpp's AnswerRank: re-encoded stand-ins (and their packed forms) 0, plain files 1, a plain .lz4b 2.
function answerRank(name) {
  let n = lower(name);
  const packed = n.endsWith('.lz4b');
  if (packed) n = n.slice(0, -5);
  if (['.opcm', '.xmo', '.xmop', '.hevc'].some((s) => n.endsWith(s))) return 0;
  return packed ? 2 : 1;
}

function fnv1a(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  push(u8) { this.parts.push(u8); this.length += u8.length; }
  u8(v) { this.push(Uint8Array.of(v)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.push(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); }
  str(s) { const b = new TextEncoder().encode(s); this.u32(b.length); this.push(b); }
  bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

// The files of game_root/ as the zip writes them, in its order: add(path in game_root, size on the SD card, held = the
// size of the file a stand-in stands for, or null for a plain file). bytes(hostPath, when) gives the index.
export class VfsIndex {
  constructor() { this.root = { children: new Map() }; }

  add(path, size, held = null) {
    const parts = path.split('/');
    let dir = this.root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.children.has(p)) dir.children.set(p, { dir: true, children: new Map() });
      dir = dir.children.get(p);
    }
    const name = parts[parts.length - 1];
    const s = held === null ? null : standIn(name);
    if (held !== null && !s) throw new Error(`vfs_index: ${path} is not a stand-in name`);
    dir.children.set(name, { dir: false, size, kinds: s ? s.kinds : 0, held, guestName: s ? s.guestName : '' });
  }

  // hostPath: the game folder as the console names it (e.g. /switch/katamari-nx/game_root); when: a Date for the files'
  // three timestamps (the zip's own date).
  bytes(hostPath, when = new Date()) {
    const fileTime = BigInt(when.getTime()) * 10000n + EPOCH_FILETIME;
    const body = new Writer();
    body.str(hostPath);
    let count = 0;
    const directory = (dir) => {
      // the scan's order: the card's (the extraction's, the zip's), then stable by AnswerRank
      const kids = [...dir.children.entries()].map(([name, e], i) => ({ name, e, i }))
        .sort((a, b) => answerRank(a.name) - answerRank(b.name) || a.i - b.i);
      body.u8(kids.length ? 1 : 0);  // a directory the scan read with children is marked complete
      body.u32(kids.length);
      for (const { name, e } of kids) {
        count++;
        body.u8(e.dir ? 1 : 0);
        body.str(name);
        body.u64(e.dir ? 0 : e.size);
        body.u8(e.dir ? 0 : e.kinds);
        if (!e.dir && e.kinds) {
          body.u64(e.held);
          body.str(e.guestName);
        }
        const t = e.dir ? EPOCH_FILETIME : fileTime;
        body.u64(t); body.u64(t); body.u64(t);
        if (e.dir) directory(e);
      }
    };
    directory(this.root);
    const b = body.bytes();
    const head = new Uint8Array(40);
    head.set(new TextEncoder().encode('RXVFSIDX'), 0);
    const v = new DataView(head.buffer);
    v.setUint32(8, INDEX_VERSION, true);
    v.setUint32(12, FLAG_INSTALLER, true);
    v.setBigUint64(16, BigInt(count), true);
    v.setBigUint64(24, BigInt(b.length), true);
    v.setBigUint64(32, fnv1a(b), true);
    const out = new Uint8Array(40 + b.length);
    out.set(head, 0);
    out.set(b, 40);
    return out;
  }
}
