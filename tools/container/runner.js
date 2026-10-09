#!/usr/bin/env node
// Runs ShadowPKG build jobs inside a container, with the repack kit under Wine.
// Node stdlib only. It speaks the same job protocol as the Windows builder
// (tools/windows), so ShadowPKG needs no changes for either:
//
//   job.json    written by ShadowPKG beside the dump      (read here)
//   state.json  running / failed / done, plus progress     (written here)
//   build.log   the tool's output                          (written here)
//
// It needs no network to work. Jobs are found by reading ShadowPKG's own
// builds.json, mounted read-only, and progress goes back through the job folder.
//
//   runner.js setup    guided: init, smoke and trust in order, skipping what is done
//   runner.js status   what is ready and what is not
//   runner.js init     one-time, needs network: Wine prefix, VC++ runtime, .NET, Python
//   runner.js smoke    does the kit's main program start at all under Wine?
//   runner.js trust    approve the kit's exact files (sha256) before anything runs
//   runner.js watch    the default: poll for jobs and build them
//   runner.js once     build one waiting job and exit
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const readline = require('readline');

const E = process.env;
const KIT = E.KIT_DIR || '/kit';
const CONFIG = E.CONFIG_DIR || '/config';
const WORK = E.WORK_DIR || '/work';
const SPKG = E.SPKG_CONFIG || '/spkg';
const PREFIX = E.WINEPREFIX || '/prefix';
const WINE = E.SPKG_WINE_ARGV ? JSON.parse(E.SPKG_WINE_ARGV) : ['wine'];
const NATIVE = E.SPKG_NATIVE_PATHS === '1';          // tests only: no Z: mapping
const PYTHON = E.SPKG_PYTHON || path.join(PREFIX, 'drive_c', 'python', 'python.exe');
// The libraries this builder can write into. ShadowPKG publishes its own list beside builds.json
// (libraries.json: each library's id and its folder as ShadowPKG sees it), and every one of them
// that exists at the same path here is used with no setting at all: mount the folder in this
// container at the same path as in ShadowPKG and it is found. LIBRARIES (id=path, comma separated)
// adds to that or overrides it, for a folder mounted at a different place. With no list published
// (an older ShadowPKG, or its config folder not mounted here) and no LIBRARIES it is games=/games,
// as it always was.
const LIBS_ENV = E.LIBRARIES ? Object.fromEntries(E.LIBRARIES.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('='))) : null;
const LIBS = {};                 // id -> folder; kept up to date by refreshLibs()
let LIBS_MISSING = [];           // in ShadowPKG's list but not mounted here: [{id, label, root}]
const LIBS_FILE = path.join(SPKG, 'libraries.json');
function publishedLibraries() {
  try {
    const j = JSON.parse(fs.readFileSync(LIBS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return (Array.isArray(j.libraries) ? j.libraries : [])
      .filter(l => l && /^[A-Za-z0-9._-]{1,64}$/.test(String(l.id)) && typeof l.root === 'string' && path.isAbsolute(l.root))
      .map(l => ({ id: String(l.id), label: String(l.label || l.id).slice(0, 80), root: path.resolve(l.root) }));
  } catch { return null; }
}
// A published folder is a library, never this builder's own places or the filesystem root.
const ownPlaces = () => [KIT, CONFIG, WORK, SPKG, PREFIX].map(p => path.resolve(p));
function libraryFolderOk(root) {
  if (root === path.parse(root).root) return false;
  return !ownPlaces().some(p => root === p || root.startsWith(p + path.sep));
}
function refreshLibs() {
  const pub = publishedLibraries();
  const next = {}, missing = [];
  if (LIBS_ENV) Object.assign(next, LIBS_ENV);
  else if (!pub) next.games = '/games';
  for (const l of pub || []) {
    if (next[l.id] || !libraryFolderOk(l.root)) continue;
    let isDir = false; try { isDir = fs.statSync(l.root).isDirectory(); } catch {}
    if (isDir) next[l.id] = l.root; else missing.push(l);
  }
  const changed = JSON.stringify(LIBS) !== JSON.stringify(next);
  for (const k of Object.keys(LIBS)) delete LIBS[k];
  Object.assign(LIBS, next);
  LIBS_MISSING = missing;
  return changed;
}
const addPathAdvice = l => `add a Path to this container: container path ${l.root}, host path the same folder ShadowPKG's "${l.label}" library uses, read/write`;
refreshLibs();
const POLL_MS = (parseInt(E.POLL_SECONDS || '30', 10) || 30) * 1000;
const COPY_DUMP = /^(1|true|yes|on)$/i.test(E.COPY_DUMP || '');
const KEEP_WORK = /^(1|true|yes|on)$/i.test(E.KEEP_WORK || '');
const PINS_FILE = path.join(CONFIG, 'pins.json');
// Python's console detection for its standard streams is what fails under Wine
// with redirected output; this makes it use plain file I/O instead.
const PY_ENV = { PYTHONLEGACYWINDOWSSTDIO: '1', PYTHONIOENCODING: 'utf-8' };
const PY_EMBED = E.PYTHON_EMBED_URL || 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip';

// Everything the builder says goes to the console (docker logs) and to
// CONFIG/builder.log, which is in the container's appdata folder, so it can be
// opened from the share and survives the container being recreated. Two files of
// 2 MB, like ShadowPKG's own server.log. A copy of the tail is put at each
// library's root (see writeBuilderStatus) for ShadowPKG to show.
const LOG_FILE = path.join(CONFIG, 'builder.log');
const LOG_MAX = 2 * 1024 * 1024;
let logWritten = -1, logBroken = false, logDirty = true;
function toLogFile(line) {
  if (logBroken) return;
  try {
    if (logWritten < 0) { try { logWritten = fs.statSync(LOG_FILE).size; } catch { logWritten = 0; } }
    if (logWritten >= LOG_MAX) { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); logWritten = 0; }
    fs.appendFileSync(LOG_FILE, line + '\n');
    logWritten += line.length + 1;
    logDirty = true;
  } catch { logBroken = true; }   // a full or read-only /config must not stop builds
}
const log = m => { const line = `${new Date().toISOString()}  ${m}`; console.log(line); toLogFile(line); };
function logTail(bytes) {
  const read = f => {
    try {
      const st = fs.statSync(f), n = Math.min(bytes, st.size), b = Buffer.alloc(n), fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
      return b.toString('utf8');
    } catch { return ''; }
  };
  let out = read(LOG_FILE);
  if (out.length < bytes) out = read(LOG_FILE + '.1').slice(-(bytes - out.length)) + out;
  const nl = out.indexOf('\n');
  return nl > 0 && out.length >= bytes ? out.slice(nl + 1) : out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const winePath = p => NATIVE ? p : 'Z:' + p.replace(/\//g, '\\');

// ---- The kit's files and the hashes approved for them -----------------------
const PIN_EXT = /\.(exe|dll|ps1|py|bat|cmd|sys)$/i;
function hashKit(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && PIN_EXT.test(e.name)) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex').toUpperCase();
    }
  };
  walk(dir, '');
  return out;
}

function pinProblems(now) {
  let pins;
  try { pins = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch { return ['the kit has not been approved yet; run: runner.js trust']; }
  const bad = [];
  for (const k of Object.keys(now)) { if (!(k in pins)) bad.push(`not approved: ${k}`); else if (pins[k] !== now[k]) bad.push(`changed: ${k}`); }
  for (const k of Object.keys(pins)) if (!(k in now)) bad.push(`missing: ${k}`);
  return bad;
}

async function trust() {
  const hashes = hashKit(KIT);
  console.log(`Files in ${KIT} that would be approved (${Object.keys(hashes).length}):`);
  for (const [k, v] of Object.entries(hashes)) console.log(`  ${k.padEnd(48)} ${v.slice(0, 12)}`);
  console.log('\nApproving them means these programs will be run inside this container.');
  let yes = process.argv.includes('--yes');
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    yes = await new Promise(r => rl.question('Type YES to approve exactly these files: ', a => { rl.close(); r(a === 'YES'); }));
  }
  if (!yes) { console.log('Not approved.'); process.exit(1); }
  fs.mkdirSync(CONFIG, { recursive: true });
  fs.writeFileSync(PINS_FILE, JSON.stringify(hashes, null, 2));
  console.log('Approved.');
}

