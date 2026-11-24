// renut_nx_ultimate_installer (2026-11-23, the user: "re-encoding katamari's audio and video"): a RIFF WAVE file holding
// one XMA sound (Beautiful Katamari's data/sound/**/*.nps), as lib/xmop.js's sound list. Two headers are met:
//   - 'fmt ' with tag 0x0165 (XMA1, XMAWAVEFORMAT, little-endian): u16 tag, u16 bits, u16 encode options, u16 largest
//     skip, u16 streams, u8 loop count, u8 version, then per stream 20 bytes: u32 pseudo bytes/s, u32 sample rate, u32
//     loop start, u32 loop end, u8 subframe data, u8 channels, u16 channel mask;
//   - an 'XMA2' chunk (XMA2WAVEFORMAT, big-endian, the Xbox 360 SDK's xma2defs.h): u8 version, u8 streams, u8 0, u8
//     loop count, u32 loop begin, u32 loop end, u32 sample rate, ... and the streams' {u8 channels, u8 0, u16 mask} at
//     its end (version 4: 44 bytes for one stream, 52 for three; version 3: 36, with an XMA1 'fmt ' beside it).
// The 'data' chunk's 2048-byte packets are the sound (the same packets and frames in XMA1 and XMA2: the base's
// docs/media-compression.md section 6). A file with more than one stream, or not mono or stereo, gives no sound: the port
// plays it as XMA as before.

const PACKET_BYTES = 2048;
const tag4 = (d, o) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

// The chunks of a RIFF WAVE file: Map id -> { at (the body's offset), size }, or null when it is not one.
export function riffChunks(d) {
  if (d.length < 12 || tag4(d, 0) !== 'RIFF' || tag4(d, 8) !== 'WAVE') return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const chunks = new Map();
  for (let at = 12; at + 8 <= d.length;) {
    const id = tag4(d, at), size = v.getUint32(at + 4, true);
    if (!chunks.has(id)) chunks.set(id, { at: at + 8, size: Math.min(size, d.length - at - 8) });
    at += 8 + size + (size & 1);
  }
  return chunks;
}

// The file's XMA header: { format ('XMA1' / 'XMA2'), streams, channels, rate } or null.
export function riffXmaFormat(d) {
  const chunks = riffChunks(d);
  if (!chunks) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const x2 = chunks.get('XMA2');
  if (x2 && x2.size >= 16) {
    const streams = d[x2.at + 1];
    const first = x2.at + x2.size - 4 * streams;  // the streams' formats end the chunk
    if (streams >= 1 && first >= x2.at + 16)
      return { format: 'XMA2', streams, channels: d[first], rate: v.getUint32(x2.at + 12, false) };
  }
  const fmt = chunks.get('fmt ');
  if (fmt && fmt.size >= 32 && v.getUint16(fmt.at, true) === 0x165) {
    const streams = v.getUint16(fmt.at + 8, true);
    return { format: 'XMA1', streams, channels: d[fmt.at + 12 + 17], rate: v.getUint32(fmt.at + 12 + 4, true) };
  }
  return null;
}

// lib/xmop.js's sound list for one file: [{ n: 0, offset, size, info }] (info: format 'XMA', streams, channels, rate,
// dataOffset, dataSize), empty when the file is not one sound of mono or stereo XMA in whole packets.
export function riffXmaSounds(d) {
  const chunks = riffChunks(d);
  const f = riffXmaFormat(d);
  const data = chunks?.get('data');
  if (!f || !data || f.streams !== 1 || f.channels < 1 || f.channels > 2) return [];
  const size = data.size - (data.size % PACKET_BYTES);
  if (!size) return [];
  return [{ n: 0, offset: data.at, size,
            info: { format: 'XMA', kind: f.format, streams: 1, channels: f.channels, rate: f.rate, dataOffset: data.at,
                    dataSize: size } }];
}
