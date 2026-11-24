// sasrt-nx-installer (2026-11-21): checks NAME.xmop against NAME. NAME is synthesized from NAME.xmop as sasrt-nx's
// port does it (culdcept-nx's sdk/src/filesystem/xmo.cpp XmoHandle::Synthesize, for each sound's packets; the stored
// and zero segments as they are), then:
//   - every byte outside the converted sounds' packets equals NAME's;
//   - every packet's header equals NAME's, every frame's 15-bit length field and last bit equal NAME's (the frames read
//     through the same packet walk), every other bit of a packet zero but its tag's;
//   - every packet a frame starts in carries the tag (0xA55C, the sound id, the packet's index in the sound), and the
//     frame table's positions are the frames the walk of the synthesized packets finds.
//   node test/xmop_check.mjs NAME NAME.xmop
import { readFileSync } from 'node:fs';

const [origPath, xmopPath] = process.argv.slice(2);
if (!origPath || !xmopPath) {
  console.error('usage: node test/xmop_check.mjs NAME NAME.xmop');
  process.exit(2);
}
const orig = new Uint8Array(readFileSync(origPath));
const x = new Uint8Array(readFileSync(xmopPath));
const v = new DataView(x.buffer, x.byteOffset, x.byteLength);
const u32 = (o) => v.getUint32(o, true), u16 = (o) => v.getUint16(o, true);
const u64 = (o) => u32(o) + u32(o + 4) * 0x100000000;
if (new TextDecoder().decode(x.subarray(0, 8)) !== 'RXXMAPK1' || u32(8) !== 1) throw new Error('not an .xmop');
const nseg = u32(12), size = u64(16), segOff = u64(24), storedOff = u64(32), storedLen = u64(40);
const nsound = u32(48), soundOff = u64(56);
if (size !== orig.length) throw new Error(`sizes differ: ${size} against ${orig.length}`);

const PB = 2048, PBITS = PB * 8, HBITS = 32, FHBITS = 15, MAXLEN = 0x7fff, TAG_BITS = 72;
const sounds = [];
for (let i = 0; i < nsound; ++i) {
  const o = soundOff + 64 * i;
  const s = { id: u32(o), packets: u32(o + 4), frames: u32(o + 8), rate: u32(o + 12), channels: u16(o + 16),
              preSkip: u16(o + 18), opusCount: u32(o + 20), opusRate: u32(o + 24), heads: u64(o + 32),
              table: u64(o + 40), opus: u64(o + 48) };
  s.frameList = [];
  for (let k = 0; k < s.frames; ++k) {
    const e = s.table + 8 * k;
    s.frameList.push({ pos: u32(e), len: u16(e + 4), last: x[e + 6] });
  }
  sounds.push(s);
}

const bit = (p, b) => (p[b >> 3] >> (7 - (b & 7))) & 1;
const setBit = (p, b) => { p[b >> 3] |= 0x80 >> (b & 7); };
// XmoTagBits (culdcept-nx's sdk/src/filesystem/xmo.cpp)
function tagBits(packet, max) {
  const out = [];
  if (packet[3] === 0xff) return out;
  const first = (((packet[0] & 3) << 13) | (packet[1] << 5) | (packet[2] >> 3)) + HBITS;
  for (let off = first; off < PBITS && out.length < max;) {
    if (PBITS - off < FHBITS) break;
    let len = 0;
    for (let k = 0; k < FHBITS; ++k) len = (len << 1) | bit(packet, off + k);
    if (len === 0 || len === MAXLEN) break;
    const end = Math.min(off + len - 1, PBITS);
    for (let b = off + FHBITS; b < end && out.length < max; ++b) out.push(b);
    if (off + len > PBITS) break;
    const last = bit(packet, off + len - 1);
    off += len;
    if (!last) break;
  }
  for (let b = HBITS + FHBITS; b + 1 < Math.min(first, PBITS) && out.length < max; ++b) out.push(b);
  return out;
}
const tagBit = (k, id, p) => (k < 16 ? (0xa55c >> (15 - k)) & 1 : k < 48 ? (id >>> (47 - k)) & 1 : (p >> (71 - k)) & 1);

