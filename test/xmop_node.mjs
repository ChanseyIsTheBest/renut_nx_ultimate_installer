// renut_nx_ultimate_installer (2026-11-23): the page's Opus re-encode (lib/audio.js makeXmop, the reader game.json's
// audio "container" names) on a PC, with ffmpeg's libopus for the encoder (Node has no WebCodecs: test/opus_node.mjs).
// Writes NAME.xmop for each audio file into OUT (the game folder's paths) and prints the sizes.
// sasrt-nx-installer's and vivapinata-nx-installer's test/xmop_node.mjs (credit both; culdcept-nx-installer's
// test/audio_node.mjs before them), now through the library itself.
//   node test/xmop_node.mjs <game folder> <out folder> [regex of paths, default game.json's audio match] [--jobs N]
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import createXmaModule from '../wasm/xma.mjs';
import { makeXmop } from '../lib/audio.js';
import { audioContainer } from '../lib/media.js';
import { ratesOf } from '../lib/xmop.js';
import { encodeOpusFfmpeg } from './opus_node.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const jobs = Number(flag('--jobs', '12'));
const config = JSON.parse(readFileSync(new URL('../game.json', import.meta.url)));
const [game, out, pattern = config.audio.match] = args;
if (!game || !out) {
  console.error('usage: node test/xmop_node.mjs <game folder> <out folder> [regex] [--jobs N]');
  process.exit(2);
}
const re = new RegExp(`^(?:${pattern})$`, 'i');

function walk(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, list);
    else list.push(relative(game, p).replace(/\\/g, '/'));
  }
  return list;
}

const xma = await createXmaModule({ print: () => {}, printErr: () => {} });
const all = walk(game);
const audioFiles = all.filter((p) => new RegExp(`^(?:${config.audio.match})$`, 'i').test(p)).sort();
const files = audioFiles.filter((p) => re.test(p));
const parse = audioContainer(config.audio);
const rates = ratesOf(config.audio);
const mb = (n) => (n / 1048576).toFixed(2);
let inAll = 0, outAll = 0, made = 0, kept = 0;
const keptWhy = new Map();
for (const path of files) {
  const t0 = Date.now();
  const d = new Uint8Array(readFileSync(join(game, path)));
  const r = await makeXmop(d, xma, { path, pack: audioFiles.indexOf(path), rules: config.audio.bitrates, jobs, parse, rates,
                                     ids: config.audio.ids, encodeOpus: encodeOpusFfmpeg });
  inAll += d.length;
  if (!r.parts) {
    outAll += d.length;
    ++kept;
    keptWhy.set(r.why, (keptWhy.get(r.why) || 0) + 1);
    if (files.length <= 40) console.log(`${path}: kept as XMA (${r.why})`);
    continue;
  }
  ++made;
  outAll += r.size;
  const dst = join(out, path + '.xmop');
  mkdirSync(dirname(dst), { recursive: true });
  const ws = createWriteStream(dst);
  for (const p of r.parts) if (!ws.write(p)) await new Promise((res) => ws.once('drain', res));
  await new Promise((res, j) => { ws.end(res); ws.on('error', j); });
  if (files.length <= 40 || d.length > 1 << 20) {
    console.log(`${path}: ${mb(d.length)} MB -> ${mb(r.size)} MB (${(100 * r.size / d.length).toFixed(1)} %), ` +
                `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
console.log(`${files.length} files: ${made} as .xmop, ${kept} kept; ${mb(inAll)} MB -> ${mb(outAll)} MB ` +
            `(${(100 * outAll / Math.max(1, inAll)).toFixed(1)} %)`);
for (const [why, n] of keptWhy) console.log(`  kept ${n}: ${why}`);
