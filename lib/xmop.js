// sasrt-nx-installer (2026-11-21, the user: "please compress all the videos and audio", "copy culdcept saga web
// installer for encoding audio and video"): one of SASRT's Wwise packages NAME (Data/sound/*.pck) as NAME.xmop, the
// package with its XMA2 sounds' frames as Opus. sasrt-nx's sdk/include/rex/filesystem/xmo.h has the format; the port
// synthesizes NAME from it and its XMA emulation plays each frame from the Opus. culdcept-nx-installer's lib/xmo.js
// (credit culdcept-nx) for many sounds in one file:
//   1. the package's WEMs found (lib/wwise.js); each XMA2 sound's packets (its data chunk) walked and its frames decoded
//      in order by wasm/xma (FFmpeg's xmaframes decoder, the port's own): frame k is samples [512 k, 512 k + 512);
//   2. those samples encoded as Opus, 20 ms packets, at 48 kHz or 24 kHz (the sound's rate; 44.1 kHz sounds resampled
//      to 48 kHz, lib/resample.js) by the page (lib/audio.js: WebCodecs) or a PC (test/xmop_node.mjs: ffmpeg's libopus);
//   3. NAME.xmop written: NAME's bytes as segments (stored, zeros, a sound's packets), each converted sound's packet
//      headers, frame table and Opus.
// A sound stays XMA (its bytes stored) when the port cannot play it this way (refusal) or its Opus is not smaller.
//
// vivapinata-nx-installer (2026-11-22, the user: "Lossy video and audio are fine go ahead please with movies audio and
// packing"): Viva Pinata's XACT 2 wave banks in place of SASRT's Wwise packages (lib/xact.js finds the sounds: each XMA
// entry's play region, whole 2048-byte packets); its 22,050 Hz voices and effects as 24 kHz Opus (resampled up by
// lib/resample.js; vivapinata-nx's port resamples back with the 160/147 filter it has for 44.1 kHz); its own sound ids
// (soundId: 268 banks, more than SASRT's 8 bits of package).

//
// renut_nx_ultimate_installer (2026-11-23, the user: "re-encoding katamari's audio and video"): vivapinata-nx-installer's
// (credit it, sasrt-nx-installer and culdcept-nx-installer) with the container's reader passed in (`parse`: Katamari's
// RIFF XMA files through lib/riffxma.js; viva's XACT banks through its lib/xact.js), the rates the port plays from Opus
// and the sound ids from game.json (the base's sdk/src/filesystem/xmo.cpp ParsePackSound takes the XMA / Opus rates
// 48000 / 48000, 24000 / 24000 and 44100 / 48000), and a rate close to one of those (Katamari's 47,996-47,999 Hz music)
// declared as it: XMA frames are 512 samples at any rate and the game's voice keeps its own rate, so each frame's
// samples are the ones it had (kameo-nx-installer's 22,050-as-24,000 Hz, credit kameo-nx).

export const XMOP_SUFFIX = '.xmop';
const TAG_BITS = 16 + 32 + 24;  // a packet's tag: magic, sound id, packet index
const SAMPLES_PER_FRAME = 512;
const PACKET_BYTES = 2048;
const OPUS_PACKET_48K = 960;  // 20 ms
const ZERO_RUN = 512;  // stored bytes this many zeros or more in a row become a zero segment
const XMA_ERRORS = {
  '-1': 'not a RIFF WAVE file', '-2': 'no fmt or data chunk', '-3': 'not XMA1', '-4': 'more than one stream',
  '-5': 'not mono or stereo', '-6': 'its data is not whole packets', '-7': 'the XMA decoder did not open',
  '-8': 'a frame runs past the data', '-9': 'out of memory', '-10': 'a frame did not decode',
  '-11': 'a frame is not 512 samples',
};

// An Opus packet's samples at 48 kHz (RFC 6716 3.1: the TOC byte's configuration and frame count).
export function opusPacketSamples(p) {
  if (!p.length) return 0;
  const config = p[0] >> 3, code = p[0] & 3;
  const size = config < 12 ? [480, 960, 1920, 2880][config & 3]
    : config < 16 ? [480, 960][config & 1]
    : [120, 240, 480, 960][config & 3];
  const frames = code === 0 ? 1 : code < 3 ? 2 : (p.length > 1 ? p[1] & 0x3f : 0);
  return size * frames;
}