// ---- Running things ----------------------------------------------------------
// One child, its output appended to files, resolving to its exit code. `beat`
// runs every few seconds while it works.
//
// All three standard streams are pipes, and the runner copies the output into the
// files itself. Windows Python under Wine dies with "Invalid handle" when its
// output is a regular file (and also when its input is /dev/null or a file), but
// runs normally when the streams are pipes; tested on the real Wine here.
function run(argv, opts, beat) {
  return new Promise(resolve => {
    let child;
    try { child = cp.spawn(argv[0], argv.slice(1), { env: { ...process.env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd }); }
    catch (e) { resolve({ code: 127, error: e.message }); return; }
    child.stdin.on('error', () => {});
    child.stdin.end();

    const files = [];
    const sinks = [];
    const wire = (stream, file) => {
      if (!file) { stream.resume(); return; }
      const ws = fs.createWriteStream(file, { flags: 'a' });
      ws.on('error', () => {});
      files.push(ws);
      sinks.push(new Promise(r => ws.on('close', r)));
      stream.pipe(ws);
    };
    wire(child.stdout, opts.out);
    wire(child.stderr, opts.err);

    const t = beat ? setInterval(() => { try { beat(); } catch {} }, 15000) : null;
    let code = null, finished = false, cancelled = false;
    // A cancel request is a file appearing in the job folder. The whole Wine
    // environment is stopped along with the child, because the packer is a
    // grandchild of the program that was started and dies with wineserver.
    const ct = opts.cancelFile ? setInterval(() => {
      if (finished || cancelled) return;
      try { if (fs.existsSync(opts.cancelFile)) { cancelled = true; stopWine(); try { child.kill('SIGKILL'); } catch {} } } catch {}
    }, 3000) : null;
    // Ends the step: cuts the pipes, closes the log files, and resolves. It does
    // not wait for the "close" event, which never comes if a background process
    // the program started (Wine's wineserver and winedevice do this) still holds
    // an inherited pipe open, and a promise that never resolves would let Node
    // exit with the job unfinished.
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (t) clearInterval(t);
      if (ct) clearInterval(ct);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      for (const ws of files) try { ws.end(); } catch {}
      await Promise.race([Promise.all(sinks), sleep(3000)]);   // what it wrote is in its file
      resolve({ code: code === null ? 1 : code, ...(cancelled ? { cancelled: true } : {}) });
    };
    child.on('error', e => { if (finished) return; finished = true; if (t) clearInterval(t); if (ct) clearInterval(ct); resolve({ code: 127, error: e.message }); });
    // Exited: give its last output a moment to drain, then finish.
    child.on('exit', c => { code = c; setTimeout(finish, 3000); });
    // Exited and every pipe closed by itself: no need to wait.
    child.on('close', c => { if (code === null) code = c; finish(); });
  });
}

// Wine leaves its background services running after a program finishes. Ending
// them after each step means nothing lingers holding files or pipes, and the
// next step simply starts them again.
function stopWine() {
  if (NATIVE) return;
  try { cp.spawnSync('wineserver', ['-k'], { stdio: 'ignore', timeout: 20000 }); } catch {}
}

const wine = (exe, args) => [...WINE, exe, ...args];

function treeBytes(dir) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { if (e.isDirectory()) n += treeBytes(p); else if (e.isFile()) n += fs.statSync(p).size; } catch {}
  }
  return n;
}

// The SDK draws its own progress bar into the log: fifty columns for 0 to 100.
function sdkPercent(text) {
  const i = text.lastIndexOf('Creating an image');
  if (i < 0) return null;
  const runs = [...text.slice(i).matchAll(/^(=+)\s*$/gm)];
  return runs.length ? Math.min(100, runs[runs.length - 1][1].length * 2) : 0;
}

// ---- Jobs --------------------------------------------------------------------
const CONTENT_ID = /^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}$/;

