// banjo-nx-installer: the files of an Xbox 360 disc image (XDVDFS, "MICROSOFT*XBOX*MEDIA"), so the player can choose
// their ISO instead of an extracted folder. The game partition starts at 0 (a rebuilt image), 0x2080000 (XGD3),
// 0xFD90000 (XGD2: Banjo-Kazooie: Nuts & Bolts) or 0x18300000 (XGD1); its volume descriptor is at +0x10000:
// magic (20 bytes), u32 root directory sector, u32 root directory size. A directory is a binary tree of entries
// (little endian): u16 left and u16 right (offsets in 4-byte units from the directory's start, 0xFFFF none), u32 first
// sector, u32 size, u8 attributes (0x10 directory), u8 name length, the name; sectors are 2048 bytes from the partition.
const SECTOR = 2048;
const PARTITIONS = [0, 0x2080000, 0xfd90000, 0x18300000];
const MAGIC = 'MICROSOFT*XBOX*MEDIA';

// read(offset, length) -> Promise<Uint8Array>; size: the image's size. Returns [{ path, offset, size }] (offset in
// the image), or null if it is not an Xbox disc image.
export async function listXiso(read, size) {
  for (const base of PARTITIONS) {
    if (base + 0x10000 + 28 > size) continue;
    const head = await read(base + 0x10000, 28);
    if (String.fromCharCode(...head.subarray(0, 20)) !== MAGIC) continue;
    const view = new DataView(head.buffer, head.byteOffset);
    const files = [];
    await walk(read, size, base, view.getUint32(20, true), view.getUint32(24, true), '', files, 0);
    return files;
  }
  return null;
}

async function walk(read, size, base, sector, length, prefix, files, depth) {
  if (depth > 32 || length === 0) return;
  const at = base + sector * SECTOR;
  if (at + length > size) throw new Error('the disc image is cut short (a directory past its end)');
  const dir = await read(at, length);
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const seen = new Set();
  const stack = [0];
  while (stack.length) {
    const off = stack.pop();
    if (seen.has(off) || off + 14 > dir.length) continue;
    seen.add(off);
    const left = view.getUint16(off, true), right = view.getUint16(off + 2, true);
    if (left === 0xffff && right === 0xffff && view.getUint32(off + 4, true) === 0xffffffff) continue;  // padding
    const first = view.getUint32(off + 4, true), bytes = view.getUint32(off + 8, true);
    const attributes = dir[off + 12], nameLength = dir[off + 13];
    const name = new TextDecoder('latin1').decode(dir.subarray(off + 14, off + 14 + nameLength));
    if (left && left !== 0xffff) stack.push(left * 4);
    if (right && right !== 0xffff) stack.push(right * 4);
    if (!name) continue;
    const path = prefix + name;
    if (attributes & 0x10) {
      await walk(read, size, base, first, bytes, path + '/', files, depth + 1);
    } else {
      if (base + first * SECTOR + bytes > size) throw new Error(`the disc image is cut short (${path})`);
      files.push({ path, offset: base + first * SECTOR, size: bytes });
    }
  }
  if (!prefix) files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
