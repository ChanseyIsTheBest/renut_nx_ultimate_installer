// Beautiful Katamari's CPDB blocks (katamari-nx's tools/cpdb.py, read from the game's own code), in the page: the models
// of d02.dat-d05.dat hold 84 of the game's shaders inside them.
//
// A block starts with a 16-byte header: "CPDB", the coding (byte 4: 0 stored, 1 plain LZSS, 2 Huffman LZSS), 0, the
// uncompressed size (big endian). The rest is a bit stream of 64-bit big-endian words, each read from its least
// significant bit.
//
//   plain LZSS: until the output is complete, a flag bit; 0: an 8-bit literal; 1: a 4-bit length (+3) and a 12-bit
//   distance, copied from distance bytes back.
//   Huffman LZSS: blocks of a 16-bit entry count; a Huffman tree written depth first (1 = node: the subtree taken on a
//   1 bit first, then the one taken on a 0 bit; 0 = leaf with a 9-bit symbol); then entries: a symbol, and after a
//   symbol of 256 or more a 12-bit distance (an entry of its own). Symbol < 256: a literal; otherwise a copy of
//   symbol - 253 bytes from distance bytes back.

class Bits {
  constructor(data, position) {
    this.data = data;
    this.word = position;  // the next 8-byte word
    this.high = false;     // whether its low half has been taken
    this.buffer = 0;
    this.available = 0;
  }

  // The next 32 bits of the stream: a word's low half (its last four bytes), then its high half. Past the end: zeros.
  half() {
    const d = this.data;
    const at = this.high ? this.word : this.word + 4;
    // a read past the end gives undefined, which these operators take as 0
    const value = ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
    if (this.high) {
      this.word += 8;
    }
    this.high = !this.high;
    return value;
  }

  // n <= 25: the next n bits, the first one the result's bit 0.
  get(n) {
    if (this.available >= n) {
      const value = this.buffer & ((1 << n) - 1);
      this.buffer >>>= n;
      this.available -= n;
      return value;
    }
    const next = this.half();
    const used = n - this.available;
    const value = (this.available ? this.buffer : 0) | ((next & ((1 << used) - 1)) << this.available);
    this.buffer = used === 32 ? 0 : next >>> used;
    this.available = 32 - used;
    return value >>> 0;
  }
}

// The game's copy: byte by byte from distance bytes back, so a copy may overlap itself. Returns the new length.
function copy(out, at, distance, length) {
  const source = at - distance;
  if (distance === 0 || source < 0) {
    throw new Error(`distance ${distance} at ${at}`);
  }
  const end = Math.min(at + length, out.length);
  for (let i = 0; at + i < end; ++i) {
    out[at + i] = out[source + i];
  }
  return at + length;
}

function lzss(bits, out) {
  let at = 0;
  while (at < out.length) {
    if (bits.get(1) === 0) {
      out[at++] = bits.get(8);
    } else {
      const length = bits.get(4) + 3;
      at = copy(out, at, bits.get(12), length);
    }
  }
}

// The tree as two arrays: node i's children (a value >= 0x10000 is the leaf symbol + 0x10000). Written without
// recursion's depth limit in mind: a tree of 9-bit symbols is at most a few hundred levels deep.
function readTree(bits, ones, zeros) {
  if (bits.get(1)) {
    const node = ones.length;
    ones.push(0);
    zeros.push(0);
    ones[node] = readTree(bits, ones, zeros);
    zeros[node] = readTree(bits, ones, zeros);
    return node;
  }
  return bits.get(9) + 0x10000;
}

function huffman(bits, out) {
  let at = 0;
  while (at < out.length) {
    const count = bits.get(16);
    const ones = [];
    const zeros = [];
    const root = readTree(bits, ones, zeros);
    let entries = 0;
    // The entries are all read before any is applied in the game; applying them in order gives the same bytes.
    while (entries < count) {
      let node = root;
      while (node < 0x10000) {
        node = bits.get(1) ? ones[node] : zeros[node];
      }
      const symbol = node - 0x10000;
      entries++;
      if (symbol < 256) {
        if (at < out.length) {
          out[at] = symbol;
        }
        at++;
      } else {
        const distance = bits.get(12);
        entries++;
        at = copy(out, at, distance, symbol - 253);
      }
    }
  }
}

// The block's contents. A stream that does not fit its header's coding is tried with the other one (an older packer
// mislabelled a file the game never loads), as tools/cpdb.py does.
export function decompressCpdb(block) {
  if (block[0] !== 0x43 || block[1] !== 0x50 || block[2] !== 0x44 || block[3] !== 0x42) {
    throw new Error('not a CPDB block');
  }
  const size = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) >>> 0;
  const coding = block[4];
  if (coding === 0) {
    return block.subarray(16, 16 + size);
  }
  if (coding !== 1 && coding !== 2) {
    throw new Error(`unknown coding ${coding}`);
  }
  const tries = coding === 1 ? [lzss, huffman] : [huffman, lzss];
  let failure = null;
  for (const decode of tries) {
    const out = new Uint8Array(size);
    try {
      decode(new Bits(block, 16), out);
      return out;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`CPDB stream broken: ${failure.message}`);
}