// A path from a job is only ever a relative path under a library root.
// `<>:"|?*\` and control characters are rejected because a Windows filesystem
// (and, through Z: mapping, Wine) cannot have them in a name — inherited from
// the Windows builder's own Resolve-Under, where every path this resolves is
// one Windows itself has to open. Linux has no such restriction, so a path
// this builder only ever touches with plain Node fs calls (the job folder
// itself: job.json, state.json, build.log, the finished package's own output
// folder) — never handed to Wine as a Z: argument — can afford to allow a
// name like "Game: Subtitle" that Linux is fine with. `nativeOnly` opts a
// call into that: still no `.`/`..`/empty segment, still confined to `root`,
// just not the Windows character set. The dump itself and a patch's
// reference package are read *in place* and reach Wine as Z: paths, so they
// keep the strict rule until that is actually tested under Wine (see D9 in
// the private handoff, if it still exists, or just: don't loosen those two
// without a real run to check against).
function resolveUnder(root, rel, allowRoot, nativeOnly) {
  if (!rel) { if (allowRoot) return path.resolve(root); throw new Error('empty path'); }
  const bad = nativeOnly ? /[\x00-\x1f]/ : /[<>:"|?*\\\x00-\x1f]/;
  for (const seg of rel.split('/')) if (seg === '' || seg === '.' || seg === '..' || bad.test(seg)) throw new Error(`unacceptable path: ${rel}`);
  const full = path.resolve(root, ...rel.split('/'));
  const r = path.resolve(root) + path.sep;
  if (!full.startsWith(r)) throw new Error(`path leaves the library: ${rel}`);
  return full;
}

// In a GP5 project text, the <file> whose dst_path is sce_sys/param.json gets src_path set to `srcPath` (a path as Wine
// reads it). Exactly one such entry must be there; anything else is an error, never a silent no-op.
function pointParamAt(text, srcPath) {
  if (/["'<>&]/.test(srcPath)) return { error: 'the staged path holds a character that cannot go into the project file' };
  const entries = text.match(/<file\b[^>]*\bdst_path="sce_sys\/param\.json"[^>]*>/g) || [];
  if (entries.length !== 1) return { error: `the project lists sce_sys/param.json ${entries.length} times, not once` };
  if (!/\bsrc_path="[^"]*"/.test(entries[0])) return { error: 'the project entry for sce_sys/param.json has no src_path' };
  const fixed = entries[0].replace(/\bsrc_path="[^"]*"/, () => `src_path="${srcPath}"`);
  return { text: text.replace(entries[0], () => fixed) };
}

function writeState(dir, state, message, extra, flag) {
  const o = { state, message, updated: new Date().toISOString(), ...(extra || {}) };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(o, null, 2), flag ? { flag } : undefined);
}

// Every reason a job can go unseen is said once in the log, because a runner
// that quietly finds nothing looks exactly like one that is working.
const warned = new Set();
function warnOnce(m) { if (!warned.has(m)) { warned.add(m); log(m); } }

// A build claimed right before a known maintenance window gets killed mid-way
// -- the owner has already lost one at 84% to Unraid's own Appdata Backup.
// BUILD_QUIET_HOURS names windows (the container's own local time; set TZ if
// that needs to match the host) no *new* job is claimed in: comma-separated
// HH:MM-HH:MM, a window that crosses midnight is fine (23:30-00:30). A build
// already running is not touched -- there is no way to pause Wine partway
// through, only to not start one that would still be going when the window
// arrives is not attempted either (see inQuietWindow's use in watch()).
function parseQuietHours(s) {
  const out = [];
  for (const part of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    const start = m && (+m[1]) * 60 + (+m[2]), end = m && (+m[3]) * 60 + (+m[4]);
    if (!m || start < 0 || start >= 1440 || end < 0 || end >= 1440) { warnOnce(`BUILD_QUIET_HOURS: could not read "${part}" (want HH:MM-HH:MM); ignoring it.`); continue; }
    out.push({ start, end, text: part });
  }
  return out;
}
const QUIET_HOURS = parseQuietHours(E.BUILD_QUIET_HOURS);
function inQuietWindow(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return QUIET_HOURS.find(w => w.start <= w.end ? (mins >= w.start && mins < w.end) : (mins >= w.start || mins < w.end)) || null;
}

function findPending() {
  let builds;
  refreshLibs();
  const file = path.join(SPKG, 'builds.json');
  try { builds = JSON.parse(fs.readFileSync(file, 'utf8')).builds || []; }
  catch (e) {
    warnOnce(e.code === 'ENOENT'
      ? `cannot find ${file}. ShadowPKG writes it into its own config folder (the one mapped to its /config), so mount that same folder here at ${SPKG}. Until it exists no job can be seen.`
      : `cannot read ${file}: ${e.message}`);
    return [];
  }
  const out = [];
  for (const b of builds) {
    try {
      if (!/^[0-9a-f]{12}$/.test(b.id)) continue;
      if (!LIBS[b.src]) {
        const m = LIBS_MISSING.find(l => l.id === b.src);
        warnOnce(m ? `job ${b.id} is for the library "${m.label}", which is at ${m.root} in ShadowPKG but not mounted here: ${addPathAdvice(m)}.`
          : `job ${b.id} is for the library "${b.src}", which this builder does not know (${Object.keys(LIBS).join(', ') || 'none'}). ShadowPKG has not published it in ${LIBS_FILE} (is its config folder mounted here at ${SPKG}, and is ShadowPKG up to date?), and LIBRARIES does not list it. Set LIBRARIES=${b.src}=/where/it/is and mount that folder.`);
        continue;
      }
      const dir = resolveUnder(LIBS[b.src], b.jobRel, false, true);
      if (!fs.existsSync(dir)) {
        warnOnce(`job ${b.id}: its folder "${b.jobRel}" is not under ${LIBS[b.src]}. Is the library mounted here at the same place as in ShadowPKG?`);
        continue;
      }
      if (fs.existsSync(path.join(dir, 'job.json')) && !fs.existsSync(path.join(dir, 'state.json'))) out.push({ b, dir, root: LIBS[b.src] });
    } catch {}
  }
  return out;
}

// ---- Telling ShadowPKG the builder exists, and keeping the work disk tidy ------
let currentJob = null;          // the job being built right now, if any
const RUNNER_VERSION = 4;       // 4: DLC jobs (kind "dlc")
const WORK_KEEP_DAYS = parseFloat(E.WORK_KEEP_DAYS || '2') || 2;
const canRead = p => { try { fs.accessSync(p); return true; } catch { return false; } };

// A small file at each library's root, refreshed every few seconds. ShadowPKG
// reads it to say "builder online" (or that none has been seen) before anyone
// presses Build, and what is missing if it is online but cannot build yet.
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const INIT_JSON = path.join(CONFIG, 'init.json');      // how the last `init` ended
const SMOKE_JSON = path.join(CONFIG, 'smoke.json');    // how the last `smoke` ended

// The slow questions are asked now and then, not every 15 seconds: whether the
// kit still matches what was approved means reading all of it, and whether this
// container can reach the internet is a network round trip.
const slow = { pins: null, pinsAt: 0, net: null, netAt: 0, netBusy: false };
function slowChecks(force) {
  if (!currentJob && (force || Date.now() - slow.pinsAt > 10 * 60 * 1000)) {
    slow.pinsAt = Date.now();
    try { slow.pins = canRead(path.join(KIT, 'toolchain')) && canRead(PINS_FILE) ? pinProblems(hashKit(KIT)) : null; } catch { slow.pins = null; }
  }
  if (!slow.netBusy && (force || Date.now() - slow.netAt > 10 * 60 * 1000)) {
    slow.netBusy = true; slow.netAt = Date.now();
    require('dns').promises.lookup('www.python.org').then(() => { slow.net = true; }, () => { slow.net = false; }).finally(() => { slow.netBusy = false; });
  }
}

// Everything a person setting this up would otherwise have to find out from
// docker logs. Each check is {id, label, ok, detail, fix}: ok true is fine, false
// stops builds or will make them fail, null is worth knowing but harmless.
function collectChecks() {
  slowChecks(false);
  const c = [];
  const add = (id, label, ok, detail, fix) => c.push({ id, label, ok, detail: detail || '', fix: fix || '' });

  add('kit', 'Repack kit', canRead(path.join(KIT, 'toolchain', 'prospero-pub-cmd.exe')),
    canRead(path.join(KIT, 'toolchain', 'prospero-pub-cmd.exe')) ? `found at ${KIT}` : `nothing at ${KIT}`,
    `Mount your extracted kit (build-from-folder.ps1, scripts/ and toolchain/ directly inside it) at ${KIT}.`);

  const init = readJson(INIT_JSON), hasPy = canRead(PYTHON);
  add('wine', 'Wine, Python and .NET', hasPy && !(init && init.ok === false),
    !hasPy ? 'Wine has not been set up' : init && init.ok === false ? `setup ended with problems: ${(init.failed || []).join(', ')}` : init && init.ok ? 'set up' : 'set up (no record of how)',
    'Run the guided setup: docker exec -it ShadowPKG-Builder node /app/runner.js setup (or tools/container/install.sh). It needs network access once.');

  const smoke = readJson(SMOKE_JSON);
  add('runtime', 'Kit starts under Wine', smoke ? !!(smoke.python && smoke.pub) : null,
    !smoke ? 'not tested yet' : smoke.python && smoke.pub ? 'Python and the kit both start' : !smoke.python ? 'Windows Python did not run a real script' : 'the kit\'s main program did not start',
    'Run: docker exec -it ShadowPKG-Builder node /app/runner.js smoke   and read what it says.');

  const hasPins = canRead(PINS_FILE);
  add('trust', 'Kit approved', hasPins && !(slow.pins && slow.pins.length),
    !hasPins ? 'the kit has not been approved' : slow.pins && slow.pins.length ? `the kit no longer matches what was approved (${slow.pins.slice(0, 3).join('; ')})` : 'every program in the kit matches its approved hash',
    'Run: docker exec -it ShadowPKG-Builder node /app/runner.js trust   and type YES if you accept these files.');

  let free = null, workOk = false;
  try { fs.accessSync(WORK, fs.constants.W_OK); workOk = true; const s = fs.statfsSync(WORK); free = Number(s.bavail) * Number(s.bsize); } catch {}
  add('work', 'Work folder', workOk ? (free !== null && free < 30 * 2 ** 30 ? null : true) : false,
    !workOk ? `${WORK} is not writable` : free !== null ? `${(free / 2 ** 30).toFixed(0)} GB free at ${WORK}${free < 30 * 2 ** 30 ? ' — less than a large game needs' : ''}` : WORK,
    `Map a folder with room for the biggest dump at ${WORK}, read/write.`);

  for (const [id, root] of Object.entries(LIBS)) {
    let w = false; try { fs.accessSync(root, fs.constants.W_OK); w = true; } catch {}
    add('library:' + id, `Library "${id}"`, w, w ? `${root} is writable` : canRead(root) ? `${root} is read-only` : `${root} is not mounted`, `Map the library at ${root} read/write, the same folder ShadowPKG uses.`);
  }

  // Advice, not a blocker: nothing is waiting for it. A job for it says so when it arrives.
  for (const l of LIBS_MISSING) add('libmissing:' + l.id, `Library "${l.label}"`, null, `in ShadowPKG at ${l.root}, not mounted here`, `Add a Path to this container: container path ${l.root}, host path the same folder ShadowPKG's "${l.label}" uses, read/write.`);

  // Only shown at all when BUILD_QUIET_HOURS is set — informational either
  // way (never blocks ready), so an owner looking at Setup can see why a
  // waiting job hasn't been claimed instead of it just looking stuck.
  if (QUIET_HOURS.length) {
    const q = inQuietWindow();
    add('quiet', 'Quiet hours', null,
      q ? `inside a window now (${q.text}); a waiting job will not be claimed until it ends` : `configured (${QUIET_HOURS.map(w => w.text).join(', ')}), not in one right now`, '');
  }

  add('network', 'Network access', slow.net === true ? null : true,
    slow.net === true ? 'this container can reach the internet' : slow.net === false ? 'no internet access, as intended' : 'not checked yet',
    'Only setup needs the internet. Recreate the container with Network set to None once setup is done.');
  return c;
}

// Ready means a build could start; the rest is advice.
const BLOCKING = new Set(['kit', 'wine', 'trust']);
function writeBuilderStatus() {
  const checks = collectChecks();
  const problems = checks.filter(x => x.ok === false).map(x => `${x.label}: ${x.detail}`);
  const ready = !checks.some(x => x.ok === false && (BLOCKING.has(x.id) || x.id.startsWith('library:') || x.id === 'work'));
  const status = { kind: 'container', host: require('os').hostname(), version: RUNNER_VERSION, dlc: true, updated: new Date().toISOString(), busy: currentJob, ready, problems, checks };
  for (const root of Object.values(LIBS)) {
    const f = path.join(root, '.shadowpkg-builder.json');
    try { fs.writeFileSync(f + '.tmp', JSON.stringify(status)); fs.renameSync(f + '.tmp', f); try { fs.chmodSync(f, 0o666); } catch {} }
    catch (e) { warnOnce(`cannot write the builder status file into ${root}: ${e.message}. ShadowPKG will not be able to tell that a builder is running.`); }
  }
  // The log's tail, for ShadowPKG's "Builder log". Only rewritten when it grew.
  if (logDirty) {
    logDirty = false;
    const text = logTail(256 * 1024);
    for (const root of Object.values(LIBS)) {
      const f = path.join(root, '.shadowpkg-builder.log');
      try { fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); try { fs.chmodSync(f, 0o666); } catch {} } catch { /* the status file already warned */ }
    }
  }
}

// ---- What a build is limited by -----------------------------------------------
// A build takes most of an hour, and whether more CPU, faster disks or more memory
// would shorten it is a question the numbers answer, not a guess. Everything here
// is read from the container's own cgroup (and the kernel's pressure files, where
// there are any), which is where Docker keeps how much it has used. Nothing is
// asked of the packer, and anything that cannot be read is simply left out.
const SYS = E.SPKG_SYS_ROOT || '';
const sysText = f => { try { return fs.readFileSync(SYS + f, 'utf8'); } catch { return null; } };
const sysNum = (f, re) => { const t = sysText(f); const m = t && (re ? re.exec(t) : /^\s*(\d+)/.exec(t)); return m ? Number(m[1]) : null; };
const GB = 1073741824, MB = 1048576;

function perfSnapshot() {
  const s = { t: Date.now() };
  s.cpuUsec = sysNum('/sys/fs/cgroup/cpu.stat', /usage_usec (\d+)/);
  if (s.cpuUsec === null) { const n = sysNum('/sys/fs/cgroup/cpuacct/cpuacct.usage'); s.cpuUsec = n === null ? null : n / 1000; }
  s.mem = sysNum('/sys/fs/cgroup/memory.current') ?? sysNum('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  s.cache = sysNum('/sys/fs/cgroup/memory.stat', /^file (\d+)/m) ?? sysNum('/sys/fs/cgroup/memory/memory.stat', /^total_cache (\d+)/m);
  let limit = sysText('/sys/fs/cgroup/memory.max'); limit = limit && /^\d+/.test(limit) ? Number(limit) : sysNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  s.memLimit = limit && limit < 2 ** 50 ? limit : null;                 // "max" and the v1 "unlimited" are not limits
  // bytes the container has read from and written to disk
  const io2 = sysText('/sys/fs/cgroup/io.stat');
  if (io2) { s.read = 0; s.write = 0; for (const m of io2.matchAll(/rbytes=(\d+)/g)) s.read += Number(m[1]); for (const m of io2.matchAll(/wbytes=(\d+)/g)) s.write += Number(m[1]); }
  else {
    const io1 = sysText('/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes');
    if (io1) { s.read = 0; s.write = 0; for (const m of io1.matchAll(/ Read (\d+)/g)) s.read += Number(m[1]); for (const m of io1.matchAll(/ Write (\d+)/g)) s.write += Number(m[1]); }
  }
  // "some avg10": the share of the last ten seconds in which something was stalled waiting
  s.ioWait = sysNum('/proc/pressure/io', /some avg10=([\d.]+)/);
  s.cpuWait = sysNum('/proc/pressure/cpu', /some avg10=([\d.]+)/);
  return s;
}

// How many cores the container may use: its quota if it has one, otherwise the host's.
function perfCores() {
  const q = sysText('/sys/fs/cgroup/cpu.max');
  const m = q && /^(\d+) (\d+)/.exec(q);
  const quota = m ? Number(m[1]) / Number(m[2]) : null;
  const all = require('os').cpus().length;
  return quota && quota < all ? quota : all;
}

function perfTracker() {
  const cores = perfCores();
  const first = perfSnapshot();
  let last = first, peakMem = first.mem || 0, waits = [], cpuWaits = [];
  const rate = (a, b, k) => (a[k] != null && b[k] != null && b.t > a.t) ? Math.max(0, (b[k] - a[k]) / ((b.t - a.t) / 1000)) : null;
  const describe = (a, b) => {
    const cpu = rate(a, b, 'cpuUsec'), rd = rate(a, b, 'read'), wr = rate(a, b, 'write');
    return [
      cpu != null ? `CPU ${(cpu / 1e6).toFixed(1)} of ${cores % 1 ? cores.toFixed(1) : cores} cores` : null,
      b.mem != null ? `memory ${(b.mem / GB).toFixed(1)} GB${b.cache != null ? ` (${(b.cache / GB).toFixed(1)} GB of it file cache)` : ''}${b.memLimit ? ` of a ${(b.memLimit / GB).toFixed(0)} GB limit` : ''}` : null,
      rd != null ? `disk read ${(rd / MB).toFixed(0)} MB/s, write ${(wr / MB).toFixed(0)} MB/s` : null,
      b.ioWait != null ? `waiting on disk ${b.ioWait.toFixed(0)}%` : null,
    ].filter(Boolean).join(' · ');
  };
  return {
    // One reading, and a line about the stretch since the last one.
    tick() {
      const now = perfSnapshot();
      if (now.mem) peakMem = Math.max(peakMem, now.mem);
      if (now.ioWait != null) waits.push(now.ioWait);
      if (now.cpuWait != null) cpuWaits.push(now.cpuWait);
      const line = describe(last, now);
      last = now;
      return line;
    },
    // What the whole stretch came to, and what it suggests limited it.
    summary(seconds) {
      const end = perfSnapshot();
      if (end.mem) peakMem = Math.max(peakMem, end.mem);
      const cpu = rate(first, end, 'cpuUsec'), rd = rate(first, end, 'read'), wr = rate(first, end, 'write');
      const avgCores = cpu != null ? cpu / 1e6 : null;
      const ioWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null;
      let limit = null;
      if (end.memLimit && peakMem >= 0.95 * end.memLimit) limit = 'memory: it ran up against the container\'s memory limit';
      else if (avgCores != null && avgCores >= 0.8 * cores) limit = 'CPU: nearly every core was busy, so faster or more cores (or a lower compression level) would help, and more memory would not';
      else if (ioWait != null && ioWait >= 15) limit = 'disk: it spent a good part of the time waiting for storage, so a faster disk for the dump and the work folder would help, more memory or cores would not';
      else if (avgCores != null && avgCores < 0.3 * cores) limit = 'neither: the disks and most cores were idle, so the packer is probably not able to use more of either, and more memory or cores will not make it faster; a lower compression level may';
      else if (avgCores != null) limit = 'nothing clear: CPU and disk were both partly busy';
      return {
        seconds: Math.round(seconds), cores, avgCores: avgCores != null ? Number(avgCores.toFixed(1)) : null,
        peakMemGB: peakMem ? Number((peakMem / GB).toFixed(1)) : null, memLimitGB: end.memLimit ? Number((end.memLimit / GB).toFixed(1)) : null,
        readMBs: rd != null ? Math.round(rd / MB) : null, writeMBs: wr != null ? Math.round(wr / MB) : null,
        ioWaitPct: ioWait != null ? Math.round(ioWait) : null, limit,
      };
    },
  };
}

// A failed or cancelled build leaves its scratch folder (up to the size of the
// game) where it can be looked at, and nothing else would ever delete it. Folders
// whose job has been cleared go at once; the rest after WORK_KEEP_DAYS. Nothing
// is judged without ShadowPKG's job list, and nothing while a build is running.
function sweepWork() {
  if (currentJob) return;
  let builds;
  try { builds = JSON.parse(fs.readFileSync(path.join(SPKG, 'builds.json'), 'utf8')).builds; } catch { return; }
  if (!Array.isArray(builds)) return;
  const known = new Map(builds.map(b => [b.id, b]));
  let entries; try { entries = fs.readdirSync(WORK, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || !/^[0-9a-f]{12}$/.test(e.name)) continue;
    const dir = path.join(WORK, e.name), b = known.get(e.name);
    let why = null;
    if (!b) why = 'its job has been cleared';
    else {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(resolveUnder(LIBS[b.src], b.jobRel, false, true), 'state.json'), 'utf8').replace(/^﻿/, ''));
        if (st.state !== 'running' && Date.now() - fs.statSync(dir).mtimeMs > WORK_KEEP_DAYS * 86400000) why = `it ended more than ${WORK_KEEP_DAYS} day(s) ago`;
      } catch { /* cannot tell what state it is in, so keep it */ }
    }
    if (!why) continue;
    const bytes = treeBytes(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); log(`work folder ${e.name} removed (${why}); ${(bytes / 1073741824).toFixed(1)} GB freed`); }
    catch (err) { log(`could not remove work folder ${e.name}: ${err.message}`); }
  }
}