// The XMA rates a port plays from Opus, and the Opus rate each is made at: game.json's audio "rates" ({ "XMA rate":
// Opus rate }), by default the base's (sdk/src/filesystem/xmo.cpp ParsePackSound); viva's port adds 22050: 24000.
// "near_hz": a rate this close to one of them is declared as it (Katamari: 4, for its 47,996-47,999 Hz music).
export const BASE_RATES = { 48000: 48000, 44100: 48000, 24000: 24000 };
export function ratesOf(audio = {}) {
  const table = Object.fromEntries(Object.entries(audio.rates || BASE_RATES).map(([k, v]) => [Number(k), Number(v)]));
  const near = audio.near_hz ?? 0;
  const played = Object.keys(table).map(Number);
  return {
    table,
    // the rate a sound at `rate` is declared as, or null (it stays XMA)
    declare: (rate) => {
      if (table[rate]) return rate;
      const close = played.find((p) => Math.abs(p - rate) <= near);
      return close ?? null;
    },
    opus: (rate) => table[rate],
  };
}
// The rate the Opus of a sound declared at `rate` is made at (the table's; vivapinata-nx-installer: 22,050 Hz from
// 24 kHz Opus).
export const opusRateFor = (rate, rates = ratesOf()) => rates.opus(rate) ?? (rate === 24000 || rate === 22050 ? 24000 : 48000);
// An OpusHead pre-skip (always 48 kHz samples, RFC 7845) at the Opus stream's own rate, as the table keeps it.
export const preSkipAt = (opusRate, preSkip48) => Math.round(preSkip48 * opusRate / 48000);

// The wave bank's XMA sounds that could be Opus: [{ n (the entry's index), offset, size, info }] in bank order.
// vivapinata-nx-installer: XACT entries (lib/xact.js) where sasrt-nx-installer had WEMs; info as before (format,
// streams, channels, rate, dataOffset, dataSize). A 4-channel sound is two interleaved streams: not one (xma_open_raw
// refuses packets of more than one stream too).
// renut_nx_ultimate_installer: `parse(d)` gives the container's sounds ([{ n, offset, size, info }], info as above);
// `rates` is ratesOf(game.json's audio): a sound whose rate it does not take is left out (kept as XMA), one it takes
// near a played rate gets that rate (`info.sourceRate` keeps its own).
export function xmaSounds(d, { parse, rates = ratesOf() }) {
  const out = [];
  parse(d).forEach((e) => {
    const info = { ...e.info };
    const played = rates.declare(info.rate);
    if (played === null) return;
    info.sourceRate = info.rate;
    info.rate = played;
    if (info.format === 'XMA' && info.streams === 1 && info.channels >= 1 && info.channels <= 2 &&
        info.dataSize && info.dataSize % PACKET_BYTES === 0 && info.dataOffset + info.dataSize <= d.length)
      out.push({ n: e.n, offset: e.offset, size: e.size, info });
  });
  // two entries can name the same data (a sound listed twice): once each
  const seen = new Set();
  return out.filter((s) => (seen.has(s.info.dataOffset) ? false : seen.add(s.info.dataOffset)));
}

// A sound's packets (`d` the package, `s` from xmaSounds) walked by wasm/xma (`xma`, an instance of it): { info } or
// { why }. decode(count) gives the next frames' samples (interleaved floats at the sound's rate).
export function openSound(xma, d, s) {
  const { dataOffset, dataSize, rate, channels } = s.info;
  const at = xma._xma_malloc(dataSize);
  xma.HEAPU8.set(d.subarray(dataOffset, dataOffset + dataSize), at);
  const r = xma._xma_open_raw(at, dataSize, rate, channels);
  const close = () => { xma._xma_close(); xma._xma_free(at); };
  if (r < 0) {
    close();
    return { why: XMA_ERRORS[String(r)] || `error ${r}` };
  }
  const info = {
    packets: xma._xma_info(1), frames: xma._xma_info(2), rate: xma._xma_info(3), channels: xma._xma_info(4),
    mismatches: xma._xma_info(6), tagRoom: xma._xma_info(8),
  };
  const tablePtr = xma._xma_frames();
  info.table = xma.HEAPU8.slice(tablePtr, tablePtr + info.frames * 8);
  let out = 0, outFrames = 0;
  const decode = (count) => {
    if (count > outFrames) {
      if (out) xma._xma_free(out);
      out = xma._xma_malloc(count * SAMPLES_PER_FRAME * info.channels * 4);
      outFrames = count;
    }
    const n = xma._xma_decode(count, out);
    if (n < 0) throw new Error(`${XMA_ERRORS[String(n)] || `error ${n}`} (frame ${xma._xma_info(7)})`);
    return new Float32Array(xma.HEAPU8.buffer, out, n * SAMPLES_PER_FRAME * info.channels).slice();
  };
  return { info, decode, close: () => { if (out) xma._xma_free(out); out = 0; close(); } };
}