// Bit j of a frame at bit pos of the sound's packets (`skips(pk)`: packet pk's skip count) -> [packet, bit in it].
function frameBit(pos, j, skips, packets) {
  let pk = Math.floor(pos / PBITS), b = (pos % PBITS) + j;
  while (b >= PBITS) {
    b -= PBITS;
    const s = pk < packets ? skips(pk) : 0;
    pk += (s === 0xff ? 0 : s) + 1;
    b += HBITS;
  }
  return [pk, b];
}

// synthesize NAME
const view = new Uint8Array(size);
let storedEnd = 0;
const soundRanges = [];
for (let i = 0; i < nseg; ++i) {
  const o = segOff + 32 * i;
  const off = u64(o), len = u64(o + 8), kind = u32(o + 16), si = u32(o + 20), src = u64(o + 24);
  if (kind === 0) {
    view.set(x.subarray(storedOff + src, storedOff + src + len), off);
    storedEnd = Math.max(storedEnd, src + len);
  } else if (kind === 2) {
    const s = sounds[si];
    if (src !== 0 || len !== s.packets * PB) throw new Error(`segment ${i}: not a whole sound`);
    soundRanges.push([off, s]);
    const headAt = s.heads;
    const skips = (pk) => x[headAt + pk * 4 + 3];
    const packet = new Uint8Array(PB);
    // xmo.h: a tag in each packet a frame starts in, and only there. (culdcept-nx's Synthesize tags every packet with
    // room: in SASRT's sounds a last packet that no frame starts in, first frame offset 0x7FFF but skip count 0, has its
    // tag bits over the end of the frame that began before, and the tag overwrote that frame's last bit.)
    const startsHere = new Set(s.frameList.map((f) => Math.floor(f.pos / PBITS)));
    let fi = 0;
    for (let p = 0; p < s.packets; ++p) {
      packet.fill(0);
      packet.set(x.subarray(headAt + p * 4, headAt + p * 4 + 4));
      const from = p >= 2 ? (p - 2) * PBITS : 0, to = (p + 1) * PBITS;
      while (fi < s.frameList.length && s.frameList[fi].pos < from) ++fi;
      for (let k = fi; k < s.frameList.length && s.frameList[k].pos < to; ++k) {
        const f = s.frameList[k];
        for (let j = 0; j < FHBITS; ++j) {
          if ((f.len >> (FHBITS - 1 - j)) & 1) {
            const [pk, b] = frameBit(f.pos, j, skips, s.packets);
            if (pk === p) setBit(packet, b);
          }
        }
        if (f.last) {
          const [pk, b] = frameBit(f.pos, f.len - 1, skips, s.packets);
          if (pk === p) setBit(packet, b);
        }
      }
      const bits = startsHere.has(p) ? tagBits(packet, TAG_BITS) : [];
      if (bits.length >= TAG_BITS) for (let k = 0; k < TAG_BITS; ++k) if (tagBit(k, s.id, p)) setBit(packet, bits[k]);
      view.set(packet, off + p * PB);
    }
  }
  // kind 1: zeros (view is zeroed)
}
if (storedEnd !== storedLen) console.log(`note: the stored bytes used ${storedEnd} of ${storedLen}`);

// 1. outside the sounds' packets
const inSound = new Uint8Array(size);
for (const [off, s] of soundRanges) inSound.fill(1, off, off + s.packets * PB);
let outsideDiff = 0;
for (let i = 0; i < size; ++i) if (!inSound[i] && view[i] !== orig[i]) ++outsideDiff;
console.log(`bytes outside the sounds' packets that differ: ${outsideDiff}`);

