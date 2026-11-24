// renut_nx_ultimate_installer: the page. The player chooses their disc image (lib/xiso.js) or the folder the game was
// extracted to, and the DLC packages if the port takes them; worker.js makes the Switch package from them (the shaders,
// the LZ4-packed files: lib/install.js) and sw.js serves it as a download. Everything game-specific comes from
// game.json and release/manifest.json.
// From rr6-nx-installer's and kameo-nx-installer's app.js (bejeweled3-nx-installer's, ChanseyIsTheBest;
// nfsmw-nx-installer's download flow, StevensND; GPL-3.0).
import { listXiso } from './lib/xiso.js';
import { checkGameFiles, describeProblems, optionalPaths } from './lib/game_check.js';
import { checkUpdate, updateFromPackage } from './lib/update.js';

const $ = (id) => document.getElementById(id);
const folderInput = $('folder'), isoInput = $('iso'), chosen = $('chosen'), detected = $('detected');
const dlcInput = $('dlc'), dlcFolderInput = $('dlc-folder'), dlcChosen = $('dlc-chosen'), dlcDetected = $('dlc-detected');
const updateInput = $('update'), updateFolderInput = $('update-folder'), updateChosen = $('update-chosen');
const updateDetected = $('update-detected');
const create = $('create'), compileBox = $('compile'), bar = $('bar'), logBox = $('log');
// no-cache (blur-nx-installer, 2026-11-19): the browser asks the server whether its copy is current, so a copy it
// cached (GitHub Pages allows 10 minutes) never meets a newer release
const manifest = fetch('./release/manifest.json', { cache: 'no-cache' }).then((r) => r.json());
const game = fetch('./game.json', { cache: 'no-cache' }).then((r) => r.json());
let entries = null;
let dlc = [];  // [{ path (under dlc/), size, file }]
let update = null;  // blur-nx (2026-11-18): the title update when game.json names one: [{ path (in the update), size, file }]
let busy = false;
let downloadFrame = null;

// the texts of game.json (trusted: the port's own file, as the page's HTML is)
game.then((g) => {
  document.title = `${g.package} web installer`;
  for (const el of document.querySelectorAll('[data-game]')) el.textContent = g[el.dataset.game];
  for (const el of document.querySelectorAll('[data-text]')) el.innerHTML = g.texts?.[el.dataset.text] || '';
  if ($('dlc-step')) $('dlc-step').hidden = !g.dlc;  // a port's page may leave the DLC step out (blur-nx-installer)
  $('update-step').hidden = !g.update;
  for (const el of document.querySelectorAll('[data-update]')) el.textContent = g.update?.[el.dataset.update] || '';
  // the steps' numbers, over the ones this game shows
  let n = 0;
  for (const el of document.querySelectorAll('section:not([hidden]) h2 .n')) el.textContent = `${++n}. `;
  $('compile-row').hidden = !g.shaders;
  $('movies-row').hidden = !g.movies;
  $('audio-row').hidden = !g.audio;
  $('reencode-note').hidden = !g.movies && !g.audio;
  if (g.texts?.movies) $('movies-text').innerHTML = g.texts.movies;  // the game's figures, when game.json has them
  if (g.texts?.audio) $('audio-text').innerHTML = g.texts.audio;
  create.textContent = `Create ${g.package}.zip`;
  manifest.then((m) => { $('version').textContent = `version ${m.version}`; });
});