// All of a sound's frames decoded (interleaved floats), then two frames of silence (the encoder's tail covers the
// last frame).
export function decodeAll(x) {
  const { info } = x;
  const pcm = new Float32Array((info.frames + 2) * SAMPLES_PER_FRAME * info.channels);
  for (let f = 0; f < info.frames;) {
    const part = x.decode(Math.min(1024, info.frames - f));
    pcm.set(part, f * SAMPLES_PER_FRAME * info.channels);
    f += part.length / (SAMPLES_PER_FRAME * info.channels);
  }
  return pcm;
}

// Whether the port can play this sound from Opus (null) or why not.
export function refusal(info) {
  if (!info.frames) return 'no frames';
  if (info.packets >= 1 << 24) return 'too many packets';
  if (info.tagRoom < TAG_BITS) return `a packet with room for ${info.tagRoom} tag bits (${TAG_BITS} needed)`;
  if (info.mismatches) return `${info.mismatches} frames end where the next packet does not start its first one`;
  return null;
}

// The Opus bitrate for a sound: the first of `rules` ({ match (a RegExp source of the package's path), rate (optional),
// stereo, mono }) that fits.
export function xmopBitrate(rules, path, rate, channels) {
  const r = rules.find((x) => new RegExp(`^(?:${x.match})$`, 'i').test(path) && (!x.rate || x.rate === rate));
  return r ? (channels === 2 ? r.stereo : r.mono) : null;
}

// Checks a sound's Opus ({ packets, preSkip (at its rate), rate }) covers its frames; returns its bytes in NAME.xmop
// (tables and packets), or throws.
export function opusCost(info, opus) {
  for (let i = 0; i < opus.packets.length; ++i) {
    if (opus.packets[i].length > 0xffff) throw new Error(`Opus packet ${i} is ${opus.packets[i].length} bytes`);
    if (opusPacketSamples(opus.packets[i]) !== OPUS_PACKET_48K) throw new Error(`Opus packet ${i} is not 20 ms`);
  }
  const perPacket = OPUS_PACKET_48K * opus.rate / 48000;
  const need = opus.preSkip + Math.ceil(info.frames * SAMPLES_PER_FRAME * opus.rate / info.rate);
  if (opus.packets.length * perPacket < need) throw new Error(`the Opus stream is short (${opus.packets.length} packets)`);
  return info.packets * 4 + info.frames * 8 + opus.packets.length * 2 + opus.packets.reduce((n, p) => n + p.length, 0);
}

// The sound id of package `pack` (its index among the game's packages, sorted by path) and its sound `index`.
// vivapinata-nx-installer: 0x56 ('V') in the top byte, 12 bits of wave bank (268 here) and 12 of sound (1,058 at most in
// one bank); the port takes ids as they are (unique among the .xmop files is all it needs).
// renut_nx_ultimate_installer: game.json's audio "ids": { "top": the top byte, "pack_bits": the package's bits (the
// sound's are the 24 left) }; Katamari's { "top": 75 ('K'), "pack_bits": 16 }: 1,375 files of one sound each.
export const soundId = (pack, index, ids = { top: 0x56, pack_bits: 12 }) => {
  const packBits = ids.pack_bits ?? 12, soundBits = 24 - packBits;
  if (pack >= 2 ** packBits || index >= 2 ** soundBits) throw new Error(`sound ${index} of package ${pack}: no room in the sound id`);
  return (((ids.top ?? 0x56) << 24) | (pack << soundBits) | index) >>> 0;
};

