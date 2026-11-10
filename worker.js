// renut_nx_ultimate_installer: makes the package off the page's thread (lib/install.js) and streams the zip to the
// download service worker (sw.js). From rr6-nx-installer's and kameo-nx-installer's worker.js (bejeweled3-nx-installer's,
// nfsmw-nx-installer's download stream, GPL-3.0).
import createRenutHlslModule from './wasm/renut_hlsl.mjs';
import createLzxModule from './wasm/lzx.mjs';
import { buildPackage } from './lib/install.js';
import { glslMaker, uamCompile, workerPool } from './lib/pool.js';

const quiet = () => ({ print: () => {}, printErr: () => {} });

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A release file, checked against the SHA-256 the manifest gives for it.
async function fetchRelease(name, hash) {
  const bytes = await fetchBytes(`./release/${name}`);
  const got = await sha256(bytes);
  if (hash && got !== hash) throw new Error(`release/${name} is not the one the manifest names (${got})`);
  return bytes;
}

// Sends every write as one chunk, and only when the download has asked for more ("pull").
function portSink(port) {
  let credits = 0, cancelled = false, waiting = null;
  port.onmessage = ({ data }) => {
    if (data.type === 'pull') credits++;
    else if (data.type === 'cancel') cancelled = true;
    if (waiting) { const wake = waiting; waiting = null; wake(); }
  };
  return {
    async write(bytes) {
      while (!credits) {
        if (cancelled) throw new Error('the download was cancelled');
        await new Promise((resolve) => (waiting = resolve));
      }
      if (cancelled) throw new Error('the download was cancelled');
      credits--;
      const copy = bytes.slice();
      port.postMessage({ type: 'chunk', buffer: copy.buffer }, [copy.buffer]);
    },
    async close() { port.postMessage({ type: 'end' }); },
    fail(message) { port.postMessage({ type: 'error', message }); },
  };
}

// The game's files: { path (in the game folder), size, read(offset, length) } from the page's Files, or for
// test/browser.html from the test server (HTTP range requests). A file inside a disc image has the image as its file
// and its offset there (lib/xiso.js).
function gameFiles(entries) {
  return entries.map((e) => ({
    path: e.path,
    size: e.size,
    read: e.file
      ? async (offset, length) => {
          const at = (e.offset || 0) + offset;
          return new Uint8Array(await e.file.slice(at, at + length).arrayBuffer());
        }
      : async (offset, length) => {
          const r = await fetch(e.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
          if (!r.ok) throw new Error(`${e.url}: HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
  }));
}

// count Web Workers of a script, each started and ready, as lib/pool.js takes them
function startWorkers(script, count) {
  return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const w = new Worker(script, { type: 'module' });
    w.onerror = (e) => reject(new Error(`${script}: ${e.message}`));
    w.addEventListener('message', ({ data }) => {
      if (data.ready) resolve({ w, version: data.version, post: (m, t) => w.postMessage(m, t),
                                onMessage: (cb) => w.addEventListener('message', ({ data: d }) => cb(d)) });
    }, { once: true });
  })));
}

// One kind of worker as lib/install.js takes it: { run, version, stop() }.
async function tool(script, count, wrap) {
  const workers = await startWorkers(script, count);
  return { run: wrap(workerPool(workers)), version: workers[0].version, stop: () => workers.forEach((x) => x.w.terminate()) };
}

self.onmessage = async ({ data }) => {
  const sink = portSink(data.port);
  try {
    const [game, manifest] = (await Promise.all([fetchBytes('./game.json'), fetchBytes('./release/manifest.json')]))
      .map((b) => JSON.parse(new TextDecoder().decode(b)));
    const cores = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
    // A GLSL worker (Pyodide, numpy, DXC) holds about 0.5 GB: at most 8, fewer on a device with less memory
    // (navigator.deviceMemory, in GB, Chromium only). uam and LZ4 workers are small: one per core.
    const glslThreads = Math.max(1, Math.min(cores, 8, navigator.deviceMemory || 8));
    const tools = {
      cores,
      glslThreads,
      translator: game.shaders ? await createRenutHlslModule(quiet()) : null,
      lzx: game.shaders ? await createLzxModule(quiet()) : null,
      startGlsl: (n) => tool('./glsl_worker.js', n, glslMaker),
      startUam: (n) => tool('./uam_worker.js', n, uamCompile),
      startLz4: (n) => tool('./lz4_worker.js', n, (pool) => (bytes, level) =>
        pool.run({ bytes, level }, [bytes.buffer]).then((r) => r.bytes)),
    };
    const report = await buildPackage({
      game, manifest, files: gameFiles(data.entries), dlc: gameFiles(data.dlc || []), fetchRelease, tools, sink,
      compile: data.compile !== false,
      events: {
        log: (text) => postMessage({ type: 'log', text }),
        progress: (fraction) => postMessage({ type: 'progress', fraction }),
        start: (estimate) => postMessage({ type: 'start', estimate }),
      },
    });
    postMessage({ type: 'done', seconds: report.seconds, size: report.size });
  } catch (error) {
    const message = error.message || String(error);
    sink.fail(message);
    postMessage({ type: 'error', message });
  }
};
