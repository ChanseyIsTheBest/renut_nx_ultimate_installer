// culdcept-nx-installer (2026-11-20, the user: "We can have an option in thr web browser on by default to rencode videos
// or not reccomended on by default we can leave wmv as fallback"): one of the game's WMV movies as an H.265 copy, as the
// port plays it (culdcept-nx's app/src/cpu/culdcept_wmv_ffmpeg.cpp: a movie whose first frame is H.265 goes to the Switch's
// video hardware, NVDEC). The same file as culdcept-nx's tools/hevc_movie.py makes on a PC:
//   1. the ASF file read as its frames (lib/asf.js);
//   2. each WMV3 frame decoded (wasm/wmv3: FFmpeg's decoder) and encoded by the browser's H.265 encoder (WebCodecs, the
//      computer's video hardware) at `fraction` of the movie's own video bitrate (35 %: PSNR about 42 dB against the WMV3
//      picture), a keyframe every `gop` frames, no reordering (one picture out per frame in);
//   3. the file written again with the H.265 frames in place of the WMV3 ones (lib/asf.js), each led by an access unit
//      delimiter, so the port knows the movie by its first bytes.
// Returns null (and the WMV is kept as it is) when the browser has no H.265 encoder or the encoder does not give one
// frame per frame in order.
import { Asf } from './asf.js';

const AUD = new Uint8Array([0, 0, 0, 1, 0x46, 0x01, 0x50]);  // an H.265 access unit delimiter (any picture type)

export function hevcConfig(width, height, kbps, fps) {
  return {
    codec: 'hvc1.1.6.L120.B0',  // Main profile, level 4: 1280x720 at 60 fps
    width, height,
    bitrate: Math.round(kbps * 1000),
    bitrateMode: 'variable',
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    hevc: { format: 'annexb' },
  };
}

// Whether this browser can encode the movies' H.265 (WebCodecs with an H.265 encoder).
export async function canEncodeHevc() {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return !!(await VideoEncoder.isConfigSupported(hevcConfig(1280, 720, 1500, 60))).supported;
  } catch {
    return false;
  }
}

// bytes: the .wmv file; wmv3: an instance of wasm/wmv3.mjs. -> { bytes, frames, kbps } or null (keep the WMV), and why.
export async function reencodeMovie(bytes, wmv3, { fraction = 0.35, gop = 120, minKbps = 200 } = {}) {
  const asf = new Asf(bytes);
  const objs = asf.mediaObjects();
  const video = objs.filter((o) => o.stream === asf.videoStream);
  if (video.length < 2) return { bytes: null, why: 'no video frames' };
  const span = (video[video.length - 1].time - video[0].time) / 1000;
  const seconds = span * video.length / (video.length - 1);
  const fps = video.length / seconds;
  const sourceKbps = video.reduce((n, o) => n + o.data.length, 0) * 8 / seconds / 1000;
  const kbps = Math.max(minKbps, sourceKbps * fraction);
  const config = hevcConfig(asf.width, asf.height, kbps, Math.round(fps));
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) return { bytes: null, why: 'this browser has no H.265 encoder' };

  // the WMV3 decoder, set up from the stream's sequence header
  const seq = wmv3._wmv3_malloc(Math.max(1, asf.codecData.length));
  wmv3.HEAPU8.set(asf.codecData, seq);
  if (wmv3._wmv3_open(seq, asf.codecData.length, asf.width, asf.height) < 0) {
    wmv3._wmv3_free(seq);
    return { bytes: null, why: 'the WMV3 decoder did not open' };
  }
  wmv3._wmv3_free(seq);
  const frameBytes = asf.width * asf.height * 3 / 2;
  let input = wmv3._wmv3_malloc(1 << 20), inputSize = 1 << 20;

  const chunks = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(config);
  try {
    for (let i = 0; i < video.length; ++i) {
      const o = video[i];
      if (o.data.length > inputSize) {
        wmv3._wmv3_free(input);
        inputSize = o.data.length;
        input = wmv3._wmv3_malloc(inputSize);
      }
      wmv3.HEAPU8.set(o.data, input);
      if (wmv3._wmv3_decode(input, o.data.length) !== 1) return { bytes: null, why: `WMV3 frame ${i} gave no picture` };
      const p = wmv3._wmv3_picture();
      const frame = new VideoFrame(wmv3.HEAPU8.slice(p, p + frameBytes), {
        format: 'I420', codedWidth: asf.width, codedHeight: asf.height,
        timestamp: Math.round(o.time * 1000), duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 8 && !failure) await new Promise((r) => setTimeout(r, 1));
      if (failure) break;
    }
    await encoder.flush();
  } catch (e) {
    failure = failure || e;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    wmv3._wmv3_free(input);
    wmv3._wmv3_close();
  }
  if (failure) return { bytes: null, why: `the encoder failed: ${failure.message || failure}` };
  if (chunks.length !== video.length) return { bytes: null, why: `${chunks.length} H.265 frames for ${video.length}` };
  for (let i = 1; i < chunks.length; ++i)
    if (chunks[i].timestamp <= chunks[i - 1].timestamp) return { bytes: null, why: 'the encoder reordered frames' };
  if (!chunks[0].key) return { bytes: null, why: 'the first H.265 frame is not a keyframe' };

  // An access unit delimiter first, unless the encoder put one there (Chrome's does): one per access unit.
  const startsWithAud = (d) => {
    const i = d[2] === 1 ? 3 : d[3] === 1 ? 4 : -1;
    return d[0] === 0 && d[1] === 0 && i > 0 && ((d[i] >> 1) & 0x3f) === 35;
  };
  video.forEach((o, i) => {
    const c = chunks[i].data;
    if (startsWithAud(c)) {
      o.data = c;
    } else {
      o.data = new Uint8Array(AUD.length + c.length);
      o.data.set(AUD);
      o.data.set(c, AUD.length);
    }
    o.key = chunks[i].key;
  });
  return { bytes: asf.write(objs), frames: video.length, kbps: Math.round(kbps), why: null };
}