// What is set up and what is not, once at startup, so `docker logs` answers
// "why is nothing happening" without any digging.
function startupChecks() {
  const has = p => { try { fs.accessSync(p); return true; } catch { return false; } };
  const ok = (cond, good, bad) => log(`  ${cond ? 'ok     ' : 'MISSING'}  ${cond ? good : bad}`);
  log('setup check:');
  ok(has(path.join(KIT, 'toolchain', 'prospero-pub-cmd.exe')), `kit found at ${KIT}`, `no kit at ${KIT} (mount your extracted kit there: build-from-folder.ps1, scripts/ and toolchain/ directly inside it)`);
  ok(has(PYTHON), 'Wine environment is set up', `Wine is not set up yet: run  docker exec -d ShadowPKG-Builder node /app/runner.js init  (needs network, takes a while)`);
  ok(has(PINS_FILE), 'kit has been approved', `kit is not approved yet: run  docker exec -it ShadowPKG-Builder node /app/runner.js trust`);
  ok(has(path.join(SPKG, 'builds.json')), `${path.join(SPKG, 'builds.json')} exists`, `${path.join(SPKG, 'builds.json')} not there yet: it appears once ShadowPKG has been asked to build something, and only if ShadowPKG's /config is mounted here at ${SPKG}`);
  for (const [id, root] of Object.entries(LIBS)) ok(has(root), `library "${id}" at ${root}`, `library "${id}" is not mounted at ${root}`);
  for (const l of LIBS_MISSING) ok(false, '', `library "${l.label}" is in ShadowPKG at ${l.root} but is not mounted here: ${addPathAdvice(l)}`);
  if (!LIBS_ENV && publishedLibraries() === null) log(`  note     ${LIBS_FILE} is not there: ShadowPKG (an older version, or its config folder is not mounted here at ${SPKG}) has not said which libraries it has, so only games=/games is used. Set LIBRARIES to add others.`);
}

