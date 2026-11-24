// renut_nx_ultimate_installer (2026-11-23, the user: "could you also please work on re-encoding katamari's audio and video
// (ZXC compress the video) and L4Z/ZXC compressing the other files"): the smaller game files of the base's port 259, made
// here as vivapinata-nx-installer makes Viva Pinata's (credit it, sasrt-nx-installer, banjo-nx-installer and
// culdcept-nx-installer; the base's docs/media-compression.md has the method and every port's figures):
//   - game.json "movies" { match, fraction, gop, zxc }: an ASF movie (WMV3) re-encoded to H.265 in the same ASF file
//     (lib/movies.js: wasm/wmv3 decodes, the browser's VideoEncoder encodes at `fraction` of the video's bitrate, a
//     keyframe every `gop` frames), under its own name (the port's movie hook tells H.265 by the first frame), ZXC-packed
//     as NAME.lz4b when `zxc`;
//   - game.json "audio" { match, container, bitrates, rates, near_hz, ids, pack, min_saving }: a file of XMA sounds as
//     NAME.xmop (lib/audio.js, lib/xmop.js: the sounds' frames as Opus, the browser's AudioEncoder; the base's
//     sdk/include/rex/filesystem/xmo.h), packed with `pack` (NAME.xmop.lz4b) when that saves `min_saving` (5 %);
//   - either kept as it is (then packed by game.json's lz4 / zxc lists) when the page's option is off, the browser has no
//     encoder, or the file cannot be re-encoded (the log says why).
import { canEncodeOpus, makeXmop } from './audio.js';
import { canEncodeHevc, reencodeMovie } from './movies.js';
import { riffXmaSounds } from './riffxma.js';
import { ratesOf } from './xmop.js';
import { pack, SUFFIX } from './lz4b.js';

// The share of a file left after its re-encode or packing, for the zip's size before it is known (Katamari's, measured
// 2026-11-23 on the PC's copy; the others vivapinata-nx-installer's).
export const KEPT = { lz4: 0.6, lz4s: 0.78, zxc: 0.99, xmop: 0.55, hevc: 0.38 };

// game.json's audio "container": the reader of the files' XMA sounds (lib/xmop.js's sound list).
const CONTAINERS = { riff: riffXmaSounds };
export function audioContainer(audio) {
  const parse = CONTAINERS[audio?.container || 'riff'];
  if (!parse) throw new Error(`game.json audio.container "${audio.container}": not one this page reads`);
  return parse;
}

const fits = (m, p) => !!m && new RegExp(`^(?:${m})$`, 'i').test(p);

// What this run re-encodes: { movies, audio, kind(path), wmv3, xma } from game.json, the page's options and this
// browser's encoders. tools.loadWmv3() / tools.loadXma(): the WebAssembly modules; tools.encodeOpus (Node tests): an
// Opus encoder in place of the browser's.
export async function mediaSetup(game, options = {}, tools = {}, log = () => {}) {
  const movies = !!game.movies && options.movies !== false && (await canEncodeHevc());
  const audio = !!game.audio && options.audio !== false && (!!tools.encodeOpus || (await canEncodeOpus()));
  if (game.movies && options.movies === false) log('H.265 unticked: the movies are kept as they are (packed losslessly).');
  else if (game.movies && !movies) log('This browser has no H.265 encoder: the movies are kept as they are (packed losslessly).');
  if (game.audio && options.audio === false) log('Opus unticked: the sounds are kept as they are (packed losslessly).');
  else if (game.audio && !audio) log('This browser has no Opus encoder: the sounds are kept as they are (packed losslessly).');
  const setup = {
    movies, audio,
    wmv3: movies ? await tools.loadWmv3() : null,
    xma: audio ? await tools.loadXma() : null,
    parse: audio ? audioContainer(game.audio) : null,
    rates: ratesOf(game.audio),
  };
  setup.kind = (path) => (setup.audio && fits(game.audio.match, path) ? 'xmop'
    : setup.movies && fits(game.movies.match, path) ? 'hevc' : null);
  return setup;
}

async function* blobChunks(blob, size = 8 << 20) {
  for (let at = 0; at < blob.size; at += size)
    yield new Uint8Array(await blob.slice(at, Math.min(blob.size, at + size)).arrayBuffer());
}

const asFile = (blob) => ({ size: blob.size, read: async (o, n) => new Uint8Array(await blob.slice(o, o + n).arrayBuffer()) });

// File `f` re-encoded (`kind` 'hevc' or 'xmop') into the zip under `dir`: { name, size, held } (name: the entry's, in the
// game folder; held: for a stand-in (NAME.lz4b, NAME.xmop...), the size of the file it stands for, for lib/vfs_index.js;
// null for a plain file) or { why } when it is kept as it is. compress(bytes, codec): the packing workers; cores: for in-flight blocks.
export async function reencodeInto(zip, dir, f, kind, { game, setup, compress, cores, audioFiles, tools = {} }) {
  const bytes = await f.read(0, f.size);
  if (kind === 'hevc') {
    const r = await reencodeMovie(bytes, setup.wmv3, { fraction: game.movies.fraction ?? 0.35, gop: game.movies.gop ?? 120 });
    if (!r.bytes) return { why: r.why };
    const blob = new Blob([r.bytes]);
    if (game.movies.zxc) {
      const size = await zip.addStream(`${dir}/${f.path}${SUFFIX}`, pack(asFile(blob), compress, { codec: 'zxc', inFlight: cores * 4 }));
      return { name: f.path + SUFFIX, size, held: blob.size };
    }
    await zip.addFile(`${dir}/${f.path}`, blob.size, blobChunks(blob));
    return { name: f.path, size: blob.size, held: null };
  }
  const a = game.audio;
  const r = await makeXmop(bytes, setup.xma, {
    path: f.path, pack: audioFiles.indexOf(f.path), rules: a.bitrates, jobs: Math.max(1, Math.min(4, cores)),
    parse: setup.parse, rates: setup.rates, ids: a.ids, ...(tools.encodeOpus ? { encodeOpus: tools.encodeOpus } : {}),
  });
  if (!r.parts) return { why: r.why };
  const blob = new Blob(r.parts);
  const name = `${f.path}.xmop`;
  if (a.pack) {
    // packed only when that saves enough (the Opus does not compress; a file's stored bytes may): packed once, kept in
    // memory (a sound file is at most a few tens of MB), and written packed or as it is
    const parts = [];
    let packed = 0;
    for await (const c of pack(asFile(blob), compress, { codec: a.pack, inFlight: cores * 4 })) { parts.push(c); packed += c.length; }
    if (1 - packed / blob.size >= (a.min_saving ?? 0.05)) {
      const size = await zip.addStream(`${dir}/${name}${SUFFIX}`, (async function* () { yield* parts; })());
      return { name: name + SUFFIX, size, held: f.size, made: r.made, candidates: r.candidates, kept: r.kept };
    }
  }
  await zip.addFile(`${dir}/${name}`, blob.size, blobChunks(blob));
  return { name, size: blob.size, held: f.size, made: r.made, candidates: r.candidates, kept: r.kept };
}