// NAME.xmop as parts (Uint8Arrays, in order) and its size. d: NAME; sounds: the converted ones, each { id, info
// (openSound's), dataOffset (in NAME), opus: { packets, preSkip, rate } }.
export function writeXmop(d, sounds) {
  sounds = [...sounds].sort((a, b) => a.dataOffset - b.dataOffset);
  const segs = [];  // { off, len, kind, sound, src }
  const storedRuns = [];
  let storedLen = 0;
  const addStored = (a, b) => {
    // zero runs of ZERO_RUN bytes or more as zero segments
    let s = a;
    for (let i = a; i < b;) {
      if (d[i] !== 0) { ++i; continue; }
      let j = i;
      while (j < b && d[j] === 0) ++j;
      if (j - i >= ZERO_RUN) {
        if (i > s) { segs.push({ off: s, len: i - s, kind: 0, sound: 0, src: storedLen }); storedRuns.push([s, i]); storedLen += i - s; }
        segs.push({ off: i, len: j - i, kind: 1, sound: 0, src: 0 });
        s = j;
      }
      i = j;
    }
    if (b > s) { segs.push({ off: s, len: b - s, kind: 0, sound: 0, src: storedLen }); storedRuns.push([s, b]); storedLen += b - s; }
  };
  let at = 0;
  sounds.forEach((s, i) => {
    if (s.dataOffset < at) throw new Error('two sounds overlap');
    if (s.dataOffset > at) addStored(at, s.dataOffset);
    const len = s.info.packets * PACKET_BYTES;
    segs.push({ off: s.dataOffset, len, kind: 2, sound: i, src: 0 });
    at = s.dataOffset + len;
  });
  if (at < d.length) addStored(at, d.length);

  const head = 64, segOff = head, soundOff = segOff + 32 * segs.length, storedOff = soundOff + 64 * sounds.length;
  let tail = storedOff + storedLen;
  const meta = new Uint8Array(storedOff);
  const v = new DataView(meta.buffer);
  const u64 = (o, x) => { v.setUint32(o, x % 0x100000000, true); v.setUint32(o + 4, Math.floor(x / 0x100000000), true); };
  'RXXMAPK1'.split('').forEach((c, i) => { meta[i] = c.charCodeAt(0); });
  v.setUint32(8, 1, true);
  v.setUint32(12, segs.length, true);
  u64(16, d.length);
  u64(24, segOff);
  u64(32, storedOff);
  u64(40, storedLen);
  v.setUint32(48, sounds.length, true);
  u64(56, soundOff);
  segs.forEach((s, i) => {
    const o = segOff + 32 * i;
    u64(o, s.off);
    u64(o + 8, s.len);
    v.setUint32(o + 16, s.kind, true);
    v.setUint32(o + 20, s.sound, true);
    u64(o + 24, s.src);
  });
  const parts = [meta, ...storedRuns.map(([a, b]) => d.subarray(a, b))];
  sounds.forEach((s, i) => {
    const { info, opus } = s;
    const o = soundOff + 64 * i;
    v.setUint32(o, s.id, true);
    v.setUint32(o + 4, info.packets, true);
    v.setUint32(o + 8, info.frames, true);
    v.setUint32(o + 12, info.rate, true);
    v.setUint16(o + 16, info.channels, true);
    v.setUint16(o + 18, opus.preSkip, true);
    v.setUint32(o + 20, opus.packets.length, true);
    v.setUint32(o + 24, opus.rate, true);
    // the packet headers, frame table and Opus table, after the stored bytes, sound by sound
    const heads = new Uint8Array(info.packets * 4);
    for (let p = 0; p < info.packets; ++p) heads.set(d.subarray(s.dataOffset + p * PACKET_BYTES, s.dataOffset + p * PACKET_BYTES + 4), p * 4);
    u64(o + 32, tail);
    tail += heads.length;
    u64(o + 40, tail);
    tail += info.table.length;
    u64(o + 48, tail);
    const sizes = new Uint8Array(opus.packets.length * 2);
    const sv = new DataView(sizes.buffer);
    opus.packets.forEach((p, k) => sv.setUint16(2 * k, p.length, true));
    tail += sizes.length + opus.packets.reduce((n, p) => n + p.length, 0);
    parts.push(heads, info.table, sizes, ...opus.packets);
  });
  return { parts, size: tail };
}