// How long each stage of a job took, for ShadowPKG's history: starting (the private copy of the kit), fetching (the dump copied to the
// work disk, when that is on), preparing (the package list), packing, and copying (the package out to the library). mark() ends the stage
// that was running and starts the next; list() is what has been timed so far, with the running stage counted up to now.
function stageTimer() {
  const done = []; let cur = null;
  const secs = (from, to) => Math.max(0, Math.round((to - from) / 1000));
  const end = now => { if (cur) done.push({ name: cur.name, seconds: secs(cur.at, now) }); cur = null; };
  return {
    mark(name, now = Date.now()) { end(now); if (name) cur = { name, at: now }; },
    list(now = Date.now()) { return done.concat(cur ? [{ name: cur.name, seconds: secs(cur.at, now) }] : []); },
    finish(now = Date.now()) { end(now); return done.slice(); },
  };
}

async function runJob({ dir: jobDir, root }) {
  const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8').replace(/^﻿/, ''));
  const id = String(job.id);
  const stages = stageTimer(), claimedAt = new Date().toISOString();
  const fail = (msg, extra) => { try { writeState(jobDir, 'failed', msg, { exit: 0, startedAt: claimedAt, phases: stages.list(), ...(extra || {}) }); } catch {} log(`job ${id} failed: ${msg}`); };

  if (!/^[0-9a-f]{12}$/.test(id)) return log('job.json: bad id');
  // Claim it. Creating the file exclusively means two runners cannot both start it.
  try { writeState(jobDir, 'running', 'starting', { host: require('os').hostname(), startedAt: claimedAt }, 'wx'); }
  catch { return log(`job ${id} was claimed by someone else`); }
  currentJob = id;
  stages.mark('starting');
  const o = job.options || {};
  // A DLC unlocker rebuilt for another region (ShadowPKG staged its two input files under dumpRel): the same two kit
  // steps as a game, with the additional-content volume, so the publishing tool writes the license entries.
  const isDlc = job.kind === 'dlc';
  log(isDlc ? `job ${id} started: a DLC for another region, ${job.contentId} (${job.title || ''}); compression ${o.compression}`
    : `job ${id} started: ${job.dumpRel} (${job.title || job.contentId}); compression ${o.compression}, ${o.chunks} chunks${o.validateOnly ? ', validate only' : ''}${COPY_DUMP ? ', copying the dump to the work disk first' : ''}`);
  // ShadowPKG asks for a build to stop by putting a file called "cancel" in the job folder.
  const cancelFile = path.join(jobDir, 'cancel');
  const cancelled = r => !!(r && r.cancelled) || fs.existsSync(cancelFile);

  try {
    if (!CONTENT_ID.test(String(job.contentId))) return fail('job.json: bad content ID');
    const compression = Number(job.options && job.options.compression), chunks = Number(job.options && job.options.chunks);
    if (!Number.isInteger(compression) || compression < -4 || compression > 9) return fail('job.json: compression out of range');
    if (!isDlc && (!Number.isInteger(chunks) || chunks < 1 || chunks > 255)) return fail('job.json: chunks out of range');
    const dlc = isDlc ? job.dlc || {} : null;
    if (isDlc) {
      if (dlc.volume !== 'ac') return fail('job.json: a DLC job must say volume "ac"');
      if (!/^[0-9a-f]{32}$/.test(String(dlc.entitlementKey))) return fail('job.json: the entitlement key must be 32 hex digits');
      if (!/^[0-9A-Za-z]{32}$/.test(String(dlc.passcode))) return fail('job.json: the passcode must be 32 characters');
      if (o.validateOnly || o.reference) return fail('job.json: a DLC job has no validate-only or patch mode');
    }
    // (a DLC's staging folder is inside the hidden job folder and reaches Wine only as a copy in the private work folder, so its
    // path may hold any character Linux allows; a dump is read in place and keeps the stricter rule)
    const dump = resolveUnder(root, String(job.dumpRel), false, isDlc);
    const outDir = resolveUnder(root, String(job.outputDirRel || ''), true, true);
    if (!fs.existsSync(path.join(dump, 'sce_sys', 'param.json'))) return fail(isDlc ? `the DLC's staged files are not at ${dump}` : `the dump is not at ${dump}`);
    if (isDlc && !fs.existsSync(path.join(dump, 'sce_sys', 'icon0.png'))) return fail(`the DLC's icon0.png is not at ${dump}/sce_sys`);
    // A patch is built against the base game's package (the kit's reference=).
    // It also produces a ".remastered.pkg" companion, and both are put in the
    // library; the patch is named apart so it cannot collide with its own base.
    let refPkg = null;
    if (o.reference && !o.validateOnly) {
      refPkg = resolveUnder(root, String(o.reference));
      if (!/\.pkg$/i.test(refPkg) || !fs.existsSync(refPkg) || !fs.statSync(refPkg).isFile()) return fail(`the base package for the patch is not at ${refPkg}`);
    }
    const outName = job.contentId + (refPkg ? '-patch' : '') + '.pkg';
    const finalPkg = path.join(outDir, outName);
    const finalRemastered = finalPkg + '.remastered.pkg';
    if (fs.existsSync(finalPkg) || (refPkg && fs.existsSync(finalRemastered))) return fail(`${fs.existsSync(finalPkg) ? finalPkg : finalRemastered} already exists; not overwriting it`);

    // No precheck existed before this: a hung or doomed build only failed
    // once the work disk actually filled up, hours in (kit copy, dump copy,
    // then packing). Checked against the same three things this job is about
    // to write: the kit's own copy, the dump's copy (only with COPY_DUMP),
    // and the package "Check this dump" already estimated. The dump and
    // estimated sizes come from job.json (ShadowPKG measured them already) so
    // this never re-walks a dump that can run past 100 GB just to ask how
    // big it is; only the kit (small) is walked here. Unknown free space, or
    // an older job.json with neither figure, does not block a build over a
    // guess — it only refuses when it actually knows there isn't room.
    let workFree = null;
    try { const s = fs.statfsSync(WORK); workFree = Number(s.bavail) * Number(s.bsize); } catch {}
    if (workFree !== null) {
      const kitBytes = treeBytes(KIT);
      const need = kitBytes + (COPY_DUMP ? Number(job.dumpBytes) || 0 : 0) + (Number(job.estimatedBytes) || 0);
      if (need > workFree) {
        return fail(`not enough room on the work disk for this build: about ${(need / 2 ** 30).toFixed(1)} GB needed (kit${COPY_DUMP ? ', a dump copy' : ''}${job.estimatedBytes ? ', the estimated package' : ''}), ${(workFree / 2 ** 30).toFixed(1)} GB free at ${WORK}.`);
      }
    }

    // A private copy of the kit, checked after it is copied, so what is approved
    // is what runs and the mounted kit can stay read-only.
    const w = path.join(WORK, id);
    // Stopping leaves nothing behind: the scratch folder and any half-copied package go.
    const cancelJob = () => {
      try { fs.rmSync(w, { recursive: true, force: true }); } catch {}
      for (const n of ['copying.part', 'copying-2.part']) { try { fs.rmSync(path.join(jobDir, n), { force: true }); } catch {} }
      writeState(jobDir, 'cancelled', 'cancelled from ShadowPKG', { startedAt: claimedAt, phases: stages.list() });
      log(`job ${id} cancelled`);
    };
    fs.rmSync(w, { recursive: true, force: true });
    fs.mkdirSync(path.join(w, 'tmp'), { recursive: true });
    const kit = path.join(w, 'kit');
    fs.cpSync(KIT, kit, { recursive: true });
    const bad = pinProblems(hashKit(kit));
    if (bad.length) return fail('the kit does not match what was approved, so nothing was run: ' + bad.join('; '));

    const logFile = path.join(jobDir, 'build.log'), errFile = path.join(jobDir, 'build.err');
    const started = new Date().toISOString();
    let source = dump;

    // Bytes that were already in the work folder before the tool started, so
    // "written" counts only what the tool produced.
    let baseBytes = treeBytes(w);

    if (COPY_DUMP || isDlc) {      // (a DLC's two small files are always copied: what Wine reads is then in a folder this runner named)
      const local = path.join(w, 'dump');
      const total = treeBytes(dump);
      fs.mkdirSync(local, { recursive: true });
      stages.mark('fetching');
      writeState(jobDir, 'running', 'fetching', { copied: 0, total, startedAt: started });
      const r = await run(['cp', '-a', dump + '/.', local + '/'], { cancelFile }, () => writeState(jobDir, 'running', 'fetching', { copied: treeBytes(local), total, startedAt: started }));
      if (cancelled(r)) return cancelJob();
      if (r.code !== 0 || treeBytes(local) !== total) return fail('copying the dump to the work disk did not complete');
      source = local;
      baseBytes += total;
    }

    // The same two steps the kit's own wrapper script runs.
    const stem = job.contentId;
    const gp5 = path.join(w, stem + '.gp5');
    const partial = path.join(w, stem + '.partial.pkg');
    const env = { TEMP: winePath(path.join(w, 'tmp')), TMP: winePath(path.join(w, 'tmp')), ...PY_ENV };
    const phase = () => {
      let text = ''; try { text = fs.readFileSync(logFile, 'latin1'); } catch {}
      const pct = sdkPercent(text);
      return { phase: pct !== null ? 'packing' : 'preparing', pct };
    };
    const perf = perfTracker();
    let lastPerfLog = Date.now(), lastWritten = 0, lastWrittenAt = Date.now();
    const heartbeat = () => {
      const { phase: ph, pct } = phase();
      const written = Math.max(0, treeBytes(w) - baseBytes);
      writeState(jobDir, 'running', ph, { startedAt: started, written, ...(pct !== null ? { percent: pct } : {}) });
      // Once a minute: where the packing is, how fast, and what the machine is doing meanwhile.
      if (Date.now() - lastPerfLog >= 60000) {
        const speed = (written - lastWritten) / Math.max(1, (Date.now() - lastWrittenAt) / 1000);
        const line = perf.tick();
        log(`job ${id}: ${ph}${pct !== null ? ` ${pct}%` : ''} · ${(written / GB).toFixed(1)} GB written${speed > 0 ? ` (${(speed / MB).toFixed(0)} MB/s)` : ''}${line ? ' · ' + line : ''}`);
        lastPerfLog = Date.now(); lastWritten = written; lastWrittenAt = Date.now();
      }
    };

    stages.mark('preparing');
    fs.appendFileSync(logFile, '[1/2] Creating GP5\n');
    log(`job ${id}: step 1 of 2, creating the package list`);
    heartbeat();
    const gp5Args = isDlc
      ? ['--volume', 'ac', '--passcode', dlc.passcode, '--entitlement-key', dlc.entitlementKey, '--absolute-paths']
      : ['--passcode', '0'.repeat(32), '--absolute-paths', '--keep-keystone', '--chunk-count', String(chunks), ...(refPkg ? [] : ['--auto-size-profile', 'sdk313'])];
    let r = await run(wine(PYTHON, [winePath(path.join(kit, 'scripts', 'create-gp5-from-folder.py')), winePath(source), winePath(gp5), ...gp5Args]),
      { out: logFile, err: errFile, env, cwd: w, cancelFile }, heartbeat);
    stopWine();
    if (cancelled(r)) return cancelJob();
    if (r.code !== 0 || !fs.existsSync(gp5)) return fail(`creating the package list failed (exit ${r.code}${r.error ? ', ' + r.error : ''})`, { exit: r.code });
    // The script regenerates sce_sys/param.json as if for a game and adds applicationDrmType to it, which the publishing tool
    // refuses in an additional-content package ("Application Category Type / Application DRM Type must not be specified").
    // The param.json ShadowPKG staged is the right one, so the project is pointed at that file instead.
    if (isDlc) {
      const fix = pointParamAt(fs.readFileSync(gp5, 'utf8'), winePath(path.join(source, 'sce_sys', 'param.json')));
      if (fix.error) return fail('the DLC project could not be prepared: ' + fix.error);
      fs.writeFileSync(gp5, fix.text);
    }

    // A quick validation stops here: the package list is the part that trips on a
    // bad dump, and it takes seconds where packing takes most of an hour.
    if (job.options && job.options.validateOnly) {
      let text = ''; try { text = fs.readFileSync(logFile, 'latin1'); } catch {}
      const m = /with (\d+) explicit file mapping/.exec(text);
      if (!KEEP_WORK) { try { fs.rmSync(w, { recursive: true, force: true }); } catch {} }
      writeState(jobDir, 'done', 'the package list built without errors; nothing was packed', { validated: true, startedAt: claimedAt, phases: stages.finish(), ...(m ? { files: Number(m[1]) } : {}) });
      return log(`job ${id} validated${m ? ` (${m[1]} files)` : ''}`);
    }

    stages.mark('packing');
    fs.appendFileSync(logFile, refPkg ? `[2/2] Building plaintext/no-auth patch against: ${refPkg}\n` : `[2/2] Building final plaintext/no-auth PKG (compression level: ${compression})\n`);
    log(`job ${id}: step 2 of 2, packing${refPkg ? ' a patch against ' + path.basename(refPkg) : ''}`);
    heartbeat();
    r = await run(wine(path.join(kit, 'toolchain', 'prospero-pub-cmd.exe'), ['img_create', '--oformat', 'nwonly', '--compression_level', String(compression), ...(refPkg ? ['--ref_pkg_path', winePath(refPkg)] : []), winePath(gp5), winePath(partial)]),
      { out: logFile, err: errFile, env, cwd: w, cancelFile }, heartbeat);
    stopWine();
    if (cancelled(r)) return cancelJob();
    if (r.code !== 0 || !fs.existsSync(partial) || fs.statSync(partial).size <= 0) return fail(`the kit stopped with exit code ${r.code}${r.error ? ' (' + r.error + ')' : ''}`, { exit: r.code });

    // Out to the library under names that are not packages, then renamed into
    // place last, so a copy that stops halfway is never listed or sent. A patch
    // has its remastered companion with it, and both arrive or neither does.
    const partialRemastered = partial + '.remastered.pkg';
    if (refPkg && (!fs.existsSync(partialRemastered) || fs.statSync(partialRemastered).size <= 0)) return fail('the kit finished but did not produce the remastered package that goes with a patch');
    const outs = [{ from: partial, hold: path.join(jobDir, 'copying.part'), to: finalPkg }];
    if (refPkg) outs.push({ from: partialRemastered, hold: path.join(jobDir, 'copying-2.part'), to: finalRemastered });
    stages.mark('copying');
    const size = fs.statSync(partial).size;
    const total = outs.reduce((n, x) => n + fs.statSync(x.from).size, 0);
    log(`job ${id}: packed (${(size / 1073741824).toFixed(1)} GB), copying it to the library`);
    let copiedSoFar = 0;
    try {
      for (const x of outs) {
        fs.rmSync(x.hold, { force: true });
        const expect = fs.statSync(x.from).size;
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(x.from), ws = fs.createWriteStream(x.hold);
          let n = 0, last = 0;
          rs.on('data', c => {
            n += c.length;
            if (Date.now() - last > 5000) {
              last = Date.now();
              try { writeState(jobDir, 'running', 'copying', { copied: copiedSoFar + n, total }); } catch {}
              if (cancelled()) { rs.destroy(new Error('cancelled')); ws.destroy(); }
            }
          });
          rs.on('error', reject); ws.on('error', reject); ws.on('close', resolve);
          rs.pipe(ws);
        });
        if (fs.statSync(x.hold).size !== expect) return fail('copying the package to the library did not complete');
        copiedSoFar += expect;
      }
    } catch (e) { if (cancelled()) return cancelJob(); throw e; }
    for (const x of outs) {
      try { fs.chmodSync(x.hold, 0o666); fs.chownSync(x.hold, 99, 100); } catch {}
      fs.renameSync(x.hold, x.to);
    }
    // The package is already in place; failing to tidy the scratch folder must
    // not turn a finished job into a failed one.
    if (!KEEP_WORK) { try { fs.rmSync(w, { recursive: true, force: true }); } catch (e) { log(`job ${id}: could not remove ${w}: ${e.message}`); } }
    const stats = perf.summary((Date.now() - Date.parse(started)) / 1000);
    writeState(jobDir, 'done', isDlc ? 'the DLC package is in the game\'s folder' : 'the package is next to the dump', { package: outName, size, stats, startedAt: claimedAt, phases: stages.finish(), ...(refPkg ? { remastered: path.basename(finalRemastered) } : {}) });
    log(`job ${id}: took ${Math.round(stats.seconds / 60)} min · ${[stats.avgCores != null ? `CPU averaged ${stats.avgCores} of ${stats.cores} cores` : null, stats.peakMemGB != null ? `memory peaked at ${stats.peakMemGB} GB` : null, stats.readMBs != null ? `disk read ${stats.readMBs} MB/s, write ${stats.writeMBs} MB/s` : null, stats.ioWaitPct != null ? `waiting on disk ${stats.ioWaitPct}%` : null].filter(Boolean).join(' · ')}`);
    if (stats.limit) log(`job ${id}: this build was limited by ${stats.limit}`);
    log(`job ${id} done: ${finalPkg} (${(size / 1073741824).toFixed(1)} GB)`);
  } catch (e) { fail(e.message); }
  finally { currentJob = null; }
}