function log(text, error = false) {
  const line = document.createElement('div');
  line.textContent = text;
  if (error) line.className = 'error';
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function formatSize(bytes) {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${(bytes / (1 << 20)).toFixed(0)} MB`;
}

async function sha256(blob) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function show(state, text, box = detected) {
  box.hidden = false;
  box.className = `detected ${state}`;
  box.textContent = text;
}

let needsUpdate = false;
game.then((g) => { needsUpdate = !!g.update; updateCreate(); });

function updateCreate() {
  create.disabled = busy || !entries || (needsUpdate && !update);
}

// list: [{ path (in the game), size, file, offset (in a disc image) }]
async function choose(list, what) {
  entries = null;
  updateCreate();
  const g = await game;
  const total = list.reduce((n, e) => n + e.size, 0);
  chosen.textContent = `${what}: ${list.length} files, ${formatSize(total)}`;
  const xex = list.find((e) => e.path.toLowerCase() === 'default.xex');
  if (!xex) {
    show('bad', 'No default.xex: choose the folder the game disc was extracted to, or the disc image.');
    return;
  }
  show('', 'Checking default.xex...');
  const blob = xex.offset === undefined ? xex.file : xex.file.slice(xex.offset, xex.offset + xex.size);
  const hash = await sha256(blob);
  const build = (await manifest).builds.find((b) => b.xex_sha256 === hash);
  if (!build) {
    show('bad', `This default.xex is not one this release supports. Its SHA-256: ${hash}`);
    return;
  }
  // 2026-11-18: every file of the copy the release was made from (the build's "game_files"), with its size: a copy with
  // default.xex and little else (or a file cut short) is refused here, with what is missing named (lib/game_check.js).
  const problems = describeProblems(checkGameFiles(list, build.game_files, optionalPaths(g)));
  if (problems) {
    show('bad', problems);
    return;
  }
  const missing = (g.needs || []).filter((p) => !list.some((e) => new RegExp(`^(?:${p})$`, 'i').test(e.path)));
  if (missing.length) {
    show('bad', `Files are missing (${missing.map((p) => p.replace(/\\/g, '')).join(', ')}): choose the whole extracted game.`);
    return;
  }
  show('good', `${g.title} (${build.edition}), supported.`);
  entries = list;
  updateCreate();
}

// The DLC: Xbox 360 packages ("LIVE", "PIRS" or "CON "), copied whole to switch/<package>/dlc/; the game installs them.
async function chooseDlc(list) {
  dlc = [];
  const g = await game;
  if (!list.length) {
    dlcChosen.textContent = 'None.';
    dlcDetected.hidden = true;
    return;
  }
  const kept = [];
  let skipped = 0;
  for (const e of list) {
    const magic = String.fromCharCode(...new Uint8Array(await e.file.slice(0, 4).arrayBuffer()));
    if (e.size >= 0x1000 && (magic === 'LIVE' || magic === 'PIRS' || magic === 'CON ')) kept.push(e);
    else skipped++;
  }
  const total = kept.reduce((n, e) => n + e.size, 0);
  dlcChosen.textContent = `${kept.length} package${kept.length === 1 ? '' : 's'}, ${formatSize(total)}` +
    (skipped ? ` (${skipped} other file${skipped === 1 ? '' : 's'} left out)` : '');
  if (!kept.length) {
    show('bad', 'None of these is an Xbox 360 package.', dlcDetected);
    return;
  }
  show('good', `${kept.length} DLC package${kept.length === 1 ? '' : 's'} will go to switch/${g.package}/dlc/.`, dlcDetected);
  dlc = kept;
}

// blur-nx (2026-11-18): the title update (game.json "update"), as the Xbox 360 package the player has (lib/stfs.js reads
// it here) or the folder it was extracted to; checked against the release's (lib/update.js). Its default.xexp goes to
// game_root/, its other files to update/.
const readerOf = (file) => async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
const readable = (list) => list.map((e) => ({ ...e, read: readerOf(e.file) }));

// The files of a package, as Blobs the worker can take; null when the file is not an Xbox 360 package.
async function packageFiles(file) {
  const pkg = await updateFromPackage(readerOf(file), file.size);
  if (!pkg) return null;
  const out = [];
  for (const f of pkg.files) out.push({ path: f.path, size: f.size, file: new Blob([await f.read(0, f.size)]) });
  return out;
}

async function chooseUpdate(list, what) {
  update = null;
  updateCreate();
  const g = await game;
  const title = g.update?.title || 'the title update';
  const total = list.reduce((n, e) => n + e.size, 0);
  updateChosen.textContent = `${what}: ${list.length} file${list.length === 1 ? '' : 's'}, ${formatSize(total)}`;
  show('', 'Checking the update...', updateDetected);
  let problem = 'This release takes no title update.';
  for (const b of (await manifest).builds.filter((x) => x.update)) {
    problem = await checkUpdate(b, readable(list), title);
    if (!problem) break;
  }
  if (problem) {
    show('bad', problem, updateDetected);
    return;
  }
  show('good', `${title[0].toUpperCase()}${title.slice(1)}, supported: its default.xexp goes to switch/${g.package}/game_root/, ` +
       `its other files to switch/${g.package}/update/.`, updateDetected);
  update = list;
  updateCreate();
}

updateInput.addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const files = await packageFiles(file);
    if (!files) {
      updateChosen.textContent = file.name;
      show('bad', `${file.name} is not an Xbox 360 package: choose the update's own file (a LIVE package, named like TU_...).`,
           updateDetected);
      return;
    }
    await chooseUpdate(files, file.name);
  } catch (error) {
    show('bad', `${file.name}: ${error.message}`, updateDetected);
  }
});

