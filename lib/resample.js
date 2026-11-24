// sasrt-nx-installer (2026-11-21): 44.1 kHz sounds to 48 kHz for Opus (which has no 44.1 kHz rate). A windowed-sinc
// resampler (Kaiser, 32 taps a phase, cutoff 0.475 of the input rate), the same in the page and test/xmop_node.mjs:
// output sample m is the sound at time m / 48000 (input sample m x 147 / 160), so sample 0 of both is the same instant.
// sasrt-nx's XMA emulation resamples the 48 kHz Opus back to 44.1 kHz.

const TAPS = 32;  // input samples a phase (16 either side)
const CUTOFF = 0.475;  // of the input rate
const BETA = 8;

function bessel0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; ++k) {
    t *= (x / (2 * k)) * (x / (2 * k));
    s += t;
  }
  return s;
}

const tables = new Map();
// Phase k of den: output m with (m x num) % den == k sits k / den of an input sample after input floor(m x num / den).
function table(num, den) {
  const key = `${num}/${den}`;
  if (tables.has(key)) return tables.get(key);
  const t = new Float32Array(den * TAPS);
  const i0b = bessel0(BETA);
  for (let k = 0; k < den; ++k) {
    const frac = k / den;
    let sum = 0;
    for (let j = 0; j < TAPS; ++j) {
      const x = j - (TAPS / 2 - 1) - frac;  // input sample (base - 15 + j) is x samples from the output's time
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * 2 * CUTOFF * x) / (Math.PI * 2 * CUTOFF * x);
      const r = x / (TAPS / 2);
      const w = Math.abs(r) >= 1 ? 0 : bessel0(BETA * Math.sqrt(1 - r * r)) / i0b;
      t[k * TAPS + j] = sinc * w;
      sum += sinc * w;
    }
    for (let j = 0; j < TAPS; ++j) t[k * TAPS + j] /= sum;
  }
  tables.set(key, t);
  return t;
}

// Interleaved float PCM at `from` Hz (44100) to `to` Hz (48000); the output covers the whole input:
// ceil(frames x to / from) frames.
export function resample(pcm, channels, from, to) {
  if (from === to) return pcm;
  const g = gcd(from, to), num = from / g, den = to / g;  // 147 / 160
  const t = table(num, den);
  const inFrames = pcm.length / channels;
  const outFrames = Math.ceil(inFrames * to / from);
  const out = new Float32Array(outFrames * channels);
  for (let m = 0; m < outFrames; ++m) {
    const pos = m * num;
    const base = Math.floor(pos / den), k = pos % den;
    const row = k * TAPS;
    const first = base - (TAPS / 2 - 1);
    for (let c = 0; c < channels; ++c) {
      let s = 0;
      for (let j = 0; j < TAPS; ++j) {
        const i = first + j;
        if (i >= 0 && i < inFrames) s += pcm[i * channels + c] * t[row + j];
      }
      out[m * channels + c] = s;
    }
  }
  return out;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