// A job left "running" by a runner that no longer exists (the container was
// restarted or recreated) will never finish. On startup nothing of ours is
// running, so say what happened rather than let it sit as stalled. This assumes
// one runner per ShadowPKG; the age check leaves a job that is still being
// updated alone.
function failOrphans() {
  let builds;
  try { builds = JSON.parse(fs.readFileSync(path.join(SPKG, 'builds.json'), 'utf8')).builds || []; } catch { return; }
  for (const b of builds) {
    try {
      if (!/^[0-9a-f]{12}$/.test(b.id) || !LIBS[b.src]) continue;
      const dir = resolveUnder(LIBS[b.src], b.jobRel, false, true);
      const file = path.join(dir, 'state.json');
      if (!fs.existsSync(file)) continue;
      const st = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (st.state === 'running' && Date.now() - Date.parse(st.updated) > 2 * 60 * 1000) {
        writeState(dir, 'failed', 'the builder was restarted while this was running, so the build was lost. Clear it and build again.', { exit: 0 });
        log(`job ${b.id} was left running by a builder that no longer exists; marked failed`);
      }
    } catch {}
  }
}

async function watch(onceOnly) {
  fs.mkdirSync(WORK, { recursive: true });
  failOrphans();
  sweepWork();
  log(`builder v${RUNNER_VERSION} started; log file ${LOG_FILE}`);
  refreshLibs();
  log(`watching ${SPKG}/builds.json every ${POLL_MS / 1000}s; kit ${KIT}; libraries ${JSON.stringify(LIBS)}`);
  startupChecks();
  writeBuilderStatus();
  setInterval(writeBuilderStatus, 15000).unref();
  setInterval(sweepWork, 3600000).unref();
  let noted = '';
  for (;;) {
    const before = JSON.stringify(LIBS);
    const jobs = findPending();
    if (JSON.stringify(LIBS) !== before) { log(`libraries now ${JSON.stringify(LIBS)}`); writeBuilderStatus(); }
    if (jobs.length) {
      // Until the kit is approved, leave the job alone rather than claim it just
      // to fail it: it stays waiting for whichever runner is ready.
      const bad = pinProblems(hashKit(KIT));
      if (bad.length) {
        const note = 'a job is waiting but the kit is not usable yet: ' + bad.join('; ');
        if (noted !== note) { log(note); noted = note; }
        if (onceOnly) return;
        await sleep(POLL_MS);
        continue;
      }
      const quiet = inQuietWindow();
      if (quiet) {
        const note = `a job is waiting but this is a quiet-hours window (${quiet.text}); it will be picked up once that ends`;
        if (noted !== note) { log(note); noted = note; }
        if (onceOnly) return;
        await sleep(POLL_MS);
        continue;
      }
      noted = '';
      await runJob(jobs[0]);
      if (onceOnly) return;
      continue;
    }
    if (onceOnly) { log('no build is waiting'); return; }
    if (noted !== 'idle') { log('idle: no build waiting'); noted = 'idle'; }
    await sleep(POLL_MS);
  }
}