updateFolderInput.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  const top = files[0].webkitRelativePath.split('/')[0];
  try {
    // an extracted update: its files from the folder that holds default.xexp (the chosen one or one inside it)
    const xexp = files.find((f) => /(^|\/)default\.xexp$/i.test(f.webkitRelativePath));
    if (xexp) {
      const base = xexp.webkitRelativePath.slice(0, -'default.xexp'.length);
      const inside = files.filter((f) => f.webkitRelativePath.startsWith(base));
      await chooseUpdate(inside.map((file) => ({ path: file.webkitRelativePath.slice(base.length), size: file.size, file })), top);
      return;
    }
    // a folder with the package in it (as the console keeps it): the first package of the folder that is the update
    for (const f of files.filter((x) => x.size >= 0x1000).slice(0, 64)) {
      const inside = await packageFiles(f);
      if (inside && inside.some((x) => x.path.toLowerCase() === 'default.xexp')) {
        await chooseUpdate(inside, `${top}: ${f.name}`);
        return;
      }
    }
    updateChosen.textContent = `${top}: ${files.length} files`;
    show('bad', 'No default.xexp and no update package in this folder.', updateDetected);
  } catch (error) {
    show('bad', `${top}: ${error.message}`, updateDetected);
  }
});

dlcInput?.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  await chooseDlc(files.map((file) => ({ path: file.name, size: file.size, file })));
});

dlcFolderInput?.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  // the paths inside the chosen folder (its own name dropped): the game walks into subfolders of dlc/
  await chooseDlc(files.map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), size: file.size, file })));
});

folderInput.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  // the paths inside the chosen folder (its own name dropped)
  await choose(files.map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), size: file.size, file })),
               files[0].webkitRelativePath.split('/')[0]);
});

isoInput.addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  try {
    const files = await listXiso(read, file.size);
    if (!files) {
      entries = null;
      updateCreate();
      show('bad', `${file.name} is not an Xbox 360 disc image.`);
      return;
    }
    await choose(files.map((f) => ({ path: f.path, size: f.size, file, offset: f.offset })), file.name);
  } catch (error) {
    show('bad', error.message);
  }
});

// The zip is served by sw.js as a normal browser download, streamed while it is being made.
async function downloadHelper() {
  if (!('serviceWorker' in navigator)) throw new Error('this browser cannot stream a download (no service workers)');
  await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const claimed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    registration.active.postMessage({ type: 'claim' });
    await claimed;
  }
  return navigator.serviceWorker.controller;
}
const helper = downloadHelper();
helper.catch(() => {});

create.addEventListener('click', async () => {
  if (!entries || busy || (needsUpdate && !update)) return;
  let controller;
  try {
    controller = await helper;
  } catch (error) {
    log(`Error: ${error.message}`, true);
    return;
  }
  const zipName = `${(await game).package}.zip`;
  busy = true;
  create.disabled = true;
  bar.hidden = false;
  bar.value = 0;
  logBox.textContent = '';
  const channel = new MessageChannel();
  const keepAlive = setInterval(() => controller.postMessage({ type: 'ping' }), 10000);
  const worker = new Worker('./worker.js', { type: 'module' });
  const finish = () => {
    clearInterval(keepAlive);
    worker.terminate();
    busy = false;
    updateCreate();
  };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') {
      log(data.text);
    } else if (data.type === 'progress') {
      bar.value = data.fraction;
    } else if (data.type === 'start') {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ack = new MessageChannel();
      const registered = new Promise((resolve) => (ack.port1.onmessage = resolve));
      controller.postMessage({ type: 'download', id, filename: zipName, size: null }, [channel.port2, ack.port2]);
      await registered;
      // a hidden frame opens the download: its request is a navigation, which always reaches the service worker
      downloadFrame?.remove();
      downloadFrame = document.createElement('iframe');
      downloadFrame.hidden = true;
      downloadFrame.src = `./download/${id}/${zipName}`;
      document.body.appendChild(downloadFrame);
      log(`Download started: ${zipName}, about ${formatSize(data.estimate)}. Keep this page open until it finishes.`);
    } else if (data.type === 'done') {
      bar.value = 1;
      log(`Finished in ${data.seconds} s: ${zipName} is ${formatSize(data.size)}.`);
      finish();
    } else if (data.type === 'error') {
      log(`Error: ${data.message}`, true);
      finish();
    }
  };
  worker.onerror = (event) => {
    log(`Error: ${event.message}`, true);
    finish();
  };
  // 2026-11-23: the re-encodes the page offers (game.json "movies", "audio"; vivapinata-nx-installer's, the user there:
  // "Make sure you give option for user not to rencode as well")
  const options = { movies: !!$('movies')?.checked, audio: !!$('audio')?.checked };
  worker.postMessage({ entries, dlc, update: update || [], compile: compileBox.checked, options, port: channel.port1 },
                     [channel.port1]);
});