// 2. and 3. each sound
let badHeads = 0, badFields = 0, strayBits = 0, badTags = 0, untagged = 0, walkDiff = 0, packetsChecked = 0;
for (const [off, s] of soundRanges) {
  const skipsO = (pk) => orig[off + pk * PB + 3];
  const fieldBits = new Set();  // packet * PBITS + bit of every length field and last bit
  for (const f of s.frameList) {
    let lenO = 0, lenV = 0;
    for (let j = 0; j < FHBITS; ++j) {
      const [pk, b] = frameBit(f.pos, j, skipsO, s.packets);
      lenO = (lenO << 1) | bit(orig.subarray(off + pk * PB), b);
      lenV = (lenV << 1) | bit(view.subarray(off + pk * PB), b);
      fieldBits.add(pk * PBITS + b);
    }
    const [pk, b] = frameBit(f.pos, f.len - 1, skipsO, s.packets);
    fieldBits.add(pk * PBITS + b);
    if (lenO !== f.len || lenV !== f.len || bit(orig.subarray(off + pk * PB), b) !== f.last ||
        bit(view.subarray(off + pk * PB), b) !== f.last) { ++badFields; if (process.env.XMOP_DEBUG) console.log(`sound ${s.id.toString(16)} packets ${s.packets} frame at ${f.pos} (packet ${Math.floor(f.pos / PBITS)}) len ${f.len} last ${f.last}: orig len ${lenO} view len ${lenV}, last-bit packet ${pk}`); }
  }
  const starts = new Set(s.frameList.map((f) => Math.floor(f.pos / PBITS)));
  for (let p = 0; p < s.packets; ++p) {
    ++packetsChecked;
    const o = view.subarray(off + p * PB, off + (p + 1) * PB), g = orig.subarray(off + p * PB, off + (p + 1) * PB);
    for (let k = 0; k < 4; ++k) if (o[k] !== g[k]) { ++badHeads; break; }
    const bits = tagBits(o, TAG_BITS);
    const tagSet = new Set(bits.length >= TAG_BITS && starts.has(p) ? bits : []);
    if (starts.has(p)) {
      if (bits.length < TAG_BITS) ++untagged;
      else {
        let magic = 0, id = 0, idx = 0;
        for (let k = 0; k < 16; ++k) magic = (magic << 1) | bit(o, bits[k]);
        for (let k = 16; k < 48; ++k) id = ((id << 1) | bit(o, bits[k])) >>> 0;
        for (let k = 48; k < 72; ++k) idx = (idx << 1) | bit(o, bits[k]);
        if (magic !== 0xa55c || id !== s.id || idx !== p) ++badTags;
      }
    }
    stray: for (let byte = 4; byte < PB; ++byte) {
      if (!o[byte]) continue;
      for (let b = byte * 8; b < byte * 8 + 8; ++b) {
        if (bit(o, b) && !tagSet.has(b) && !fieldBits.has(p * PBITS + b)) { ++strayBits; break stray; }
      }
    }
  }
  // the walk of the synthesized packets finds the frame table's frames
  const found = [];
  for (let p = 0; p < s.packets; ++p) {
    const pk = view.subarray(off + p * PB, off + (p + 1) * PB);
    if (pk[3] === 0xff) continue;
    let o = (((pk[0] & 3) << 13) | (pk[1] << 5) | (pk[2] >> 3)) + HBITS;
    const skipsV = (q) => view[off + q * PB + 3];
    while (o < PBITS) {
      let len = 0;
      for (let j = 0; j < FHBITS; ++j) {
        const [q, b] = frameBit(p * PBITS + o, j, skipsV, s.packets);
        if (q >= s.packets) { len = -1; break; }
        len = (len << 1) | bit(view.subarray(off + q * PB), b);
      }
      if (len <= 0 || len === MAXLEN) break;
      const [q, b] = frameBit(p * PBITS + o, len - 1, skipsV, s.packets);
      found.push(p * PBITS + o);
      if (PBITS - o < FHBITS || len > PBITS - o) break;
      o += len;
      if (!bit(view.subarray(off + q * PB), b)) break;
    }
  }
  if (found.length !== s.frameList.length || found.some((p, i) => p !== s.frameList[i].pos)) ++walkDiff;
}
console.log(`sounds ${soundRanges.length}, packets ${packetsChecked}: headers differing ${badHeads}, frames whose length ` +
            `or last bit differ ${badFields}, packets with a stray bit ${strayBits}, packets a frame starts in without a ` +
            `tag ${untagged}, wrong tags ${badTags}, sounds whose walk differs from their frame table ${walkDiff}`);
const ok = !outsideDiff && !badHeads && !badFields && !strayBits && !untagged && !badTags && !walkDiff;
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);