// ---- One-time setup and the self-test ----------------------------------------
// Setup can run detached (docker exec -d), so its progress goes to init.log too,
// where it can be followed with tail -f.
const INIT_LOG = path.join(CONFIG, 'init.log');
function note(m) { log(m); try { fs.appendFileSync(INIT_LOG, `\n== ${m}\n`); } catch {} }

async function sh(argv, opts) {
  note('$ ' + argv.join(' '));
  const r = await run(argv, { out: INIT_LOG, err: INIT_LOG, ...(opts || {}) });
  note(`  exit ${r.code}`);
  return r.code;
}

async function init() {
  fs.mkdirSync(CONFIG, { recursive: true });
  console.log(`Setting up the Wine environment in ${PREFIX}. This needs network access and takes a while; details go to ${path.join(CONFIG, 'init.log')}.`);
  // Wine refuses a prefix that is not owned by the user running it, and a folder
  // mounted from an Unraid share usually belongs to "nobody" rather than root.
  try {
    if (process.getuid && fs.statSync(PREFIX).uid !== process.getuid()) {
      fs.chownSync(PREFIX, process.getuid(), process.getgid());
      note(`took ownership of ${PREFIX}`);
    }
  } catch (e) { note(`could not take ownership of ${PREFIX}: ${e.message}. Wine will refuse it unless the folder belongs to this user.`); }
  const x = a => ['xvfb-run', '-a', ...a];
  const failed = [];
  const record = f => { try { fs.writeFileSync(INIT_JSON, JSON.stringify({ at: new Date().toISOString(), ok: !f.length, failed: f })); } catch {} };
  if (await sh(x(['wineboot', '-u']))) { record(['wineboot']); note('INIT STOPPED: wineboot failed'); return process.exit(1); }
  if (await sh(x(['winetricks', '-q', 'win10']))) failed.push('win10');
  if (await sh(x(['winetricks', '-q', 'vcrun2022']))) failed.push('vcrun2022');
  if (await sh(x(['winetricks', '-q', 'dotnet48']))) failed.push('dotnet48 (the kit\'s main library needs it)');
  if (!fs.existsSync(PYTHON)) {
    const zip = path.join(PREFIX, 'python-embed.zip');
    fs.mkdirSync(path.dirname(PYTHON), { recursive: true });
    if (await sh(['curl', '-fsSL', '-o', zip, PY_EMBED]) === 0) { if (await sh(['unzip', '-o', '-q', zip, '-d', path.dirname(PYTHON)])) failed.push('python unpack'); }
    else failed.push('python download');
  }
  record(failed);
  note(failed.length ? `INIT FINISHED WITH PROBLEMS: ${failed.join(', ')}. Next: runner.js smoke shows what still works.` : 'INIT COMPLETE. Next: runner.js smoke');
  return !failed.length;
}

