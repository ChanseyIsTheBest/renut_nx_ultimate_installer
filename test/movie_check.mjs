// renut_nx_ultimate_installer (2026-11-23): checks a movie the page re-encoded (test/movie_browser.html) against the
// original: the same stream layout and sequence header, every audio object's bytes the same and in the same order, every
// video frame there (one H.265 access unit each, the first led by an access unit delimiter so the port's hook knows the
// movie), and the pictures' PSNR against the WMV3's (ffmpeg, each picture by its order).
//   node test/movie_check.mjs <original.wmv> <reencoded.wmv>
// FFMPEG (env): default C:/ffmpeg/ffmpeg.exe.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Asf } from '../lib/asf.js';

const [origPath, newPath] = process.argv.slice(2);
const FFMPEG = process.env.FFMPEG || 'C:/ffmpeg/ffmpeg.exe';
const a = new Asf(new Uint8Array(readFileSync(origPath)));
const b = new Asf(new Uint8Array(readFileSync(newPath)));
const fail = (why) => { console.log(`FAIL: ${why}`); process.exit(1); };
if (a.videoStream !== b.videoStream || a.width !== b.width || a.height !== b.height) fail('another stream layout');
if (Buffer.compare(Buffer.from(a.codecData), Buffer.from(b.codecData))) fail('another sequence header');
const ao = a.mediaObjects(), bo = b.mediaObjects();
const audioA = ao.filter((o) => o.stream !== a.videoStream), audioB = bo.filter((o) => o.stream !== b.videoStream);
if (audioA.length !== audioB.length) fail(`${audioB.length} audio objects for ${audioA.length}`);
audioA.forEach((o, i) => {
  if (o.stream !== audioB[i].stream || Buffer.compare(Buffer.from(o.data), Buffer.from(audioB[i].data))) fail(`audio object ${i} differs`);
});
const va = ao.filter((o) => o.stream === a.videoStream), vb = bo.filter((o) => o.stream === b.videoStream);
if (va.length !== vb.length) fail(`${vb.length} video frames for ${va.length}`);
const aud = [0, 0, 0, 1, 0x46, 0x01];
if (!aud.every((x, i) => vb[0].data[i] === x)) fail('the first frame is not led by an H.265 access unit delimiter');
const dir = mkdtempSync(join(tmpdir(), 'movie_check_'));
try {
  const hevc = join(dir, 'video.hevc');
  writeFileSync(hevc, Buffer.concat(vb.map((o) => Buffer.from(o.data))));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', origPath, '-f', 'hevc', '-i', hevc, '-lavfi',
    // the browser's encoder writes reserved colour primaries, which ffmpeg's conversions refuse: tagged as BT.709 here
    '[0:v]format=yuv420p,settb=1/30,setpts=N[a];[1:v]setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,' +
    'format=yuv420p,settb=1/30,setpts=N[b];[a][b]psnr', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = /PSNR y:([\d.inf]+) u:([\d.inf]+) v:([\d.inf]+) average:([\d.inf]+) min:([\d.inf]+)/.exec(r.stderr);
  const frames = (r.stderr.match(/frame=\s*(\d+)/g) || []).pop();
  if (!m) fail(`no PSNR from ffmpeg: ${r.stderr.slice(-400)}`);
  console.log(`OK: ${va.length} frames (${frames}), ${audioA.length} audio objects the same; ` +
              `PSNR y ${m[1]} average ${m[4]} min ${m[5]} dB; ${readFileSync(origPath).length} -> ${readFileSync(newPath).length} bytes`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