async function smoke() {
  fs.mkdirSync(CONFIG, { recursive: true });
  const t = path.join(CONFIG, 'smoke.log');
  fs.rmSync(t, { force: true });
  const show = (label, code, file) => {
    let text = ''; try { text = fs.readFileSync(file, 'latin1'); } catch {}
    console.log(`\n== ${label}: exit ${code}`);
    console.log(text.trim().split('\n').slice(-12).join('\n'));
    return text;
  };
  // A real statement, not --version: that exits before Python sets up its
  // standard streams, which is where it fails under Wine if it is going to.
  let r = await run(wine(PYTHON, ['-c', 'import sys, subprocess, xml.etree.ElementTree, hashlib; print("Python", sys.version.split()[0], "streams ok")']), { out: t, err: t, env: PY_ENV });
  const py = show('Windows Python under Wine', r.code, t);
  fs.rmSync(t, { force: true });
  const exe = path.join(KIT, 'toolchain', 'prospero-pub-cmd.exe');
  r = await run(wine(exe, ['--help']), { out: t, err: t });
  const pub = show('prospero-pub-cmd.exe --help', r.code, t);
  console.log('\n== Reading the result');
  if (!/streams ok/.test(py)) console.log('- Python did not run a real script: re-run "init", or check the Wine prefix. "Invalid handle" means its standard streams failed.');
  if (/mscoree|BadImageFormat|0xe0434352|clr|\.NET|Could not load file or assembly/i.test(pub)) console.log('- Looks like a .NET problem: the kit\'s library is mixed-mode .NET, which needs a real .NET Framework in the prefix. Check init.log for the dotnet48 step.');
  else if (/vcruntime|msvcp|c000007b|0xc0000135|err:module/i.test(pub)) console.log('- Looks like a missing runtime library: check init.log for the vcrun2022 step.');
  else if (/usage|img_create|commands?:/i.test(pub)) console.log('- pub-cmd started and printed its usage. The hard part works; try a build.');
  else console.log('- No clear verdict. Send back the output above.');
  const result = { python: /streams ok/.test(py), pub: /usage|img_create|commands?:/i.test(pub) };
  try { fs.writeFileSync(SMOKE_JSON, JSON.stringify({ at: new Date().toISOString(), ...result })); } catch {}
  return result;
}

// ---- Guided setup and a plain status report -----------------------------------
// The three one-time steps (init, smoke, trust) in order, skipping what is
// already done, with a plain statement at the end of what is left. The one
// thing it will not do for you is approve the kit: that stays a typed YES.
const say = (...a) => console.log(...a);
const MARK = { true: 'ok     ', false: 'MISSING', null: 'note   ' };
function printChecks(checks) {
  for (const c of checks) say(`  ${MARK[c.ok]}  ${c.label}: ${c.detail}${c.ok === false && c.fix ? `\n           -> ${c.fix}` : ''}`);
}

function haveInternet() {
  return new Promise(resolve => {
    const req = require('https').request(PY_EMBED, { method: 'HEAD', timeout: 8000 }, r => { r.resume(); resolve(true); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function status() {
  slowChecks(true);
  await sleep(1500);            // the network answer arrives on its own
  const checks = collectChecks();
  say(`ShadowPKG builder ${RUNNER_VERSION}, kit ${KIT}:`);
  printChecks(checks);
  const bad = checks.filter(c => c.ok === false);
  say(bad.length ? `\n${bad.length} thing(s) to fix before builds can run.` : '\nReady: a Build .pkg in ShadowPKG will be picked up.');
  process.exit(bad.length ? 1 : 0);
}

async function setup() {
  say('ShadowPKG builder setup\n');
  if (!canRead(path.join(KIT, 'toolchain', 'prospero-pub-cmd.exe'))) {
    say(`No kit was found at ${KIT}. Mount your extracted kit there (build-from-folder.ps1, scripts/ and toolchain/ directly inside it) and run this again.`);
    process.exit(1);
  }
  const init0 = readJson(INIT_JSON);
  if (canRead(PYTHON) && (!init0 || init0.ok !== false)) say('1/3  Wine, Python and .NET: already set up, skipping.');
  else {
    say('1/3  Wine, Python and .NET: this downloads about 1 GB and takes 10 to 20 minutes.');
    if (!(await haveInternet())) {
      say('     This container cannot reach the internet, and this step needs it once. Run setup in a container with network access:\n       tools/container/install.sh    (does this for you)\n     or start the container with Network set to bridge for now, run setup, then recreate it with Network None.');
      process.exit(1);
    }
    say(`     Details go to ${INIT_LOG}; leave this running.`);
    if (!(await init())) say('     Setup ended with problems (see above). Continuing so you can see what still works.');
  }
  say('\n2/3  Does the kit start under Wine?');
  const s = await smoke();
  if (!s.python || !s.pub) say('\n     It does not, so builds will fail. Read the notes above; fixing this is not something setup can do for you.');
  say('\n3/3  Approve the kit');
  slowChecks(true);
  const pins = canRead(PINS_FILE) ? pinProblems(hashKit(KIT)) : ['not approved'];
  if (!pins.length) say('     Already approved, and every file still matches.');
  else await trust();

  say('\nWhere things stand:');
  slowChecks(true); await sleep(1500);
  const checks = collectChecks();
  printChecks(checks);
  const bad = checks.filter(c => c.ok === false);
  if (bad.length) { say(`\n${bad.length} thing(s) still to fix.`); process.exit(1); }
  say('\nSetup is done. ' + (checks.find(c => c.id === 'network' && c.ok === null && /can reach/.test(c.detail))
    ? 'This container can still reach the internet, and nothing after this needs it: recreate it with Network set to None (tools/container/install.sh does that).'
    : 'Builds will be picked up as soon as you press Build .pkg in ShadowPKG.'));
}

const cmd = process.argv[2] || 'watch';
({ init, smoke, trust, setup, status, watch: () => watch(false), once: () => watch(true) }[cmd] || (() => { console.log('usage: runner.js setup|status|init|smoke|trust|watch|once'); process.exit(2); }))()
  .catch(e => { console.error(e); process.exit(1); });
