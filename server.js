// ShadowPKG: browses .pkg files under ROOT, serves them over HTTP (with Range
// support so the console can resume), and forwards install requests to DPI v2.
// Node stdlib only. Config via env vars:
//   ROOT         main library folder (default /games)
//   ROOT_LABEL   name of the main library (default Games)
//   SOURCES_DIR  each folder in here is an extra library (default /extra-libraries)
//   PORT         port to listen on (default 12801)
//   PS5_HOST     DPI v2 host:port used to seed the first profile (e.g. 192.168.1.50:12800)
//   CONFIG_DIR   writable folder for profiles.json (default /config)
//   PUBLIC_BASE  URL the PS5 uses to reach this server, e.g. http://192.168.1.10:12801
//                (default: derived from the browser's Host header). Just the
//                starting value — the Setup panel can set this at runtime,
//                no container recreate needed, and that wins when both exist.
//   DEFAULT_THEME  theme a device starts with when it has not picked one: a built-in
//                id or an installed one (e.g. midnight). The Themes dialog can set it
//                at runtime, and that wins when both exist.

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const net = require('net');
const { PassThrough, Writable } = require('stream');

const ROOT = path.resolve(process.env.ROOT || '/games');
const PORT = parseInt(process.env.PORT || '12801', 10);
const PS5_HOST = process.env.PS5_HOST || '192.168.1.50:12800';
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
// The env var is the starting default — set once, at container creation. A
// value saved from the Setup panel is the same thing settable at runtime, no
// container recreate required, and wins when both exist. Whichever answers
// PUBLIC_BASE() is what every place that used to read the bare env var
// constant reads now.
const PUBLIC_BASE_ENV = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
let settings = {};   // { publicBase?: string, defaultTheme?: string } — loadSettings() fills this in below
const ROOT_LABEL = process.env.ROOT_LABEL || 'Games';
const SOURCES_DIR = process.env.SOURCES_DIR || '/extra-libraries';
// Optional: the id of an already-mapped library (map a fast local disk under
// SOURCES_DIR the normal way — nothing new to mount for this alone) to extract
// a dump-inside-a-.rar build into instead of beside the archive, so the build
// that follows reads the dump from fast local storage instead of whatever
// share the archive itself lives on. Only this one path uses it — a package
// extraction, "Extract all files", and a build started by hand on a dump
// already on real disk are all unaffected. Checked against real SOURCES at
// use time (SOURCES_DIR is scanned after this line runs), not here.
let SCRATCH_LIBRARY = (process.env.SCRATCH_LIBRARY || '').trim();      // (let: a value saved from the Settings window replaces it, see APP_SETTINGS)
// Browse and serve every file, not just .pkg. Off by default so the library
// stays a package list.
let ANY_FILE = /^(1|true|yes|on)$/i.test(process.env.ALLOW_ANY_FILE || '');
// A library with less than this much free gets a quiet warning in the Setup
// panel. Counted in the page's own gigabytes (1024 cubed); 0 turns it off.
let LOW_SPACE_GB = (() => { const n = parseFloat(process.env.LOW_SPACE_GB); return Number.isFinite(n) && n >= 0 ? n : 50; })();
// What this instance calls itself, in the page and in the startup line. Only
// worth setting when a second one runs alongside the first: two identical tabs
// are an easy way to send 75 GB from the wrong one, and a send cannot be
// recalled. It changes nothing else — not the links, not the config folder.
const APP_NAME = (process.env.APP_NAME || 'ShadowPKG').trim().slice(0, 40) || 'ShadowPKG';
// index.html carries the logo easter egg as one base64 GIF, about a megabyte and
// four fifths of the file, wanted only after ten taps. The file on disk keeps it
// (the app is still two files, and the page still works opened straight from
// disk), but what is served has it cut out: the bytes are held here and sent
// from /egg.gif the moment the egg is earned. The address carries a hash of the
// bytes, so it can be cached for good without ever going stale. If the literal is
// not found in the shape expected, or does not decode to a GIF, the page is
// served untouched and the egg keeps working from inside it.
let EGG = null, EGG_ETAG = '';
const INDEX_HTML = (() => {
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const head = "const EGG_GIF = 'data:image/gif;base64,";
  const at = html.indexOf(head), end = at < 0 ? -1 : html.indexOf("';", at + head.length);
  if (end > 0) {
    const b64 = html.slice(at + head.length, end);
    const gif = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) ? Buffer.from(b64, 'base64') : null;
    if (gif && gif.length > 6 && gif.toString('latin1', 0, 4) === 'GIF8') {
      const tag = crypto.createHash('sha1').update(gif).digest('hex');
      EGG = gif;
      EGG_ETAG = `"${tag}"`;
      html = `${html.slice(0, at)}const EGG_GIF = 'egg.gif?v=${tag.slice(0, 10)}';${html.slice(end + 2)}`;
    }
  }
  if (APP_NAME === 'ShadowPKG') return html;
  // Only the two places the name stands alone as an element's whole text: the
  // tab title and the header. Prose that happens to mention it is left alone.
  const safe = APP_NAME.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return html.split('>ShadowPKG<').join(`>${safe}<`);
})();
// What is served, computed once, not per request: the page is the same 270-odd
// KB every time until the container is rebuilt (or the server's default theme is
// changed, which rewrites one attribute), so a browser that already has it should
// only need to ask, not download it again. The compressed copy is made once as
// well, when holding the loop for a few milliseconds costs nothing (at startup);
// it has an ETag of its own, since a cache must not mix the two encodings up.
// After a rebuild the compressed copy is made on the thread pool instead, and
// until it is ready everyone gets the plain one.
let PAGE = null;   // {plain, gz, etag, etagGz}; set once the themes have been read, see servedPage()
function makePage(html, gzipNow) {
  const plain = Buffer.from(html);
  const hash = crypto.createHash('sha1').update(plain).digest('hex');
  const page = { plain, gz: gzipNow ? zlib.gzipSync(plain, { level: 9 }) : null, etag: `"${hash}"`, etagGz: `"${hash}-gzip"` };
  if (!gzipNow) zlib.gzip(plain, { level: 9 }, (err, gz) => { if (!err) page.gz = gz; });
  return page;
}

// Keep the last few hundred log lines in memory for GET /api/log, and write the
// same lines to CONFIG_DIR/server.log so they survive the container being
// recreated — which is exactly when you most want to know what happened just
// before. Kept to two files of 4 MB so a library being hammered for a week
// cannot fill the array.
const LOG = [];
const LOG_FILE = path.join(CONFIG_DIR, 'server.log');
const LOG_MAX = 4 * 1024 * 1024;
let logStream = null, logWritten = 0, logBroken = false;
// A console fetches a package as many 16 MiB range requests, so a line for each
// used to push everything else out of the ring within one big send. By default a
// transfer is logged when it starts, when it finishes, and whenever a range is
// cut short; this brings back a start and an end line for every range.
let LOG_RANGES = /^(1|true|yes|on)$/i.test(process.env.LOG_RANGES || '');
// The startup line names the running build, and a ring of a few hundred lines
// scrolls it out, so it is kept on its own and always comes first in /api/log.
let startupLine = null;

function openLog() {
  if (logBroken) return null;
  if (logStream) return logStream;
  try {
    try { logWritten = fs.statSync(LOG_FILE).size; } catch { logWritten = 0; }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    // A disk that fills or a share that goes away must not take the app with
    // it: stop writing and carry on serving.
    logStream.on('error', e => { logBroken = true; logStream = null; process.stderr.write(`log file stopped: ${e.message}\n`); });
  } catch { logBroken = true; logStream = null; }
  return logStream;
}

function rotateLog() {
  try {
    logStream.end();
    logStream = null;
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');   // one generation back is enough to see a restart
    logWritten = 0;
  } catch { logBroken = true; logStream = null; }
}

function writeLog(line) {
  const s = openLog();
  if (!s) return;
  s.write(line + '\n');
  logWritten += line.length + 1;
  if (logWritten >= LOG_MAX) rotateLog();
}

// Lines still queued for the file are lost if the process exits before they
// are written, and the last lines are the ones a stop or a crash is about.
// Nothing is written after this.
function closeLog() {
  const s = logStream;
  logStream = null; logBroken = true;
  if (!s) return Promise.resolve();
  return new Promise(resolve => { const t = setTimeout(resolve, 1000); s.end(() => { clearTimeout(t); resolve(); }); });
}

// What /api/log answers: the ring, headed by the startup line whether or not the
// ring still holds it.
function logText() {
  const rest = startupLine ? LOG.filter(l => l !== startupLine) : LOG;
  return (startupLine ? [startupLine, ...rest] : rest).join('\n') + '\n';
}

// The tail of what is on disk, across a rotation, so a restart is visible in it.
function tailLog(bytes) {
  const read = f => {
    let fd;
    try {
      const st = fs.statSync(f);
      fd = fs.openSync(f, 'r');
      const n = Math.min(bytes, st.size);
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, st.size - n);
      return b.toString('utf8');
    } catch { return ''; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  };
  let out = read(LOG_FILE);
  if (out.length < bytes) out = read(LOG_FILE + '.1').slice(-(bytes - out.length)) + out;
  // The first line of a tail is usually half a line.
  const nl = out.indexOf('\n');
  return nl > 0 && out.length >= bytes ? out.slice(nl + 1) : out;
}

// Whether the log is being kept, and why not when it is not — the same question
// the profiles file answers, and for the same reason.
function logState() {
  if (logBroken) return { ok: false, why: `Could not write ${LOG_FILE}.` };
  try {
    fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
    return { ok: true, file: LOG_FILE, why: '' };
  } catch {
    return { ok: false, why: `${CONFIG_DIR} is not writable, so the log is kept in memory only and is lost when the container restarts.` };
  }
}

for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(a => typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a)).join(' ');
    const stamped = line.startsWith('20') ? line : `${new Date().toISOString()} ${line}`;
    LOG.push(stamped);
    if (LOG.length > 400) LOG.splice(0, LOG.length - 400);
    writeLog(stamped);
    orig(...args);
  };
}

// PS5 profiles: [{id, name, host}]. Saved to CONFIG_DIR when it exists and is
// writable. "persistent" additionally requires CONFIG_DIR to be a mount (a host
// folder), since a folder inside the container is lost when Unraid recreates it.
let profiles = [];
let profilesWritable = false;
let profilesPersistent = false;

// True if dir is a mount point. Assumes true where mountinfo isn't available (non-Linux).
function isMountPoint(dir) {
  try {
    const target = fs.realpathSync(dir);
    return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .some(line => line.split(' ')[4] === target);
  } catch { return true; }
}

function loadProfiles() {
  try {
    const j = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    if (Array.isArray(j.profiles)) profiles = j.profiles.filter(p => p && p.id && p.name && p.host);
  } catch {}
  if (!profiles.length) profiles = [{ id: newId(), name: 'PS5', host: PS5_HOST }];
  try {
    // Made when it is missing, so a run outside Docker keeps what it is told without a mkdir first. (In a container a
    // folder made here is not a mount, and the Setup panel says so.)
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.statSync(CONFIG_DIR).isDirectory()) throw new Error('not a directory');
    fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
    profilesWritable = true;
    if (!fs.existsSync(PROFILES_FILE)) saveProfiles();
  } catch { profilesWritable = false; }
  profilesPersistent = profilesWritable && isMountPoint(CONFIG_DIR);
}

// Writing a state file must not hold up the requests waiting behind it: on a
// network share or a busy disk a write can take long enough to freeze every page
// open, and the biggest files are megabytes. So the text is written to a temp
// file off the main thread and renamed into place, one write per file at a time;
// a save asked for while one is running is done once more afterwards, from the
// newest state. `build` returns the text (or a promise of it).
const saveState = new Map();      // file -> {running, again, done}
function saveAtomic(file, build, label) {
  let s = saveState.get(file);
  if (!s) saveState.set(file, s = { running: false, again: false, done: null });
  if (s.running) { s.again = true; return; }
  s.running = true;
  s.done = (async () => {
    try {
      do {
        s.again = false;
        const text = await build();
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, text);
        // Windows refuses to rename over a file that something else (a virus scanner,
        // an indexer, a reader) has open at that instant, with EPERM or EBUSY, and a
        // moment later it works. Without a retry that save was lost until the next change.
        for (let tries = 0; ; tries++) {
          try { await fsp.rename(tmp, file); break; }
          catch (e) {
            if (tries >= 5 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e;
            await new Promise(r => setTimeout(r, 40 * (tries + 1)));
          }
        }
      } while (s.again);
    } catch (e) { console.error(`could not save ${label}: ${e.message}`); }
    finally { s.running = false; }
  })();
}

// Resolves once every save started so far has reached the disk (or failed and
// said so), including the repeat a save asked for while another was running.
async function savesSettled() {
  for (;;) {
    const busy = [...saveState.values()].filter(s => s.running);
    if (!busy.length) return;
    await Promise.all(busy.map(s => s.done));
  }
}

// ---- Stopping ----------------------------------------------------------------
// docker stop sends SIGTERM and, ten seconds later, SIGKILL, and a state file
// that is only written a few seconds after its last change loses that change to
// either. So anything that saves later registers here, and a stop writes it all
// out first. A hook may be async; it runs once, when the process is told to stop
// or is about to die of an unexpected error.
const shutdownHooks = [];
function onShutdown(fn) { shutdownHooks.push(fn); }
let stopping = false;
const STOP_DEADLINE_MS = 8000;

async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`shutting down (${reason})`);
  // Whatever else happens, the process is gone within the deadline: Docker's own
  // is ten seconds, and a hook stuck on a dead network share must not use it up.
  const deadline = setTimeout(() => {
    const still = [...saveState.entries()].filter(([, s]) => s.running).map(([k]) => k);
    process.stderr.write(`shutdown: gave up after ${STOP_DEADLINE_MS / 1000} s${still.length ? `; still saving: ${still.join(', ')}` : ''}. The last changes may not have been written.\n`);
    process.exit(code || 1);
  }, STOP_DEADLINE_MS);
  try {
    try { server.close(); server.closeIdleConnections?.(); } catch {}
    const results = await Promise.allSettled(shutdownHooks.map(async fn => fn()));
    for (const r of results) if (r.status === 'rejected') console.error(`while shutting down: ${r.reason && r.reason.stack || r.reason}`);
    await savesSettled();
    await closeLog();
  } catch (e) { process.stderr.write(`shutdown: ${e && e.stack || e}\n`); }
  clearTimeout(deadline);
  process.exit(code);
}

// JSON for {…, "<key>": {a map}} built in slices, so a map of tens of thousands
// of entries does not stop the server while it is turned into text. The entries
// are copied first, so changes made in between are simply picked up next time.
async function mapJson(head, map, tail) {
  const parts = [head];
  let n = 0;
  for (const [k, v] of [...map]) {
    parts.push((n ? ',' : '') + JSON.stringify(k) + ':' + JSON.stringify(v));
    if (++n % 1000 === 0) await new Promise(r => setImmediate(r));
  }
  parts.push(tail);
  return parts.join('');
}

function saveProfiles() {
  if (!profilesWritable) return;
  const text = JSON.stringify({ profiles }, null, 2);
  saveAtomic(PROFILES_FILE, () => text, 'the console list');
}

// A handful of settings a user can change from the Setup panel without
// touching the container's environment or recreating it — same folder, same
// writability question, as profiles.json.
function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (j && typeof j === 'object') settings = j;
  } catch {}
}

function saveSettings() {
  if (!profilesWritable) return;
  const text = JSON.stringify(settings, null, 2);
  saveAtomic(SETTINGS_FILE, () => text, 'settings');
}

// What every place that used to read the bare PUBLIC_BASE constant reads
// now — a value saved from the Setup panel first, the env var otherwise.
function PUBLIC_BASE() {
  return (settings.publicBase || PUBLIC_BASE_ENV || '').replace(/\/+$/, '');
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

// Plain-language reason profiles aren't persistent, shown in the app (null when fine).
function configIssue() {
  if (profilesPersistent) return null;
  if (!profilesWritable) return `The container has no ${CONFIG_DIR} folder mapped (or it is read-only), so the console list resets every time ShadowPKG restarts.`;
  return `${CONFIG_DIR} exists but isn't mapped to a folder on Unraid, so the console list is lost whenever the container is updated or recreated.`;
}

// Accepts "192.168.1.50", "192.168.1.50:12800" or a hostname; defaults the port to 12800.
function normalizeHost(h) {
  h = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const m = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(h);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : 12800;
  if (port < 1 || port > 65535) return null;
  return `${m[1]}:${port}`;
}

function validateProfile(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 40) return { error: 'Nickname must be 1–40 characters' };
  const host = normalizeHost(body.host);
  if (!host) return { error: 'Enter an IP address, optionally with :port' };
  // "This is a PS4": its installer is an app that is only there while it is open, so
  // it can be saved before it has ever been seen, and sends to it wait for the app.
  // Only present when the form said so either way.
  const out = { name, host };
  if ('installer' in body) out.installer = body.installer === 'rpi' ? 'rpi' : null;
  // FTP fields (goldhen/etaHEN's built-in FTP server): all optional, independent of the
  // DPI host above — a console with no ftpHost set simply has no FTP source (see
  // "---- FTP-connected consoles"). null clears a field, same convention as `installer`.
  // ftpHost's "default to the DPI host, no port" and ftpPort's "2121" placeholder are
  // UI defaults only (the field stays editable) — nothing here invents or assumes them.
  if ('ftpHost' in body) {
    const h = String(body.ftpHost || '').trim().replace(/^ftp:\/\//i, '').replace(/\/.*$/, '');
    if (h.length > 253) return { error: 'FTP host is too long' };
    out.ftpHost = h || null;
  }
  if ('ftpPort' in body) {
    const raw = body.ftpPort;
    if (raw === '' || raw === null || raw === undefined) out.ftpPort = null;
    else {
      // Same absurd-value guard normalizeHost applies to the DPI host's own port.
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: 'FTP port must be 1–65535' };
      out.ftpPort = n;
    }
  }
  if ('ftpUser' in body) {
    const u = String(body.ftpUser || '');
    if (u.length > 200) return { error: 'FTP username is too long' };
    out.ftpUser = u || null;
  }
  if ('ftpPass' in body) {
    // Many goldhen/etaHEN FTP setups are anonymous; blank means "attempt anonymous login",
    // not "clear a saved password" — but null still clears the field the same as the others,
    // there being no meaningful difference between "no password set" and "empty password" here.
    const pw = String(body.ftpPass || '');
    if (pw.length > 200) return { error: 'FTP password is too long' };
    out.ftpPass = pw || null;
  }
  // The console's payload loader port (elfldr and friends), used by the Send payload
  // button. Kept with the profile so it is set once; unset means the default is used at
  // send time rather than stored. null clears it, the same convention as `installer`.
  if ('payloadPort' in body) {
    const raw = body.payloadPort;
    if (raw === '' || raw === null || raw === undefined) out.payloadPort = null;
    else {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: 'Payload port must be 1–65535' };
      out.payloadPort = n;
    }
  }
  return out;
}

const findProfile = id => profiles.find(p => p.id === id);

// Remote Package Installer builds listen on 12800 or on 12801, and one PS4 answers
// on only one of them. Nothing stops the same PS4 being saved under both, so a
// console at the same address on either of the two ports is the same console.
const RPI_PORTS = ['12800', '12801'];
const ipOf = h => String(h).split(':')[0];
const portOf = h => String(h).split(':')[1] || '12800';
const sameAddressTwin = (a, b) => ipOf(a) === ipOf(b) && a !== b && RPI_PORTS.includes(portOf(a)) && RPI_PORTS.includes(portOf(b));
// A saved console that is this address exactly, or this PS4 on its other port.
function savedAs(host, exceptId) {
  const rest = profiles.filter(p => p.id !== exceptId);
  return rest.find(p => p.host === host) || rest.find(p => sameAddressTwin(p.host, host)) || null;
}
// Another saved console at this address on any port: one address is one console here, so a second
// installer on the same machine is not saved beside the first, and a console that moves is never
// pointed at an address another one already has.
function ipTaken(host, exceptId) {
  return profiles.find(p => p.id !== exceptId && ipOf(p.host) === ipOf(host)) || null;
}
function duplicateMessage(other, host) {
  if (ipOf(other.host) === ipOf(host) && other.host !== host && !sameAddressTwin(other.host, host)) {
    return `${other.name} is already saved at ${other.host}. Each address can only be saved once, so edit ${other.name} if its installer or port changed.`;
  }
  return other.host === host
    ? `${other.name} is already saved at ${host}.`
    : `${other.name} is already saved at ${other.host}. Remote Package Installer can listen on either port, so that is the same PS4: edit ${other.name} to change its port.`;
}

loadProfiles();
loadSettings();

// ---- Libraries ---------------------------------------------------------------
// Whether p is the root or lies under it. `root + path.sep` is wrong for a root that already ends in a
// separator (D:\ or Q:\, the top of a drive, or /), which nothing would then be under; a sibling that
// only shares the prefix (D:\games2 beside D:\games) is still outside.
function underRoot(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// ROOT is the main library (ROOT_LABEL). Every folder under SOURCES_DIR is an
// extra library named after that folder, e.g. /extra-libraries/Downloads -> "Downloads", so adding
// one is just another container path mapping.
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lib'; }

let SOURCES = [];
function loadSources() {
  const list = [{ id: slug(ROOT_LABEL), label: ROOT_LABEL, root: ROOT }];
  try {
    for (const e of fs.readdirSync(SOURCES_DIR, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const root = path.join(SOURCES_DIR, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(root).isDirectory(); } catch { isDir = false; } }
      if (!isDir) continue;
      let id = slug(e.name);
      while (list.some(s => s.id === id)) id += '-2';
      list.push({ id, label: e.name, root: path.resolve(root) });
    }
  } catch {}
  SOURCES = [list[0], ...list.slice(1).sort((a, b) => a.label.localeCompare(b.label))];
}
// The builder container reads this beside builds.json, so it can find every library by itself: a
// library it can see at the same path as here needs no setting on its side. Written when the list
// changes; the config folder has to be writable, as for everything else that is remembered.
const LIBRARIES_FILE = path.join(CONFIG_DIR, 'libraries.json');
let librariesPublished = '';
function publishLibraries() {
  if (!profilesWritable) return;
  const text = JSON.stringify({ schema: 1, libraries: SOURCES.map(s => ({ id: s.id, label: s.label, root: s.root })) });
  if (text === librariesPublished) return;
  librariesPublished = text;
  saveAtomic(LIBRARIES_FILE, () => text, 'the library list');
}
loadSources();
publishLibraries();
const findSource = id => (id ? SOURCES.find(s => s.id === id) : SOURCES[0]) || null;

// ---- Themes ------------------------------------------------------------------
// A theme is data: a JSON manifest (four colours, some overrides, some css) that the
// page turns into a whole set of colours. This side keeps them, under
// CONFIG_DIR/themes, and is the one place that decides what a theme may contain.
// What a theme carries ends up in every visitor's page, and a file dropped into the
// folder by hand is as unvetted as one posted over the network, so every field is
// treated as hostile and the same function (validateTheme) judges all of them: the
// folder scan, /api/themes/check and the install. Nothing a theme says is passed on
// as it was written: what the page applies is rebuilt from the pieces that passed, so
// text that closes a <style> early, opens an at-rule or loads something from elsewhere
// has no way through. The one thing given back as written is a theme's own css, in
// `source`, so it can be edited and exported; it went through the same compiler first,
// and the page never puts `source` into a style element, only the rebuilt `css`.
//
// What the page is given: the list carries a summary of each theme (GET /api/themes);
// one theme in full, with what to apply and the source, is GET /api/themes/<id>.
//
// Layout of the folder:  <id>.json            one file, pictures embedded as data: URLs
//                        <id>/theme.json      a folder: theme.json, optional theme.css,
//                        <id>/assets/<file>   and its pictures and fonts, one level deep
// A hand-placed file or folder is picked up without a restart.
const THEMES_DIR = path.join(CONFIG_DIR, 'themes');
const DEFAULT_THEME_ENV = (process.env.DEFAULT_THEME || '').trim();
const BUILTIN_THEMES = ['ps1', 'ps1v2', 'midnight', 'purple', 'nes', 'snes', 'dreamcast', 'wii', 'itsmemario', 'yoshisisland', 'oled', 'nathan', 'win95', 'spookemon', 'minimal'];
const LIGHT_BASES = new Set(['wii', 'yoshisisland', 'minimal']);        // the built-ins with a light --bg; the rest are dark
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const THEME_MAX = 64;
const THEME_LIMITS = {
  file: 1024 * 1024,                          // one <id>.json
  folder: 4 * 1024 * 1024,                    // a whole folder theme
  each: 1536 * 1024,                          // any one file of a folder theme
  files: 24,
  css: 60 * 1024, rules: 200, decls: 40,
  body: 6 * 1024 * 1024,                      // a check or an install request
  dataImage: 300 * 1024, dataFont: 900 * 1024, // decoded, for a data: URL
};
const THEME_RECHECK_MS = 1000;
const THEME_ENTRIES_MAX = 200;                // more than this in the folder is not looked at
// Names Windows will not make a file of (CON, NUL, COM1 ...), with any extension.
const THEME_RESERVED_FILE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// The custom properties a theme may set, and what each one holds. The page derives a
// value for every one of them from a theme's colours; a theme's own `tokens` come after.
const THEME_TOKENS = new Map();
for (const [type, names] of Object.entries({
  colour: '--meta --bg --text --muted --link --panel-text --panel-muted --panel-head --line --hover --sel-text --sel-muted --icon --panel-busy --panel-warn --check --on-accent --focus --ghost-text --ghost-line --input-bg --input-text --input-line --ok --err --panel-ok --panel-err --tray-line --dlg-bg --warn-bg --warn-text --warn-line --danger-text --danger-line --danger-hover --backdrop',
  paint: '--panel --sel --accent --accent-2 --ghost-bg --ghost-hover --tray',
  image: '--bg-image', shadow: '--panel-shadow', length: '--radius --radius-lg --pad --row-h --gap', font: '--font',
})) for (const n of names.split(' ')) THEME_TOKENS.set(n, type);
const THEME_KEYS = new Set(['shadowtheme', 'id', 'name', 'author', 'description', 'version', 'base', 'mode', 'palette', 'tokens', 'fonts', 'css', 'logo', 'icons']);
const THEME_PALETTE_KEYS = ['background', 'surface', 'text', 'accent', 'surface2', 'dialog', 'tray', 'link', 'good', 'bad', 'warn'];
const THEME_ICON_KINDS = new Set(['file', 'document', 'text', 'image', 'video', 'audio', 'archive', 'disk', 'code', 'package', 'folder']);

// Lookups keyed by something a theme supplied are Maps, never plain objects: a plain
// one answers for "constructor" and "__proto__".
const THEME_ASSET_TYPES = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
}));
const THEME_FONT_EXT = new Set(['woff', 'woff2', 'ttf', 'otf']);
const THEME_FONT_FORMAT = new Map([['woff2', 'woff2'], ['woff', 'woff'], ['ttf', 'truetype'], ['otf', 'opentype']]);
const THEME_DATA_TYPES = new Map(Object.entries({
  'image/png': ['png', 'image'], 'image/jpeg': ['jpg', 'image'], 'image/webp': ['webp', 'image'], 'image/gif': ['gif', 'image'], 'image/svg+xml': ['svg', 'image'],
  'font/woff2': ['woff2', 'font'], 'font/woff': ['woff', 'font'], 'font/ttf': ['ttf', 'font'], 'font/otf': ['otf', 'font'],
}));
const THEME_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const themeExt = name => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const THEME_UTF8 = new TextDecoder('utf-8', { fatal: true });   // a leading byte order mark is dropped

class ThemeBad extends Error {}
const themeBad = msg => { throw new ThemeBad(msg); };
// Control characters, line separators, bidi overrides, the replacement character (what
// invalid UTF-8 turns into) and lone surrogates: none belongs in a name or a colour.
const THEME_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// The same for css text, where tab, newline, form feed and return are ordinary whitespace.
const THEME_CSS_BAD_CHARS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\ufffd]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Text from a theme that is repeated in a reason or a log line: printable ASCII only,
// and nothing a page could mistake for markup.
// Cut to length first: a message is made of what a theme said, which can be megabytes.
const themeQuote = s => String(s).slice(0, 40).replace(/[^\x20-\x7e]/g, '?').replace(/[<>&"'`\\]/g, '?');
// A character named in words, for a reason that must not carry markup or an escape.
const themeName = c => ({ '\\': 'a backslash', '<': 'a less-than sign', '>': 'a greater-than sign', '{': 'a {', '}': 'a }', ';': 'a semicolon', '@': 'an @', ':': 'a colon', '"': 'a double quote', "'": 'a single quote' })[c]
  || (/^[\x21-\x7e]$/.test(c) ? `"${c}"` : 'a character outside plain ASCII');
const themeWs = s => s.replace(/[\t\n\r\f ]+/g, ' ').trim();
const themeOwn = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const themeIsObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const themeSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');

function themeText(v, what, max, need) {
  if (v === undefined || v === null) { if (need) themeBad(`${what} is required`); return ''; }
  if (typeof v !== 'string') themeBad(`${what} must be text`);
  const s = v.trim();
  if (!s && need) themeBad(`${what} is required`);
  if (s.length > max * 2 || [...s].length > max) themeBad(`${what} is longer than ${max} characters`);
  if (THEME_BAD_CHARS.test(s) || /[<>]/.test(s)) themeBad(`${what} has a character that is not allowed (control characters and angle brackets)`);
  return s;
}

// ---- Values: every one is parsed and written back out from its parts --------------
const THEME_NUM = /^-?(?:\d{1,7}(?:\.\d{1,8})?|\.\d{1,8})$/;
// Numbers are written with at most a few decimals and never in exponent form.
const themeFmt = (n, dp = 3) => { const r = parseFloat(n.toFixed(dp)); return String(Object.is(r, -0) ? 0 : r); };
function themeNumber(t) {
  if (!THEME_NUM.test(t)) themeBad(`"${themeQuote(t)}" is not a plain number`);
  return parseFloat(t);
}

// Splits at a separator that is not inside brackets or quotes.
function themeSplit(s, sep) {
  const out = [], open = [];
  let quote = '', cur = '';
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') open.push(c);
    else if ((c === ')' || c === ']') && open.pop() !== (c === ')' ? '(' : '[')) themeBad('a bracket is closed that was not the one opened last');
    if (c === sep && open.length === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote || open.length) themeBad('a quote or bracket is not closed');
  out.push(cur);
  return out;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(x => Math.round(x * 255));
}
const themeHex = c => '#' + c.rgb.map(v => v.toString(16).padStart(2, '0')).join('');
// WCAG relative luminance, 0 (black) to 1 (white).
function themeLuminance(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// #rgb #rrggbb (#rgba #rrggbbaa), rgb() rgba() hsl() hsla() with plain numbers, or
// transparent. Returns {text, rgb, a}: text is the form that is stored and served.
function themeColour(text, opts = {}) {
  const t = themeWs(text).toLowerCase();
  const nope = () => themeBad(`"${themeQuote(text)}" is not a colour: use #rrggbb, rgb(), hsl() or transparent`);
  let m;
  if (t.length > 300) nope();
  if (t === 'transparent') {
    if (!opts.transparent) themeBad('transparent is not allowed here');
    return { text: t, rgb: [0, 0, 0], a: 0 };
  }
  if ((m = /^#([0-9a-f]+)$/.exec(t))) {
    const h = m[1];
    if (![3, 4, 6, 8].includes(h.length)) nope();
    if ((h.length === 4 || h.length === 8) && !opts.alpha) themeBad(`"${themeQuote(text)}" has an alpha part, which is not allowed here`);
    const full = h.length <= 4 ? [...h].map(c => c + c).join('') : h;
    return { text: '#' + h, rgb: [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)), a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 };
  }
  if (!(m = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/.exec(t))) nope();
  const hsl = m[1].startsWith('hsl');
  const inner = m[2].trim();
  let list, alpha = null;
  const slash = inner.split('/');
  if (slash.length > 2) nope();
  if (slash.length === 2) {
    if (slash[0].includes(',')) nope();
    list = slash[0].trim().split(' '); alpha = slash[1].trim();
  } else if (inner.includes(',')) {
    list = inner.split(',').map(s => s.trim());
    if (list.length === 4) alpha = list.pop();
  } else list = inner.split(' ');
  if (list.length !== 3 || list.some(s => !s)) nope();
  let a = 1;
  if (alpha !== null) {
    if (!opts.alpha) themeBad(`"${themeQuote(text)}" has an alpha part, which is not allowed here`);
    a = alpha.endsWith('%') ? themeNumber(alpha.slice(0, -1)) / 100 : themeNumber(alpha);
    if (a < 0 || a > 1) nope();
  }
  const tail = a < 1 ? `, ${themeFmt(a)}` : '';
  if (!hsl) {
    const rgb = list.map(s => {
      const pct = s.endsWith('%');
      const v = themeNumber(pct ? s.slice(0, -1) : s);
      if (v < 0 || v > (pct ? 100 : 255)) nope();
      return Math.round(pct ? v * 2.55 : v);
    });
    return { text: `${a < 1 ? 'rgba' : 'rgb'}(${rgb.join(', ')}${tail})`, rgb, a };
  }
  const h = themeNumber(list[0].replace(/deg$/, ''));
  const [s, l] = [list[1], list[2]].map(x => { const v = themeNumber(x.replace(/%$/, '')); if (v < 0 || v > 100) nope(); return v; });
  const hn = ((h % 360) + 360) % 360;
  return { text: `${a < 1 ? 'hsla' : 'hsl'}(${themeFmt(hn, 2)}, ${themeFmt(s, 2)}%, ${themeFmt(l, 2)}%${tail})`, rgb: hslToRgb(h, s, l), a };
}

// A length or percentage. o.units: which units are allowed; o.neg: a minus sign is; o.max: per unit.
function themeLength(t, o) {
  const m = /^(-?)(\d{1,6}(?:\.\d{1,4})?|\.\d{1,4})(px|rem|em|%)?$/.exec(t);
  if (!m) themeBad(`"${themeQuote(t)}" is not a length`);
  const neg = m[1] === '-', n = parseFloat(m[2]), unit = m[3] || '';
  if (neg && !o.neg && n !== 0) themeBad(`"${themeQuote(t)}" cannot be negative`);
  if (!unit) { if (n !== 0) themeBad(`"${themeQuote(t)}" needs a unit`); return '0'; }
  if (!o.units.includes(unit)) themeBad(`"${themeQuote(t)}" cannot use the unit ${unit}`);
  if (o.max && n > o.max[unit]) themeBad(`"${themeQuote(t)}" is too large (at most ${o.max[unit]}${unit})`);
  return n === 0 && unit !== '%' ? '0' : `${neg ? '-' : ''}${themeFmt(n)}${unit}`;
}

// The safety check for a picture that is an SVG. It is a single left-to-right scan (each
// character is looked at a bounded number of times), not a set of regular expressions: an
// expression such as `<!doctype[^>]*\[` starts over at every "<!doctype" and made a 180 KB
// file freeze the whole server for seconds. Values are decoded first (a character or a
// named entity, a CSS escape) and only then judged, so href="&#106;avascript:..." is seen
// as what a browser would see.
const THEME_SVG_BAD_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'embed', 'object']);
const THEME_SVG_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')', num: '#', semi: ';', comma: ',', period: '.', equals: '=', excl: '!', percnt: '%', plus: '+', quest: '?', tab: '\t', newline: '\n', nbsp: '\u00a0' };
const THEME_SVG_CP = cp => (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd');
// The text with character references and the known named ones replaced, or null when a
// name is not one that is known (an entity that cannot be looked at cannot be trusted).
function themeSvgDecode(s) {
  let at = s.indexOf('&');
  if (at < 0) return s;
  const parts = [];
  let from = 0;
  while (at >= 0) {
    if (at > from) parts.push(s.slice(from, at));
    let end = at + 1;
    if (s.charCodeAt(end) === 35) {                                  // &#106; or &#x6a;
      end++;
      const hex = s.charCodeAt(end) === 120 || s.charCodeAt(end) === 88;
      if (hex) end++;
      const digits = end;
      let cp = 0;
      for (; end < s.length && end - digits < 9; end++) {
        const d = s.charCodeAt(end);
        const v = d >= 48 && d <= 57 ? d - 48 : hex && d >= 97 && d <= 102 ? d - 87 : hex && d >= 65 && d <= 70 ? d - 55 : -1;
        if (v < 0) break;
        cp = cp * (hex ? 16 : 10) + v;
      }
      if (end === digits) return null;
      parts.push(THEME_SVG_CP(cp));
    } else {
      while (end < s.length && end - at < 12) {
        const d = s.charCodeAt(end);
        if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122))) break;
        end++;
      }
      const name = s.slice(at + 1, end).toLowerCase();
      const v = Object.prototype.hasOwnProperty.call(THEME_SVG_ENTITIES, name) ? THEME_SVG_ENTITIES[name] : undefined;    // not "constructor" and the like
      if (v === undefined || s[end] !== ';') return null;
      parts.push(v);
    }
    if (s[end] === ';') end++;
    from = end;
    at = s.indexOf('&', from);
  }
  if (from < s.length) parts.push(s.slice(from));
  return parts.join('');
}

// CSS escapes (\6a, \j) and comments removed, so url(\68ttp://x) and @imp/**/ort read plainly.
function themeSvgCssPlain(css) {
  if (css.indexOf('\\') < 0 && css.indexOf('/*') < 0) return css;
  const parts = [];
  let i = 0, from = 0;
  while (i < css.length) {
    const c = css.charCodeAt(i);
    if (c === 47 && css.charCodeAt(i + 1) === 42) {
      parts.push(css.slice(from, i));
      const e = css.indexOf('*/', i + 2);
      i = from = e < 0 ? css.length : e + 2; continue;
    }
    if (c === 92) {
      parts.push(css.slice(from, i));
      let j = i + 1, cp = 0;
      for (; j < css.length && j - i <= 6; j++) {
        const d = css.charCodeAt(j);
        const v = d >= 48 && d <= 57 ? d - 48 : d >= 97 && d <= 102 ? d - 87 : d >= 65 && d <= 70 ? d - 55 : -1;
        if (v < 0) break;
        cp = cp * 16 + v;
      }
      if (j > i + 1) {
        parts.push(THEME_SVG_CP(cp));
        if (j < css.length && (css.charCodeAt(j) === 32 || css.charCodeAt(j) === 9 || css.charCodeAt(j) === 13 || css.charCodeAt(j) === 10 || css.charCodeAt(j) === 12)) j++;
        i = from = j; continue;
      }
      if (j < css.length && css.charCodeAt(j) !== 10) parts.push(css[j]);
      i = from = j + 1; continue;
    }
    i++;
  }
  if (from < css.length) parts.push(css.slice(from));
  return parts.join('');
}

// True when a reference (an href, or what stands in url()) leaves the picture: any scheme
// but data:image/, or a protocol-relative //. Whitespace and control characters inside are
// skipped by a browser, so they are here too.
function themeSvgLeaves(ref) {
  const n = ref.replace(/[\u0000-\u0020\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase();
  if (n.startsWith('//') || n.startsWith('\\\\')) return true;
  return /^[a-z][a-z0-9+.-]*:/.test(n) && !n.startsWith('data:image/');
}

// CSS text (a <style> body or a style attribute), already entity-decoded.
function themeSvgCssProblem(text) {
  const css = themeSvgCssPlain(text).toLowerCase();
  if (css.includes('@import') || css.includes('javascript:') || css.includes('image-set(') || css.includes('expression(') || css.includes('-moz-binding')) return true;
  // Each url( is read up to its own end and the search goes on from there, so the work
  // stays proportional to the text however many of them there are.
  for (let at = css.indexOf('url('); at >= 0;) {
    let i = at + 4;
    while (i < css.length && css.charCodeAt(i) <= 32) i++;
    const q = css[i] === '"' || css[i] === "'" ? css[i++] : '';
    const end = css.indexOf(q || ')', i);
    if (end < 0) return true;
    const ref = css.slice(i, end);
    if (themeSvgLeaves(ref)) return true;
    if (!q && /[\s"'(]/.test(ref.trim())) return true;             // not something a browser reads as one address
    at = css.indexOf('url(', end);
  }
  return false;
}

const THEME_SVG_LINK_ATTRS = new Set(['href', 'src', 'to', 'from', 'by', 'values']);
// By character code, not a regular expression per character: these loops run once for every character of a megabyte of markup.
const svgWs = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const svgEnd = c => svgWs(c) || c === 47 || c === 62 || c === 61;      // white space, / > =
function themeSvgProblem(buf) {
  const LEAVES = 'has script or a link to somewhere else in it';
  if (buf.length > THEME_LIMITS.each) return `is larger than ${THEME_LIMITS.each / 1024} KB`;   // before anything reads it
  let text;
  try { text = THEME_UTF8.decode(buf); } catch { return 'is not valid UTF-8 text'; }
  const low = text.toLowerCase(), n = text.length;
  if (low.includes('javascript:') || low.includes('vbscript:') || low.includes('data:text/html') || low.includes('<!entity')) return LEAVES;
  let i = 0, root = false;
  for (let lt = text.indexOf('<'); lt >= 0; lt = text.indexOf('<', i)) {
    i = lt + 1;
    const c = text[i];
    if (c === '!') {
      if (text.startsWith('!--', i)) { const e = text.indexOf('-->', i + 3); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('![CDATA[', i)) { const e = text.indexOf(']]>', i + 8); i = e < 0 ? n : e + 3; continue; }
      if (text.slice(i, i + 8).toLowerCase() !== '!doctype') return LEAVES;
      // a DOCTYPE may name a DTD but may not carry an internal subset (where entities live)
      let q = '';
      for (i += 8; i < n; i++) {
        const d = text[i];
        if (q) { if (d === q) q = ''; } else if (d === '"' || d === "'") q = d; else if (d === '[') return LEAVES; else if (d === '>') break;
      }
      if (i >= n) return 'is not well-formed';
      i++; continue;
    }
    if (c === '?') {
      // only the xml declaration: a stylesheet instruction can point anywhere
      if (!/^\?xml[ \t\r\n]/.test(text.slice(i, i + 6))) return LEAVES;
      const e = text.indexOf('?>', i);
      if (e < 0) return 'is not well-formed';
      i = e + 2; continue;
    }
    if (c === '/') { const e = text.indexOf('>', i); if (e < 0) return 'is not well-formed'; i = e + 1; continue; }
    if (c === undefined || !/^[A-Za-z_:]$/.test(c)) return 'is not well-formed';
    let e = i;
    while (e < n && !svgEnd(text.charCodeAt(e))) e++;
    const name = text.slice(i, e).toLowerCase().split(':').pop();      // (indexes go with text: lower-casing can change a string's length)
    if (THEME_SVG_BAD_ELEMENTS.has(name)) return LEAVES;
    if (!root) { if (name !== 'svg') return 'is not an SVG picture'; root = true; }
    i = e;
    for (;;) {                                                       // the attributes
      while (i < n && svgWs(text.charCodeAt(i))) i++;
      if (i >= n) return 'is not well-formed';
      if (text[i] === '>') { i++; break; }
      if (text[i] === '/') { i++; continue; }
      let s = i;
      while (i < n && !svgEnd(text.charCodeAt(i))) i++;
      if (i === s) return 'is not well-formed';                       // a stray "="
      // The name after any prefix (xlink:href). Only names of up to 6 letters can be one of those looked for, so no string is made of a longer one.
      let ls = s;
      for (let k = i - 1; k >= s; k--) if (text.charCodeAt(k) === 58) { ls = k + 1; break; }
      if ((text.charCodeAt(ls) | 32) === 111 && (text.charCodeAt(ls + 1) | 32) === 110) return LEAVES;      // on...
      const attr = i - ls <= 6 ? text.slice(ls, i).toLowerCase() : '';
      while (i < n && svgWs(text.charCodeAt(i))) i++;
      let raw = '';
      if (text[i] === '=') {
        i++;
        while (i < n && svgWs(text.charCodeAt(i))) i++;
        if (text[i] === '"' || text[i] === "'") {
          const close = text.indexOf(text[i], i + 1);
          if (close < 0) return 'is not well-formed';
          raw = text.slice(i + 1, close); i = close + 1;
        } else {
          s = i;
          while (i < n && !svgWs(text.charCodeAt(i)) && text[i] !== '>') i++;
          raw = text.slice(s, i);
        }
      }
      if (raw === '') continue;
      const v = themeSvgDecode(raw);
      if (v === null) return LEAVES;
      if (v.length >= 11 && v.toLowerCase().includes('javascript:')) return LEAVES;
      if (THEME_SVG_LINK_ATTRS.has(attr) && (attr === 'values' ? v.split(';').some(themeSvgLeaves) : themeSvgLeaves(v))) return LEAVES;
      if ((attr === 'style' || v.includes('(')) && themeSvgCssProblem(v)) return LEAVES;
    }
    if (name === 'style' && text[i - 2] !== '/') {
      // the rule text up to the next closing tag; a CDATA wrapper is not part of it
      const close = text.indexOf('</', i), stop = close < 0 ? n : close;
      const dec = themeSvgDecode(text.slice(i, stop).replace(/<!\[CDATA\[|\]\]>/g, ''));
      if (dec === null || themeSvgCssProblem(dec)) return LEAVES;
      i = stop;
    }
  }
  if (!root) return 'is not an SVG picture';
  return '';
}

// The bytes must be what the name says, so a page or a script cannot pass as a picture.
function themeCheckAsset(ext, buf, what) {
  const at = (off, s) => buf.length >= off + s.length && buf.toString('latin1', off, off + s.length) === s;
  let ok = false;
  switch (ext) {
    case 'png': ok = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a; break;
    case 'jpg': case 'jpeg': ok = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; break;
    case 'gif': ok = at(0, 'GIF87a') || at(0, 'GIF89a'); break;
    case 'webp': ok = at(0, 'RIFF') && at(8, 'WEBP'); break;
    case 'woff': ok = at(0, 'wOFF'); break;
    case 'woff2': ok = at(0, 'wOF2'); break;
    case 'ttf': ok = (buf.length > 4 && buf.readUInt32BE(0) === 0x00010000) || at(0, 'true'); break;
    case 'otf': ok = at(0, 'OTTO'); break;
    case 'svg': { const why = themeSvgProblem(buf); if (why) themeBad(`${what} ${why}`); return; }
  }
  if (!ok) themeBad(`${what} is not really a ${ext.toUpperCase()} file`);
}

// What may stand inside url(): a picture (or, for a font, a font) embedded as data:, or
// a file of the theme's own assets folder. Anything else (http:, //, an absolute path,
// .., javascript:, data:text/html ...) is refused. ctx.mode says how an assets/ file is
// written back: 'source' as it was (what is stored), 'served' as themes/<id>/assets/<file>.
// The served form has no leading slash: the page's own requests are relative (api/...),
// so behind a reverse proxy that mounts it under a subpath the pictures are found there too.
function themeRef(ref, ctx, kind) {
  let m;
  if ((m = /^data:([a-z0-9+\/.-]{1,40});base64,([A-Za-z0-9+\/]*={0,2})$/i.exec(ref))) {
    const mime = m[1].toLowerCase(), b64 = m[2];
    const type = THEME_DATA_TYPES.get(mime);
    if (!type || type[1] !== kind) themeBad(kind === 'font' ? 'a font must be data:font/woff2 (or woff, ttf, otf)' : 'a picture must be data:image/png (or jpeg, webp, gif, svg+xml)');
    if (!b64.length || b64.length % 4) themeBad('an embedded file is not valid base64');
    const size = b64.length / 4 * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    const cap = kind === 'font' ? THEME_LIMITS.dataFont : THEME_LIMITS.dataImage;
    if (size > cap) themeBad(`an embedded ${kind === 'font' ? 'font' : 'picture'} is larger than ${cap / 1024} KB`);
    themeCheckAsset(type[0], Buffer.from(b64, 'base64'), `an embedded ${mime}`);
    return { text: `data:${mime};base64,${b64}`, ext: type[0] };
  }
  if ((m = /^assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(ref))) {
    const name = m[1], ext = themeExt(name);
    if (!ctx.assets) themeBad(`assets/${name} cannot be used in a single file: embed the picture as a data: URL, or make a folder theme`);
    if (!ctx.assets.has(name)) themeBad(`assets/${name} is used but is not in the theme's assets folder`);
    if (!THEME_ASSET_TYPES.has(ext) || THEME_FONT_EXT.has(ext) !== (kind === 'font')) themeBad(`assets/${name} is not ${kind === 'font' ? 'a font (woff, woff2, ttf, otf)' : 'a picture (png, jpg, webp, gif, svg)'}`);
    return { text: ctx.mode === 'served' ? `themes/${ctx.id}/assets/${name}` : `assets/${name}`, ext };
  }
  return themeBad(`url("${themeQuote(ref)}") is not allowed: only a picture embedded as data: or a file in assets/ can be used`);
}

function themeUrl(t, ctx) {
  const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]*))\s*\)$/i.exec(t);
  if (!m) themeBad(`"${themeQuote(t)}" is not a url(...) with a picture in it`);
  return `url("${themeRef(m[1] ?? m[2] ?? m[3], ctx, 'image').text}")`;
}

const THEME_POS = /^(?:left|right|top|bottom|center|-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})(?:%|px|rem|em)?)$/;
function themeGradient(text) {
  const t = themeWs(text).toLowerCase();
  const m = /^(linear-gradient|radial-gradient)\((.*)\)$/.exec(t);
  if (!m) themeBad(`"${themeQuote(text)}" is not a colour or a linear-gradient() / radial-gradient()`);
  const args = themeSplit(m[2], ',').map(s => s.trim());
  let head = '';
  if (m[1] === 'linear-gradient') {
    if (/^-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})deg$/.test(args[0]) || /^to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?$/.test(args[0])) {
      head = args.shift();
      const to = /^to (top|bottom|left|right)(?: (top|bottom|left|right))?$/.exec(head);
      if (to && to[2] && (to[1] === to[2] || (to[1] === 'top' || to[1] === 'bottom') === (to[2] === 'top' || to[2] === 'bottom'))) themeBad(`"${themeQuote(head)}" names the same side twice`);
      const deg = /^(-?[\d.]+)deg$/.exec(head);
      if (deg) head = `${themeFmt(parseFloat(deg[1]))}deg`;
    }
  } else {
    const tk = args[0].split(' ');
    if (tk[0] === 'circle' || tk[0] === 'ellipse' || tk[0] === 'at') {
      args.shift();
      let i = 0;
      if (tk[0] !== 'at') i = 1;
      if (i < tk.length) {
        if (tk[i] !== 'at') themeBad(`"${themeQuote(tk.join(' '))}" is not a gradient shape`);
        const pos = tk.slice(i + 1);
        if (pos.length < 1 || pos.length > 2 || !pos.every(x => THEME_POS.test(x))) themeBad(`"${themeQuote(tk.join(' '))}" is not a gradient position`);
        head = (i ? tk[0] + ' ' : '') + 'at ' + pos.map(x => (/^[a-z]/.test(x) ? x : themeLength(x, { units: ['px', 'rem', 'em', '%'], neg: true }))).join(' ');
      } else head = tk[0];
    }
  }
  if (args.length < 2 || args.length > 6) themeBad('a gradient needs 2 to 6 colour stops');
  const stops = args.map(s => {
    const parts = themeSplit(s, ' ').filter(Boolean);
    if (parts.length < 1 || parts.length > 2) themeBad(`"${themeQuote(s)}" is not a colour stop (a colour, then optionally a position)`);
    const colour = themeColour(parts[0], { alpha: true, transparent: true }).text;
    return parts[1] ? `${colour} ${themeLength(parts[1], { units: ['px', 'rem', 'em', '%'], neg: true })}` : colour;
  });
  return `${m[1]}(${[head, ...stops].filter(Boolean).join(', ')})`;
}

const themePaint = t => (/^(?:linear|radial)-gradient\(/i.test(t) ? themeGradient(t) : themeColour(t, { alpha: true, transparent: true }).text);

function themeImage(t, ctx) {
  if (t.toLowerCase() === 'none') return 'none';
  const layers = themeSplit(t, ',').map(s => s.trim());
  if (layers.length > 3) themeBad('at most 3 background layers');
  return layers.map(l => (/^url\(/i.test(l) ? themeUrl(l, ctx) : themeGradient(l))).join(', ');
}

function themeShadow(t) {
  if (t.toLowerCase() === 'none') return 'none';
  const list = themeSplit(t, ',').map(s => s.trim());
  if (list.length > 4) themeBad('at most 4 shadows');
  return list.map(item => {
    const tk = themeSplit(item, ' ').filter(Boolean);
    let inset = false;
    if (tk[0] && tk[0].toLowerCase() === 'inset') { inset = true; tk.shift(); }
    const colour = tk.pop();
    if (!colour || tk.length < 2 || tk.length > 4) themeBad(`"${themeQuote(item)}" is not a shadow: [inset] x y [blur [spread]] colour`);
    const lens = tk.map((x, i) => themeLength(x, { units: ['px'], neg: i !== 2 }));
    return `${inset ? 'inset ' : ''}${lens.join(' ')} ${themeColour(colour, { alpha: true, transparent: true }).text}`;
  }).join(', ');
}

function themeFontList(t) {
  if (t.length > 200) themeBad('a font list is at most 200 characters');
  const items = themeSplit(t, ',').map(s => s.trim());
  if (items.length > 8) themeBad('at most 8 fonts in a list');
  return items.map(it => {
    let m;
    if ((m = /^"([A-Za-z0-9 _.-]{1,64})"$/.exec(it)) || (m = /^'([A-Za-z0-9 _.-]{1,64})'$/.exec(it))) return `"${m[1]}"`;
    if (/^[A-Za-z][A-Za-z0-9 _-]*$/.test(it)) return it.replace(/ +/g, ' ');
    return themeBad(`"${themeQuote(it)}" is not a font name (letters, digits, spaces, - and _; quote a name with a dot)`);
  }).join(', ');
}

// One token's value, checked by the token's type and written back canonically.
function themeValue(type, raw, ctx) {
  if (typeof raw !== 'string') themeBad('must be text');
  // Well past a 300 KB picture as base64: nothing a token holds is this long, so it is not read further.
  if (raw.length > 420000) themeBad('is far too long');
  const t = themeWs(raw);
  if (!t) themeBad('is empty');
  // 300 characters, not counting the bytes of an embedded picture, which have a limit of their own.
  if (t.replace(/data:[A-Za-z0-9+\/;=,.-]*/g, 'data:').length > 300) themeBad('is longer than 300 characters');
  switch (type) {
    case 'colour': return themeColour(t, { alpha: true, transparent: true }).text;
    case 'paint': return themePaint(t);
    case 'image': return themeImage(t, ctx);
    case 'shadow': return themeShadow(t);
    case 'length': return themeLength(t, { units: ['px', 'rem', 'em'], max: { px: 64, rem: 4, em: 4 } });
    case 'font': return themeFontList(t);
  }
  return themeBad('has no known type');
}

// ---- css: parsed, checked and written back rule by rule ---------------------------
const THEME_CSS_FUNCS = new Map(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'var', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'url', 'translate', 'translateX', 'translateY', 'scale', 'rotate', 'blur', 'drop-shadow', 'brightness', 'contrast', 'saturate', 'hue-rotate', 'grayscale', 'sepia', 'invert', 'opacity', 'cubic-bezier', 'steps'].map(n => [n.toLowerCase(), n]));
const THEME_CSS_SAFE_STRING = /^[\p{L}\p{N} _.,:%+\-\/()!?#*=~&|^$\[\]]*$/u;
const THEME_SELECTOR_FUNCS = new Set(['not', 'is', 'where', 'has', 'matches', 'any', '-webkit-any', '-moz-any', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir']);
const THEME_CSS_DENIED_PROPS = new Set(['behavior', 'behaviour', '-moz-binding', '-ms-behavior', 'binding', '-webkit-binding']);

// A quoted string starting at s[i]: same-line, no escapes, safe characters only. Returns [text, next index].
function themeCssString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q && s[j] !== '\n' && s[j] !== '\r' && s[j] !== '\f' && s[j] !== '\\') j++;
  if (s[j] !== q) themeBad(s[j] === '\\' ? 'a backslash in a string is not allowed' : 'a quoted string is not closed');
  const body = s.slice(i + 1, j);
  if (body.length > 100) themeBad('a string is longer than 100 characters');
  if (!THEME_CSS_SAFE_STRING.test(body)) themeBad('a string has a character that is not allowed');
  return [`${q}${body}${q}`, j + 1];
}

// One declaration's value. Every character has to belong to a number, a plain word, a
// hex colour, a string, an operator, or a call to one of the listed functions; what is
// returned is written out from those, so nothing else can come with it.
function themeCssValue(raw, ctx) {
  let s = themeWs(raw), important = false;
  const bang = /\s*!\s*important$/i.exec(s);
  if (bang) { important = true; s = s.slice(0, bang.index).trimEnd(); }
  if (!s) themeBad('a value is empty');
  const stack = [];
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; i++; continue; }
    if (c === '"' || c === "'") {
      const [str, next] = themeCssString(s, i);
      out += `"${str.slice(1, -1)}"`; i = next; continue;
    }
    if (c === '(') {
      // A bare ( groups a sum inside calc() and the like: it follows an operator, a comma or another (,
      // never a word, a number or a string, which is how a function name could be smuggled in.
      // (Looked up in what was read, s, not in the growing output: searching that from its start at every ( was quadratic.)
      let k = i - 1;
      while (k >= 0 && s[k] === ' ') k--;
      if (k >= 0 && !',+*/(-'.includes(s[k])) themeBad('a ( that is not a function call may only follow an operator or a comma');
      if (stack.length >= 12) themeBad('a value is nested too deeply');
      stack.push(''); out += '('; i++; continue;
    }
    if (c === ')') { if (!stack.length) themeBad('a ) has no ( before it'); stack.pop(); out += ')'; i++; continue; }
    if (c === ',' || c === '/' || c === '*') { out += c; i++; continue; }
    const rest = s.slice(i, i + 400);
    let m;
    if ((m = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest))) {
      // A number and its unit. Nothing longer than the token grammar's numbers, and no
      // exponent form (1e999): CSS would read it as a huge number.
      const num = m[0], unit = /^[A-Za-z%]*/.exec(rest.slice(num.length))[0];
      const after = rest[num.length + unit.length];
      if (!THEME_NUM.test(num.replace(/^\+/, '')) || unit.length > 8 || (after !== undefined && /[0-9.]/.test(after))) themeBad(`the number "${themeQuote(num + unit)}" is not allowed (too long)`);
      if (unit.toLowerCase() === 'e' && after !== undefined && /[0-9+-]/.test(after)) themeBad(`the number "${themeQuote(num + unit + after)}" is in exponent form, which is not allowed`);
      if (after === '(') themeBad(`the number "${themeQuote(num + unit)}" is followed by a bracket`);
      out += num + unit; i += num.length + unit.length; continue;
    }
    if ((m = /^--[A-Za-z0-9_-]{1,64}/.exec(rest)) || (m = /^-?[A-Za-z_][A-Za-z0-9_-]{0,63}/.exec(rest))) {
      const word = m[0];
      if (rest[word.length] === '(') {
        const fn = THEME_CSS_FUNCS.get(word.toLowerCase());
        if (!fn) themeBad(`the function ${themeQuote(word)}() is not allowed`);
        if (fn === 'url') {
          const um = /^\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^\s"'()\\]*))\s*\)/.exec(s.slice(i + word.length));
          if (!um) themeBad('a url( is not closed, or has more than one thing in it');
          out += `url("${themeRef(um[1] ?? um[2] ?? um[3], ctx, 'image').text}")`;
          i += word.length + um[0].length; continue;
        }
        if (stack.length >= 12) themeBad('a value is nested too deeply');
        stack.push(fn); out += fn + '('; i += word.length + 1; continue;
      }
      out += word; i += word.length; continue;
    }
    if ((m = /^#[0-9A-Fa-f]{3,8}(?![A-Za-z0-9_-])/.exec(rest)) && [4, 5, 7, 9].includes(m[0].length)) { out += m[0].toLowerCase(); i += m[0].length; continue; }
    if (c === '+' || c === '-') { out += c; i++; continue; }
    themeBad(c === '!' ? '! is only allowed as !important at the end of a value'
      : `${themeName(c)} is not allowed in a value (no backslash, braces, semicolon, at sign, colon or angle brackets outside quotes)`);
  }
  if (stack.length) themeBad('a ( is never closed');
  if (/\/\*|\*\//.test(out)) themeBad('/* and */ are not allowed in a value');
  return out + (important ? ' !important' : '');
}

// Scopes a selector list to one theme: every part is prefixed, so a rule can only
// reach the page while the theme it belongs to is the one in use.
function themeCssSelector(raw, id) {
  const s = themeWs(raw);
  if (!s) themeBad('a rule has no selector');
  if (s.length > 200) themeBad('a selector is longer than 200 characters');
  if (!/^[A-Za-z0-9 _\-.#:,>+~\[\]="'*()^$|]+$/.test(s)) themeBad(`the selector "${themeQuote(s)}" uses a character that is not allowed`);
  const parts = themeSplit(s, ',').map(x => x.trim());   // also proves the brackets and quotes match
  if (parts.length > 20) themeBad('a selector has more than 20 parts');
  // A ( belongs to :not( :is( :nth-child( and the like, and to nothing else. (Quoted
  // attribute values are skipped: a ( in there is text.)
  for (let i = 0, q = ''; i < s.length; i++) {
    if (q) { if (s[i] === q) q = ''; continue; }
    if (s[i] === '"' || s[i] === "'") q = s[i];
    else if (s[i] === '(') {
      const fn = /:([A-Za-z-]+)$/.exec(s.slice(0, i));
      if (!fn || !THEME_SELECTOR_FUNCS.has(fn[1].toLowerCase())) themeBad(`the selector "${themeQuote(s)}" uses a function that is not allowed in a selector`);
    }
  }
  const prefix = `html[data-custom="${id}"]`;
  return parts.map(part => {
    if (!part) themeBad(`the selector "${themeQuote(s)}" has an empty part`);
    const root = /^(?::root|html)(?![A-Za-z0-9_-])/.exec(part);
    return root ? prefix + part.slice(root[0].length) : `${prefix} ${part}`;
  }).join(', ');
}

// ---- css that would hide the page or put words on it --------------------------------
// A theme restyles the page; it does not get to blank it, fade it out or change what it
// says (a "Cancel" drawn over a Delete button is a lie the person cannot see through).
// So these are refused in every rule, whatever the selector: content with text in it,
// display: none, visibility: hidden or collapse, opacity under 0.3, text under 8px, and a
// scale under 0.3. Decoration stays: empty pseudo-elements, gradients, filters, shadows,
// moves and turns. The check reads the value the parser wrote back out, so spellings
// (.1, 10%, 0px, 0EM, calc()) have already been reduced to plain tokens.
const THEME_MIN_OPACITY = 0.3, THEME_MIN_SCALE = 0.3, THEME_MIN_TEXT_PX = 8;
// Sizes in em, rem and % are judged against the smallest text the page uses (14px), and
// viewport units against a narrow phone (375px): a size that only just clears 8px there is let through.
const THEME_TEXT_BASE_PX = 14, THEME_VIEWPORT_PX = 375;
const THEME_PX_PER = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
  em: THEME_TEXT_BASE_PX, rem: THEME_TEXT_BASE_PX, ex: THEME_TEXT_BASE_PX / 2, ch: THEME_TEXT_BASE_PX / 2,
  vw: THEME_VIEWPORT_PX / 100, vh: THEME_VIEWPORT_PX / 100, vmin: THEME_VIEWPORT_PX / 100, vmax: THEME_VIEWPORT_PX / 100 };

// The written-back value as a tree: {k:'num',n,u} {k:'word',v} {k:'str'} {k:'op',v} and
// {k:'fn',name,args:[[items]...]} (a bare bracket is a fn with the name '').
function themeCssTree(s) {
  let i = 0;
  const seq = () => {
    const items = [];
    while (i < s.length && s[i] !== ')' && s[i] !== ',') {
      const c = s[i];
      let m;
      if (c === ' ') { i++; continue; }
      if (c === '"') { const e = s.indexOf('"', i + 1); items.push({ k: 'str', v: s.slice(i + 1, e) }); i = e + 1; continue; }
      if (c === '(') { i++; items.push({ k: 'fn', name: '', args: args() }); continue; }
      if ((m = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)([A-Za-z%]*)/.exec(s.slice(i, i + 40)))) { items.push({ k: 'num', n: parseFloat(m[0]), u: m[1].toLowerCase() }); i += m[0].length; continue; }
      if ((m = /^--?[A-Za-z_][A-Za-z0-9_-]*|^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i, i + 80)))) {
        i += m[0].length;
        if (s[i] === '(') { i++; items.push({ k: 'fn', name: m[0], args: args() }); } else items.push({ k: 'word', v: m[0] });
        continue;
      }
      if ((m = /^#[0-9a-f]+/.exec(s.slice(i, i + 12)))) { items.push({ k: 'word', v: m[0] }); i += m[0].length; continue; }
      items.push({ k: 'op', v: c }); i++;      // + - * / and nothing else can be here
    }
    return items;
  };
  const args = () => {
    const list = [];
    for (;;) {
      list.push(seq());
      if (s[i] === ',') { i++; continue; }
      i++;                                     // the closing bracket
      return list;
    }
  };
  return seq();
}

// A number worked out from a value's tree: a plain number, a percentage, a length, or
// calc()/min()/max()/clamp() of those. mode 'len' gives pixels, 'num' a plain number
// (a percentage is then a fraction). Returns null for anything that cannot be worked out
// (var(), an unknown unit, a mix that makes no sense): the caller refuses those.
function themeCssNumber(items, mode) {
  let p = 0;
  const one = () => {
    let sign = 1;
    while (items[p] && items[p].k === 'op' && (items[p].v === '+' || items[p].v === '-')) { if (items[p].v === '-') sign = -sign; p++; }
    const t = items[p++];
    if (!t) throw 0;
    if (t.k === 'num') {
      if (!t.u) return sign * t.n;
      if (t.u === '%') return sign * (mode === 'len' ? t.n / 100 * THEME_TEXT_BASE_PX : t.n / 100);
      if (mode === 'len' && THEME_PX_PER[t.u]) return sign * t.n * THEME_PX_PER[t.u];
      throw 0;
    }
    if (t.k === 'fn') {
      const f = t.name.toLowerCase();
      const vals = t.args.map(a => themeCssNumber(a, mode));
      if (vals.some(v => v === null)) throw 0;
      if (f === '' || f === 'calc') { if (vals.length !== 1) throw 0; return sign * vals[0]; }
      if (f === 'min') return sign * Math.min(...vals);
      if (f === 'max') return sign * Math.max(...vals);
      if (f === 'clamp' && vals.length === 3) return sign * Math.max(vals[0], Math.min(vals[1], vals[2]));
    }
    throw 0;
  };
  const term = () => { let v = one(); while (items[p] && items[p].k === 'op' && (items[p].v === '*' || items[p].v === '/')) { const o = items[p++].v, r = one(); v = o === '*' ? v * r : v / r; } return v; };
  try {
    let v = term();
    while (items[p] && items[p].k === 'op' && (items[p].v === '+' || items[p].v === '-')) { const o = items[p++].v, r = term(); v = o === '+' ? v + r : v - r; }
    return p === items.length && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

// True when a rule's selector reaches the page itself (html, body, :root, *) or could.
function themeCssHitsPage(prelude) {
  if (prelude.length > 400) return true;      // a selector is at most 200 characters (refused later anyway): do not scan a long one, and fail closed
  let parts;
  try { parts = themeSplit(themeWs(prelude), ','); } catch { return false; }   // a bad selector is refused on its own
  return parts.some(part => {
    const flat = part.replace(/\[[^\]]*\]/g, '');
    const last = flat.trim().split(/[\s>+~]+/).pop();
    if (/::|:(?:before|after|first-line|first-letter)\b/i.test(last)) return false;
    return /^(?:\*|html|body|:root|:not\(|:is\(|:where\()/i.test(last);
  });
}

const THEME_CSS_GUARDED = /^(?:content|display|visibility|opacity|zoom|scale|font|font-size|transform|filter|backdrop-filter|animation|animation-duration|-webkit-(?:transform|filter|backdrop-filter))$/;
// prop is lower case, val the written-back value without !important, prelude the raw selector text.
function themeCssGuard(prop, val, prelude) {
  if (!THEME_CSS_GUARDED.test(prop)) return;      // (custom properties too: --x: 0 means nothing until something reads it, and var() is refused where it would count)
  const P = `the property "${prop}"`, V = `"${themeQuote(val)}"`;
  const noVar = () => { if (/(?:^|[^A-Za-z0-9_-])var\(/i.test(val)) themeBad(`${P} cannot use var(), because the value could not be checked: write the value itself`); };
  const tree = themeCssTree(val);
  const words = tree.filter(t => t.k === 'word').map(t => t.v.toLowerCase());
  const walk = (items, fn) => { for (const t of items) if (t.k === 'fn') { fn(t); for (const a of t.args) walk(a, fn); } };
  switch (prop) {
    case 'content':
      if (!(val === '""' || /^(?:none|normal)$/i.test(val))) themeBad(`${P} cannot be ${V}: only "" (empty), none or normal are allowed, because words added by a theme change what the page says`);
      return;
    case 'display':
      noVar();
      if (words.includes('none')) themeBad(`${P} cannot be ${V}: display: none hides part of the page`);
      if (words.includes('contents') && themeCssHitsPage(prelude)) themeBad(`${P} cannot be ${V} on html, body or a rule that reaches them`);
      return;
    case 'visibility':
      noVar();
      if (words.includes('hidden') || words.includes('collapse')) themeBad(`${P} cannot be ${V}: it hides part of the page`);
      return;
    case 'opacity': case 'zoom': case 'scale': {
      noVar();
      const lo = prop === 'opacity' ? THEME_MIN_OPACITY : THEME_MIN_SCALE;
      if (tree.length && tree.every(t => t.k === 'word')) return;             // inherit, initial and the like
      // scale takes one to three numbers; each one is judged
      const lists = [];
      if (prop === 'scale') { let cur = []; for (const t of tree) { cur.push(t); if (t.k !== 'op') { lists.push(cur); cur = []; } } } else lists.push(tree);
      for (const g of lists) {
        const n = themeCssNumber(g, 'num');
        if (n === null) themeBad(`${P} cannot be ${V}: it could not be checked, write a plain number or a percentage`);
        if ((prop === 'scale' ? Math.abs(n) : n) < lo - 1e-9) themeBad(`${P} cannot be ${V}: below ${lo} ${prop === 'opacity' ? 'the page fades out' : 'the page shrinks to nothing'}`);
      }
      return;
    }
    case 'font-size': case 'font': {
      noVar();
      let size = null;
      if (prop === 'font-size') size = tree;
      else {
        // font: [style variant weight stretch] size[/line-height] family. A bare number before the size is the weight.
        for (let k = 0; k < tree.length; k++) {
          const t = tree[k];
          if (t.k === 'num' && !t.u && t.n !== 0) continue;
          if (t.k === 'word') continue;
          size = [t];                                   // one number, percentage or calc(): what follows is the line height and the family
          break;
        }
      }
      if (!size || !size.length || size.every(t => t.k === 'word')) return;    // keywords (medium, larger, inherit) are all readable
      const px = themeCssNumber(size, 'len');
      if (px === null) themeBad(`${P} cannot be ${V}: the size could not be checked, write it in px, em, rem or %`);
      if (px < THEME_MIN_TEXT_PX - 1e-9) themeBad(`${P} cannot be ${V}: text under ${THEME_MIN_TEXT_PX}px cannot be read`);
      return;
    }
    case 'transform': case '-webkit-transform': case 'filter': case '-webkit-filter': {
      // scale(..) under 0.3 hides; so does filter: opacity(..) under 0.3
      walk(tree, f => {
        const name = f.name.toLowerCase(), scaleFn = /^scale(?:x|y)?$/.test(name), opFn = name === 'opacity';
        if (!scaleFn && !opFn) return;
        if (JSON.stringify(f.args).toLowerCase().includes('"name":"var"')) themeBad(`${P} cannot use var() inside ${name}(), because the value could not be checked`);
        for (const a of f.args) {
          const n = themeCssNumber(a, 'num');
          if (n === null) themeBad(`${P} cannot be ${V}: ${name}() could not be checked, write a plain number or a percentage`);
          const lo = opFn ? THEME_MIN_OPACITY : THEME_MIN_SCALE;
          if (Math.abs(n) < lo - 1e-9) themeBad(`${P} cannot be ${V}: ${name}() below ${lo} ${opFn ? 'fades the page out' : 'shrinks it to nothing'}`);
        }
      });
      return;
    }
    case 'backdrop-filter': case '-webkit-backdrop-filter': {
      // The only thing a theme may blur is the layer behind an element, and only a little:
      // a heavy backdrop blur reads as a broken page. blur(Npx), N from 0 to 20.
      noVar();
      if (tree.length && tree.every(t => t.k === 'word')) return;       // none, inherit, initial, unset
      const one = tree.length === 1 && tree[0].k === 'fn' && tree[0].name.toLowerCase() === 'blur'
        && tree[0].args.length === 1 && tree[0].args[0].length === 1 && tree[0].args[0][0].k === 'num'
        && (tree[0].args[0][0].u === 'px' || (tree[0].args[0][0].u === '' && tree[0].args[0][0].n === 0))
        && tree[0].args[0][0].n >= 0 && tree[0].args[0][0].n <= 20;
      if (!one) themeBad(`${P} can only be blur(Npx) with N from 0 to 20`);
      return;
    }
    case 'animation': case 'animation-duration': {
      // A theme may animate, but not on a long loop that keeps the page moving: no duration over 1s.
      noVar();
      const times = items => { for (const t of items) { if (t.k === 'num' && (t.u === 's' || t.u === 'ms')) { const sec = t.u === 's' ? t.n : t.n / 1000; if (sec > 1 + 1e-9) themeBad(`${P} cannot be ${V}: a duration over 1s is not allowed`); } else if (t.k === 'fn') for (const a of t.args) times(a); } };
      times(tree);
      return;
    }
  }
}

// Every theme @keyframes name is namespaced under this, so a theme's animation can
// never collide with the page's own keyframes (its 'dlbob' among them). The definition
// and the animation names that point at it both get the prefix.
const THEME_KF_PREFIX = 'spk-';

// An @keyframes at-rule: the one at-rule a theme may use, and only to fade or move things.
// Keyframe blocks hold only opacity or transform (with var() refused), and the name must be a
// plain CSS identifier. The compiled rule is pushed onto `out`; the index just past its closing
// brace is returned. The caller has already matched the "@...keyframes" itself.
function themeCssKeyframes(src, i, ctx, count, out) {
  const n = src.length;
  const comment = () => { const e = src.indexOf('*/', i + 2); if (e < 0) themeBad('a comment is not closed'); i = e + 2; };
  i += /^@(-webkit-)?keyframes/.exec(src.slice(i))[0].length;
  const ws = () => { for (;;) { if (i >= n) themeBad('@keyframes is not closed'); if (src[i] === '/' && src[i + 1] === '*') { comment(); continue; } if (/\s/.test(src[i])) { i++; continue; } break; } };
  ws();
  const nm = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
  if (!nm) themeBad('@keyframes needs a name (letters, digits, - and _)');
  const name = nm[0];
  i += name.length;
  ws();
  if (src[i] !== '{') themeBad('@keyframes needs a { after its name');
  i++;
  const blocks = [];
  for (;;) {
    ws();
    if (i >= n) themeBad('a { is never closed');
    if (src[i] === '}') { i++; break; }
    let sel = '';
    for (;;) {
      if (i >= n) themeBad('a keyframe selector is not closed');
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') { comment(); sel += ' '; continue; }
      if (c === '{') { i++; break; }
      sel += c; i++;
    }
    const s = sel.trim();
    if (!/^(?:from|to|(?:100|\d{1,2})(?:\.\d+)?%)$/.test(s)) themeBad(`"${themeQuote(s)}" is not a keyframe selector (from, to, or a percentage)`);
    if (++count.rules > THEME_LIMITS.rules) themeBad(`css has more than ${THEME_LIMITS.rules} rules`);
    const decls = [];
    let cur = '', depth = 0;
    const endDecl = () => {
      const text = cur.trim(); cur = '';
      if (!text) return;
      const colon = text.indexOf(':');
      if (colon < 0) themeBad(`"${themeQuote(text)}" is not a declaration (property: value)`);
      const prop = text.slice(0, colon).trim().toLowerCase();
      if (!/^(?:opacity|transform|-webkit-transform)$/.test(prop)) themeBad(`@keyframes can only animate opacity or transform (not "${themeQuote(prop)}")`);
      const value = themeCssValue(text.slice(colon + 1), ctx);
      if (/(?:^|[^A-Za-z0-9_-])var\(/i.test(value)) themeBad('@keyframes cannot use var(), because the value could not be checked');
      if (prop === 'opacity') {
        const tn = themeCssNumber(themeCssTree(value), 'num');
        if (tn === null || tn < 0 || tn > 1) themeBad('opacity in @keyframes must be a number from 0 to 1');
      }
      decls.push(`${prop}: ${value}`);
    };
    for (;;) {
      if (i >= n) themeBad('a { is never closed');
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') { comment(); cur += ' '; continue; }
      if (c === '"' || c === "'") { const [str, next] = themeCssString(src, i); cur += str; i = next; continue; }
      if (c === '(') depth++;
      if (c === ')' && --depth < 0) themeBad('a ) has no ( before it');
      if (c === '}') { if (depth) themeBad('a ( is never closed'); i++; endDecl(); break; }
      if (c === ';' && depth === 0) { i++; endDecl(); continue; }
      cur += c; i++;
    }
    if (!decls.length) themeBad('a keyframe block has no declarations');
    blocks.push(`${s} { ${decls.join('; ')} }`);
  }
  if (!blocks.length) themeBad('@keyframes has no keyframes');
  out.push(`@keyframes ${THEME_KF_PREFIX}${name} { ${blocks.join(' ')} }`);
  return i;
}

// count: {bytes, rules}, shared between the pieces of css one theme carries.
function themeCssCompile(src, ctx, count) {
  // The size first: nothing reads more than the limit's worth of it (a request may carry megabytes).
  count.bytes += Buffer.byteLength(src);
  if (count.bytes > THEME_LIMITS.css) themeBad(`css is larger than ${THEME_LIMITS.css / 1024} KB`);
  if (THEME_CSS_BAD_CHARS.test(src)) themeBad('css has a control character or an invalid character in it');
  if (src.includes('<')) themeBad('css has a less-than sign in it, which could close the page\'s style element early');
  const out = [], n = src.length;
  // The names of every @keyframes this css defines, so they can be namespaced below.
  const kfNames = new Set();
  for (const m of src.matchAll(/@(-webkit-)?keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) kfNames.add(m[2]);
  let i = 0;
  const comment = () => { const e = src.indexOf('*/', i + 2); if (e < 0) themeBad('a comment is not closed'); i = e + 2; };
  for (;;) {
    let prelude = '';
    for (;;) {
      if (i >= n) { if (prelude.trim()) themeBad('a rule has no { } after its selector'); return out; }
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') { comment(); prelude += ' '; continue; }
      if (c === '"' || c === "'") { const [str, next] = themeCssString(src, i); prelude += str; i = next; continue; }
      if (c === '{') { i++; break; }
      if (c === '@') {
        if (/^@(-webkit-)?keyframes\b/.test(src.slice(i))) { i = themeCssKeyframes(src, i, ctx, count, out); continue; }
        themeBad('at-rules (@import, @media, @font-face, ...) are not allowed');
      }
      if (c === '}' || c === ';') themeBad(`a stray ${c} in css`);
      prelude += c; i++;
    }
    if (++count.rules > THEME_LIMITS.rules) themeBad(`css has more than ${THEME_LIMITS.rules} rules`);
    const decls = [];
    let cur = '', depth = 0;
    const endDecl = () => {
      const text = cur.trim(); cur = '';
      if (!text) return;
      const colon = text.indexOf(':');
      if (colon < 0) themeBad(`"${themeQuote(text)}" is not a declaration (property: value)`);
      let prop = text.slice(0, colon).trim();
      if (!prop.startsWith('--')) prop = prop.toLowerCase();
      if (!/^(?:-?[a-z][a-z-]{0,63}|--[A-Za-z0-9_-]{1,64})$/.test(prop) || THEME_CSS_DENIED_PROPS.has(prop)) themeBad(`the property "${themeQuote(prop)}" is not allowed`);
      if (decls.length >= THEME_LIMITS.decls) themeBad(`a rule has more than ${THEME_LIMITS.decls} declarations`);
      let value = themeCssValue(text.slice(colon + 1), ctx);
      if ((prop === 'animation' || prop === 'animation-name') && kfNames.size) {
        value = value.replace(/(^|[^A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]*)/g, (m, p, w) => kfNames.has(w) ? p + THEME_KF_PREFIX + w : m);
      }
      themeCssGuard(prop, value.replace(/ !important$/, ''), prelude);
      decls.push(`${prop}: ${value}`);
    };
    for (;;) {
      if (i >= n) themeBad('a { is never closed');
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') { comment(); cur += ' '; continue; }
      if (c === '"' || c === "'") { const [str, next] = themeCssString(src, i); cur += str; i = next; continue; }
      if (c === '{') themeBad('rules inside rules are not allowed');
      if (c === '@') themeBad('at-rules (@import, @media, @font-face, ...) are not allowed');
      if (c === '(') depth++;
      if (c === ')' && --depth < 0) themeBad('a ) has no ( before it');
      if (c === '}') { if (depth) themeBad('a ( is never closed'); i++; endDecl(); break; }
      if (c === ';' && depth === 0) { i++; endDecl(); continue; }
      cur += c; i++;
    }
    if (decls.length) out.push(`${themeCssSelector(prelude, ctx.id)} { ${decls.join('; ')} }`);
    else themeCssSelector(prelude, ctx.id);       // an empty rule is dropped, but its selector is still judged
  }
}

// Looks for the two things JSON.parse lets through silently: a key given twice (two
// readers of the same file would then disagree about it) and nesting deep enough to be a
// weapon. Not a parser; it only walks the text, and returns a reason or null.
function themeJsonProblem(text) {
  const sets = [];           // per open container: a Set of the keys so far for an object, null for an array
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      let j = i + 1;
      for (;;) {
        j = text.indexOf('"', j);
        if (j < 0) return null;                 // unterminated: JSON.parse will say so
        let b = 0;
        while (text.charCodeAt(j - 1 - b) === 92) b++;
        if (b % 2 === 0) break;
        j++;
      }
      if (expectKey) {
        const top = sets[sets.length - 1];
        const raw = text.slice(i + 1, j);
        let key = raw;
        if (raw.includes('\\')) { try { key = JSON.parse(`"${raw}"`); } catch { return null; } }
        if (top) {
          if (top.has(key)) return `has the key "${themeQuote(key)}" more than once`;
          top.add(key);
        }
        expectKey = false;
      }
      i = j;
    } else if (c === 123) { if (sets.length >= 64) return 'is nested too deeply'; sets.push(new Set()); expectKey = true; }
    else if (c === 91) { if (sets.length >= 64) return 'is nested too deeply'; sets.push(null); expectKey = false; }
    else if (c === 125 || c === 93) { sets.pop(); expectKey = false; }
    else if (c === 44) expectKey = sets.length > 0 && sets[sets.length - 1] !== null;
  }
  return null;
}

// {value} or {error}: JSON text from a file or a request, with a leading byte order mark tolerated.
function themeParseJson(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const why = themeJsonProblem(text);
  if (why) return { error: why };
  try { return { value: JSON.parse(text) }; } catch { return { error: 'is not valid JSON' }; }
}

// ---- The validator: one function for the folder scan, /check and the install -------
// inp: {form: 'file'|'folder', manifest (the parsed JSON), css (a folder's theme.css, or
// null), assets (Map name -> Buffer, or null for a single file), fallbackId (from the file
// or folder name, or null)}. Returns {problems, warnings, theme, stored}; theme is what
// the page is given, stored is what is written to disk (its own manifest text, so that
// reading it back gives the same theme).
function validateTheme(inp) {
  const problems = [], warnings = [];
  const warn = t => { if (warnings.length < 20) warnings.push(t); };
  const attempt = (fn, prefix = '') => {
    try { return fn(); } catch (e) {
      if (!(e instanceof ThemeBad)) throw e;
      if (problems.length < 20) problems.push(prefix + e.message);
      return undefined;
    }
  };
  const fail = () => ({ problems, warnings, theme: null, stored: null });
  const m = inp.manifest;
  if (!themeIsObject(m)) { problems.push('theme.json must be one JSON object'); return fail(); }
  if (m.shadowtheme !== 1) problems.push('"shadowtheme": 1 is missing (it says the file is a theme)');
  for (const k of Object.keys(m)) if (!THEME_KEYS.has(k)) warn(`"${themeQuote(k)}" is not part of the theme format and was ignored`);

  const name = attempt(() => themeText(themeOwn(m, 'name'), 'name', 40, true)) || '';
  const author = attempt(() => themeText(themeOwn(m, 'author'), 'author', 40, false)) || '';
  const description = attempt(() => themeText(themeOwn(m, 'description'), 'description', 140, false)) || '';
  const version = attempt(() => themeText(themeOwn(m, 'version'), 'version', 16, false)) || '';

  const id = attempt(() => {
    const raw = themeOwn(m, 'id');
    let v;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string' || !THEME_ID.test(raw)) themeBad(`id "${themeQuote(raw)}" must be 1 to 32 lower-case letters, digits or dashes, starting with a letter or digit`);
      v = raw;
    } else {
      v = inp.fallbackId !== null && inp.fallbackId !== undefined ? inp.fallbackId : themeSlug(name);
      if (!THEME_ID.test(v)) themeBad('an id could not be made from the name: add an "id" of lower-case letters, digits and dashes');
      warn(`no "id" given, using "${v}"`);
    }
    if (BUILTIN_THEMES.includes(v)) themeBad(`"${v}" is the name of a built-in theme: use another "id"`);
    if (THEME_RESERVED_FILE.test(v)) themeBad(`"${v}" is a name Windows does not allow for a file: use another "id"`);
    return v;
  });
  const ctxBase = { id: id || 'invalid', assets: inp.assets || null };

  const base = attempt(() => {
    const raw = themeOwn(m, 'base');
    if (raw === undefined || raw === null) return 'midnight';
    if (typeof raw !== 'string' || !BUILTIN_THEMES.includes(raw)) themeBad(`base must be one of ${BUILTIN_THEMES.join(', ')}`);
    return raw;
  }) || 'midnight';
  let mode = attempt(() => {
    const raw = themeOwn(m, 'mode');
    if (raw === undefined || raw === null) return null;
    if (raw !== 'dark' && raw !== 'light') themeBad('mode must be "dark" or "light"');
    return raw;
  });

  // palette: normalised to lower-case #rrggbb
  let palette = null, backgroundRgb = null;
  attempt(() => {
    const raw = themeOwn(m, 'palette');
    if (raw === undefined || raw === null) return;
    if (!themeIsObject(raw)) themeBad('palette must be an object of colours');
    for (const k of Object.keys(raw)) if (!THEME_PALETTE_KEYS.includes(k)) warn(`palette "${themeQuote(k)}" is not a colour the theme format knows and was ignored`);
    const out = {};
    for (const k of THEME_PALETTE_KEYS) {
      const v = themeOwn(raw, k);
      if (v === undefined || v === null) continue;
      attempt(() => {
        if (typeof v !== 'string') themeBad('must be a colour written as text');
        const c = themeColour(v, {});
        out[k] = themeHex(c);
        if (k === 'background') backgroundRgb = c.rgb;
      }, `palette ${k}: `);
    }
    if (Object.keys(out).length) palette = out;
  });

  // tokens: checked twice, once as they will be stored and once as they will be served.
  // Only an assets/ file reads differently in the two, and a single file has none, so
  // there the second pass would say the same thing again (over 1 MiB of pictures, twice).
  const tokensSource = {}, tokensServed = {};
  attempt(() => {
    const raw = themeOwn(m, 'tokens');
    if (raw === undefined || raw === null) return;
    if (!themeIsObject(raw)) themeBad('tokens must be an object of CSS custom properties');
    for (const k of Object.keys(raw)) {
      if (problems.length >= 20) break;
      if (!THEME_TOKENS.has(k)) { if (problems.length < 20) problems.push(`"${themeQuote(k)}" is not a token a theme can set`); continue; }
      attempt(() => {
        const type = THEME_TOKENS.get(k), v = raw[k];
        tokensSource[k] = themeValue(type, v, { ...ctxBase, mode: 'source' });
        tokensServed[k] = ctxBase.assets ? themeValue(type, v, { ...ctxBase, mode: 'served' }) : tokensSource[k];
      }, `token ${k}: `);
    }
  });

  // logo: one asset the page shows in the header in place of the title text; icons: a map
  // of kind -> asset that overrides the built-in row icons. Folder themes only (assets/).
  let logo = null, icons = null;
  attempt(() => {
    const lr = themeOwn(m, 'logo');
    if (lr === undefined || lr === null) return;
    if (typeof lr !== 'string') themeBad('logo must be an assets/<file> path');
    else logo = themeRef(lr, { ...ctxBase, mode: 'source' }, 'image').text;
  }, 'logo: ');
  attempt(() => {
    const ir = themeOwn(m, 'icons');
    if (ir === undefined || ir === null) return;
    if (!themeIsObject(ir)) themeBad('icons must be an object of kind -> assets/<file>');
    else {
      icons = {};
      for (const k of Object.keys(ir)) {
        if (problems.length >= 20) break;
        if (!THEME_ICON_KINDS.has(k)) { warn(`icon \"${themeQuote(k)}\" is not a kind the page draws and was ignored`); continue; }
        const v = ir[k];
        attempt(() => { if (typeof v !== 'string') themeBad(`icon ${k} must be an assets/<file> path`); else icons[k] = themeRef(v, { ...ctxBase, mode: 'source' }, 'image').text; }, `icon ${k}: `);
      }
      if (!Object.keys(icons).length) icons = null;
    }
  }, 'icons: ');

  // fonts: also written as the @font-face rules the served css starts with
  const fontsSource = [], fontsServed = [], faces = [];
  attempt(() => {
    const raw = themeOwn(m, 'fonts');
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) themeBad('fonts must be a list');
    if (raw.length > 4) themeBad('at most 4 fonts');
    raw.forEach((f, i) => attempt(() => {
      if (!themeIsObject(f)) themeBad('must be an object with a family and a src');
      const family = themeOwn(f, 'family'), src = themeOwn(f, 'src');
      if (typeof family !== 'string' || !/^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/.test(family)) themeBad('family must be a name of letters, digits, spaces, . - and _ (at most 40)');
      if (/^(pixelchrome|serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial|unset|default)$/i.test(family)) themeBad(`"${family}" is a name the page already uses: pick another`);
      if (typeof src !== 'string') themeBad('src must be text: an assets/ file or a data:font/... URL');
      let weight = themeOwn(f, 'weight');
      if (weight === undefined || weight === null) weight = '400';
      if (typeof weight === 'number') weight = String(weight);
      if (typeof weight !== 'string' || !/^(?:[1-9]00|normal|bold)$/.test(weight)) themeBad('weight must be 100 to 900, normal or bold');
      const ref = themeRef(src, { ...ctxBase, mode: 'source' }, 'font');
      const served = ctxBase.assets ? themeRef(src, { ...ctxBase, mode: 'served' }, 'font') : ref;
      fontsSource.push({ family, src: ref.text, weight });
      fontsServed.push({ family, src: served.text, weight });
      faces.push(`@font-face { font-family: "${family}"; src: url("${served.text}") format("${THEME_FONT_FORMAT.get(ref.ext)}"); font-weight: ${weight}; font-display: swap }`);
    }, `font ${i + 1}: `));
  });

  // A folder's own files: every one is judged, used or not, since each is served at its own address.
  if (inp.assets) {
    const seen = new Set();
    for (const [an, buf] of inp.assets) attempt(() => {
      if (!THEME_ASSET_NAME.test(an) || !THEME_ASSET_TYPES.has(themeExt(an)) || THEME_RESERVED_FILE.test(an)) themeBad(`"${themeQuote(an)}" is not a name an asset can have`);
      if (seen.has(an.toLowerCase())) themeBad(`assets/${an} has the same name as another asset, apart from its capitals`);
      seen.add(an.toLowerCase());
      themeCheckAsset(themeExt(an), buf, `assets/${an}`);
    });
  }

  // css: the manifest's, then a folder's theme.css. Each is its own document, so an
  // unclosed brace in one cannot swallow the other.
  const cssRaw = themeOwn(m, 'css');
  const rules = [];
  attempt(() => {
    if (cssRaw !== undefined && cssRaw !== null && typeof cssRaw !== 'string') themeBad('css must be text');
    const count = { bytes: 0, rules: 0 };
    for (const src of [typeof cssRaw === 'string' ? cssRaw : null, typeof inp.css === 'string' ? inp.css : null]) {
      if (src !== null) rules.push(...themeCssCompile(src, { ...ctxBase, mode: 'served' }, count));
    }
  }, 'css: ');

  if (!palette && !Object.keys(tokensSource).length && !rules.length && !problems.length) problems.push('a theme needs at least one of palette, tokens or css');
  if (mode === null || mode === undefined) mode = backgroundRgb ? (themeLuminance(backgroundRgb) < 0.4 ? 'dark' : 'light') : (LIGHT_BASES.has(base) ? 'light' : 'dark');
  if (problems.length) return fail();

  const manifest = { shadowtheme: 1, id, name };
  if (author) manifest.author = author;
  if (description) manifest.description = description;
  if (version) manifest.version = version;
  manifest.base = base; manifest.mode = mode;
  if (palette) manifest.palette = palette;
  if (logo) manifest.logo = logo;
  if (icons) manifest.icons = icons;
  if (Object.keys(tokensSource).length) manifest.tokens = tokensSource;
  if (fontsSource.length) manifest.fonts = fontsSource;
  if (typeof cssRaw === 'string' && cssRaw.trim()) manifest.css = cssRaw;
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  const cssText = inp.form === 'folder' && typeof inp.css === 'string' && inp.css.trim() ? inp.css : null;
  const assets = inp.assets || new Map();
  let bytes = Buffer.byteLength(manifestText);
  if (inp.form === 'file') {
    if (bytes > THEME_LIMITS.file) problems.push(`a single-file theme is at most ${THEME_LIMITS.file / 1024 / 1024} MiB (this one is ${(bytes / 1024 / 1024).toFixed(2)} MiB)`);
  } else {
    const sizes = [bytes, ...(cssText !== null ? [Buffer.byteLength(cssText)] : []), ...[...assets.values()].map(b => b.length)];
    bytes = sizes.reduce((a, b) => a + b, 0);
    if (sizes.length > THEME_LIMITS.files) problems.push(`a folder theme has at most ${THEME_LIMITS.files} files`);
    if (sizes.some(n => n > THEME_LIMITS.each)) problems.push(`no file in a theme may be larger than ${THEME_LIMITS.each / 1024 / 1024} MiB`);
    if (bytes > THEME_LIMITS.folder) problems.push(`a folder theme is at most ${THEME_LIMITS.folder / 1024 / 1024} MiB in all`);
  }
  if (problems.length) return fail();

  // What the page is told is the summary (all the list carries) and then the pieces it
  // applies: tokens, css and fonts as validated, scoped and with assets/ rewritten, and
  // `source`, the manifest as stored, for a person to edit or export. A single file's
  // source is exactly what is on disk, so posting it back gives this same theme. A
  // folder's has its theme.css joined on to `css` and a `files` list of its assets, since
  // its pictures are not in the manifest; a folder cannot be posted back as one file.
  let source = manifest;
  if (inp.form === 'folder') {
    source = { ...manifest };
    const css = [manifest.css, cssText].filter(t => typeof t === 'string' && t.trim()).join('\n');
    if (css) source.css = css; else delete source.css;
    source.files = [...assets].map(([n, b]) => ({ name: n, size: b.length })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const theme = {
    id, name, author, description, version, base, mode, palette, logo, icons,
    form: inp.form, bytes, hasFonts: fontsSource.length > 0, hasCss: rules.length > 0, hasTokens: Object.keys(tokensSource).length > 0, editable: inp.form === 'file',
    tokens: tokensServed, css: [...faces, ...rules].join('\n'), fonts: fontsServed, source,
  };
  // The last line of defence for the one rule that matters most: nothing that goes into a
  // <style> element, or into the page at all, can contain what closes one.
  const stray = [];
  (function walk(v) {
    if (typeof v === 'string') { if (/</.test(v) || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(v)) stray.push(v); }
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  })(theme);
  if (/\/\*|\*\/|<\/style/i.test(theme.css)) stray.push(theme.css);
  if (stray.length) { problems.push('the theme could not be made safe (it has an angle bracket or a comment marker where none is possible)'); return fail(); }
  return { problems, warnings, theme, stored: { manifest, manifestText, css: cssText, assets, bytes } };
}

// ---- The folder: read once, then looked at again when it changes ------------------
let THEME_LIST = [];               // the themes on offer, by name
let THEME_BY_ID = new Map();
let THEME_REJECTED = [];           // [{name, reason}]: in the folder, not offered
const themeCache = new Map();      // entry name -> {sig, rec | reason}: an unchanged entry is not read again
let themeCheckedAt = 0, themeRev = 0, themeBusy = 0;
const themeLogged = new Set();     // lines already written, so each is written once

function themeLogOnce(line) {
  if (themeLogged.has(line) || themeLogged.size >= 500) return;
  themeLogged.add(line);
  console.log(line);
}

// The list carries a summary of each theme and nothing that grows with the theme: the
// pieces a page applies (tokens, css, fonts, and the source they came from) hold every
// embedded picture and font, so with 64 themes on offer they would make the list tens of
// megabytes. A page fetches those for the one theme it is using: GET /api/themes/<id>.
const THEME_SUMMARY = ['id', 'name', 'author', 'description', 'version', 'base', 'mode', 'palette', 'form', 'bytes', 'hasFonts', 'hasCss', 'hasTokens', 'editable', 'logo', 'icons'];
const themePublic = rec => Object.fromEntries(THEME_SUMMARY.map(k => [k, rec[k]]));
const themeFull = rec => ({ ...themePublic(rec), tokens: rec.tokens, css: rec.css, fonts: rec.fonts, source: rec.source });

// What is in one entry of the folder, as cheaply as it can be told: sizes and times, no
// contents. It is also the entry's signature, so a change to any file that matters shows.
// A link is never followed; anything else in a theme's folder than the files below is
// never read or served.
function themeDescribe(name) {
  const full = path.join(THEMES_DIR, name);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) return { kind: 'link' };
  if (st.isFile()) return { kind: 'file', size: st.size, mtime: st.mtimeMs };
  if (!st.isDirectory()) return { kind: 'other' };
  const d = { kind: 'dir', files: [], assets: [] };
  const top = fs.readdirSync(full);
  if (top.length > 100) { d.tooMany = true; return d; }
  for (const n of top.sort()) {
    if (n === 'theme.json' || n === 'theme.css') {
      const s = fs.lstatSync(path.join(full, n));
      d.files.push({ name: n, size: s.size, mtime: s.mtimeMs, file: s.isFile() });
    } else if (n === 'assets') {
      const dir = path.join(full, n);
      const s = fs.lstatSync(dir);
      if (!s.isDirectory()) { d.assetsBad = true; continue; }
      const list = fs.readdirSync(dir);
      if (list.length > 100) { d.tooMany = true; return d; }
      for (const a of list.sort()) {
        const as = fs.lstatSync(path.join(dir, a));
        d.assets.push({ name: a, size: as.size, mtime: as.mtimeMs, file: as.isFile() });
      }
    }
  }
  return d;
}

// -> {rec, warnings} or {reason}
function themeLoad(name, d) {
  const full = path.join(THEMES_DIR, name);
  const why = reason => ({ reason });
  if (d.kind === 'error') return why('could not be read');
  if (d.kind === 'link') return why('is a link, and links are not followed');
  let manifestText, cssText = null, assets = null, bytes;
  // What the theme is as it is stored: the bytes of its files and its assets' names, sizes
  // and times. It is the theme's ETag (with the server's start in front, see themeRoute),
  // so a page that has fetched the theme in full is told when a file, a picture or a
  // replace has changed it. The pictures themselves are not read into it.
  const stamp = crypto.createHash('sha1').update(`${d.kind}\0${name}\0`);
  try {
    if (d.kind === 'file') {
      if (d.size > THEME_LIMITS.file) return why(`is larger than ${THEME_LIMITS.file / 1024 / 1024} MiB`);
      const raw = fs.readFileSync(full);
      manifestText = THEME_UTF8.decode(raw);
      stamp.update(raw);
    } else {
      if (d.tooMany) return why('has too many files in it');
      const tj = d.files.find(f => f.name === 'theme.json'), tc = d.files.find(f => f.name === 'theme.css');
      if (!tj) return why('has no theme.json');
      if (!tj.file || (tc && !tc.file)) return why('has a theme.json or theme.css that is a link, not a file');
      if (d.assetsBad) return why('has an assets that is a link, not a folder');
      // Only files with a name and a kind a theme may have count; a .DS_Store, a folder
      // inside assets, a link or a README is left where it is and never served.
      const mine = d.assets.filter(a => a.file && THEME_ASSET_NAME.test(a.name) && THEME_ASSET_TYPES.has(themeExt(a.name)) && !THEME_RESERVED_FILE.test(a.name));
      const all = [tj, ...(tc ? [tc] : []), ...mine];
      bytes = all.reduce((n, f) => n + f.size, 0);
      if (all.length > THEME_LIMITS.files) return why(`has more than ${THEME_LIMITS.files} files`);
      if (all.some(f => f.size > THEME_LIMITS.each)) return why(`has a file larger than ${THEME_LIMITS.each / 1024 / 1024} MiB`);
      if (bytes > THEME_LIMITS.folder) return why(`is larger than ${THEME_LIMITS.folder / 1024 / 1024} MiB`);
      const rawJson = fs.readFileSync(path.join(full, 'theme.json'));
      manifestText = THEME_UTF8.decode(rawJson);
      stamp.update(`json ${rawJson.length}\0`).update(rawJson);
      if (tc) {
        const rawCss = fs.readFileSync(path.join(full, 'theme.css'));
        cssText = THEME_UTF8.decode(rawCss);
        stamp.update(`css ${rawCss.length}\0`).update(rawCss);
      }
      assets = new Map();
      for (const a of mine) {
        assets.set(a.name, fs.readFileSync(path.join(full, 'assets', a.name)));
        stamp.update(`\0${a.name}\0${a.size}\0${a.mtime}`);
      }
    }
  } catch (e) {
    return why(e instanceof TypeError ? 'is not valid UTF-8 text' : `could not be read (${themeQuote(e.code || e.message)})`);
  }
  const parsed = themeParseJson(manifestText);
  if (parsed.error) return why(`${d.kind === 'dir' ? 'theme.json ' : ''}${parsed.error}`);
  const v = validateTheme({
    form: d.kind === 'file' ? 'file' : 'folder', manifest: parsed.value, css: cssText, assets,
    fallbackId: themeSlug(name.replace(/\.json$/i, '')),
  });
  if (!v.theme) return why(v.problems.join('; ').slice(0, 400));
  // `bytes` is the validator's: the theme as this server would store it once cleaned, which
  // is what is on disk for anything installed here, and what a check of its source says.
  const rec = { ...v.theme, _file: name, _stamp: stamp.digest('hex').slice(0, 20), _assets: assets ? new Map([...assets].map(([n, b]) => [n, { name: n, size: b.length }])) : null };
  return { rec };
}

// force: the folder is known to have changed (this process just wrote to it), whatever the
// listing looks like.
function themeScan(force) {
  let names = [];
  try { names = fs.readdirSync(THEMES_DIR); } catch {}
  names = names.filter(n => !n.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const skipped = Math.max(0, names.length - THEME_ENTRIES_MAX);
  names = names.slice(0, THEME_ENTRIES_MAX);
  const seen = new Set(), results = [];
  let changed = !!force || skipped !== (themeScan.skipped || 0);
  themeScan.skipped = skipped;
  for (const name of names) {
    let d;
    try { d = themeDescribe(name); } catch { d = { kind: 'error' }; }
    // Not a theme, and not worth a word: a note, a picture, a stray file.
    if (d.kind === 'other' || (d.kind === 'file' && !/\.json$/i.test(name)) || (d.kind === 'link' && /\.[^.]+$/.test(name) && !/\.json$/i.test(name))) continue;
    seen.add(name);
    const sig = JSON.stringify(d);
    let hit = themeCache.get(name);
    if (!hit || hit.sig !== sig) { hit = { sig, ...themeLoad(name, d) }; themeCache.set(name, hit); changed = true; }
    results.push([name, hit]);
  }
  for (const name of [...themeCache.keys()]) if (!seen.has(name)) { themeCache.delete(name); changed = true; }
  if (!changed) return;

  const list = [], rejected = [], byId = new Map();
  for (const [name, hit] of results) {
    if (!hit.rec) { rejected.push({ name, reason: hit.reason }); continue; }
    const first = byId.get(hit.rec.id);
    if (first) rejected.push({ name, reason: `its id "${hit.rec.id}" is already used by ${themeQuote(first._file)}` });
    else if (list.length >= THEME_MAX) rejected.push({ name, reason: `there are already ${THEME_MAX} themes, so this one is not used` });
    else { byId.set(hit.rec.id, hit.rec); list.push(hit.rec); }
  }
  if (skipped) rejected.push({ name: `${skipped} more`, reason: `the folder holds more than ${THEME_ENTRIES_MAX} entries, and the rest were not looked at` });
  THEME_LIST = list.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  THEME_BY_ID = byId;
  THEME_REJECTED = rejected.map(r => ({ name: themeQuote(r.name), reason: r.reason }));
  for (const r of THEME_REJECTED) themeLogOnce(`themes: ${r.name} not offered: ${r.reason}`);
  themeRev++;
  const ids = list.map(t => t.id).sort();
  const line = `themes: ${ids.length} installed${ids.length ? ` (${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', ...' : ''})` : ''}`;
  if (line !== themeScan.line && (themeScan.line || ids.length)) console.log(line);
  themeScan.line = line;
  syncDefault();
}

// Looked at again when asked, at most once a second; a write in progress is left alone
// (a folder is mid-swap), and its own end asks again with force.
function refreshThemes(force) {
  if (themeBusy) return;
  const now = Date.now();
  if (!force && themeCheckedAt && now - themeCheckedAt < THEME_RECHECK_MS) return;
  themeCheckedAt = now;
  try { themeScan(force); } catch (e) { console.error(`themes: could not read ${THEMES_DIR}: ${e && e.message}`); }
}

// What an interrupted install leaves behind (dot-named, so never taken for a theme).
function themeSweep() {
  if (!profilesWritable) return;
  try {
    for (const n of fs.readdirSync(THEMES_DIR)) {
      if (!/^\.[a-z0-9-]+\.[0-9a-f]{12}\.(?:tmp|old)$/.test(n)) continue;
      const full = path.join(THEMES_DIR, n);
      if (Date.now() - fs.lstatSync(full).mtimeMs > 10 * 60000) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {}
}

// ---- The server's default theme ---------------------------------------------------
// A device that has not picked one starts with this. A value saved from the page beats
// DEFAULT_THEME, the same way it does for PUBLIC_BASE; one that names a theme that is not
// there (deleted by hand) counts for nothing until it is back.
const themeKnown = id => BUILTIN_THEMES.includes(id) || THEME_BY_ID.has(id);
const BUILTIN_DEFAULT_THEME = 'nes';      // what a device gets when neither a saved choice nor DEFAULT_THEME names one
function themeDefault() {
  const s = settings.defaultTheme;
  if (typeof s === 'string' && s && themeKnown(s)) return { id: s, from: 'setting' };
  if (DEFAULT_THEME_ENV && themeKnown(DEFAULT_THEME_ENV)) return { id: DEFAULT_THEME_ENV, from: 'env' };
  return { id: BUILTIN_DEFAULT_THEME, from: 'none' };
}

// The page as served, starting with the default: a built-in is put in data-theme, a
// custom theme in data-server-theme (which the page applies before first paint) with its
// base in data-theme, so a device that has never seen the theme still gets its structure.
function servedPage(d, now) {
  let html = INDEX_HTML;
  if (d.id) {
    const custom = !BUILTIN_THEMES.includes(d.id);
    const base = custom ? THEME_BY_ID.get(d.id).base : d.id;
    html = html.replace(/<html\b[^>]*>/i, tag => tag
      .replace(/\s+data-(?:theme|server-theme)=(?:"[^"]*"|'[^']*')/gi, '')
      .replace(/\s*>$/, ` data-theme="${base}"${custom ? ` data-server-theme="${d.id}"` : ''}>`));
  }
  return makePage(html, now);
}

let themeDefaultKey = null, themeDefaultLine = null;
// Called whenever the default might have changed: a setting, a delete, a rescan. The page
// is rebuilt only when what it says changed.
function syncDefault() {
  const d = themeDefault();
  if (DEFAULT_THEME_ENV && !themeKnown(DEFAULT_THEME_ENV)) themeLogOnce(`themes: DEFAULT_THEME "${themeQuote(DEFAULT_THEME_ENV)}" is not a built-in or installed theme, so it is ignored`);
  const key = d.id ? `${d.id}|${BUILTIN_THEMES.includes(d.id) ? '' : THEME_BY_ID.get(d.id).base}` : '';
  if (key !== themeDefaultKey) {
    const first = themeDefaultKey === null;
    themeDefaultKey = key;
    PAGE = servedPage(d, first);       // the first one at startup, where waiting for the compression costs nothing
  }
  const line = d.id ? `themes: default is ${d.id} (${d.from})` : null;
  if (line !== themeDefaultLine) {
    if (line) console.log(line); else if (themeDefaultLine) console.log('themes: default cleared');
    themeDefaultLine = line;
  }
}

// ---- Writing: one at a time, into place with a rename -----------------------------
let themeChain = Promise.resolve();
function themeExclusive(fn) {
  const run = themeChain.then(fn);
  themeChain = run.catch(() => {});
  return run;
}

// Windows refuses a rename while something has the file open, for a moment (see saveAtomic).
async function themeRename(from, to) {
  for (let tries = 0; ; tries++) {
    try { return await fsp.rename(from, to); } catch (e) {
      if (tries >= 5 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e;
      await new Promise(r => setTimeout(r, 40 * (tries + 1)));
    }
  }
}

// Takes an entry of the themes folder away: renamed out of sight first, so it is gone in
// one step, then deleted. The name is one that came from listing the folder, and is
// checked to be a single plain name inside it.
async function themeRemoveEntry(name) {
  if (!name || name.startsWith('.') || path.basename(name) !== name) throw new Error('not a name inside the themes folder');
  const aside = path.join(THEMES_DIR, `.${themeSlug(name) || 'x'}.${crypto.randomBytes(6).toString('hex')}.old`);
  await themeRename(path.join(THEMES_DIR, name), aside);
  await fsp.rm(aside, { recursive: true, force: true });
}

// Two names in the themes folder that differ only by capitals are one entry on a file
// system that ignores case (Windows, macOS, some shares) and two on one that does not:
// the file system is asked, by file identity, so a theme kept as Foo.json is not taken for
// something else than the foo.json a replace writes.
function themeSameEntry(a, b) {
  if (a === b) return true;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    const x = fs.lstatSync(path.join(THEMES_DIR, a)), y = fs.lstatSync(path.join(THEMES_DIR, b));
    if (x.ino && y.ino) return x.dev === y.dev && x.ino === y.ino;
    return fs.realpathSync.native(path.join(THEMES_DIR, a)) === fs.realpathSync.native(path.join(THEMES_DIR, b));
  } catch { return false; }
}

// v: what validateTheme returned. -> {status, body}
function themeInstall(v, replace) {
  return themeExclusive(async () => {
    const t = v.theme, id = t.id, folder = t.form === 'folder';
    refreshThemes(true);
    const existing = THEME_BY_ID.get(id);
    if (existing && !replace) return { status: 409, body: { error: 'exists', id } };
    if (!existing && THEME_LIST.length >= THEME_MAX) return { status: 409, body: { error: `There are already ${THEME_MAX} themes on this server. Delete one to make room` } };
    const target = folder ? id : `${id}.json`, targetPath = path.join(THEMES_DIR, target);
    // The name may be taken by something that is not this theme: another theme kept under
    // a different id, or a file that is not a working theme (only replaced when asked).
    const holder = THEME_LIST.find(x => themeSameEntry(x._file, target));
    if (holder && holder !== existing) return { status: 409, body: { error: `The file name "${target}" is used by the theme "${holder.id}". Delete that one first` } };
    let taken = false;
    try { fs.lstatSync(targetPath); taken = true; } catch {}
    if (taken && !existing && !replace) return { status: 409, body: { error: 'exists', id } };

    themeBusy++;
    const tag = crypto.randomBytes(6).toString('hex');
    const tmp = path.join(THEMES_DIR, `.${id}.${tag}.tmp`);
    let failed = null;
    try {
      await fsp.mkdir(THEMES_DIR, { recursive: true });
      if (!folder) await fsp.writeFile(tmp, v.stored.manifestText, { flag: 'wx' });
      else {
        await fsp.mkdir(path.join(tmp, 'assets'), { recursive: true });
        await fsp.writeFile(path.join(tmp, 'theme.json'), v.stored.manifestText, { flag: 'wx' });
        if (v.stored.css !== null) await fsp.writeFile(path.join(tmp, 'theme.css'), v.stored.css, { flag: 'wx' });
        for (const [n, buf] of v.stored.assets) await fsp.writeFile(path.join(tmp, 'assets', n), buf, { flag: 'wx' });
      }
      // A folder cannot be renamed over a folder, so what is there steps aside first and
      // goes back if the new one cannot be put in place.
      const cur = await fsp.lstat(targetPath).catch(() => null);
      const aside = cur && (folder || cur.isDirectory()) ? path.join(THEMES_DIR, `.${id}.${tag}.old`) : null;
      if (aside) await themeRename(targetPath, aside);
      try { await themeRename(tmp, targetPath); } catch (e) {
        if (aside) await themeRename(aside, targetPath).catch(() => {});
        throw e;
      }
      if (aside) await fsp.rm(aside, { recursive: true, force: true }).catch(e => console.error(`themes: could not remove the old copy of ${id}: ${e.message}`));
      // The id used to live under another name (a file, now a folder; or a hand-named file).
      if (existing && !themeSameEntry(existing._file, target)) await themeRemoveEntry(existing._file).catch(e => console.error(`themes: could not remove the old ${existing._file}: ${e.message}`));
    } catch (e) {
      failed = e;
    } finally {
      themeBusy--;
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    themeCache.delete(target);
    if (existing) themeCache.delete(existing._file);
    refreshThemes(true);
    if (failed) {
      console.error(`themes: could not write ${id}: ${failed.message}`);
      return { status: 500, body: { error: `The theme could not be written: ${themeQuote(failed.code || failed.message)}` } };
    }
    const rec = THEME_BY_ID.get(id);
    if (!rec) {
      // Written and then not accepted on reading back: never expected, and not left behind.
      await themeRemoveEntry(target).catch(() => {});
      themeCache.delete(target); refreshThemes(true);
      console.error(`themes: ${id} was written but could not be read back, so it was removed`);
      return { status: 500, body: { error: 'The theme was written but could not be read back, so it was removed' } };
    }
    console.log(`themes: installed ${id} (${t.form}, ${t.bytes} bytes)`);
    return { status: 200, body: { ok: true, theme: themeFull(rec), warnings: v.warnings } };
  });
}

function themeDelete(id) {
  return themeExclusive(async () => {
    refreshThemes(true);
    const rec = THEME_BY_ID.get(id);
    if (!rec) return { status: 404, body: { error: 'no such theme' } };
    themeBusy++;
    try { await themeRemoveEntry(rec._file); }
    catch (e) {
      console.error(`themes: could not delete ${id}: ${e.message}`);
      return { status: 500, body: { error: `The theme could not be deleted: ${themeQuote(e.code || e.message)}` } };
    } finally { themeBusy--; }
    themeCache.delete(rec._file);
    if (settings.defaultTheme === id) { delete settings.defaultTheme; saveSettings(); }
    refreshThemes(true);
    console.log(`themes: removed ${id}`);
    // Deleting the default theme clears it. What the default is now (nothing, or the one
    // DEFAULT_THEME names) is in the answer, so the page can update its choice without asking again.
    const d = themeDefault();
    return { status: 200, body: { ok: true, default: d.id, defaultFrom: d.from } };
  });
}

// ---- Requests ---------------------------------------------------------------------
// The body of a check or an install, parsed; or null once the caller has been answered.
async function themeRequestBody(req, res) {
  const fail = (code, msg) => { sendJson(res, code, { ok: false, problems: [msg], error: msg }); return null; };
  let text;
  try { text = await readBody(req, THEME_LIMITS.body, 60000); }
  catch (e) { return e && e.tooLarge ? fail(413, `That is more than ${THEME_LIMITS.body / 1024 / 1024} MiB, the most a theme can be sent in one go`) : fail(400, 'The request did not arrive'); }
  // What invalid UTF-8 was turned into when the body was read: no honest theme has it.
  if (text.includes('\ufffd')) return fail(400, 'The request is not valid UTF-8 text');
  const parsed = themeParseJson(text);
  if (parsed.error) return fail(400, `The request ${parsed.error}`);
  if (!themeIsObject(parsed.value)) return fail(400, 'The request must be a JSON object');
  return parsed.value;
}

// {theme} (one manifest) or {files} (a folder) -> what validateTheme takes, or {problems}.
function themeInput(body) {
  const warnings = [], problems = [];
  const warn = t => { if (warnings.length < 20) warnings.push(t); };
  const theme = themeOwn(body, 'theme'), files = themeOwn(body, 'files');
  if ((theme === undefined) === (files === undefined)) return { problems: ['Send either "theme" (one manifest object) or "files" (a folder)'] };
  if (theme !== undefined) {
    if (!themeIsObject(theme)) return { problems: ['"theme" must be the manifest, a JSON object'] };
    return { input: { form: 'file', manifest: theme, css: null, assets: null, fallbackId: null }, warnings };
  }
  if (!themeIsObject(files)) return { problems: ['"files" must be an object of file name to contents'] };
  const keys = Object.keys(files);
  if (keys.length > 100) return { problems: ['A theme folder has at most 24 files'] };
  // A path that leaves the folder, or is not one at all, is refused outright.
  const hostile = keys.find(k => k.length > 200 || /[\\\u0000-\u001f\u007f]/.test(k) || k.startsWith('/') || /^[A-Za-z]:/.test(k) || k.split('/').some(s => s === '' || s === '.' || s === '..'));
  if (hostile !== undefined) return { problems: [`"${themeQuote(hostile)}" is not a path inside the theme folder`] };
  // One folder name in front of everything (mytheme/theme.json) is what a dropped folder looks like.
  const tj = keys.filter(k => k === 'theme.json' || /^[^/]+\/theme\.json$/.test(k));
  if (tj.length !== 1) return { problems: [tj.length ? 'There is more than one theme.json' : 'There is no theme.json in the folder'] };
  const prefix = tj[0].slice(0, -'theme.json'.length);
  let manifestText = null, css = null, total = 0;
  const assets = new Map();
  for (const k of keys) {
    if (!k.startsWith(prefix)) { warn(`"${themeQuote(k)}" is outside the theme folder and was ignored`); continue; }
    const rel = k.slice(prefix.length), v = files[k], base = rel.slice(rel.lastIndexOf('/') + 1);
    if (/^\./.test(base) || /^(?:thumbs\.db|desktop\.ini)$/i.test(base)) continue;      // operating system litter
    if (typeof v !== 'string') { problems.push(`"${themeQuote(rel)}" must be text (theme.json, theme.css) or base64 (a picture or font)`); continue; }
    let m;
    if (rel === 'theme.json') manifestText = v;
    else if (rel === 'theme.css') css = v.charCodeAt(0) === 0xfeff ? v.slice(1) : v;
    else if ((m = /^assets\/([^/]+)$/.exec(rel)) && THEME_ASSET_NAME.test(m[1]) && THEME_ASSET_TYPES.has(themeExt(m[1])) && !THEME_RESERVED_FILE.test(m[1])) {
      if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(v) || v.length % 4) { problems.push(`"${themeQuote(rel)}" is not valid base64`); continue; }
      if (v.length / 4 * 3 > THEME_LIMITS.each) { problems.push(`"${themeQuote(rel)}" is larger than ${THEME_LIMITS.each / 1024 / 1024} MiB`); continue; }
      total += v.length / 4 * 3;
      if (total > THEME_LIMITS.folder) return { problems: [`A folder theme is at most ${THEME_LIMITS.folder / 1024 / 1024} MiB in all`] };
      assets.set(m[1], Buffer.from(v, 'base64'));
    } else warn(`"${themeQuote(rel)}" is not part of a theme (theme.json, theme.css, assets/<file>) and was ignored`);
  }
  if (assets.size + 1 + (css !== null ? 1 : 0) > THEME_LIMITS.files) problems.push(`A folder theme has at most ${THEME_LIMITS.files} files`);
  const parsed = typeof manifestText === 'string' ? themeParseJson(manifestText) : { error: 'is missing or is not text' };
  if (parsed.error) problems.push(`theme.json ${parsed.error}`);
  if (problems.length) return { problems };
  return { input: { form: 'folder', manifest: parsed.value, css, assets, fallbackId: prefix ? themeSlug(prefix.slice(0, -1)) : null }, warnings };
}

// GET /themes/<id>/assets/<file>: found by exact name among the files the scan listed for
// that theme, never by joining what the request said onto a path.
async function themeAsset(req, res, p) {
  const gone = () => sendJson(res, 404, { error: 'not found' });
  const m = /^\/themes\/([^/]+)\/assets\/([^/]+)$/.exec(p);
  if (!m) return gone();
  let id, file;
  try { id = decodeURIComponent(m[1]); file = decodeURIComponent(m[2]); } catch { return gone(); }
  if (!THEME_ID.test(id) || !THEME_ASSET_NAME.test(file)) return gone();
  refreshThemes();
  const t = THEME_BY_ID.get(id), a = t && t._assets ? t._assets.get(file) : null;
  if (!a) return gone();
  const full = path.join(THEMES_DIR, t._file, 'assets', a.name);
  let st, buf;
  try {
    st = await fsp.lstat(full);
    if (!st.isFile() || st.size > THEME_LIMITS.each) return gone();
    buf = await fsp.readFile(full);
  } catch { return gone(); }
  if (buf.length > THEME_LIMITS.each) return gone();
  const ext = themeExt(a.name);
  const etag = `"${buf.length.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const head = {
    'Content-Type': THEME_ASSET_TYPES.get(ext), 'X-Content-Type-Options': 'nosniff',
    // Kept, but asked about each time (the ETag answers with a 304): a picture that is replaced under
    // the same name shows at once, and behind a password it stays out of shared caches.
    'Cache-Control': (ACCESS_PASSWORD ? 'private' : 'public') + ', no-cache', 'ETag': etag, 'Accept-Ranges': 'bytes',
  };
  // Served straight from its own address, an SVG must not be able to run anything.
  if (ext === 'svg') head['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (etagMatches(req.headers['if-none-match'], etag)) { res.writeHead(304, head); return res.end(); }
  let start = 0, end = buf.length - 1, code = 200;
  const range = !req.headers['if-range'] && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = parseInt(range[1], 10); if (range[2]) end = Math.min(end, parseInt(range[2], 10)); }
    else { start = Math.max(0, buf.length - parseInt(range[2], 10)); }
    if (start >= buf.length) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
    if (start <= end) { code = 206; head['Content-Range'] = `bytes ${start}-${end}/${buf.length}`; } else { start = 0; end = buf.length - 1; }
  }
  const body = code === 206 ? buf.subarray(start, end + 1) : buf;
  res.writeHead(code, { ...head, 'Content-Length': body.length });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// Answers the theme routes; false when the request is not one of them.
async function themeRoute(req, res, p) {
  const isGet = req.method === 'GET', isRead = isGet || req.method === 'HEAD';   // sendJson leaves the body off a HEAD
  if (isRead && p === '/api/themes') {
    refreshThemes();
    const d = themeDefault();
    const tag = `W/"${LIST_BOOT}.t${themeRev}.${d.id || ''}.${d.from}.${profilesWritable ? 1 : 0}"`;
    const cache = { 'ETag': tag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
    if (etagMatches(req.headers['if-none-match'], tag)) { res.writeHead(304, cache); res.end(); return true; }
    sendJson(res, 200, {
      themes: THEME_LIST.map(themePublic), rejected: THEME_REJECTED, default: d.id, defaultFrom: d.from,
      writable: profilesWritable, max: THEME_MAX,
    }, cache);
    return true;
  }
  if (req.method === 'POST' && (p === '/api/themes/check' || p === '/api/themes')) {
    const body = await themeRequestBody(req, res);
    if (!body) return true;
    const inp = themeInput(body);
    if (inp.problems) { sendJson(res, 400, { ok: false, problems: inp.problems }); return true; }
    const v = validateTheme(inp.input);
    const warnings = [...inp.warnings, ...v.warnings].slice(0, 20);
    if (!v.theme) { sendJson(res, 400, { ok: false, problems: v.problems }); return true; }
    if (p === '/api/themes/check') {
      refreshThemes();
      if (THEME_BY_ID.has(v.theme.id)) warnings.push(`A theme with the id "${v.theme.id}" is already installed; installing this one asks before replacing it`);
      sendJson(res, 200, { ok: true, theme: v.theme, warnings });
      return true;
    }
    if (!profilesWritable) { sendJson(res, 403, { error: `The themes folder is read-only (${CONFIG_DIR} is not writable), so a theme cannot be installed for every device` }); return true; }
    const r = await themeInstall({ ...v, warnings }, themeOwn(body, 'replace') === true);
    sendJson(res, r.status, r.body);
    return true;
  }
  let m;
  // One theme in full: what the page applies (tokens, css, fonts) and the source it was
  // made from. The tag is the theme's own (its stored bytes and its pictures' times, see
  // themeLoad) behind the server's start, so it changes when this theme does and not when
  // another one does. An id that is not a possible id is a theme that is not there.
  if (isRead && (m = /^\/api\/themes\/([^/]+)$/.exec(p))) {
    let id = '';
    try { id = decodeURIComponent(m[1]); } catch {}
    refreshThemes();
    const rec = THEME_ID.test(id) ? THEME_BY_ID.get(id) : null;
    if (!rec) { sendJson(res, 404, { error: 'no such theme' }); return true; }
    const tag = `W/"${LIST_BOOT}.${rec._stamp}"`;
    const cache = { 'ETag': tag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
    if (etagMatches(req.headers['if-none-match'], tag)) { res.writeHead(304, cache); res.end(); return true; }
    sendJson(res, 200, themeFull(rec), cache);
    return true;
  }
  if (req.method === 'DELETE' && (m = /^\/api\/themes\/([^/]+)$/.exec(p))) {
    let id = '';
    try { id = decodeURIComponent(m[1]); } catch {}
    refreshThemes();
    if (!THEME_ID.test(id) || !THEME_BY_ID.has(id)) { sendJson(res, 404, { error: 'no such theme' }); return true; }
    if (!profilesWritable) { sendJson(res, 403, { error: `The themes folder is read-only (${CONFIG_DIR} is not writable), so a theme cannot be deleted` }); return true; }
    const r = await themeDelete(id);
    sendJson(res, r.status, r.body);
    return true;
  }
  if (isRead && p.startsWith('/themes/')) { await themeAsset(req, res, p); return true; }
  return false;
}

themeSweep();
refreshThemes(true);
syncDefault();

async function walk(src, dir, out, ctx = { pending: 0 }) {
  const root = src.root;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      try {
        const st = await fsp.stat(full);
        out.push({ path: path.relative(root, full).split(path.sep).join('/'), dir: true, size: 0, mtime: st.mtimeMs });
      } catch {}
      await walk(src, full, out, ctx);
    }
    else if (e.isFile() && /\.(rar|r\d\d)$/i.test(e.name)) {
      try {
        const st = await fsp.stat(full);
        const rel = path.relative(root, full).split(path.sep).join('/');
        const r = await rarPkgs(full, st, true);
        if (r.pending) ctx.pending++;
        for (const x of r.entries) out.push(withMeta(src, { path: rel + ARC + x.name, size: x.size, mtime: st.mtimeMs, inArchive: e.name }));
      } catch {}
    }
    else if (e.isFile() && (ANY_FILE || /\.pkg$/i.test(e.name))) {
      try {
        const st = await fsp.stat(full);
        if (st.size === 0) continue;
        out.push(withMeta(src, { path: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs }));
      } catch {}
    }
  }
  return out;
}

// Resolve a client-supplied relative path, refusing anything outside the library or not a .pkg.
function safeResolve(root, rel) {
  const full = path.resolve(root, rel);
  if (!underRoot(root, full)) return null;
  if (!ANY_FILE && !/\.pkg$/i.test(full)) return null;
  return full;
}

// ---- Packages inside .rar archives -------------------------------------------
// Repacked releases wrap a single .pkg in a .rar with no compression, so the
// package sits inside as one unbroken byte run. Those we can serve straight out
// of the archive: the console's range requests are shifted by the entry's
// offset, and nothing is extracted or copied. Compressed, encrypted and
// multi-part archives are skipped — there is no byte run to point at.
const ARC = '!/';                 // separates the archive path from the entry inside it
const rarCache = new Map();       // archive path -> {key, entries, note}

async function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fsp.read(fd, b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

// RAR5 stores numbers 7 bits at a time, high bit = "another byte follows".
function vint(b, p) {
  let v = 0n, s = 0n;
  for (let i = 0; i < 10; i++) {
    const c = b[p + i];
    if (c === undefined) throw new Error('truncated header');
    v |= BigInt(c & 0x7f) << s;
    if (!(c & 0x80)) return [v, p + i + 1];
    s += 7n;
  }
  throw new Error('bad number in header');
}

// A file header's extra area lists optional records; type 1 means encrypted.
function isEncrypted(buf, at, len) {
  try {
    let p = at;
    const end = at + len;
    while (p < end && p < buf.length) {
      let rs, rt;
      [rs, p] = vint(buf, p);
      const next = p + Number(rs);
      [rt, p] = vint(buf, p);
      if (rt === 1n) return true;
      p = next;
    }
  } catch {}
  return false;
}

const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

async function scanRar4(fd, size) {
  const entries = [];
  let pos = 7, note = null, volume = false, guard = 0;
  while (pos < size && guard++ < 50000) {
    const buf = await readAt(fd, pos, 4096);
    if (buf.length < 11) break;
    const type = buf[2];
    const flags = buf.readUInt16LE(3);
    const hsize = buf.readUInt16LE(5);
    if (hsize < 7) break;
    let add = (flags & 0x8000) ? buf.readUInt32LE(7) : 0;

    if (type === 0x73) {                                   // main archive header
      if (flags & 0x0001) volume = true;
    } else if (type === 0x74) {                            // file header
      if (buf.length < 40) break;
      const large = !!(flags & 0x0100);
      const packLo = buf.readUInt32LE(7), unpLo = buf.readUInt32LE(11);
      const method = buf[25];
      const nameSize = buf.readUInt16LE(26);
      let np = 32, packHi = 0, unpHi = 0;
      if (large) { packHi = buf.readUInt32LE(32); unpHi = buf.readUInt32LE(36); np = 40; }
      const packed = packHi * 4294967296 + packLo;
      const unpacked = unpHi * 4294967296 + unpLo;
      // Unicode names keep an ASCII fallback before a NUL; that one is enough.
      // A RAR4 archive packed on Windows stores its paths with backslashes, not
      // forward slashes — real unrar/unar already convert that to the local
      // separator on extraction, so every downstream name match in this file
      // (dump detection, package matching, everything that joins or compares
      // paths) needs the same normalization at the one place names are read,
      // rather than re-normalizing in each regex that touches a name.
      const name = buf.subarray(np, np + nameSize).toString('utf8').split('\0')[0].replace(/\\/g, '/');
      const isDir = (flags & 0xE0) === 0xE0;
      const encrypted = !!(flags & 0x0004);
      const split = !!(flags & 0x0003);                    // continues in another volume
      if (!isDir) {
        entries.push({ name, offset: pos + hsize, size: unpacked, chunk: packed, stored: method === 0x30, whole: packed === unpacked, encrypted, split });
      }
      add = packed;
    }
    pos += hsize + add;
  }
  return { entries, note, volume };
}

async function scanRar(full) {
  const fd = await fsp.open(full, 'r');
  try {
    const size = (await fd.stat()).size;
    const sig = await readAt(fd, 0, 8);
    if (sig.length < 8) return { entries: [], note: 'too small to be an archive' };
    if (sig.subarray(0, 7).equals(RAR4_SIG)) return await scanRar4(fd, size);
    if (!sig.equals(RAR5_SIG)) return { entries: [], note: 'not a RAR archive' };

    const entries = [];
    let pos = 8n, note = null, volume = false, guard = 0;
    while (pos < BigInt(size) && guard++ < 50000) {
      const buf = await readAt(fd, Number(pos), 4096);
      if (buf.length < 16) break;
      let p = 4;                                   // header CRC32
      let hs, ht, hf, extra = 0n, data = 0n;
      [hs, p] = vint(buf, p);
      const hStart = BigInt(p);
      [ht, p] = vint(buf, p);
      [hf, p] = vint(buf, p);
      if (hf & 0x1n) [extra, p] = vint(buf, p);
      if (hf & 0x2n) [data, p] = vint(buf, p);

      if (ht === 1n) {                             // main archive header
        let af; [af, p] = vint(buf, p);
        volume = !!(af & 0x1n);
      } else if (ht === 2n) {                      // file header
        let ff, unp, attr, comp, os, nlen;
        [ff, p] = vint(buf, p);
        [unp, p] = vint(buf, p);
        [attr, p] = vint(buf, p);
        if (ff & 0x2n) p += 4;                     // mtime
        if (ff & 0x4n) p += 4;                     // CRC32
        [comp, p] = vint(buf, p);
        [os, p] = vint(buf, p);
        [nlen, p] = vint(buf, p);
        const name = buf.subarray(p, p + Number(nlen)).toString('utf8');
        const isDir = !!(ff & 0x1n);
        const stored = Number((comp >> 7n) & 0x7n) === 0;
        const whole = unp === data;
        const enc = extra > 0n && isEncrypted(buf, Number(hStart + hs - extra), Number(extra));
        const split = !!(hf & 0x18n);            // continues from/into another volume
        if (!isDir) {
          entries.push({ name, offset: Number(pos + hStart + hs), size: Number(unp), chunk: Number(data), stored, whole, encrypted: enc, split });
        }
      } else if (ht === 5n) break;                 // end of archive
      pos = pos + hStart + hs + data;
    }
    return { entries, note, volume };
  } finally { await fd.close(); }
}

// A package split across volumes is still one unbroken byte run, just spread
// over several files: part01 holds the first chunk, part02 the next, and so on.
// Those chunks can be served in order, so a split release needs no more work
// than a single archive — as long as every volume is present.
const PART_RE = /^(.*)\.part(\d+)\.rar$/i;      // RAR5 style: name.part01.rar
const OLD_PART_RE = /^(.*)\.r(\d{2})$/i;         // RAR4 style: name.rar + name.r00

// A volume that isn't the first one: it belongs to a set and isn't listed alone.
function isLaterVolume(file) {
  const base = path.basename(file);
  const m = PART_RE.exec(base);
  if (m) return parseInt(m[2], 10) !== 1;
  return OLD_PART_RE.test(base);
}

// Every volume of the set this file starts, in order, or null if it isn't a set.
function volumesFor(full) {
  const dir = path.dirname(full), base = path.basename(full);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }

  const m = PART_RE.exec(base);
  if (m) {
    const stem = m[1], width = m[2].length;
    const out = [];
    for (let n = 1; ; n++) {
      const guess = `${stem}.part${String(n).padStart(width, '0')}.rar`;
      const hit = names.find(x => x.toLowerCase() === guess.toLowerCase());
      if (!hit) break;
      out.push(path.join(dir, hit));
    }
    return out.length > 1 ? out : null;
  }

  if (/\.rar$/i.test(base)) {
    // name.rar + name.r00, r01, … r99 — then the classic scheme rolls the
    // LETTER over rather than the digits: r99 is followed by s00, s01, … s99,
    // then t00, and so on. A set past 100 volumes (real, for a large dump
    // split small) was silently cut off here at r99, undercounting every
    // later volume's bytes — this walks the same a/b/c letters real RAR
    // tools use instead of assuming "r" forever.
    const stem = base.replace(/\.rar$/i, '');
    const out = [full];
    for (let i = 0; ; i++) {
      const letter = String.fromCharCode('r'.charCodeAt(0) + Math.floor(i / 100));
      const guess = `${stem}.${letter}${String(i % 100).padStart(2, '0')}`;
      const hit = names.find(x => x.toLowerCase() === guess.toLowerCase());
      if (!hit) break;
      out.push(path.join(dir, hit));
    }
    return out.length > 1 ? out : null;
  }
  return null;
}

// Scan a whole set and stitch each package's chunks together in volume order.
async function scanVolumeSet(volumes) {
  const byName = new Map();
  let note = null;
  for (const vol of volumes) {
    let r;
    try { r = await scanRar(vol); } catch (e) { note = e.message; break; }
    if (r.note) { note = r.note; break; }
    for (const e of r.entries) {
      if (!/\.pkg$/i.test(e.name)) continue;
      let acc = byName.get(e.name);
      if (!acc) {
        acc = { name: e.name, size: e.size, stored: true, encrypted: false, segments: [] };
        byName.set(e.name, acc);
      }
      if (!e.stored) acc.stored = false;
      if (e.encrypted) acc.encrypted = true;
      acc.segments.push({ path: vol, offset: e.offset, length: e.chunk });
    }
  }
  const entries = [], blocked = [];
  for (const e of byName.values()) {
    const have = e.segments.reduce((n, x) => n + x.length, 0);
    if (note) blocked.push({ name: e.name, size: e.size, reason: note });
    else if (e.encrypted) blocked.push({ name: e.name, size: e.size, reason: 'password protected' });
    else if (!e.stored) blocked.push({ name: e.name, size: e.size, reason: 'compressed' });
    else if (have !== e.size) blocked.push({ name: e.name, size: e.size, reason: `incomplete set (${fmtGb(have)} of ${fmtGb(e.size)} present)` });
    else entries.push({ name: e.name, size: e.size, segments: e.segments });
  }
  return { entries, blocked, parts: volumes.length };
}

const fmtGb = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';
const fmtSize = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? Math.round(n / 1048576) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

// Cached by size+mtime so a folder listing doesn't re-read every archive.
// Reading an archive's index costs a disk seek or three, which is nothing for one
// folder and about twenty minutes across a library of a thousand. So results are
// kept on disk and reused, and anything not yet known is looked at in the
// background rather than making a search wait for it.
const INDEX_FILE = path.join(CONFIG_DIR, 'archives.json');
let indexDirty = false, indexTimer = null;

function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j.archives || {})) rarCache.set(k, v);
    if (rarCache.size) console.log(`archive index: ${rarCache.size} archive(s) remembered from ${INDEX_FILE}`);
  } catch {}
}

function saveIndexNow() {
  if (!indexDirty) return;
  indexDirty = false;
  saveAtomic(INDEX_FILE, () => mapJson('{"archives":{', rarCache, '}}'), 'the archive index');
}

function saveIndexSoon() {
  indexDirty = true;
  if (indexTimer) return;
  indexTimer = setTimeout(() => { indexTimer = null; saveIndexNow(); }, 5000);
  indexTimer.unref?.();
}
onShutdown(saveIndexNow);

// Archives waiting for a first look, worked through one at a time.
const scanQueue = [];
const scanQueued = new Set();
let scanRunning = false;

function queueScan(full) {
  if (scanQueued.has(full)) return;
  scanQueued.add(full);
  scanQueue.push(full);
  if (!scanRunning) { scanRunning = true; setTimeout(scanStep, 200); }
}

async function scanStep() {
  const full = scanQueue.shift();
  if (!full) {
    scanRunning = false;
    saveIndexNow();
    // The lists were built while these archives were still unknown, so rebuild
    // them now that their packages can be listed.
    for (const src of SOURCES) buildList(src, true);
    console.log(`archive index: caught up, ${rarCache.size} archive(s) known`);
    return;
  }
  scanQueued.delete(full);
  try {
    const st = await fsp.stat(full);
    await rarPkgs(full, st);                       // fills and persists the cache
  } catch {}
  setTimeout(scanStep, 20);                  // leave the disk some room
}

// Identity of a volume set: every volume's name, size and timestamp, so a part
// that lands later (or grows) invalidates the scan.
function setKeyFor(volumes) {
  let key = '';
  for (const v of volumes) {
    try { const vs = fs.statSync(v); key += `${path.basename(v)}|${vs.size}|${vs.mtimeMs};`; }
    catch { key += `${path.basename(v)}|missing;`; }
  }
  return key;
}

async function rarPkgs(full, st, cachedOnly) {
  // Later volumes belong to the set their first volume represents.
  if (isLaterVolume(full)) {
    const val = { key: `${st.size}|${st.mtimeMs}`, note: null, entries: [], blocked: [], part: true };
    rarCache.set(full, val);
    return val;
  }

  const volumes = volumesFor(full);
  const key = volumes ? setKeyFor(volumes) : `${st.size}|${st.mtimeMs}`;
  const hit = rarCache.get(full);
  if (hit && hit.key === key) return hit;

  // A search should not stall behind a thousand unread archives.
  if (cachedOnly) {
    queueScan(full);
    return { key, note: null, entries: [], blocked: [], pending: true };
  }

  if (volumes) {
    const set = await scanVolumeSet(volumes);
    const val = { key, note: null, entries: set.entries, blocked: set.blocked, parts: set.parts };
    rarCache.set(full, val);
    saveIndexSoon();
    return val;
  }

  let r;
  try { r = await scanRar(full); } catch (e) { r = { entries: [], note: e.message }; }
  const pkgs = r.entries.filter(e => /\.pkg$/i.test(e.name));
  const entries = r.note ? [] : pkgs.filter(e => e.stored && e.whole && !e.encrypted && !e.split);
  const blocked = pkgs.filter(e => !entries.includes(e)).map(e => ({
    name: e.name, size: e.size,
    reason: r.note ? r.note.replace(', not supported yet', '') : e.encrypted ? 'password protected' : e.split ? 'split across volumes' : 'compressed',
  }));
  const val = { key, note: r.note, entries, blocked };
  rarCache.set(full, val);
  saveIndexSoon();
  return val;
}

// Where a request's bytes actually live: a file, or a byte run inside an archive.
async function resolveTarget(src, rel) {
  const i = rel.indexOf(ARC);
  if (i < 0) {
    const full = safeResolve(src.root, rel);
    if (!full) return { error: 'forbidden' };
    let st;
    try { st = await fsp.stat(full); } catch { return { error: 'not found' }; }
    if (!st.isFile()) return { error: 'not found' };
    return { full, base: 0, size: st.size, mtime: st.mtime };
  }
  const arcRel = rel.slice(0, i), inner = rel.slice(i + ARC.length);
  const full = path.resolve(src.root, arcRel);
  if (!underRoot(src.root, full)) return { error: 'forbidden' };
  if (!/\.rar$/i.test(full)) return { error: 'forbidden' };
  let st;
  try { st = await fsp.stat(full); } catch { return { error: 'not found' }; }
  if (!st.isFile()) return { error: 'not found' };
  const e = (await rarPkgs(full, st)).entries.find(x => x.name === inner);
  if (!e) return { error: 'not found' };
  if (e.segments) return { segments: e.segments, size: e.size, mtime: st.mtime };
  return { full, base: e.offset, size: e.size, mtime: st.mtime };
}

// Which file on disk a listed path really is, for telling one file listed twice
// (libraries that overlap) from two files that are copies. A package inside an
// archive is identified by its archive plus its own name. Null when that cannot
// be told, and null is never taken to mean "the same".
function identityPath(src, rel) {
  const i = rel.indexOf(ARC);
  const full = path.resolve(src.root, i < 0 ? rel : rel.slice(0, i));
  return !underRoot(src.root, full) ? null : { full, tail: i < 0 ? '' : rel.slice(i) };
}
async function fileIdentity(src, rel) {
  const at = identityPath(src, rel);
  if (!at) return null;
  try {
    const st = await fsp.stat(at.full, { bigint: true });
    return st.ino ? `${st.dev}:${st.ino}${at.tail}` : null;
  } catch { return null; }
}
function fileIdentitySync(src, rel) {
  const at = identityPath(src, rel);
  if (!at) return null;
  try {
    const st = fs.statSync(at.full, { bigint: true });
    return st.ino ? `${st.dev}:${st.ino}${at.tail}` : null;
  } catch { return null; }
}

// ---- What a package says about itself (param.sfo) ----------------------------
// Most of the library is named things like "NBA 2K16_1.pkg", which says nothing
// about what the package is: a base game, an update, or a piece of DLC for
// something else entirely. Every .pkg carries that in a param.sfo entry in its
// own table — title, content id, version and kind. Reading it is three small
// reads, and they go through the same runs the file is served from, so a
// package inside a stored archive is read in place without extracting it.

// A package's header says which console it was built for, and that decides how
// much can be read: only a PS4 package carries a param.sfo in the clear. A PS3
// package keeps its content id in the header and nothing else. A PS5 package's
// actual files (param.json included) are encrypted, but its content id is not
// — the console has to identify an install before it can decrypt anything, so
// the outer \x7FFIH image embeds a small, unencrypted \x7FCNT metadata
// container carrying it. See PS5_CNT_OFFSET_FIELD below for where that lives.
const PLATFORMS = { 0x7f434e54: 'PS4', 0x7f504b47: 'PS3', 0x7f464948: 'PS5' };
const SFO_ENTRY = 0x1000;         // param.sfo's id in a PS4 package's entry table
const SFO_MAGIC = 0x00505346;     // "\0PSF"
// PS5 outer-image layout, credited to LibProsperoPkg (SvenGDK,
// https://github.com/SvenGDK/LibProsperoPKG, GPL-3.0) — its PKG/ProsperoPkgReader.cs
// and ProsperoPkgLayout is where these offsets came from; verified here against a
// real package before use (byte-identical content id, MD5-checked against the
// filename's own claim).
const PS5_FIH_MAGIC = 0x7f464948;      // "\x7FFIH", same value PLATFORMS keys on
const PS5_CNT_MAGIC = 0x7f434e54;      // "\x7FCNT", the embedded metadata container
const PS5_CNT_OFFSET_FIELD = 0x58;     // in the FIH header: little-endian u64
const PS5_CNT_HEADER_SIZE = 0x5a0;     // the fixed-field region; the entry table lives
                                        // wherever PS5_ENTRY_TABLE_OFFSET_FIELD points, often past this
const PS5_CONTENT_ID_OFFSET = 0x40;    // within the CNT header
const PS5_CONTENT_ID_SIZE = 0x30;
// The rest of the CNT header, for the Info panel — not read on every routine
// scan, only on demand, since the entry table and name table need reads of
// their own wherever their offsets happen to point.
const PS5_FIH_SIGNED_BYTE_FIELD = 0x05;      // u8: 0x80 official, 0x00 debug/fake-signed
const PS5_FIH_FORMAT_VERSION_FIELD = 0x06;   // little-endian u16
const PS5_FIH_PFS_IMAGE_SIZE_FIELD = 0x18;   // little-endian u64: encrypted body size
const PS5_ENTRY_COUNT_FIELD = 0x10;          // in the CNT header: big-endian u32
const PS5_ENTRY_TABLE_OFFSET_FIELD = 0x18;   // in the CNT header: big-endian u32
const PS5_DRM_TYPE_FIELD = 0x70;             // big-endian u32
const PS5_CONTENT_TYPE_FIELD = 0x74;         // big-endian u32
const PS5_CONTENT_FLAGS_FIELD = 0x78;        // big-endian u32
const PS5_ENTRY_SIZE = 0x20;                 // one entry-table record
const PS5_ENTRY_NAMES_ID = 0x00000200;       // the entry whose data IS the name table
const PS5_ENTRY_ENCRYPTED_FLAG = 0x80000000; // in an entry's Flags1

// The bytes of a package as a list of runs, so a plain file, a run inside an
// archive and a run split across volumes are all read the same way.
function segmentsOf(t) {
  return t.segments || [{ path: t.full, offset: t.base || 0, length: t.size }];
}

// Read len bytes at `start` within the package itself, not within the file that
// happens to hold it. Same offset arithmetic as segmentStream, collected rather
// than piped.
async function readPkgRange(t, start, len) {
  const end = Math.min(start + len, t.size) - 1;
  if (end < start) return Buffer.alloc(0);
  const parts = [];
  let at = 0;
  for (const seg of segmentsOf(t)) {
    const segStart = at, segEnd = at + seg.length - 1;
    at += seg.length;
    if (segEnd < start || segStart > end) continue;
    const from = seg.offset + Math.max(start, segStart) - segStart;
    const to = seg.offset + Math.min(end, segEnd) - segStart;
    const fh = await fsp.open(seg.path, 'r');
    try {
      const b = Buffer.alloc(to - from + 1);
      let got = 0;
      while (got < b.length) {                  // a read can come back short
        const { bytesRead } = await fh.read(b, got, b.length - got, from + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      parts.push(b.subarray(0, got));
    } finally { await fh.close(); }
  }
  return Buffer.concat(parts);
}

// param.sfo is a key table, a data table, and an index tying the two together.
function parseSfo(b) {
  if (b.length < 20 || b.readUInt32BE(0) !== SFO_MAGIC) return null;
  const keys = b.readUInt32LE(8), data = b.readUInt32LE(12), count = b.readUInt32LE(16);
  if (!count || count > 1024 || keys > b.length || data > b.length) return null;
  const out = {};
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 16;
    if (at + 16 > keys) break;                  // the index runs up to the key table
    const keyAt = keys + b.readUInt16LE(at), fmt = b.readUInt16LE(at + 2);
    const len = b.readUInt32LE(at + 4), valueAt = data + b.readUInt32LE(at + 12);
    if (keyAt >= b.length || valueAt + len > b.length) continue;
    let end = keyAt;
    while (end < b.length && b[end]) end++;
    out[b.toString('utf8', keyAt, end)] = fmt === 0x0404
      ? b.readUInt32LE(valueAt)
      : b.toString('utf8', valueAt, valueAt + len).replace(/\0[\s\S]*$/, '');
  }
  return Object.keys(out).length ? out : null;
}

// Header, entry table, then param.sfo itself: three reads however big the
// package is. The other consoles' formats stop at the first read.
async function readPackage(t) {
  const head = await readPkgRange(t, 0, 4096);
  if (head.length < 0x54) return { bad: 'not a package' };
  const platform = PLATFORMS[head.readUInt32BE(0)];
  if (!platform) return { bad: 'not a package' };
  if (platform === 'PS3') {
    let end = 0x30;                             // content id, then padding to 0x54
    while (end < 0x54 && head[end]) end++;
    return { platform, contentId: head.toString('utf8', 0x30, end) };
  }
  if (platform === 'PS5') {
    // signedByte: 0x80 = officially signed, 0x00 = debug/fake-signed. Every
    // scene release seen here has been the latter — this whole ecosystem is
    // jailbreak-oriented fake-signed images, never Sony-signed retail ones —
    // but an unrecognised value is treated as unreadable rather than guessed at.
    if (head[5] !== 0x00 && head[5] !== 0x80) return { platform, bad: 'unrecognised PS5 image type' };
    const cnt = await readPs5Cnt(t);
    if (!cnt || !cnt.contentId) return { platform, bad: 'damaged header' };
    const result = { platform, contentId: cnt.contentId, ps5: cnt };
    // param.json turned out to carry the real title in the clear — checked
    // against a real package before relying on it (see readPs5Cnt's own
    // note). Everything else about the game stays encrypted; this one file
    // just happens not to be.
    const paramEntry = cnt.entries.find(e => e.name === 'param.json' && !e.encrypted);
    if (paramEntry && cnt.cntOffset + paramEntry.dataOffset + paramEntry.dataSize <= t.size) {
      try {
        const raw = await readPkgRange(t, cnt.cntOffset + paramEntry.dataOffset, paramEntry.dataSize);
        result.param = JSON.parse(raw.toString('utf8'));
      } catch { /* a malformed param.json still leaves the content id usable */ }
    }
    return result;
  }

  const count = head.readUInt32BE(0x10), tableAt = head.readUInt32BE(0x18);
  if (!count || count > 8192 || tableAt + count * 32 > t.size) return { platform, bad: 'damaged header' };
  const table = await readPkgRange(t, tableAt, count * 32);
  let e = null;
  for (let i = 0; i + 32 <= table.length; i += 32) {
    if (table.readUInt32BE(i) !== SFO_ENTRY) continue;
    e = { flags: table.readUInt32BE(i + 8), offset: table.readUInt32BE(i + 0x10), size: table.readUInt32BE(i + 0x14) };
    break;
  }
  if (!e) return { platform, bad: 'no param.sfo' };
  if (!e.size || e.size > 1 << 20 || e.offset + e.size > t.size) return { platform, bad: 'damaged param.sfo' };
  const sfo = parseSfo(await readPkgRange(t, e.offset, e.size));
  if (sfo) return { platform, sfo };
  // Parsing is tried before the flag is consulted, since the flag on its own is
  // not a reliable way to tell an encrypted entry from one this misreads.
  return { platform, bad: (e.flags & 0x80000000) ? 'param.sfo is encrypted' : 'unreadable param.sfo' };
}

// ---- Before telling a console to fetch a file --------------------------------
// SCE_NP_DRM_CONTENT_ERROR_HEADERFORMAT is what a console reports for a package
// that is not actually whole yet — a magic it does not recognise, or a tail
// that never got written. Two more range reads catch that before it ever
// leaves here, rather than after the console has spent minutes on a file that
// was never going to mount.
async function badTail(t) {
  const len = Math.min(4096, t.size);
  const tail = await readPkgRange(t, t.size - len, len);
  return tail.length < len || tail.every(b => b === 0);
}

// A file mid-write (still downloading into the library, or being extracted
// into) has no fixed size or mtime yet — the same instability nameGuess
// already treats as "not settled", just checked once, deliberately, right
// before a send rather than inferred from repeated listings over time.
async function stillWriting(t) {
  const paths = [...new Set(segmentsOf(t).map(s => s.path))];
  const before = await Promise.all(paths.map(p => fsp.stat(p).catch(() => null)));
  await sleep(700);
  const after = await Promise.all(paths.map(p => fsp.stat(p).catch(() => null)));
  return before.some((b, i) => {
    const a = after[i];
    if (!b || !a) return true;             // vanished or newly appeared — not stable either way
    return b.size !== a.size || b.mtimeMs !== a.mtimeMs;
  });
}

// null when the file looks safe to send; otherwise a short, specific reason
// to show instead of ever contacting the console.
async function preflightCheck(t) {
  if (t.size < 0x100) return 'the file is too small to be a real package';
  // A .pkg whose header magic isn't one of the three recognised is still sent —
  // the console's installer decides whether it can use it. Platform is detected
  // separately (left null here) for the driver check in attemptInstall.
  if (await stillWriting(t)) return 'the file is still being written — wait for it to finish';
  // No zero-tail check here: a legitimately zero-padded package (re-signed, backported)
  // reads the same as a truncated one, and the console reports its own error if the
  // file is genuinely incomplete. stillWriting catches the actively-writing case.
  return null;
}

// The CNT header, entry table and resolved names, at whatever offset the
// container actually starts — for the Info panel and cover art, on demand,
// not the routine scan (the entry table lives wherever entryTableOffset
// points to, often well past the fixed header region, so this costs reads
// of its own). Everything read here came back unencrypted on every real
// package this was checked against (one PS4, one PS5), icon0.png included —
// only the license/DRM entries had the encrypted bit (0x80000000 in Flags1)
// set. A PS4 package's own outer container IS this format, at offset 0 —
// same magic, same entry layout — a PS5 package wraps one inside its FIH
// image at a dynamic offset readPs5Cnt resolves first.
async function readCntEntries(t, baseOffset) {
  const head = await readPkgRange(t, baseOffset, PS5_CNT_HEADER_SIZE);
  if (head.length < PS5_CNT_HEADER_SIZE || head.readUInt32BE(0) !== PS5_CNT_MAGIC) return null;

  const entryCount = head.readUInt32BE(PS5_ENTRY_COUNT_FIELD);
  const entryTableOffset = head.readUInt32BE(PS5_ENTRY_TABLE_OFFSET_FIELD);
  if (!entryCount || entryCount > 4096) return null;

  let idEnd = PS5_CONTENT_ID_OFFSET;
  while (idEnd < PS5_CONTENT_ID_OFFSET + PS5_CONTENT_ID_SIZE && head[idEnd]) idEnd++;
  const contentId = head.toString('ascii', PS5_CONTENT_ID_OFFSET, idEnd);
  const drmType = head.readUInt32BE(PS5_DRM_TYPE_FIELD);
  const contentType = head.readUInt32BE(PS5_CONTENT_TYPE_FIELD);
  const contentFlags = head.readUInt32BE(PS5_CONTENT_FLAGS_FIELD);

  if (baseOffset + entryTableOffset + entryCount * PS5_ENTRY_SIZE > t.size) return null;
  const table = await readPkgRange(t, baseOffset + entryTableOffset, entryCount * PS5_ENTRY_SIZE);
  if (table.length < entryCount * PS5_ENTRY_SIZE) return null;

  const entries = [];
  let namesEntry = null;
  for (let i = 0; i < entryCount; i++) {
    const o = i * PS5_ENTRY_SIZE;
    const e = {
      rawId: table.readUInt32BE(o), nameOffset: table.readUInt32BE(o + 4),
      flags1: table.readUInt32BE(o + 8), flags2: table.readUInt32BE(o + 0xc),
      dataOffset: table.readUInt32BE(o + 0x10), dataSize: table.readUInt32BE(o + 0x14),
    };
    if (e.rawId === PS5_ENTRY_NAMES_ID) namesEntry = e;
    entries.push(e);
  }

  // The name table is itself the data of the ENTRY_NAMES entry: one block of
  // NUL-terminated strings, each entry pointing at where its own name starts.
  let names = null;
  if (namesEntry && namesEntry.dataSize && namesEntry.dataSize < (1 << 20)
      && baseOffset + namesEntry.dataOffset + namesEntry.dataSize <= t.size) {
    names = await readPkgRange(t, baseOffset + namesEntry.dataOffset, namesEntry.dataSize);
  }
  const nameAt = off => {
    if (!names || !off || off >= names.length) return null;
    let e = off;
    while (e < names.length && names[e]) e++;
    return names.toString('ascii', off, e) || null;
  };
  for (const e of entries) {
    e.name = nameAt(e.nameOffset);
    e.encrypted = !!(e.flags1 & PS5_ENTRY_ENCRYPTED_FLAG);
    e.keyIndex = (e.flags2 >> 12) & 0xf;
  }

  return { baseOffset, contentId, drmType, contentType, contentFlags, entries };
}

// The FIH wrapper's own fields, plus its embedded CNT container resolved
// through readCntEntries.
async function readPs5Cnt(t) {
  const fih = await readPkgRange(t, 0, 0x60);
  if (fih.length < 0x60 || fih.readUInt32BE(0) !== PS5_FIH_MAGIC) return null;
  const signedByte = fih[PS5_FIH_SIGNED_BYTE_FIELD];
  const formatVersion = fih.readUInt16LE(PS5_FIH_FORMAT_VERSION_FIELD);
  const pfsImageSize = Number(fih.readBigUInt64LE(PS5_FIH_PFS_IMAGE_SIZE_FIELD));
  const cntOffset = Number(fih.readBigUInt64LE(PS5_CNT_OFFSET_FIELD));
  if (!Number.isSafeInteger(cntOffset) || cntOffset <= 0 || cntOffset + PS5_CNT_HEADER_SIZE > t.size) return null;
  const cnt = await readCntEntries(t, cntOffset);
  if (!cnt) return null;
  return { signedByte, formatVersion, pfsImageSize, cntOffset: cnt.baseOffset, ...cnt };
}

// A PS4 package needs no FIH resolving — it is a CNT container from byte 0.
async function readPs4Cnt(t) {
  return readCntEntries(t, 0);
}

// Whichever of the two applies, so /api/icon and /api/info don't each need
// to know the platform difference themselves.
async function readCntFor(t) {
  const magic = await readPkgRange(t, 0, 4);
  if (magic.length < 4) return null;
  const m = magic.readUInt32BE(0);
  if (m === PS5_FIH_MAGIC) return readPs5Cnt(t);
  if (m === PS5_CNT_MAGIC) return readPs4Cnt(t);   // PS4's own magic is the same value
  return null;
}

// The region letter that opens a content id, e.g. UP0002-CUSA13795_00-...
const REGIONS = { U: 'US', E: 'EU', J: 'JP', H: 'Asia', K: 'KR', I: 'Int' };
// Only the codes actually seen are named; anything else is shown as it comes,
// which is better than guessing a label for it.
const CATEGORIES = { gd: 'game', gp: 'patch', ac: 'DLC' };
// None of these end on a word boundary. What follows an id is usually "_" —
// "CUSA06302_00", "PLACEHOLDER00000_1" — and \b does not match before one, so
// asking for a boundary there quietly rejects the commonest names of all.
//
// Every console's title id is four letters and five digits: CUSA13795 on PS4,
// PPSA01325 on PS5, NPUB30009 or BCUS98254 on PS3.
const TITLE_ID = /[A-Z]{4}\d{5}/;
// A full content id, for the many releases that are named after one. The tail
// is always sixteen characters, so matching exactly sixteen is right even when
// the name runs straight on.
const CONTENT_ID = /\b[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}/;
// A title id on its own in a file name. Only the two prefixes a console this
// app talks to can use, since a file name is not a content id and four letters
// followed by five digits turns up in release names by accident.
const NAME_TITLE_ID = /\b(?:CUSA|PPSA)\d{5}/;
// A backport re-signs the package, so the header magic can't be read — but the
// title id in the name still says which console it is: PPSA… is PS5, CUSA… PS4.
function platformFromName(name) {
  const m = NAME_TITLE_ID.exec(String(name || '').toUpperCase());
  if (!m) return null;
  return m[0].startsWith('PPSA') ? 'PS5' : 'PS4';
}

// Firmware versions are packed as hex digits: 0x09508000 is 9.50.
function firmwareOf(v) {
  if (typeof v !== 'number' || !v) return null;
  const h = v.toString(16).padStart(8, '0');
  if (!/^[0-9]{8}$/.test(h) || +h.slice(0, 2) < 1) return null;      // not a version: a chip saying "needs 0.00" or "NaN.ff" helps no one
  return `${parseInt(h.slice(0, 2), 10)}.${h.slice(2, 4)}`;
}

// A PS5 param.json packs a firmware into a 16-digit hex string, version first:
// "0x1001000000000000" is 10.01, "0x0900000000000000" is 9.00. Anything after
// the first two bytes is not a version, and a value that is not that shape is
// left alone rather than guessed at.
function firmwareOfParam(v) {
  const m = typeof v === 'string' && /^0x([0-9]{4})[0-9a-f]{12}$/i.exec(v);
  if (!m) return null;
  const major = parseInt(m[1].slice(0, 2), 10);
  return major >= 1 ? `${major}.${m[1].slice(2)}` : null;
}

// A package localises its title per language, and an Asian release's default
// TITLE is often one nobody reading this can use. An English entry wins when
// there is one; otherwise the most Latin-looking one does.
function pickTitle(sfo) {
  const latin = s => (String(s).match(/[A-Za-z]/g) || []).length / (String(s).length || 1);
  for (const k of ['TITLE_01', 'TITLE_18']) if (sfo[k]) return sfo[k];
  let best = sfo.TITLE || '';
  if (latin(best) >= 0.4) return best;
  for (const [k, v] of Object.entries(sfo)) {
    if (/^TITLE_\d\d$/.test(k) && v && latin(v) > latin(best)) best = v;
  }
  return best;
}

// param.json localises its title the same way an SFO does, just as JSON:
// localizedParameters[defaultLanguage].titleName. Checked against a real
// package before trusting it — see readPs5Cnt's own note on that.
function ps5Title(param) {
  const lp = param.localizedParameters;
  if (!lp) return null;
  const lang = lp.defaultLanguage;
  const pick = (lang && lp[lang]) || lp['en-US'] || Object.values(lp).find(v => v && typeof v === 'object' && v.titleName);
  return pick && typeof pick.titleName === 'string' ? pick.titleName.trim() : null;
}

// param.json's own equivalent of metaFromSfo — read straight from the
// package, not looked up anywhere, so it is trusted the same way an SFO is.
function metaFromParam(param) {
  return {
    title: ps5Title(param) || null,
    titleId: typeof param.titleId === 'string' ? param.titleId : null,
    contentId: typeof param.contentId === 'string' ? param.contentId : null,
    // contentVersion is the game as it stands — an update, or a dump of a patched
    // game, moves it — while masterVersion stays at the original build's "01.00".
    // The console reports the former, so that is what is shown.
    version: param.contentVersion || param.masterVersion || null,
    // Two numbers, and the second is usually higher. sdkVersion is the firmware
    // the game was built against, which is what a scene release's "9xx" / "5xx"
    // tag names and what a jailbroken console needs to run it; the
    // requiredSystemSoftwareVersion is what Sony's own installer insists on (a
    // "3xx" game can ask for 7.40). The chip shows the first, the second is
    // kept for its tooltip.
    firmware: firmwareOfParam(param.sdkVersion) || firmwareOfParam(param.requiredSystemSoftwareVersion),
    firmwareRequired: firmwareOfParam(param.requiredSystemSoftwareVersion),
    titleFrom: 'header',
  };
}

// The handful of fields worth keeping out of the thirty-odd in a param.sfo.
function metaFromSfo(sfo) {
  const category = typeof sfo.CATEGORY === 'string' ? sfo.CATEGORY : '';
  return {
    title: pickTitle(sfo) || null,
    titleId: typeof sfo.TITLE_ID === 'string' ? sfo.TITLE_ID : null,
    contentId: typeof sfo.CONTENT_ID === 'string' ? sfo.CONTENT_ID : null,
    category: category || null,
    kind: CATEGORIES[category] || category || null,
    version: sfo.APP_VER || sfo.VERSION || null,
    firmware: firmwareOf(sfo.SYSTEM_VER),
  };
}

// A PS5 package has no CATEGORY to say what it is, so its kind comes from the
// content type in its CNT header. The mapping is read off real packages, not
// taken from any document: 94 of them, off the owner's library and USB
// stick (headers only, nothing written).
//   0x21  DLC   all 57 add-on packs, whoever built them, and none of
//               them has an applicationCategoryType in its param.json
//   0x20  game  all 37 others: a full game, the small stub some
//               releases ship in a game's place, or a homebrew app. All carry
//               applicationCategoryType 0.
// No PS5 update package turned up, so no value is known to mean "patch" and none
// is called that. A PS4 update shares its game's content type and only its
// CATEGORY tells them apart, so a PS5 update may well read as a game until one
// can be looked at. A value not in this table, or a 0x20 whose param.json cannot
// be read to check, stays without a kind: unknown is better than a wrong label.
function ps5KindOf(cnt, param) {
  if (!cnt) return null;
  if (cnt.contentType === 0x21) return 'DLC';
  if (cnt.contentType === 0x20 && param && param.applicationCategoryType === 0) return 'game';
  return null;
}

// What to remember about a package. Where param.sfo could not be read, a
// release named after its content id still gives away which game it belongs to
// — but that came from the name, not the package, so it says so.
function metaOf(r, rel) {
  const m = r.sfo ? metaFromSfo(r.sfo) : r.param ? metaFromParam(r.param) : {};
  m.platform = r.platform || platformFromName(rel);
  if (r.ps5) { const k = ps5KindOf(r.ps5, r.param); if (k) m.kind = k; }
  if (!m.contentId && r.contentId) { m.contentId = r.contentId; m.idFrom = 'header'; }
  if (!m.contentId) {
    const c = CONTENT_ID.exec(rel.split('/').pop().toUpperCase());
    if (c) { m.contentId = c[0]; m.idFrom = 'name'; }
  }
  if (!m.titleId && m.contentId) {
    const t = TITLE_ID.exec(m.contentId);
    if (t) m.titleId = t[0];
  }
  if (!m.titleId) {
    // Not every release is named after a full content id, but most still carry
    // the title id: "Pacific Drive v01.007.004 PPSA10965.pkg".
    const t = NAME_TITLE_ID.exec(rel.split('/').pop().toUpperCase());
    if (t) { m.titleId = t[0]; m.idFrom = m.idFrom || 'name'; }
  }
  m.region = m.contentId ? REGIONS[m.contentId[0]] || null : null;
  m.note = r.bad || null;
  for (const k of Object.keys(m)) if (m[k] === null) delete m[k];
  return m;
}

// Remembered on disk the same way archive indexes are, and for the same reason:
// three reads is nothing for one folder and the best part of an hour across a
// library of thousands. A package is re-read only if its size or timestamp
// changes, and a package that could not be read is remembered as such so it is
// not tried again on every listing.
const META_FILE = path.join(CONFIG_DIR, 'packages.json');
const metaCache = new Map();      // "<library id>\n<path>" -> {k, meta} or {k, bad}
let metaDirty = false, metaTimer = null;

// A counter that goes up whenever what GET /api/list would say changes: the
// list is rebuilt, or a package's details are read, renamed or dropped. With a
// start-up stamp in front it is the list's ETag, so the page asking again every
// few seconds while indexing runs is answered "unchanged" for a few bytes rather
// than the whole library again. Anything that changes a list entry has to bump it.
let listRev = 0;
const LIST_BOOT = Date.now().toString(36);

// Bump when what is stored for a package changes meaning. Entries written under
// an older schema that the change affects are dropped on load, so they are read
// again, while everything else is kept — re-reading a whole library is an hour.
//   2: a PS5 package's version is its contentVersion (was masterVersion)
//   3: a PS5 package has a kind (game or DLC), from its content type. Only PS5
//      entries that came out without one are read again.
//   4: a PS5 package has a firmware, from its param.json. Only entries whose
//      param.json was readable (their title came from the header) can gain one,
//      so only those are read again; the rest could not have it.
const META_SCHEMA = 4;

function loadMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const schema = j.schema || 1;
    const older = schema < META_SCHEMA;
    let dropped = 0;
    for (const [k, v] of Object.entries(j.packages || {})) {
      // From schema 2 on a PS5 entry is only stale for lack of a kind, so one that
      // has a kind stays. An entry that still has none after being read again is
      // written back under the new schema and is not asked again.
      if (older && v && v.meta && v.meta.platform === 'PS5' && (schema < 2 || !v.meta.kind || (schema < 4 && v.meta.titleFrom === 'header'))) { dropped++; continue; }
      metaCache.set(k, v);
    }
    if (metaCache.size) console.log(`package details: ${metaCache.size} package(s) remembered from ${META_FILE}`);
    if (older) {
      if (dropped) console.log(`package details: ${dropped} PS5 package(s) will be read again for their kind and firmware`);
      saveMetaSoon();                 // write the file back under the new schema
    }
  } catch {}
}

function saveMetaNow() {
  if (!metaDirty) return;
  metaDirty = false;
  saveAtomic(META_FILE, () => mapJson(`{"schema":${META_SCHEMA},"packages":{`, metaCache, '}}'), 'the package details');
}

// Longer than the archive index waits. There are several times more packages
// than archives, the first pass over a large library runs for the best part of
// an hour, and every save rewrites the whole file — so saving every few seconds
// would spend the run writing the same megabytes over and over. Losing the last
// half-minute to a crash costs a few dozen reads.
function saveMetaSoon() {
  metaDirty = true;
  if (metaTimer) return;
  metaTimer = setTimeout(() => { metaTimer = null; saveMetaNow(); }, 30000);
  metaTimer.unref?.();
}
onShutdown(saveMetaNow);

// Packages waiting for a first read. Unlike the archive scanner, this is real
// async I/O (readPkgRange goes through fsp.open/.read, not a sync call), so
// several can be outstanding at once without blocking the event loop — worth
// doing, since round-trip latency to the SMB-mounted share, not disk
// throughput, is what a single-file-at-a-time queue was actually waiting on.
// A handful in flight rather than one: this is someone else's SMB server too,
// not just local CPU, and courtesy matters the same way it does for the
// PROSPEROPatches queue, just at a different scale.
const metaQueue = [], metaQueued = new Set();
const META_CONCURRENCY = 4;
let metaWorkers = 0, metaDone = 0;

function queueMeta(job) {
  if (metaQueued.has(job.id)) return;
  metaQueued.add(job.id);
  metaQueue.push(job);
  if (metaWorkers < META_CONCURRENCY) { metaWorkers++; setTimeout(metaStep, 500); }
}

async function metaStep() {
  // Archives come first. They want the same disks, and a folder cannot even
  // name the packages inside an archive until its index has been read.
  if (scanQueue.length) { setTimeout(metaStep, 2000).unref?.(); return; }
  const job = metaQueue.shift();
  if (!job) {
    // Only the worker that empties the queue reports it — with several
    // running, the others would otherwise each find it empty in turn and
    // print the same line several times over.
    if (--metaWorkers === 0) {
      saveMetaNow();
      // No rebuild here: reading a title does not change which files exist, and
      // the list picks the details up as it goes out. Walking the whole library
      // again would cost a minute to change nothing.
      console.log(`package details: caught up, ${metaCache.size} package(s) known`);
    }
    return;
  }
  metaQueued.delete(job.id);
  try {
    const t = await resolveTarget(job.src, job.rel);
    // Even a file that turns out not to be a package is remembered with the
    // reason, and one named after its content id still says which game it is.
    // Only a read that threw is written off, so a disk hiccup is not recorded
    // as a fact about the file.
    if (t.error) metaCache.set(job.id, { k: job.k, bad: t.error });
    else {
      const meta = metaOf(await readPackage(t), job.rel);
      metaCache.set(job.id, { k: job.k, meta });
      enrichTitle(job.id, meta);
    }
  } catch (e) {
    metaCache.set(job.id, { k: job.k, bad: e.message });
  }
  listRev++;
  saveMetaSoon();
  if (++metaDone % 500 === 0) console.log(`package details: ${metaDone} read, ${metaQueue.length} to go`);
  setTimeout(metaStep, 20).unref?.();          // leave the disk some room
}

// What is known about a package, queueing a read when it is not known yet.
// Size and timestamp are part of the key, so a file still being written is
// re-read once it settles.
function pkgMeta(src, rel, size, mtime) {
  const id = `${src.id}\n${rel}`;
  const k = `${size}|${mtime}`;
  const v = metaCache.get(id);
  if (v && v.k === k) return v.meta || null;
  queueMeta({ src, rel, id, k });
  return null;
}

// A guess at what to call a package before its own bytes can be trusted —
// from the file and folder names alone, which are known the moment a listing
// sees the file at all, unlike param.sfo which pkgMeta refuses to read from a
// file still being written (its size and mtime never settle). Computed fresh
// on every listing rather than cached: it is cheap, and real meta from a
// finished read always wins once it exists.
function nameGuess(rel) {
  const parts = rel.split('/');
  const file = parts[parts.length - 1].replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const upper = file.toUpperCase();
  const cid = CONTENT_ID.exec(upper);
  const titleId = (cid && TITLE_ID.exec(cid[0])?.[0]) || (NAME_TITLE_ID.exec(upper) || [])[0] || null;
  const out = {};
  if (titleId) out.titleId = titleId;
  if (parts.length >= 2) {
    // A payload named after its content id has nothing readable left once the
    // id is stripped out — that is when the folder it sits in, usually the
    // actual release name, is worth showing instead of the file's own name.
    const stripped = upper.replace(cid ? cid[0] : '', '').replace(NAME_TITLE_ID, '').replace(/[^A-Z]+/g, '');
    if (stripped.length < 3) out.title = parts[parts.length - 2];
  }
  return Object.keys(out).length ? out : null;
}

// A guessed PPSA id can still ask PROSPEROPatches for the real name without
// waiting for a confirmed byte read — the id came from the file name, which
// does not change while a transfer is in progress, so it is no less reliable
// mid-download than once finished. Upgrades the guess in place if the answer
// is already known, and queues it if not. titleCache and queueTitle are
// defined further down, in the PS5 titles section; both exist by the time
// this runs, since nothing calls it until a request comes in.
function enrichGuess(guess) {
  if (PROSPEROPATCHES_DORMANT) return guess;
  if (!guess.titleId || !guess.titleId.startsWith('PPSA')) return guess;
  const known = titleCache.get(guess.titleId);
  if (known && known.name) guess.title = known.name;
  queueTitle(guess.titleId);   // no-ops on its own if already known and not due a recheck
  return guess;
}

// What a download, send or history entry should call itself — the same
// question a folder listing answers, just asked for one specific file rather
// than everything in view. Whatever was last read for it wins regardless of
// how stale the cache key is: a title does not go wrong by being a little
// old, and a transfer in progress will never itself have a settled key to
// match against. Falls back to a guess off the name when nothing was ever
// read at all.
function fileMeta(srcId, rel) {
  const cached = metaCache.get(`${srcId}\n${rel}`);
  if (cached && cached.meta) return cached.meta;
  const guess = nameGuess(rel);
  return guess ? { ...enrichGuess(guess), tentative: true } : null;
}

// Attach those details to a listing entry, if they have been read yet, or a
// name guess if not — better than a bare content-id filename while a package
// is still downloading or just hasn't reached the front of the read queue.
function withMeta(src, item) {
  const m = pkgMeta(src, item.path, item.size, item.mtime);
  if (m) { item.meta = m; return item; }
  const guess = nameGuess(item.path);
  if (guess) item.meta = { ...enrichGuess(guess), tentative: true };
  return item;
}

// The search list is walked once and then reused for ten minutes, while titles
// carry on arriving behind it — so they are attached as the list goes out, not
// when it was walked. Baking them in at walk time means a library keeps every
// row untitled until the very last package has been read, and searching by
// title finds nothing at all until then. Untouched entries are passed through
// rather than copied, so a list with nothing new costs nothing.
function listWithMeta(src, files) {
  return files.map(f => {
    if (f.dir) return f;
    const m = pkgMeta(src, f.path, f.size, f.mtime);
    if (m) return { ...f, meta: m };
    const guess = nameGuess(f.path);
    return guess ? { ...f, meta: { ...enrichGuess(guess), tentative: true } } : f;
  });
}

// ---- PS5 titles --------------------------------------------------------------
// readPackage gets a real content id out of every PS5 package now, but not a
// title — the game's own files, param.json included, stay encrypted, so a
// PPSA release still has no name of its own to show. PROSPEROPatches.com
// renders a plain page per title id with the game's name in <title>, no API
// key or JS challenge required, so a background queue fills in what the
// package can't say. A title id maps to one game for good, so it is only
// ever looked up once.
// Dormant, not removed — flip back to false once the header-read content id
// has had a clean run on its own. Nothing downstream needs to change either
// way: queueTitle just never queues anything while this is true.
const PROSPEROPATCHES_DORMANT = true;
const TITLE_FILE = path.join(CONFIG_DIR, 'titles.json');
const titleCache = new Map();     // title id -> { name: string|null, at: when checked }
let titleDirty = false, titleTimer = null;
// A found title never changes and is kept for good; a miss might just mean
// the site hasn't catalogued it yet, so it is allowed to be asked again after
// a while rather than written off forever the first time.
const TITLE_RECHECK_MS = 30 * 24 * 3600 * 1000;
const titleFresh = known => !!known && (known.name || Date.now() - known.at < TITLE_RECHECK_MS);

function loadTitles() {
  try {
    const j = JSON.parse(fs.readFileSync(TITLE_FILE, 'utf8'));
    // Older files stored a bare name (or null) per id; wrapped with an age of
    // zero so a miss from before this existed is immediately due a recheck,
    // same as any other stale one, rather than treated as freshly confirmed.
    for (const [k, v] of Object.entries(j.titles || {})) titleCache.set(k, v && typeof v === 'object' ? v : { name: v, at: 0 });
    if (titleCache.size) console.log(`PS5 titles: ${titleCache.size} remembered from ${TITLE_FILE}`);
  } catch {}
}

function saveTitlesNow() {
  if (!titleDirty) return;
  titleDirty = false;
  saveAtomic(TITLE_FILE, () => mapJson('{"titles":{', titleCache, '}}'), 'PS5 titles');
}

function saveTitlesSoon() {
  titleDirty = true;
  if (titleTimer) return;
  titleTimer = setTimeout(() => { titleTimer = null; saveTitlesNow(); }, 5000);
  titleTimer.unref?.();
}
onShutdown(saveTitlesNow);

// One request in flight at a time, spaced out — this is someone else's site,
// not local disk. A found id never queues again; a missed one only queues
// again once titleFresh says its recheck window has passed.
const titleQueue = [], titleQueued = new Set();
let titleRunning = false, titleDone = 0;   // titleDone resets on restart, same as metaDone
// Packages already read that were waiting on an id when it was queued, so the
// answer can be backfilled without waiting for the file to change and be
// re-scanned.
const titleWaiters = new Map();   // title id -> Set of metaCache keys
// A network hiccup or the site itself being down is not the same fact as "this
// id is not in their database" — the first should be tried again, the second
// should not. Retried a handful of times before being left alone, so one id
// that keeps failing (a firewall, a ban) cannot spin forever.
const titleFailures = new Map();  // title id -> attempts so far
const TITLE_MAX_ATTEMPTS = 5;
// Last few lookups, newest first, for the bar's own dialog to show — not
// persisted, this run's activity only.
const titleHistory = [];

// Requests are already spaced 1.5s+ apart, so keep-alive saves a handshake
// rather than any real contention, but it is the same TLS session doing it
// every time — no reason to pay for a new one each round.
const titleAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function fetchTitleName(id) {
  return new Promise(resolve => {
    const req = https.request({
      host: 'prosperopatches.com', path: '/' + id, method: 'GET', timeout: 8000, agent: titleAgent,
      headers: { 'User-Agent': 'ShadowPKG (private library tool)' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: `HTTP ${res.statusCode}` }); return; }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 1 << 16) req.destroy(); });
      res.on('end', () => {
        const m = /<title>\s*([^<]*?)\s*<\/title>/i.exec(data);
        const t = m && m[1];
        if (!t) { resolve({ ok: false, reason: 'no title in the response' }); return; }
        // Unknown ids land on the site's own home page, titled after the site
        // itself rather than a game — a real answer, just a negative one.
        if (/^PROSPEROPatches\.com/i.test(t)) { resolve({ ok: true, name: null }); return; }
        const name = t.replace(new RegExp(`^${id}:\\s*`), '')
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
          .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').trim();
        resolve({ ok: true, name: name || null });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', e => resolve({ ok: false, reason: e.message || 'network error' }));
    req.end();
  });
}

function queueTitle(id) {
  if (PROSPEROPATCHES_DORMANT) return;
  if (titleQueued.has(id) || titleFresh(titleCache.get(id))) return;
  titleQueued.add(id);
  titleQueue.push(id);
  if (!titleRunning) { titleRunning = true; setTimeout(titleStep, 1000).unref?.(); }
}

function recordTitleHistory(entry) {
  titleHistory.unshift({ at: Date.now(), ...entry });
  titleHistory.length = Math.min(titleHistory.length, 30);
}

async function titleStep() {
  const id = titleQueue.shift();
  if (!id) {
    titleRunning = false;
    saveTitlesNow();
    return;
  }
  titleQueued.delete(id);
  let r;
  try { r = await fetchTitleName(id); } catch (e) { r = { ok: false, reason: e.message }; }

  if (!r.ok) {
    const attempts = (titleFailures.get(id) || 0) + 1;
    if (attempts < TITLE_MAX_ATTEMPTS) {
      titleFailures.set(id, attempts);
      recordTitleHistory({ id, status: 'retry', reason: r.reason, attempts });
      // Not the disk-scan queue, so a slower retry does not compete with it —
      // a site that is genuinely down needs minutes, not milliseconds, to recover.
      titleQueued.add(id);
      setTimeout(() => {
        titleQueued.delete(id);
        titleQueue.push(id);
        // The main loop stops itself once the queue runs dry, which it will
        // if this retry is the only thing left outstanding — restart it.
        if (!titleRunning) { titleRunning = true; titleStep(); }
      }, 30000).unref?.();
      setTimeout(titleStep, 1500).unref?.();
      return;
    }
    // Given up, not given an answer — left out of titleCache on purpose, so a
    // later restart (or a manual retry) can still try again from scratch.
    recordTitleHistory({ id, status: 'gave up', reason: r.reason, attempts });
    titleFailures.delete(id);
    setTimeout(titleStep, 1500).unref?.();
    return;
  }

  titleFailures.delete(id);
  titleCache.set(id, { name: r.name, at: Date.now() });
  titleDone++;
  saveTitlesSoon();
  recordTitleHistory({ id, status: r.name ? 'found' : 'not found', name: r.name });
  const waiters = titleWaiters.get(id);
  titleWaiters.delete(id);
  if (r.name && waiters) {
    for (const key of waiters) {
      const entry = metaCache.get(key);
      if (entry && entry.meta && !entry.meta.title) {
        entry.meta.title = r.name;
        entry.meta.titleFrom = 'prosperopatches';
      }
    }
    listRev++;
    saveMetaSoon();
  }
  setTimeout(titleStep, 1500).unref?.();   // one site, be a good citizen
}

// Called once a package's own meta is known. Only PS5 needs this: PS4 and PS3
// packages can read (or already fall back to) a title of their own.
function enrichTitle(metaKey, meta) {
  if (PROSPEROPATCHES_DORMANT) return;
  if (!meta || meta.title || meta.platform !== 'PS5' || !meta.titleId) return;
  const known = titleCache.get(meta.titleId);
  if (known && known.name) { meta.title = known.name; meta.titleFrom = 'prosperopatches'; return; }
  if (titleFresh(known)) return;   // a recent, still-standing miss — nothing to wait on
  if (!titleWaiters.has(meta.titleId)) titleWaiters.set(meta.titleId, new Set());
  titleWaiters.get(meta.titleId).add(metaKey);
  queueTitle(meta.titleId);
}

// Same containment check for folders (no .pkg requirement).
function safeDir(root, rel) {
  const full = path.resolve(root, rel || '');
  if (!underRoot(root, full)) return null;
  return full;
}

// ---- Game dumps --------------------------------------------------------------
// A dump is a game as its own files rather than a package: a folder whose
// sce_sys/param.json says what it is. A console cannot be sent one, but it can
// be repacked into a .pkg, and most of what can go wrong with that is visible
// from here. Detection is one small read per folder; the full check walks the
// whole tree and is run on request.
const DUMP_CONTENT_ID = /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/;
const dumpCache = new Map();     // "<dir>|<mtime>|<size>" -> summary

async function readParamJson(dir) {
  const file = path.join(dir, 'sce_sys', 'param.json');
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (!st.isFile()) return null;
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (dumpCache.has(key)) return dumpCache.get(key);
  let out;
  try {
    if (st.size > 1 << 20) throw new Error('param.json is unreasonably large');
    const raw = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    const param = JSON.parse(raw);
    if (!param || typeof param !== 'object' || Array.isArray(param)) throw new Error('param.json is not a JSON object');
    out = { param };
  } catch (e) { out = { error: e.message }; }
  if (dumpCache.size > 2000) dumpCache.clear();
  dumpCache.set(key, out);
  return out;
}

async function dumpSummary(dir) {
  const r = await readParamJson(dir);
  if (!r) return null;
  if (r.error) return { error: r.error };
  const m = metaFromParam(r.param);
  const out = {};
  for (const k of ['title', 'titleId', 'contentId', 'version', 'firmware', 'firmwareRequired']) if (m[k]) out[k] = m[k];
  return out;
}

// What the repack kit refuses, and what it quietly changes, worked out ahead of
// time from a dump on disk. Mirrors create-gp5-from-folder.py's own rules.
const DUMP_STANDARD_LIMIT = 162_514_599_936;
const DUMP_LV1_LIMIT = 195_878_191_104;
const DUMP_LV2_LIMIT = 260_436_918_272;
const DUMP_LV3_LIMIT = 343_597_383_680;   // 320 GiB — SDK 3.13 level 3 (kernel.appSizeInGib cap)
const DUMP_LV2_FILES = 500_000;
const DUMP_WALK_CAP = 3_000_000;
const dumpChecks = new Map();    // "<library>|<dir>" -> {state, startedAt, endedAt, files, bytes, checks, notes}

function pngColorType(head) {
  if (head.length < 26 || head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a
      || head.readUInt32BE(8) !== 13 || head.toString('ascii', 12, 16) !== 'IHDR' || head[24] !== 8) return null;
  return head[25];
}

async function runDumpCheck(job, dir) {
  const checks = job.checks;
  const add = (level, text) => checks.push({ level, text });

  // param.json: identity and the fields the kit insists on.
  const pr = await readParamJson(dir);
  let mountLevel = 0;
  if (!pr) add('error', 'sce_sys/param.json is missing.');
  else if (pr.error) add('error', `sce_sys/param.json cannot be read: ${pr.error}.`);
  else {
    const p = pr.param;
    if (typeof p.contentId !== 'string' || !DUMP_CONTENT_ID.test(p.contentId)) add('error', `param.json has no valid content ID (${JSON.stringify(p.contentId)}), which the kit requires.`);
    else add('ok', `Content ID ${p.contentId}.`);
    if (p.applicationCategoryType !== 0) add('error', `param.json applicationCategoryType is ${JSON.stringify(p.applicationCategoryType)}; the kit only builds native games (0).`);
    if (p.kernel !== undefined && (typeof p.kernel !== 'object' || p.kernel === null || Array.isArray(p.kernel))) add('error', 'param.json "kernel" is not an object.');
    else {
      const lv = p.kernel ? p.kernel.addcontMountLevel : undefined;
      if (lv === undefined) mountLevel = 0;
      else if (Number.isInteger(lv) && lv >= 0 && lv <= 2) mountLevel = lv;
      else add('error', `param.json kernel.addcontMountLevel is ${JSON.stringify(lv)}; the kit accepts 0, 1 or 2.`);
    }
  }

  // The container builder reads the dump in place, mapped to Wine as a Z:
  // path — a Windows path (and so Wine) cannot have <>:"|?*\ in a name, even
  // though Linux is fine with all of them. A dump folder named for how the
  // release actually reads ("Game: Subtitle") would pass every check above
  // and then fail only once a build is actually attempted (resolveUnder in
  // tools/container/runner.js still rejects it — the dump is one of the two
  // paths that reach Wine, so that rule was not relaxed there). Caught here
  // instead, before an hour is spent finding out.
  const BAD_PATH_CHARS = /[<>:"|?*\\\x00-\x1f]/;
  const dumpBase = path.basename(dir);
  if (BAD_PATH_CHARS.test(dumpBase)) {
    const found = [...new Set(dumpBase.match(new RegExp(BAD_PATH_CHARS, 'g')))].join(' ');
    add('error', `This folder's own name has a character (${found}) a Windows path can't have — and the repack kit reads the dump under Wine, which maps it to one. Rename the folder without it before building.`);
  }

  // The keystone the kit packs is the dump's own, and must be exactly 96 bytes.
  try {
    const ks = await fsp.stat(path.join(dir, 'sce_sys', 'keystone'));
    if (!ks.isFile() || ks.size !== 96) add('error', `sce_sys/keystone is ${ks.size} bytes; the kit needs exactly 96.`);
    else add('ok', 'sce_sys/keystone is 96 bytes.');
  } catch { add('error', 'sce_sys/keystone is missing; the kit needs the dump\'s own 96-byte keystone.'); }

  // Presentation images: icon0/pic0/pic1 must be 8-bit RGB, pic2 8-bit RGBA.
  // A wrong one is rebuilt from its .dds, which is the one place the kit runs
  // its extra converter program; with no .dds to rebuild from it stops.
  try {
    const sys = await fsp.readdir(path.join(dir, 'sce_sys'));
    const lower = new Set(sys.map(n => n.toLowerCase()));
    const ddsSeen = sys.filter(n => /\.dds$/i.test(n));
    let needsDds = 0;
    for (const n of sys) {
      const stem = n.replace(/\.png$/i, '');
      if (stem === n) continue;
      const want = /^(?:icon0|pic0|pic1)(?:_\d\d)?$/i.test(stem) ? 2 : /^pic2(?:_\d\d)?$/i.test(stem) ? 6 : null;
      if (!want) continue;
      let head = Buffer.alloc(0);
      try { const fh = await fsp.open(path.join(dir, 'sce_sys', n), 'r'); try { head = Buffer.alloc(26); const { bytesRead } = await fh.read(head, 0, 26, 0); head = head.subarray(0, bytesRead); } finally { await fh.close(); } } catch {}
      if (pngColorType(head) === want) continue;
      if (lower.has(stem.toLowerCase() + '.dds')) needsDds++;
      else add('error', `sce_sys/${n} is not the ${want === 2 ? '8-bit RGB' : '8-bit RGBA'} PNG the kit needs, and there is no ${stem}.dds to rebuild it from.`);
    }
    if (needsDds) add('warn', `${needsDds} presentation image(s) will be rebuilt from their .dds by the kit's own converter (prospero-dds2png.exe, an unsigned community build).`);
    else if (ddsSeen.length) add('ok', 'Presentation images are the right colour mode.');
  } catch { /* no sce_sys folder — already reported above */ }

  // The whole tree: how big, how many files, and anything the kit would trip on
  // or quietly pack into the game.
  let files = 0, bytes = 0, symlink = null, stray = [], hidden = [], dlcFolders = [], truncated = false;
  const walkDir = async (d, rel) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    const jobs = [];
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { symlink = symlink || r; continue; }
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && !(rel === '' && e.name === '.gp5-assets')) { hidden.push(r); continue; }
        jobs.push(async () => {
          // A folder that directly holds a .pkg is a separate bundled
          // package in its own right — most commonly a DLC or unlocker
          // shipped alongside the main game's loose files — and is left
          // alone entirely: not walked into, not counted, not flagged, not
          // packed into the game. A bare .pkg with no folder of its own
          // (checked below) is still flagged — that shape is usually
          // leftover build debris, not a deliberately bundled package.
          let sub;
          try { sub = await fsp.readdir(path.join(d, e.name)); } catch { sub = []; }
          if (sub.some(n => /\.pkg$/i.test(n))) { dlcFolders.push(r); return; }
          await walkDir(path.join(d, e.name), r);
        });
      } else if (e.isFile()) {
        if (/\.pkg$/i.test(e.name)) stray.push(r);
        jobs.push(async () => {
          try {
            const st = await fsp.stat(path.join(d, e.name));
            bytes += st.size; files++;   // added after the await, not `bytes += (await …)`, which would read bytes first and drop concurrent additions
          } catch {}
        });
      }
      if (files > DUMP_WALK_CAP) { truncated = true; break; }
    }
    for (let i = 0; i < jobs.length && !truncated; i += 16) {
      await Promise.all(jobs.slice(i, i + 16).map(f => f()));
      job.files = files; job.bytes = bytes;
    }
  };
  await walkDir(dir, '');
  job.files = files; job.bytes = bytes;

  if (truncated) add('warn', `Stopped counting at ${DUMP_WALK_CAP.toLocaleString()} files; the totals below are partial.`);
  if (symlink) add('error', `The dump contains a symbolic link (${symlink}); the kit refuses any.`);
  if (dlcFolders.length) add('ok', `${dlcFolders.length} folder${dlcFolders.length === 1 ? '' : 's'} holding a separate package (a DLC, an unlocker) left alone, not part of the game: ${dlcFolders.slice(0, 3).join(', ')}${dlcFolders.length > 3 ? ', …' : ''}.`);
  if (stray.length) add('error', `${stray.length} .pkg file(s) sit loose inside the dump, not in a folder of their own (${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ', …' : ''}); the kit would pack them into the game.`);
  if (hidden.length) add('warn', `${hidden.length} hidden folder(s) inside the dump (${hidden.slice(0, 3).join(', ')}${hidden.length > 3 ? ', …' : ''}); the kit packs them too. Leftovers from an earlier extraction or build belong outside it.`);
  if (!symlink && !stray.length && !hidden.length && !dlcFolders.length) add('ok', 'No symbolic links, stray packages or hidden folders.');

  // The kit picks a package size class from the unpacked size; a build that
  // will not fit its largest class is worth knowing about before it runs.
  const allowance = Math.max(512 * 1048576, Math.ceil(bytes / 100)) + files * 4096;
  const estimated = bytes + allowance;
  job.estimated = estimated;
  const gib = n => (n / 1073741824).toFixed(1) + ' GiB';
  if (estimated > DUMP_LV3_LIMIT) add('warn', `About ${gib(estimated)} once packed, above the largest size class the kit knows (${gib(DUMP_LV3_LIMIT)}); the SDK makes the final call after compression.`);
  else if (estimated > DUMP_LV2_LIMIT) add('ok', `About ${gib(estimated)} packed: the kit will use its largest size class (lv3).`);
  else if (estimated > DUMP_LV1_LIMIT) add(files > DUMP_LV2_FILES ? 'error' : 'ok', files > DUMP_LV2_FILES ? `About ${gib(estimated)} needs the lv2 size class, which allows at most ${DUMP_LV2_FILES.toLocaleString()} files; this has ${files.toLocaleString()}.` : `About ${gib(estimated)} packed: the kit will use the lv2 size class.`);
  else if (estimated > DUMP_STANDARD_LIMIT) add('ok', `About ${gib(estimated)} packed: the kit will use a large-package class (lv1).`);
  else add('ok', `About ${gib(estimated)} packed.`);
  if (mountLevel && estimated > 97_945_387_008) add('warn', `addcontMountLevel ${mountLevel} will be lowered by the kit because the package is too big for it; a change to how the game mounts its DLC.`);

  // Room for the result: it lands next to the dump, and is somewhere between
  // roughly half and all of the dump's size.
  try {
    if (fsp.statfs) {
      const s = await fsp.statfs(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      job.free = free;
      if (free < bytes) add('warn', `${gib(free)} free where the package will be written; it can need up to about ${gib(bytes)}.`);
      else add('ok', `${gib(free)} free where the package will be written.`);
    }
  } catch { /* not every filesystem answers */ }

  job.notes = [
    'The repack changes a few things in the game: its DRM type is set to "standard", its size class is recalculated, every PlayGo chunk is marked initial, and a few language files are added. The source folder is never touched.',
  ];
}

// ---- Build jobs --------------------------------------------------------------
// ShadowPKG never runs the repack tool. A build is a job folder written beside
// the dump — <dump's parent>/.shadowpkg-build/<id>/ — which a small script on
// a Windows PC (tools/windows) picks up, runs the tool on, and reports back
// through the same folder: state.json, build.log, and the package itself. The
// folder is hidden, so nothing half-built is ever listed or sent.
const BUILDS_FILE = path.join(CONFIG_DIR, 'builds.json');
const BUILD_STALL_MS = 3 * 60 * 1000;
const BUILD_AUTO_CANCEL_MS = 30 * 60 * 1000;
let builds = [];                 // {id, src, jobRel, dumpRel, outputDirRel, contentId, title, createdAt, recorded}

function loadBuilds() {
  try {
    const j = JSON.parse(fs.readFileSync(BUILDS_FILE, 'utf8'));
    if (Array.isArray(j.builds)) builds = j.builds.filter(b => b && /^[0-9a-f]{12}$/.test(b.id));
  } catch {}
}
function saveBuilds() {
  if (!profilesWritable) return;
  saveAtomic(BUILDS_FILE, () => JSON.stringify({ builds }), 'build jobs');
}
loadBuilds();

// A dump pulled out of an archive onto SCRATCH_LIBRARY is built and its package
// moved back; the dump itself is then removed from scratch, so nothing beside
// the archive is left for dumpAccountingFor to compare with, and "delete the
// archive?" could never be offered. What is remembered instead: that the dump's
// entries were checked against the archive's listing when they came out, and
// that the package built from it was delivered beside the archive. Kept on disk
// (a build takes an hour, a restart can fall in it), keyed by the archive.
// reviewArchive uses it only while that package is still there.
const DUMPBUILT_FILE = path.join(CONFIG_DIR, 'dumpbuilds.json');
let dumpBuilt = {};       // "library id\narchive path" -> [{root, package, at}]
try { const j = JSON.parse(fs.readFileSync(DUMPBUILT_FILE, 'utf8')); if (j && j.records && typeof j.records === 'object') dumpBuilt = j.records; } catch {}
function recordDumpBuilt(srcId, archiveRel, root, pkg) {
  const key = srcId + '\n' + archiveRel;
  dumpBuilt[key] = (dumpBuilt[key] || []).filter(r => r.root !== root).concat({ root, package: pkg, at: Date.now() });
  if (profilesWritable) saveAtomic(DUMPBUILT_FILE, () => JSON.stringify({ records: dumpBuilt }), 'built-dump records');
}
// The names inside the archive that a recorded, delivered build accounts for.
async function builtAccounting(srcId, archiveRel, dir, list) {
  const out = new Set();
  for (const r of dumpBuilt[srcId + '\n' + archiveRel] || []) {
    try { if (!(await fsp.stat(path.join(dir, r.package))).isFile()) continue; } catch { continue; }
    const prefix = r.root ? r.root + '/' : '';
    for (const f of list.files) if (!prefix || f.name.startsWith(prefix)) out.add(f.name);
  }
  return out;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function buildDir(b) {
  const src = findSource(b.src);
  return src ? safeDir(src.root, b.jobRel) : null;
}

// "stalled" (readBuildState, 3 minutes with no heartbeat) only labels a build
// for the UI; nothing acts on it, so a real hang (Wine crashed or deadlocked)
// could sit that way for a day with no one watching. This asks the builder to
// stop it exactly the way a person clicking Cancel would — the same cancel
// file — once it has gone quiet for BUILD_AUTO_CANCEL_MS rather than 3
// minutes: the heartbeat fires every 15s regardless of how much progress it
// made, so real silence this long is never just a slow phase. b.autoCancelled
// marks it so the eventual "cancelled" state explains why (see buildView)
// instead of reading as if someone chose to stop it.
function checkStalledBuilds() {
  const now = Date.now();
  for (const b of builds) {
    if (b.final || b.autoCancelled) continue;
    const { dir, state, updatedAt } = readBuildState(b);
    if (state !== 'stalled' || !updatedAt || now - updatedAt < BUILD_AUTO_CANCEL_MS || !dir) continue;
    const f = path.join(dir, 'cancel');
    if (fs.existsSync(f)) continue;      // already asked to stop, by a person or by this before
    try {
      fs.writeFileSync(f, new Date().toISOString());
      try { fs.chmodSync(f, 0o666); } catch {}
      b.autoCancelled = { afterMs: now - updatedAt };
      saveBuilds();
      console.log(`build ${b.id}: no word from the builder for ${Math.round((now - updatedAt) / 60000)} min, asking it to stop`);
    } catch (e) { console.error(`build ${b.id}: could not auto-cancel a stalled build: ${e.message}`); }
  }
}
setInterval(checkStalledBuilds, 60000).unref();

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

// Whether a builder is running for a library, and whether it can build yet. The
// builder writes a small status file at the library's root every few seconds;
// one that has gone quiet means no builder is running, whatever it once said.
function builderStatus(src) {
  const f = readJsonFile(path.join(src.root, '.shadowpkg-builder.json'));
  if (!f || typeof f.updated !== 'string') return { seen: false };
  const age = Date.now() - Date.parse(f.updated);
  return {
    seen: true, online: age < 90000, ageSeconds: Math.round(age / 1000), kind: f.kind || null, host: f.host || null,
    ready: !!f.ready, busy: f.busy || null, problems: Array.isArray(f.problems) ? f.problems.slice(0, 6) : [],
    version: Number.isFinite(f.version) ? f.version : null,
    dlc: f.dlc === true,      // this builder can rebuild a DLC for another region (a job of kind "dlc")
    // What the builder checked about itself (kit, Wine, approval, disk, network), passed through as plain strings.
    checks: Array.isArray(f.checks) ? f.checks.slice(0, 20).map(c => ({
      id: String(c.id || '').slice(0, 40), label: String(c.label || '').slice(0, 80), ok: c.ok === true ? true : c.ok === false ? false : null,
      detail: String(c.detail || '').slice(0, 300), fix: String(c.fix || '').slice(0, 300),
    })) : [],
  };
}

// The builder to report on the page as a whole: any library's, preferring one
// that is running now. Null when none has ever been seen, which is most installs.
function builderOverall() {
  let best = null;
  for (const s of SOURCES) {
    const b = builderStatus(s);
    if (b.seen && (!best || (b.online && !best.online) || (b.online === best.online && b.ageSeconds < best.ageSeconds))) best = { ...b, library: s.label };
  }
  return best;
}
const buildSamples = new Map();   // job id -> {t, w}: the last look at bytes written
const buildSpeed = new Map();     // job id -> bytes per second between the last two looks

// What a job looks like right now, worked out from what is in its folder.
// Where a build stands, from its state.json alone: no size to add up, no speed, no log. What
// a check that only needs to know whether a build is live asks for (buildView also measures
// a running build's work folder, which for a big one is minutes of walking on this thread).
// state is waiting, running, stalled (running, but not heard from for a while), done, failed,
// cancelled or gone.
function readBuildState(b) {
  const dir = buildDir(b);
  if (!dir || !fs.existsSync(dir)) return { dir, st: null, state: 'gone', updatedAt: 0 };
  const st = readJsonFile(path.join(dir, 'state.json'));
  let state = 'waiting', updatedAt = 0;
  if (st && typeof st.state === 'string') {
    state = st.state; updatedAt = Date.parse(st.updated) || 0;
    if (state === 'running' && updatedAt && Date.now() - updatedAt > BUILD_STALL_MS) state = 'stalled';
  }
  return { dir, st, state, updatedAt };
}

// What a running build has written into its work folder, when the builder does not say (see buildView). The
// folder can hold hundreds of thousands of files, and walking it in one go held up everything else (a page
// asking for the builds every few seconds, the feed every ten). So it is walked a few milliseconds at a time:
// each call carries on where the last stopped, the total so far is what is reported (flagged approximate until
// a walk has finished), and a finished walk is kept for 30 seconds before the next one starts. A walk gives up
// after 50,000 entries or 250 ms of walking altogether and settles on what it counted, flagged approximate.
const WORK_WALK_SLICE_MS = 4, WORK_WALK_MAX_MS = 250, WORK_WALK_MAX_ENTRIES = 50000, WORK_WALK_DEPTH = 3, WORK_WALK_KEEP_MS = 30000;
const workWalks = new Map();      // job id -> {stack: [{dir: fs.Dir, depth}], bytes, entries, spent, capped, doneAt, last, touched}
function workWalkClose(w) { for (const d of w.stack) { try { d.dir.closeSync(); } catch {} } w.stack = []; }
function workWritten(id, work) {
  const now = Date.now();
  let w = workWalks.get(id);
  if (w && !w.stack.length && now - w.doneAt < WORK_WALK_KEEP_MS) { w.touched = now; return { bytes: w.last, approx: w.capped, settled: true }; }
  if (!w || !w.stack.length) {
    // A new walk; until it has finished the last finished one is what is reported.
    const prev = w ? { last: w.last, capped: w.capped, had: true } : { last: 0, capped: false, had: false };
    w = { stack: [], bytes: 0, entries: 0, spent: 0, capped: false, doneAt: 0, last: prev.last, prevCapped: prev.capped, had: prev.had, touched: now };
    workWalks.set(id, w);
    // (No folder yet: nothing is kept, so the first files to land are seen on the next look.)
    try { w.stack.push({ dir: fs.opendirSync(work), depth: WORK_WALK_DEPTH }); } catch { workWalks.delete(id); return { bytes: 0, approx: false, settled: true }; }
  }
  w.touched = now;
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  let n = 0;
  while (w.stack.length) {
    if ((++n & 31) === 0 && ms() >= WORK_WALK_SLICE_MS) break;
    if (w.entries >= WORK_WALK_MAX_ENTRIES || w.spent + ms() >= WORK_WALK_MAX_MS) { w.capped = true; workWalkClose(w); break; }
    const top = w.stack[w.stack.length - 1];
    let e = null;
    try { e = top.dir.readSync(); } catch {}
    if (!e) { try { top.dir.closeSync(); } catch {} w.stack.pop(); continue; }
    w.entries++;
    const p = path.join(top.dir.path, e.name);
    try {
      if (e.isFile()) w.bytes += fs.statSync(p).size;
      else if (e.isDirectory() && top.depth > 0) w.stack.push({ dir: fs.opendirSync(p), depth: top.depth - 1 });
    } catch {}
  }
  w.spent += ms();
  if (!w.stack.length) { w.last = w.bytes; w.doneAt = Date.now(); w.had = true; }
  // Finished (or given up): exactly what it counted. Under way: the last finished walk's figure, else what it has counted.
  if (!w.stack.length) return { bytes: w.last, approx: w.capped, settled: true };
  return { bytes: w.had ? w.last : w.bytes, approx: !w.had || w.prevCapped, settled: w.had };
}
// A walk nobody has asked about for a while (its job ended or was removed) is closed, so no folder is left open.
setInterval(() => { const now = Date.now(); for (const [id, w] of workWalks) if (now - w.touched > 120000) { workWalkClose(w); workWalks.delete(id); } }, 60000).unref();

function buildView(b) {
  const { dir, st, state: seen } = readBuildState(b);
  const v = { id: b.id, src: b.src, dump: b.dumpRel, title: b.title, contentId: b.contentId, createdAt: b.createdAt, state: 'waiting', message: 'Waiting for a ShadowPKG builder to pick it up.' };
  if (seen === 'gone') return { ...v, state: 'gone', message: 'The job folder is no longer there.' };
  if (st && typeof st.state === 'string') {
    v.state = st.state;
    v.message = typeof st.message === 'string' ? st.message : '';
    v.updatedAt = Date.parse(st.updated) || 0;
    v.startedAt = Date.parse(st.startedAt) || null;
    if (st.package) v.package = String(st.package);
    if (st.stats && typeof st.stats === 'object') v.stats = st.stats;
    // How long each stage took, from a builder that says (the container's does): [{name, seconds}] in order.
    if (Array.isArray(st.phases)) v.phases = st.phases.filter(p => p && typeof p.name === 'string' && Number.isFinite(p.seconds)).slice(0, 8).map(p => ({ name: p.name.slice(0, 20), seconds: Math.max(0, Math.round(p.seconds)) }));
    if (st.validated) v.validated = true;
    if (Number.isFinite(st.files)) v.files = st.files;
    if (Number.isFinite(st.size)) v.size = st.size;
    if (Number.isFinite(st.copied) && Number.isFinite(st.total)) { v.copied = st.copied; v.total = st.total; }
    if (Number.isFinite(st.percent)) v.percent = Math.max(0, Math.min(100, Math.round(st.percent)));
    if (seen === 'stalled') {
      v.state = 'stalled';
      v.message = 'Nothing has been heard from the builder for a few minutes. It may have been restarted, gone to sleep, or been closed.';
    }
  }
  // Where this job sits among every other still-waiting one: the builder always
  // claims builds[0] of whatever findPending() returns, which is this same
  // array in this same order (see tools/container/runner.js's watch()), so the
  // position said here is the position that actually decides pickup order —
  // not a guess. Cheap enough to recompute per view: readBuildState is a
  // single stat + small JSON read, and a real queue is a handful of jobs deep.
  if (v.state === 'waiting') {
    const waitingIds = builds.filter(x => readBuildState(x).state === 'waiting').map(x => x.id);
    const pos = waitingIds.indexOf(b.id);
    if (pos >= 0) {
      v.queuePosition = pos + 1;
      v.queueLength = waitingIds.length;
      if (waitingIds.length > 1) v.message += ` (${pos + 1} of ${waitingIds.length} waiting)`;
    }
  }
  if (v.state === 'waiting' && Date.now() - b.createdAt > 3 * 60 * 1000) {
    v.message = `Still waiting after ${Math.round((Date.now() - b.createdAt) / 60000)} minutes` + (v.queueLength > 1 ? ` (${v.queuePosition} of ${v.queueLength} waiting)` : '') + `. Is a builder running? The builder container's log (docker logs) or the Windows builder's watch.log says what it is waiting for.`
      + (profilesWritable ? '' : ' ShadowPKG also has no writable /config folder, and a builder container reads its jobs from there (builds.json), so it cannot see this one; the Windows builder can.');
  }
  if (b.validateOnly) v.validateOnly = true;
  if (b.kind) v.kind = b.kind;
  if (b.dlc) v.dlc = { ...b.dlc };
  if (b.reference) v.reference = b.reference;
  if (b.autoSend) v.autoSend = { ...b.autoSend };
  // The runner's own "cancelled from ShadowPKG" message reads as if someone
  // chose to stop it; checkStalledBuilds() asked instead, so say that.
  if (v.state === 'cancelled' && b.autoCancelled) {
    v.autoCancelled = true;
    v.message = `Cancelled automatically after ${Math.max(1, Math.round(b.autoCancelled.afterMs / 60000))} minutes with no word from the builder — it may have crashed or hung. Check the builder's log.`;
  }
  if (v.state === 'running' || v.state === 'stalled') v.cancelling = fs.existsSync(path.join(dir, 'cancel'));
  if (v.state === 'running') {
    // The builder reports what it has written when it builds on its own disk;
    // otherwise the work folder is right here to measure.
    // (A big work folder is walked a few milliseconds at a time, and the answer is kept: see workWritten.)
    let settled = true;
    if (st && Number.isFinite(st.written)) v.written = st.written;
    else { const w = workWritten(b.id, path.join(dir, 'work')); v.written = w.bytes; settled = w.settled; if (w.approx) v.writtenApprox = true; }
    if (b.dumpBytes) v.dumpBytes = b.dumpBytes;
    // Speed between the last two times the figure actually changed. The PC only
    // reports every few seconds, so looking in between would read as no movement.
    const now = Date.now(), prev = buildSamples.get(b.id);
    // While the first walk of a big folder is still under way the figure is only what it has counted so far, which is
    // not a speed of anything: it is not sampled until the walk has finished (or given up and settled).
    if (!settled) { /* keep the last sample */ }
    else if (!prev) buildSamples.set(b.id, { t: now, w: v.written });
    else if (v.written !== prev.w) {
      if (v.written > prev.w && now > prev.t) buildSpeed.set(b.id, (v.written - prev.w) / ((now - prev.t) / 1000));
      buildSamples.set(b.id, { t: now, w: v.written });
    } else if (now - prev.t > 90000) buildSpeed.set(b.id, 0);
    if (buildSpeed.get(b.id)) v.speed = Math.round(buildSpeed.get(b.id));
    // Same idea as an extraction's or a transfer's own eta: bytes left over
    // speed. The "total" here is implied from percent (written / (percent/100))
    // rather than dumpBytes — a built package often ends up a different size
    // than the dump it came from (compression, per-file overhead), while
    // percent is the builder's own authoritative progress figure, so this
    // stays consistent with whatever percent is already showing rather than
    // guessing from an unrelated number. No percent yet (an early phase, or a
    // builder that doesn't report one) means no eta, same as no speed yet.
    if (v.speed && v.percent > 0 && Number.isFinite(v.written)) {
      v.eta = Math.max(0, Math.round((v.written / (v.percent / 100) - v.written) / v.speed));
    }
  } else if (workWalks.has(b.id)) { workWalkClose(workWalks.get(b.id)); workWalks.delete(b.id); }
  try {
    const tail = fs.readFileSync(path.join(dir, 'build.log'), 'latin1').slice(-2000).split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-4);
    if (tail.length) v.log = tail;
  } catch {}
  if (v.state === 'failed') {
    try {
      const e = fs.readFileSync(path.join(dir, 'build.err'), 'latin1').slice(-1500).split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-3);
      if (e.length) v.errors = e;
    } catch {}
  }
  return v;
}

// Moves a still-waiting job one place earlier or later among the other
// still-waiting jobs, by swapping its position in `builds` with the adjacent
// waiting one — everything else in `builds` (running, done, failed) keeps its
// own place, since findPending() only ever looks at the waiting ones anyway.
// Returns false when there is nowhere to move (already first/last, or not
// waiting any more by the time this runs).
function reorderWaitingBuild(id, dir) {
  const waitingIdx = [];
  builds.forEach((b, i) => { if (readBuildState(b).state === 'waiting') waitingIdx.push(i); });
  const pos = waitingIdx.findIndex(i => builds[i].id === id);
  if (pos < 0) return false;
  const swapWith = dir === 'up' ? waitingIdx[pos - 1] : dir === 'down' ? waitingIdx[pos + 1] : undefined;
  if (swapWith === undefined) return false;
  const i = waitingIdx[pos];
  [builds[i], builds[swapWith]] = [builds[swapWith], builds[i]];
  saveBuilds();
  return true;
}

// A finished job is written to the history once, and the library's package
// list is refreshed so the new package can be found by search straight away.
function settleBuild(b, v) {
  if (b.recorded || !TERMINAL.has(v.state)) return;
  b.recorded = true;
  saveBuilds();
  const src = findSource(b.src);
  const outRel = b.outputDirRel || '';
  recordHistory({
    type: 'build', status: v.state, src: b.src, dir: outRel,
    ...(v.validated ? { validated: true } : {}),
    path: v.state === 'done' && v.package ? (outRel ? outRel + '/' : '') + v.package : undefined,
    name: v.package || b.title || b.contentId, meta: { title: b.title, contentId: b.contentId },
    size: v.size, message: v.state === 'done' ? (v.validated ? `validated: the package list built without errors${v.files ? ` (${v.files} files)` : ''}` : b.kind === 'dlc' ? `DLC rebuilt for ${(b.dlc && b.dlc.regionName) || 'another region'} (${b.dlc ? b.dlc.targetTitleId : ''})` : 'built from a game dump') : v.message,
    // startedAt is when a builder took it up, so queuedAt to startedAt is the wait for one; a builder that does not say leaves it out.
    queuedAt: b.createdAt, startedAt: v.startedAt || null, endedAt: v.updatedAt || Date.now(),
    ...(v.stats ? { stats: v.stats } : {}), ...(v.phases && v.phases.length ? { phases: v.phases } : {}),
    ...(Number.isFinite(v.files) ? { files: v.files } : {}), ...(b.dumpBytes ? { dumpBytes: b.dumpBytes } : {}),
  });
  if (v.state === 'done' && v.package && src) buildList(src, true);
  const sendWhenDone = v.state === 'done' && v.package && !v.validated && b.autoSend && b.autoSend.state === 'waiting';   // a held one stays 'held' and is sent by the hand-over
  // A build whose dump came from SCRATCH_LIBRARY can now also carry a
  // moveBackTo and an autoSend at once (the archive-dump panel offers the
  // same "send when it finishes" console choice the real-disk dump panel
  // already has). Order matters: send first, from wherever the package
  // actually landed (Fast, if that's where the build wrote it — faster for
  // the console too), and only move it back to the real library once the
  // send has resolved, never concurrently — so the move's own verify-then-
  // delete step is never racing an in-flight download (deleteLocalOne's own
  // untouchable() check would also catch that, but this avoids relying on it
  // as the only guard). A HELD send (a PS4 whose installer isn't open) is the
  // one case left alone here: the later hand-over (settleHeldAutoSends) is
  // keyed to wherever the package sits right now, and moving it out from
  // under a still-pending held send would break that lookup — so a held send
  // simply keeps the scratch copy in place, un-cleaned, until it resolves. A
  // real remaining gap, not a deliberate choice; PS4 sending is already
  // documented elsewhere as limited/work-in-progress.
  if (v.state === 'done' && v.package && !v.validated && !b.moveBackTo) chainDone(b);
  if (v.state === 'done' && v.package && !v.validated && b.moveBackTo && !b.autoSend) moveBuildBackFromScratch(b, v);
  if (sendWhenDone) {
    autoSendBuild(b, v).catch(e => console.error('send when done:', e)).finally(() => {
      notifyBuild(b, v);
      // autoSendBuild resolves normally even when the send is held (a PS4
      // whose installer isn't open) — it never throws for that case, so this
      // is the one place that actually has to check the outcome rather than
      // just "did the promise settle": moving back now would pull the
      // package out from under settleHeldAutoSends' later hand-over, which is
      // keyed to wherever it sits at the moment the installer finally opens.
      if (v.state === 'done' && v.package && !v.validated && b.moveBackTo && b.autoSend && b.autoSend.state !== 'held') moveBuildBackFromScratch(b, v);
    });
  } else notifyBuild(b, v);
}

// A build whose dump was extracted into SCRATCH_LIBRARY (see runExtractDump)
// needs its finished package moved back to where the archive it came from
// actually lives. Queued through the exact same transfer machinery a
// person's own Move already uses (copy, verify, THEN remove the source), so
// a build whose move-back hasn't run yet is no worse off than one still
// sitting on scratch: nothing here is more dangerous than a normal Move
// already is. Only once that move is verified done is the now-empty-of-
// purpose dump folder on scratch removed too — through deleteLocalOne, the
// exact guarded delete /api/delete itself uses, never a raw fs call.
//
// It waits first for a console to be done with the package. "Send when done"
// resolves the moment the console ACCEPTS the send (queueSend hands back the
// install request's answer; the download is only watched afterwards), so a
// 70 GB package that is still coming off scratch would otherwise be copied
// and then deleted from under the console mid-download — every later Range
// request would find nothing. inFlight covers accepted-but-not-yet-asked and
// downloading; busyTransfer covers any console pulling it by another route.
// Both end on their own (a send that is not asked for goes silent after three
// minutes, a quiet download counts as paused after 90 seconds), so this
// cannot wait forever on a console that never comes.
// The extraction that started this build is over for good only when the build
// has, and (with scratch) its package is back beside the archive: that is when
// the page may ask whether to delete the archive.
function chainDone(b) {
  const ej = b.extractJobId && extractions.get(b.extractJobId);
  if (ej) { ej.chainDone = true; ej.chainDoneAt = Date.now(); }
}

function moveBuildBackFromScratch(b, v) {
  const scratchSrc = findSource(b.src);
  const pkgRel = (b.outputDirRel ? b.outputDirRel + '/' : '') + v.package;
  const a = b.autoSend;
  const stillServed = () => !!scratchSrc && ((a && a.profile && inFlight(a.profile, scratchSrc.id, pkgRel)) || !!busyTransfer(scratchSrc.id, r => r === pkgRel));
  const go = () => {
    if (stillServed()) { setTimeout(go, 5000).unref?.(); return; }
    queueMoveBackFromScratch(b, v);
  };
  go();
}

function queueMoveBackFromScratch(b, v) {
  const scratchSrc = findSource(b.src), destSrc = findSource(b.moveBackTo.srcId);
  if (!scratchSrc || !destSrc) { console.error(`build ${b.id}: could not move the finished package back — a library it needs is gone`); return; }
  const pkgRel = (b.outputDirRel ? b.outputDirRel + '/' : '') + v.package;
  const dstRel = b.moveBackTo.rel;
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, kind: 'move', verify: 'size', overwrite: 'rename', confirmTopLevel: true,
    src: { kind: 'local', srcId: scratchSrc.id, path: pkgRel },
    dst: { kind: 'local', srcId: destSrc.id, path: dstRel },
    name: v.package, state: 'queued', phase: 'counting',
    bytesTotal: 0, bytesDone: 0, filesTotal: 0, filesDone: 0,
    error: null, message: null, results: [],
    createdAt: Date.now(), startedAt: null, endedAt: null, cancelled: false,
    _srcEp: { kind: 'local', src: scratchSrc, rel: pkgRel, full: path.join(scratchSrc.root, ...pkgRel.split('/')), name: v.package },
    _dstEp: { kind: 'local', src: destSrc, rel: dstRel, full: dstRel ? path.join(destSrc.root, ...dstRel.split('/')) : destSrc.root },
    onDone: async fin => {
      if (fin.state !== 'done') { console.error(`build ${b.id}: moving the finished package back from scratch failed: ${fin.message}`); return; }
      const ar = b.moveBackTo.archive;
      if (ar) recordDumpBuilt(b.moveBackTo.srcId, ar.path, ar.root, v.package);
      chainDone(b);
      // Two disjoint paths, neither depending on the other's outcome — run
      // together rather than one after the other. The job folder
      // (.shadowpkg-build/<id>, job.json/build.log/the builder's own work
      // area) sits beside the dump, not inside it, so it survives the dump's
      // own removal here — the same cleanup /api/build/discard does by hand.
      const jobDir = buildDir(b);
      const rmJobDir = jobDir && /(^|\/)\.shadowpkg-build\/[0-9a-f]{12}$/.test(b.jobRel)
        ? fsp.rm(jobDir, { recursive: true, force: true }).catch(e => console.error(`build ${b.id}: could not remove its scratch job folder: ${e.message}`))
        : Promise.resolve();
      const rmDump = deleteLocalOne(scratchSrc, b.dumpRel, new Set()).catch(e => ({ ok: false, error: e.message }))
        .then(r => { if (!r.ok) console.error(`build ${b.id}: moved the package back, but could not remove the scratch dump copy (${b.dumpRel}): ${r.error}`); });
      await Promise.all([rmJobDir, rmDump]);
      builds = builds.filter(x => x !== b);
      saveBuilds();
    },
  };
  xfers.set(id, job);
  xferQueue.push(job);
  runNextXfer();
}

// The hand-over of a held send happens later and by itself, so a build whose "send when done"
// was held has to be told how it went, or it would say "waiting" for ever.
function settleHeldAutoSends(srcId, rel, ok, error) {
  let changed = false;
  for (const b of builds) {
    const a = b.autoSend;
    // (a build held before this was written down has no rel, but its package name says the same)
    const want = a && (a.rel || (b.final && b.final.package ? (b.outputDirRel ? b.outputDirRel + '/' : '') + b.final.package : ''));
    if (!a || a.state !== 'held' || b.src !== srcId || want !== rel) continue;
    a.state = ok ? 'sent' : 'failed';
    a.message = ok ? '' : (error || 'The console did not accept it.');
    changed = true;
    // The one moment settleBuild() deliberately left the scratch copy alone
    // for: a held send now has a real outcome, so the move-back it was
    // waiting on can finally happen, the same as it would have if the send
    // had never been held in the first place.
    const v = b.final;
    if (v && v.state === 'done' && v.package && !v.validated && b.moveBackTo) moveBuildBackFromScratch(b, v);
  }
  if (changed) saveBuilds();
}

// Send a finished package to the console chosen when the build was started. It
// goes through the same queue and checks as the Send button.
async function autoSendBuild(b, v) {
  const a = b.autoSend, src = findSource(b.src), prof = findProfile(a.profile);
  const done = (state, message) => { a.state = state; a.message = message; saveBuilds(); };
  if (!src || !prof) return done('failed', 'The console chosen for this build no longer exists.');
  done('sending', '');
  const rel = (b.outputDirRel ? b.outputDirRel + '/' : '') + v.package;
  a.rel = rel;      // so a later hand-over of this package can settle the build (settleHeldAutoSends)
  const r = await sendLibraryFile(prof, src, rel, b.base || PUBLIC_BASE() || '');
  if (!r) return done('failed', 'The finished package could not be found to send.');
  if (r.duplicate) return done('sent', '');      // the same package is already on its way to that console
  if (r.held) return done('held', r.payload.message || '');
  done(r.ok ? 'sent' : 'failed', r.ok ? '' : (r.payload.error || 'The console did not accept it.'));
}

// ---- Telling someone a build has finished ------------------------------------
// NOTIFY_URL is any URL that takes a POST: ntfy (https://ntfy.sh/your-topic),
// a Discord or Slack webhook, a Telegram sendMessage URL with chat_id in it, or
// anything else (Home Assistant, Gotify...). What is sent follows the URL unless
// NOTIFY_FORMAT is text, json, discord, slack or telegram.
function notifyFormatOf(url, want) {
  const f = String(want || 'auto').toLowerCase();
  if (f !== 'auto') return f;
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
  if (/hooks\.slack\.com/i.test(url)) return 'slack';
  if (/api\.telegram\.org\/bot/i.test(url)) return 'telegram';
  return 'text';
}
let NOTIFY_URL = process.env.NOTIFY_URL || '';
let notifyWantFormat = process.env.NOTIFY_FORMAT || 'auto';
let NOTIFY_FORMAT = notifyFormatOf(NOTIFY_URL, notifyWantFormat);

function postOut(urlStr, body, headers) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, error: 'NOTIFY_URL is not a valid URL' }); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return resolve({ ok: false, error: 'NOTIFY_URL must start with http:// or https://' });
    const req = mod.request(u, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, r => {
      r.resume();
      r.on('end', () => resolve(r.statusCode >= 200 && r.statusCode < 300 ? { ok: true } : { ok: false, error: `the service answered HTTP ${r.statusCode}` }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

async function notify(title, text) {
  if (!NOTIFY_URL) return { ok: false, error: 'NOTIFY_URL is not set' };
  const both = `${title}\n${text}`;
  const r = NOTIFY_FORMAT === 'discord' ? await postOut(NOTIFY_URL, JSON.stringify({ content: both.slice(0, 1900) }), { 'Content-Type': 'application/json' })
    : NOTIFY_FORMAT === 'slack' ? await postOut(NOTIFY_URL, JSON.stringify({ text: both }), { 'Content-Type': 'application/json' })
    : NOTIFY_FORMAT === 'telegram' ? await postOut(NOTIFY_URL, JSON.stringify({ text: both }), { 'Content-Type': 'application/json' })
    : NOTIFY_FORMAT === 'json' ? await postOut(NOTIFY_URL, JSON.stringify({ title, message: text, text: both, content: both }), { 'Content-Type': 'application/json' })
    // ntfy and most plain receivers: the message is the body, the title a header.
    : await postOut(NOTIFY_URL, text, { 'Content-Type': 'text/plain; charset=utf-8', Title: title.replace(/[^\x20-\x7e]/g, '') });
  if (!r.ok) console.log(`notification not delivered: ${r.error}`);
  return r;
}

// What NOTIFY_URL is used for: builds (the default, as it always was), downloads
// (a long one has finished) and problems (one has gone quiet part way), or all of them.
function notifyOnOf(text) {
  const set = new Set(String(text).toLowerCase().split(/[\s,]+/).filter(Boolean));
  if (set.has('all')) for (const k of ['builds', 'downloads', 'problems']) set.add(k);
  return set;
}
let NOTIFY_ON = notifyOnOf(process.env.NOTIFY_ON || 'builds');

function notifyBuild(b, v) {
  const name = b.title || b.contentId;
  const size = v.size ? ` (${fmtGb(v.size)})` : '';
  let title, text;
  if (v.state === 'done' && v.validated) { title = 'ShadowPKG: validated'; text = `${name}: the package list built without errors${v.files ? ` (${v.files} files)` : ''}.`; }
  else if (v.state === 'done') {
    title = 'ShadowPKG: build finished';
    text = `${name} is built${size}: ${v.package}.`;
    const a = b.autoSend;
    if (a) text += a.state === 'sent' ? ` Sent to ${a.name}.` : a.state === 'held' ? ` Waiting to be sent to ${a.name}: open Remote Package Installer on it.` : a.state === 'failed' ? ` It could not be sent to ${a.name}: ${a.message}` : '';
  } else if (v.state === 'failed') { title = 'ShadowPKG: build failed'; text = `${name}: ${v.message}`; }
  else return;   // a build you cancelled yourself needs no message
  if (NOTIFY_URL && NOTIFY_ON.has('builds')) notify(title, text).catch(() => {});
  toastConsoles(title.replace(/^ShadowPKG: /, ''), text, b.autoSend && b.autoSend.profile).catch(() => {});
}

// A short on-screen message on a console whose FTP port is a zftpd, when a build finishes or fails: zftpd's own
// GET /api/notify shows a toast. It goes to the console a build is being sent to, or else to every saved console that
// is a zftpd (usually the one). Off with ZFTPD_TOAST=0 or its switch in Setup, Settings. Nothing else is sent.
let ZFTPD_TOAST = !/^(0|false|no|off)$/i.test(process.env.ZFTPD_TOAST || '');
// ==== toast-text (pure) ====
// What a toast says: one line, no control characters, short enough to read, and the title and the text apart by a colon.
function toastText(title, text) {
  const one = String(title) + ': ' + String(text);
  return one.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
// ==== end toast-text ====
async function toastConsoles(title, text, profileId) {
  if (!ZFTPD_TOAST) return;
  const msg = toastText(title, text);
  const targets = profiles.filter(p => p.ftpHost && (!profileId || p.id === profileId));
  for (const prof of targets) {
    const z = await zftpdProbe(prof);
    if (!z.present) continue;
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/notify?text=' + encodeURIComponent(msg), 4000);
    console.log(`toast on ${prof.name}: ${r && r.ok ? 'shown' : 'not shown'}`);
  }
}

// What the Activity feed shows of build jobs: the ones in progress, and the
// ones that finished in the last ten minutes, like downloads and extractions.
// A finished job's last view is kept on it, so it is read from disk once, not on
// every poll from every open page.
function buildsFeed() {
  const out = [];
  const now = Date.now();
  for (const b of builds) {
    let v = b.final;
    if (!v) {
      v = buildView(b);
      settleBuild(b, v);
      if (TERMINAL.has(v.state)) { b.final = { ...v, endedAt: v.updatedAt || now }; saveBuilds(); v = b.final; }
    }
    if (v.state === 'gone') continue;
    // A finished build is kept for a day, not ten minutes: the page keeps its bar until the person has opened Activity and ten minutes
    // have gone by (or they hide it), and someone away when it finished should still find it there.
    if (TERMINAL.has(v.state) && now - (v.endedAt || 0) > 24 * 3600000) continue;
    const src = findSource(b.src);
    // What happens after the build (the send) can finish after the view was kept.
    out.push({ ...v, ...(b.autoSend ? { autoSend: { ...b.autoSend } } : {}), library: src ? src.label : b.src, outputDir: b.outputDirRel || '' });
  }
  return out.sort((a, c) => (c.createdAt || 0) - (a.createdAt || 0));
}

// A build that ends while nobody has the page open must still be recorded, sent
// on to its console and announced, so unfinished jobs are looked at now and then.
setInterval(() => { try { if (builds.some(b => !b.final)) buildsFeed(); } catch (e) { console.error('build check:', e); } }, 10000).unref();

function buildsFor(srcId, dumpRel) {
  return builds.filter(b => b.src === srcId && b.dumpRel === dumpRel).map(b => { const v = buildView(b); settleBuild(b, v); return v; }).reverse();
}

function dumpCheckView(j) {
  const errors = j.checks.filter(c => c.level === 'error').length;
  return {
    state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, files: j.files, bytes: j.bytes,
    estimated: j.estimated || null, free: j.free ?? null, checks: j.checks, notes: j.notes,
    ready: j.state === 'done' && errors === 0,
  };
}

// Writes a new build job folder for a dump — the one place a job.json is
// created for the external builder to pick up (see the "Build jobs" section
// above). What POST /api/build/prepare does for a person clicking "Build" on
// a dump found on real disk; a dump auto-extracted from inside an archive goes
// through this exact same function, with default options and no host header,
// so both really are the one handoff mechanism, not two that happen to agree.
// Returns { status, error } or { status, job }.
async function prepareBuildJob(src, dumpRel, dump, chk, body, hostHeader, moveBackTo) {
  if (!src || !dumpRel) return { status: 404, error: 'not a game dump that can be built' };
  if (!DUMP_CONTENT_ID.test(dump.contentId || '')) return { status: 400, error: 'the dump has no valid content ID' };
  if (!chk || chk.state !== 'done' || chk.checks.some(c => c.level === 'error')) return { status: 409, error: 'Run "Check this dump" first; it has to pass with no problems.' };
  const live = builds.find(b => b.src === src.id && b.dumpRel === dumpRel && !TERMINAL.has(buildView(b).state) && buildView(b).state !== 'gone');
  if (live) return { status: 200, job: buildView(live) };
  const compression = body.compression === undefined ? 7 : Number(body.compression);
  const chunks = body.chunks === undefined ? 100 : Number(body.chunks);
  if (!Number.isInteger(compression) || compression < -4 || compression > 9 || !Number.isInteger(chunks) || chunks < 1 || chunks > 255) return { status: 400, error: 'compression must be -4 to 9 and chunks 1 to 255' };
  const parentRel = dumpRel.includes('/') ? dumpRel.slice(0, dumpRel.lastIndexOf('/')) : '';
  // A patch is built against the base game's package, which must be in this library.
  let reference = null;
  if (body.reference && body.validateOnly !== true) {
    reference = String(body.reference).replace(/^\/+/, '');
    const rt = /\.pkg$/i.test(reference) && await resolveTarget(src, reference);
    if (!rt || rt.error) return { status: 404, error: 'the base package for the patch is not in this library' };
  }
  let autoSend = null;
  if (body.sendTo && body.validateOnly !== true) {
    const prof = findProfile(String(body.sendTo));
    if (!prof) return { status: 404, error: 'That console no longer exists — pick another' };
    autoSend = { profile: prof.id, name: prof.name, state: 'waiting', message: '' };
  }
  const id = crypto.randomBytes(6).toString('hex');
  const jobRel = (parentRel ? parentRel + '/' : '') + '.shadowpkg-build/' + id;
  try {
    const jobDir = safeDir(src.root, jobRel);
    fs.mkdirSync(jobDir, { recursive: true });
    // The PC that builds reaches this share as a different user from the one
    // this container runs as, and needs to write its progress into the folder.
    // A folder made here would otherwise be readable but not writable there.
    for (const d of [path.dirname(jobDir), jobDir]) { try { fs.chmodSync(d, 0o777); } catch {} }
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({
      id, library: src.id, dumpRel, outputDirRel: parentRel, contentId: dump.contentId,
      title: dump.title || dump.contentId, version: dump.version || null,
      // The dump's own size and the package size "Check this dump" already
      // estimated — carried over so a builder can precheck free space without
      // re-walking the dump itself. Absent on a job.json from before this, or
      // if the check never measured them; a builder treats that as "unknown".
      dumpBytes: chk.bytes || undefined, estimatedBytes: chk.estimated || undefined,
      options: { compression, chunks, ...(body.validateOnly === true ? { validateOnly: true } : {}), ...(reference ? { reference } : {}) }, createdAt: Date.now(),
    }, null, 2));
    try { fs.chmodSync(path.join(jobDir, 'job.json'), 0o666); } catch {}
  } catch (e) { return { status: 500, error: `Could not write the job folder next to the dump: ${e.message}. Is the library mounted read/write?` }; }
  const b = { id, src: src.id, jobRel, dumpRel, outputDirRel: parentRel, contentId: dump.contentId, title: dump.title || dump.contentId, createdAt: Date.now(), dumpBytes: chk.bytes || 0, ...(body.validateOnly === true ? { validateOnly: true } : {}),
    ...(reference ? { reference } : {}), ...(autoSend ? { autoSend, base: PUBLIC_BASE() || (hostHeader ? `http://${hostHeader}` : null) } : {}),
    // Set only when this dump was extracted into SCRATCH_LIBRARY rather than
    // beside its own archive — settleBuild() moves the finished package back
    // to where it actually belongs once the build is done, and only then
    // cleans up the scratch copy of the dump. Never set for a dump already on
    // real disk (built by hand or auto-built beside its own archive), which
    // has nowhere else to "move back" to — it is already where it belongs.
    ...(moveBackTo ? { moveBackTo } : {}) };
  builds.push(b);
  saveBuilds();
  return { status: 200, job: buildView(b) };
}

// ---- DLC for another region ------------------------------------------------------
// A DLC unlocker (additional content with no data of its own) is tied to one game by its title id, and the
// game's region is the first two letters of the content id. Moving it to the same game's other region means
// the same DLC under the other release's ids: keep the 16-character label (that is what names the
// entitlement), take everything else from the target game, and build it again with the kit's own
// publishing tool, which writes the license entries. Nothing is invented: the ids come from the target game.
// ==== dlc-region (pure) ====
const CID_PARTS = /^([A-Z]{2})(\d{4})-(PPSA\d{5})_(\d{2})-([A-Z0-9]{16})$/;
function parseContentId(cid) {
  const m = CID_PARTS.exec(String(cid || ''));
  return m ? { region: m[1], publisher: m[2], titleId: m[3], version: m[4], label: m[5] } : null;
}
const DLC_REGION_NAMES = { UP: 'US', EP: 'EU', JP: 'JP', HP: 'Asia', KP: 'KR', IP: 'Int' };
const DLC_OUTPUT_DIR = 'region change output';     // where the rebuilt DLC go unless another place is chosen: a folder beside the source DLC
const DLC_MAX_PFS_BYTES = 8 * 1048576;      // an unlocker's own image is a few hundred KB; a DLC that ships data is far past this

// What the target's ids must look like when they are typed in rather than read from a game: the region letters
// and title id are given, the publisher digits are the DLC's own (one publisher numbers its releases alike).
function typedDlcTarget(sourceCid, region, titleId) {
  const src = parseContentId(sourceCid);
  if (!src) return { error: 'the DLC package has no valid content ID' };
  if (!DLC_REGION_NAMES[String(region || '')]) return { error: 'unknown region ' + JSON.stringify(region) };
  if (!/^PPSA\d{5}$/.test(String(titleId || ''))) return { error: 'the title ID must look like PPSA12345' };
  return { contentId: region + src.publisher + '-' + titleId + '_00-GAME000000000000', titleId, typed: true };
}

// The new param.json for the DLC: the source's own, with the title id, content id (and, when the target game says,
// its version-file link and concept id) switched, and the two fields an additional-content package must not carry removed.
function deriveDlcParam(srcParam, target) {
  const s = parseContentId(srcParam && srcParam.contentId);
  const t = parseContentId(target && target.contentId);
  if (!s) return { error: 'the DLC package has no valid content ID' };
  if (!t) return { error: 'the target game has no valid content ID' };
  if (s.titleId === t.titleId) return { error: 'that DLC already belongs to that game' };
  const p = JSON.parse(JSON.stringify(srcParam));
  const contentId = t.region + t.publisher + '-' + t.titleId + '_' + t.version + '-' + s.label;
  const notes = [];
  p.titleId = t.titleId;
  p.contentId = contentId;
  if (target.versionFileUri) p.versionFileUri = target.versionFileUri;
  else if (p.versionFileUri) notes.push('the version-file link is the source DLC\'s; the target game did not say its own');
  if (target.conceptId && p.conceptId && String(target.conceptId) !== String(p.conceptId)) {
    notes.push('the concept ID differs (' + p.conceptId + ' and ' + target.conceptId + '): the target game\'s was used');
    p.conceptId = String(target.conceptId);
  }
  delete p.applicationDrmType; delete p.applicationCategoryType;
  if (JSON.stringify(p).includes(s.titleId)) notes.push('the old title id ' + s.titleId + ' still appears in the param.json');
  return { param: p, contentId, titleId: t.titleId, label: s.label, region: t.region, notes };
}

// Is this package one this can convert? Null when it is, else the plain reason it is not.
function checkDlcSource(info) {
  if (!info || info.platform !== 'PS5') return 'that is not a PS5 package';
  if (info.contentType !== 0x21) return 'that is not a DLC (additional content) package';
  if (!info.param || !parseContentId(info.param.contentId)) return 'the DLC package has no readable param.json';
  if (!(info.pfsImageSize <= DLC_MAX_PFS_BYTES)) return 'this DLC ships data of its own; only unlockers (DLC with no data) can be rebuilt this way';
  return null;
}
// A folder path typed or picked for the output: relative, forward slashes, no '..', no characters Windows refuses. Null if bad.
function cleanOutputRel(p) {
  const parts = String(p == null ? '' : p).replace(/\\/g, '/').split('/').map(x => x.trim()).filter(Boolean);
  for (const x of parts) if (x === '.' || x === '..' || /[<>:"|?*\x00-\x1f]/.test(x) || x.length > 120) return null;
  return parts.join('/');
}
// ==== end dlc-region ====

const newEntitlementKey = () => crypto.randomBytes(16).toString('hex');

// A package's icon0.png, out of the file itself (it is stored in the clear), or null.
async function readPackageIcon(t, cnt) {
  const icon = cnt && cnt.entries.find(e => e.name === 'icon0.png' && !e.encrypted);
  if (!icon || cnt.baseOffset + icon.dataOffset + icon.dataSize > t.size || !icon.dataSize || icon.dataSize > 4 * 1048576) return null;
  return readPkgRange(t, cnt.baseOffset + icon.dataOffset, icon.dataSize);
}

// What the package says, for this: the platform, the container facts, the parsed param.json.
async function readDlcPackage(src, rel, withIcon) {
  const t = await resolveTarget(src, rel);
  if (!t || t.error) return { status: 404, error: 'that package was not found' };
  const r = await readPackage(t);
  if (r.bad || !r.ps5) return { status: 400, error: 'that is not a readable PS5 package' };
  const out = { t, platform: 'PS5', contentType: r.ps5.contentType, pfsImageSize: r.ps5.pfsImageSize, param: r.param || null, cnt: r.ps5 };
  if (withIcon) out.icon = await readPackageIcon(t, r.ps5);
  return out;
}

// The DLC to be converted, read and checked.
async function readDlcSource(src, rel) {
  const pkg = await readDlcPackage(src, rel, true);
  if (pkg.error) return pkg;
  const bad = checkDlcSource(pkg);
  return bad ? { status: 400, error: bad } : pkg;
}

// One DLC to be built for another region: checks it, stages its two input files in a hidden job folder beside
// the target game, and queues the build. Returns { status, error } or { status, job }.
//   target: { src, path } a game package in a library (its ids are read), or { region, titleId } typed.
async function prepareDlcJob(srcLib, sourceRel, target, options, hostHeader) {
  const source = await readDlcSource(srcLib, sourceRel);
  if (source.error) return source;
  // The target's ids, and which library the finished package goes into.
  let tgt, outLib, outRel, from;
  if (target && target.path) {
    outLib = findSource(target.src);
    if (!outLib) return { status: 404, error: 'the target game\'s library was not found' };
    const tp = await readDlcPackage(outLib, target.path, true);
    if (tp.error) return { status: tp.status, error: 'the target game: ' + tp.error };
    const p = tp.param || {};
    if (tp.contentType !== 0x20 || !parseContentId(p.contentId)) return { status: 400, error: 'the target must be a PS5 game package' };
    tgt = { contentId: p.contentId, versionFileUri: p.versionFileUri || null, conceptId: p.conceptId || null };
    outRel = dirOf(target.path);
    from = 'library';
    source.fallbackIcon = tp.icon;
  } else if (target && target.region && target.titleId) {
    const typed = typedDlcTarget(source.param.contentId, target.region, target.titleId);
    if (typed.error) return { status: 400, error: typed.error };
    tgt = { contentId: typed.contentId, versionFileUri: null, conceptId: null };
    outLib = srcLib; outRel = dirOf(sourceRel);
    from = 'typed';
  } else return { status: 400, error: 'say which game to build it for' };
  // Where the finished package goes: by default a folder beside the source DLC, or beside the target game, or a folder of
  // the person's choosing in a library (made if it is not there).
  const out = options && options.output;
  const mode = out && out.mode ? String(out.mode) : 'default';
  if (mode === 'default') { outLib = srcLib; outRel = (dirOf(sourceRel) ? dirOf(sourceRel) + '/' : '') + DLC_OUTPUT_DIR; }
  else if (mode === 'target') { if (from !== 'library') return { status: 400, error: 'there is no target game folder: the target was typed in, not picked from a library' }; }
  else if (mode === 'folder') {
    outLib = findSource(out.src);
    if (!outLib) return { status: 404, error: 'the output library was not found' };
    const rel = cleanOutputRel(out.path);
    if (rel === null) return { status: 400, error: 'the output folder name has a character that is not allowed' };
    outRel = rel;
  } else return { status: 400, error: 'unknown output place ' + JSON.stringify(mode) };
  const d = deriveDlcParam(source.param, tgt);
  if (d.error) return { status: 409, error: d.error };
  const icon = source.icon || source.fallbackIcon;
  if (!icon) return { status: 400, error: 'the DLC package has no icon0.png to carry over' };
  const outDir = safeDir(outLib.root, outRel);
  if (!outDir) return { status: 400, error: 'the output folder is not inside its library' };
  if (fs.existsSync(path.join(outDir, d.contentId + '.pkg'))) return { status: 409, error: d.contentId + '.pkg is already in that folder' };
  const live = builds.find(b => b.kind === 'dlc' && b.src === outLib.id && b.contentId === d.contentId && !TERMINAL.has(buildView(b).state) && buildView(b).state !== 'gone');
  if (live) return { status: 200, job: buildView(live) };
  let autoSend = null;
  if (options && options.sendTo) {
    const prof = findProfile(String(options.sendTo));
    if (!prof) return { status: 404, error: 'That console no longer exists — pick another' };
    autoSend = { profile: prof.id, name: prof.name, state: 'waiting', message: '' };
  }
  const compression = options && options.compression !== undefined ? Number(options.compression) : 7;
  if (!Number.isInteger(compression) || compression < -4 || compression > 9) return { status: 400, error: 'compression must be -4 to 9' };
  const id = crypto.randomBytes(6).toString('hex');
  // The job's own folder (hidden, with the staged files and the builder's log) is kept beside the output folder rather
  // than in it, so the output folder holds only what was built and can be renamed or moved like any other.
  const jobParent = mode === 'target' ? outRel : dirOf(outRel);
  const jobRel = (jobParent ? jobParent + '/' : '') + '.shadowpkg-build/' + id;
  const title = ps5Title(d.param) || d.contentId;
  let outCreated = false;
  try {
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      outCreated = true;
      for (let dd = outDir; dd !== path.resolve(outLib.root) && underRoot(outLib.root, dd); dd = path.dirname(dd)) { try { fs.chmodSync(dd, 0o777); fs.chownSync(dd, 99, 100); } catch {} }
    }
    const jobDir = safeDir(outLib.root, jobRel);
    const sys = path.join(jobDir, 'src', 'sce_sys');
    fs.mkdirSync(sys, { recursive: true });
    for (const dd of [path.dirname(jobDir), jobDir, path.join(jobDir, 'src'), sys]) { try { fs.chmodSync(dd, 0o777); } catch {} }
    fs.writeFileSync(path.join(sys, 'param.json'), JSON.stringify(d.param, null, 2) + '\n');
    fs.writeFileSync(path.join(sys, 'icon0.png'), icon);
    for (const f of ['param.json', 'icon0.png']) { try { fs.chmodSync(path.join(sys, f), 0o666); } catch {} }
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({
      id, library: outLib.id, kind: 'dlc', dumpRel: jobRel + '/src', outputDirRel: outRel, contentId: d.contentId, title,
      version: d.param.contentVersion || null,
      dlc: { volume: 'ac', entitlementKey: newEntitlementKey(), passcode: '0'.repeat(32) },
      options: { compression }, createdAt: Date.now(),
    }, null, 2));
    try { fs.chmodSync(path.join(jobDir, 'job.json'), 0o666); } catch {}
  } catch (e) { return { status: 500, error: 'Could not write the job folder next to the target game: ' + e.message + '. Is the library mounted read/write?' }; }
  const b = { id, src: outLib.id, jobRel, dumpRel: jobRel + '/src', outputDirRel: outRel, kind: 'dlc', contentId: d.contentId, title, createdAt: Date.now(), dumpBytes: 0, ...(outCreated ? { outCreated: true } : {}),
    dlc: { sourceSrc: srcLib.id, source: sourceRel, sourceTitleId: parseContentId(source.param.contentId).titleId, targetTitleId: d.titleId, region: d.region, regionName: DLC_REGION_NAMES[d.region] || d.region, from, notes: d.notes },
    ...(autoSend ? { autoSend, base: PUBLIC_BASE() || (hostHeader ? 'http://' + hostHeader : null) } : {}) };
  builds.push(b);
  saveBuilds();
  return { status: 200, job: buildView(b) };
}

// The games this DLC could be rebuilt for: other releases of the same game found in the libraries, from what the
// packages already say. A game's title is the start of its DLC's title, and the concept id (one game, every region)
// confirms it, so a candidate is read (param.json only) before it is called the same game.
async function dlcTargets(srcLib, rel) {
  const source = await readDlcSource(srcLib, rel);
  if (source.error) return source;
  const sp = parseContentId(source.param.contentId);
  const norm = x => String(x || '').toLowerCase().replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
  const dlcTitle = norm(ps5Title(source.param));
  const seen = new Map();
  for (const lib of SOURCES) {
    for (const f of listWithMeta(lib, buildList(lib).files)) {
      const m = f.meta;
      if (!m || m.tentative || m.kind !== 'game' || m.platform !== 'PS5' || !/^PPSA\d{5}$/.test(m.titleId || '') || m.titleId === sp.titleId) continue;
      const mine = norm(m.title);
      const cp = parseContentId(m.contentId);
      // The game's name is somewhere in its DLC's title ("Claws of Awaji - Assassin's Creed Shadows" as often as the reverse).
      const score = (mine.length >= 3 && dlcTitle.includes(mine) ? 3 : 0) + (cp && cp.publisher === sp.publisher ? 1 : 0);
      if (score < 3) continue;
      const key = lib.id + '\n' + m.titleId;
      if (!seen.has(key) || f.size > seen.get(key).f.size) seen.set(key, { lib, f, m, score });
    }
  }
  const picked = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  const candidates = [];
  for (const c of picked) {
    const pkg = await readDlcPackage(c.lib, c.f.path, false);
    if (pkg.error || pkg.contentType !== 0x20 || !pkg.param) continue;
    const derived = deriveDlcParam(source.param, { contentId: pkg.param.contentId, versionFileUri: pkg.param.versionFileUri, conceptId: pkg.param.conceptId });
    if (derived.error) continue;
    candidates.push({
      src: c.lib.id, path: c.f.path, size: c.f.size, title: c.m.title, titleId: c.m.titleId, contentId: pkg.param.contentId, version: c.m.version || null,
      region: derived.region, regionName: DLC_REGION_NAMES[derived.region] || derived.region,
      sameConcept: !!pkg.param.conceptId && String(pkg.param.conceptId) === String(source.param.conceptId),
      willBuild: derived.contentId,
    });
  }
  candidates.sort((a, b) => (b.sameConcept - a.sameConcept) || a.regionName.localeCompare(b.regionName));
  return {
    source: { titleId: sp.titleId, contentId: source.param.contentId, title: ps5Title(source.param), region: sp.region, regionName: DLC_REGION_NAMES[sp.region] || sp.region, label: sp.label, conceptId: source.param.conceptId || null },
    candidates,
    onlineLookup: STORE_LOOKUP,
    regions: Object.entries(DLC_REGION_NAMES).map(([code, name]) => ({ code, name })),
  };
}

// ---- Other releases of a game, from the PlayStation Store (opt-in) -----------------
// A game's concept id is the same in every region, and the store's page for a concept in a region's own store lists
// that region's product ids (UP0001-PPSA20396_00-...), so asking each region's store about the concept names the game's
// other releases: their title ids, and whether the DLC's label exists there. On unless STORE_LOOKUP is set to 0; it is
// the one place this app contacts Sony's site, and only on a button press; only the concept id is sent (it is in the URL).
let STORE_LOOKUP = !/^(0|false|no|off)$/i.test(process.env.STORE_LOOKUP || '');
const STORE_LOCALES = [['en-us', 'US store'], ['en-gb', 'EU store'], ['ja-jp', 'Japan store'], ['en-hk', 'Hong Kong store'], ['ko-kr', 'Korea store']];
// ==== store-concept (pure) ====
// What one store page says: every full content id on it, as { region, titleId, labels }, by title id, and which one dominates.
function parseStoreConceptPage(html) {
  const byTitle = new Map();
  const re = /\b([A-Z]{2})(\d{4})-(PPSA\d{5})_\d\d-([A-Z0-9]{16})\b/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const e = byTitle.get(m[3]) || { region: m[1], titleId: m[3], count: 0, labels: new Set() };
    e.count++; e.labels.add(m[4]); byTitle.set(m[3], e);
  }
  return [...byTitle.values()];
}
// Several store pages together: one entry per title id, named after the stores where it is the main one.
function mergeStorePages(pages) {
  const all = new Map();
  for (const pg of pages) {
    const top = pg.entries.reduce((a, e) => Math.max(a, e.count), 0);
    for (const e of pg.entries) {
      const x = all.get(e.titleId) || { region: e.region, titleId: e.titleId, labels: new Set(), stores: [], seen: [] };
      for (const l of e.labels) x.labels.add(l);
      (e.count === top ? x.stores : x.seen).push(pg.name);
      all.set(e.titleId, x);
    }
  }
  return [...all.values()].map(x => ({ region: x.region, titleId: x.titleId, stores: x.stores.length ? x.stores : x.seen, labels: [...x.labels] }));
}
// ==== end store-concept ====
function fetchStorePage(locale, conceptId) {
  return new Promise(resolve => {
    const req = https.request({
      host: 'store.playstation.com', path: '/' + locale + '/concept/' + conceptId, method: 'GET', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShadowPKG)', 'Accept': 'text/html', 'Accept-Language': locale },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve({ error: 'HTTP ' + res.statusCode }); return; }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 6 << 20) req.destroy(); else chunks.push(c); });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', e => resolve({ error: e.message || 'network error' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', e => resolve({ error: e.message || 'network error' }));
    req.end();
  });
}
const storeCache = new Map();      // concept id -> { at, releases }
async function storeReleases(conceptId) {
  const hit = storeCache.get(conceptId);
  if (hit && Date.now() - hit.at < 3600e3) return hit.releases;
  const got = await Promise.all(STORE_LOCALES.map(async ([loc, name]) => ({ name, r: await fetchStorePage(loc, conceptId) })));
  const pages = got.filter(g => g.r.html).map(g => ({ name: g.name, entries: parseStoreConceptPage(g.r.html) }));
  if (!pages.length) return { error: 'the store did not answer (' + (got.find(g => g.r.error) || { r: {} }).r.error + ')' };
  const releases = mergeStorePages(pages);
  storeCache.set(conceptId, { at: Date.now(), releases });
  return releases;
}
// The source DLC's other releases according to the store: { releases:[{region, regionName, titleId, stores, hasDlc}] }.
async function dlcOnlineTargets(srcLib, rel) {
  if (!STORE_LOOKUP) return { status: 403, error: 'the online lookup is off: turn on "Look up other releases online" in Setup, Settings' };
  const source = await readDlcSource(srcLib, rel);
  if (source.error) return source;
  const sp = parseContentId(source.param.contentId);
  const concept = String(source.param.conceptId || '');
  if (!/^\d{5,12}$/.test(concept)) return { status: 400, error: 'the DLC does not carry a concept ID, so the store cannot be asked about it' };
  const rel2 = await storeReleases(concept);
  if (rel2.error) return { status: 502, error: rel2.error };
  const releases = rel2.filter(r => r.titleId !== sp.titleId && DLC_REGION_NAMES[r.region])
    .map(r => ({ region: r.region, regionName: DLC_REGION_NAMES[r.region], titleId: r.titleId, stores: r.stores, hasDlc: r.labels.includes(sp.label) }))
    .sort((a, b) => (b.hasDlc - a.hasDlc) || a.regionName.localeCompare(b.regionName));
  return { releases };
}

// ---- Deleting an archive whose packages are already out ------------------------
// "Extract here" leaves the archive beside what it unpacked, so a NAS ends up
// holding every repack twice. The archive can go once every package in it has a
// same-named, same-sized file next to it: the test the folder listing already uses
// to call a row "already extracted", kept in one place so the row and the delete
// cannot disagree about it.
const notUnpacked = (pkgs, beside) => pkgs.filter(x => beside.get(x.name) !== x.size);

// The sizes of the named files sitting in `dir`, read the way the folder listing
// reads them: plain files only, matched on the exact name.
async function sizesBeside(dir, leaves) {
  const names = new Set(await fsp.readdir(dir));
  const out = new Map();
  for (const n of new Set(leaves)) {
    if (!names.has(n)) continue;
    try { const st = await fsp.lstat(path.join(dir, n)); if (st.isFile() && st.size > 0) out.set(n, st.size); } catch {}
  }
  return out;
}

// Every file in an archive or a set of volumes, by name: what would be lost with
// it. `note` says why the list cannot be trusted to be everything (an unreadable
// header, or a volume that is not here). One volume at a time, letting the event
// loop breathe between them, since a console may be streaming a package meanwhile.
async function listArchive(volumes, sizes) {
  const seen = new Map();
  let note = null;
  for (const [i, v] of volumes.entries()) {
    let r;
    try { r = await scanRar(v); } catch (e) { note = `${path.basename(v)}: ${e.message}`; break; }
    if (r.note) { note = `${path.basename(v)}: ${r.note}`; break; }
    // A header can be whole while the data it describes was never all written (a download cut short).
    const cut = r.entries.find(e => e.offset + e.chunk > sizes[i]);
    if (cut) { note = `${path.basename(v)} is cut short`; break; }
    for (const e of r.entries) {
      const s = seen.get(e.name) || { name: e.name, size: e.size, have: 0, stored: true, split: false };
      s.have += e.chunk;
      if (!e.stored) s.stored = false;
      if (e.split) s.split = true;
      seen.set(e.name, s);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!note) {
    // A stored file's pieces add up to its size; when they do not, the rest is in a volume that is not here.
    const short = [...seen.values()].find(s => s.stored && s.have !== s.size);
    if (short) note = `${short.name} continues in a volume that is not here`;
    else if (volumes.length === 1 && [...seen.values()].some(s => s.split)) note = 'it continues in a volume that is not here';
  }
  return { files: [...seen.values()].map(s => ({ name: s.name, size: s.size })), note };
}

// A game dump sitting inside a .rar or multi-part .rar, unextracted — the scene
// calls these "PS5 Dump" releases. Cheap and read-only: scans the same archive
// listing listArchive() already builds (no entry's compressed data is touched),
// looking for a "sce_sys/param.json"-shaped name. That entry's path with
// "/sce_sys/param.json" stripped off is the dump's own root folder inside the
// archive ('' when the dump sits at the archive's root). Every candidate is
// returned, not just the first — a real release almost certainly has at most
// one, but nothing stops an archive from holding more. When the archive can't
// be read whole (a volume missing, cut short, …) no candidates are offered at
// all, the same as reviewArchive() already refuses to say what's inside then.
// Scoped to .rar for now: the in-process listing this relies on only covers RAR.
const dumpCandCache = new Map();   // full -> {key, candidates, note}
async function dumpCandidatesFor(full, st) {
  if (isLaterVolume(full)) return { key: `${st.size}|${st.mtimeMs}`, candidates: [], note: null };
  const volumes = volumesFor(full) || [full];
  const key = volumes.length > 1 ? setKeyFor(volumes) : `${st.size}|${st.mtimeMs}`;
  const hit = dumpCandCache.get(full);
  if (hit && hit.key === key) return hit;
  const sizes = await Promise.all(volumes.map(v => fsp.stat(v).then(s => s.size, () => 0)));
  let list;
  try { list = await listArchive(volumes, sizes); } catch (e) { list = { files: [], note: e.message }; }
  const candidates = [];
  if (!list.note) {
    const seenRoots = new Set();
    for (const f of list.files) {
      const m = /^(.*)\/sce_sys\/param\.json$/i.exec(f.name);
      const root = m ? m[1] : (/^sce_sys\/param\.json$/i.test(f.name) ? '' : null);
      if (root === null || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const prefix = root ? root + '/' : '';
      let bytes = 0;
      for (const g of list.files) if (!root || g.name.startsWith(prefix)) bytes += g.size;
      candidates.push({ root, bytes });
    }
  }
  const val = { key, candidates, note: list.note };
  dumpCandCache.set(full, val);
  return val;
}

// What stands in the way of touching this archive right now, or null: a job
// unpacking it, or a console pulling a package straight out of it.
function archiveInUse(src, rel, full) {
  // The archive is looked at as the file it is (see sameFile), not as the string it was reached by.
  const at = spotSync(full);
  if ([...extractions.values()].some(j => (j.state === 'queued' || j.state === 'running') && sameFile(j, at))) return 'it is being extracted right now (or is waiting to be)';
  const busy = busyTransfer(src.id, r => r.startsWith(rel + ARC), at.id);
  return busy ? `${ps5NameFor(busy.ip) || busy.ip} is downloading a package straight out of it right now` : null;
}

// Whether a dump's own root inside a .rar has already been extracted beside
// it, verified name and size against the archive's own listing — the same
// "good enough" standard the package check below already uses, not a byte
// compare. A root only counts once EVERY one of its own entries verifies;
// one entry missing or the wrong size and none of that root's entries are
// counted, so a partial or stale-looking extraction never lets deletion
// through. Lets a dump-only archive (no .pkg entries of its own — the common
// case for a "PS5 Dump" release) become deletable once its dump is genuinely
// out, the same as a package-only archive already can be.
async function dumpAccountingFor(dir, archiveName, list) {
  const accounted = new Set();
  const seenRoots = new Set();
  for (const f of list.files) {
    const m = /^(.*)\/sce_sys\/param\.json$/i.exec(f.name);
    const root = m ? m[1] : (/^sce_sys\/param\.json$/i.test(f.name) ? '' : null);
    if (root !== null) seenRoots.add(root);
  }
  for (const root of seenRoots) {
    const leaf = root ? root.split('/').pop() : stemOf(archiveName);
    let baseSt;
    try { baseSt = await fsp.stat(path.join(dir, leaf)); } catch { continue; }
    if (!baseSt.isDirectory()) continue;
    const prefix = root ? root + '/' : '';
    const members = list.files.filter(f => !root || f.name.startsWith(prefix));
    let ok = true;
    for (const f of members) {
      const relInside = f.name.slice(prefix.length);
      if (!relInside) { ok = false; break; }
      let st;
      try { st = await fsp.stat(path.join(dir, leaf, ...relInside.split('/'))); } catch { ok = false; break; }
      if (!st.isFile() || st.size !== f.size) { ok = false; break; }
    }
    if (ok) for (const f of members) accounted.add(f.name);
  }
  return accounted;
}

// Resolves and minimally validates a .rar/.zip/.7z path for read-only
// browsing — deliberately NOT reviewArchive()'s full check: looking inside
// an archive has to work on a read-only library and while an extraction of
// it is running, neither of which should stop merely looking at what it
// holds, unlike actually deleting it.
function resolvePeekArchive(src, rel) {
  const full = typeof rel === 'string' && rel ? path.resolve(src.root, rel) : null;
  if (!full || full === src.root || !underRoot(src.root, full) || rel.includes(ARC)) return { error: 'that is not an archive in this library' };
  if (!/\.(rar|zip|7z)$/i.test(full)) return { error: 'only a .rar, .zip or .7z archive can be looked inside here' };
  if (isLaterVolume(full)) return { error: 'that is a later volume of a set; look inside it from the first volume' };
  return { full, rel: path.relative(src.root, full).split(path.sep).join('/') };
}

// .zip/.7z listing for Open/select-extract to cover those two formats too —
// there is no in-process header parser for either (unlike RAR's own
// scanRar), so this shells out to 7-Zip's own listing mode instead. Scoped
// to the 7z family specifically (7zz/7z/7za/7zr): its `-slt` ("show
// technical information") mode is a stable, documented, machine-parseable
// format, unlike bsdtar's or unzip's own plain-text listings, which vary
// enough across builds that parsing them reliably without a real fixture to
// test against would be a guess dressed up as a feature. The Dockerfile
// always installs p7zip-full, so this covers the real deployment target; a
// container with only bsdtar/unar/unzip (no 7z at all) gets a clear refusal
// from archiveListingFor below instead of a parser that might be silently
// wrong on a build never tested against.
function sevenZipListing(full) {
  const tool = findTools(full).find(t => /^7z/.test(t.tool));
  if (!tool) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = '';
    const p = spawn(tool.path, ['l', '-slt', full], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', c => { out += c; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const files = [];
      // 7z -slt prints one blank-line-separated block per entry (plus a
      // banner and a block describing the archive itself, both skipped by
      // requiring both Path and Size — the archive's own summary block has
      // Path and "Physical Size", never plain "Size"). Folder = + is a
      // directory entry, not a file.
      for (const block of out.split(/\r?\n\r?\n/)) {
        const fields = {};
        for (const line of block.split(/\r?\n/)) {
          const i = line.indexOf(' = ');
          if (i < 0) continue;
          fields[line.slice(0, i)] = line.slice(i + 3);
        }
        if (!fields.Path || fields.Size === undefined || fields.Folder === '+') continue;
        const size = Number(fields.Size);
        if (!Number.isFinite(size)) continue;
        files.push({ name: fields.Path.replace(/\\/g, '/'), size });
      }
      resolve({ files });
    });
  });
}

// Read-only listing of an archive's entries — {files: [{name, size}], note}
// — dispatching by format: .rar reuses the in-process RAR header parser
// (listArchive/volumesFor, already relied on elsewhere for exactly this),
// .zip/.7z go through sevenZipListing above.
async function archiveListingFor(full) {
  if (/\.rar$/i.test(full)) {
    const vols = volumesFor(full) || [full];
    const sizes = await Promise.all(vols.map(v => fsp.stat(v).then(s => s.size, () => 0)));
    return listArchive(vols, sizes);
  }
  const r = await sevenZipListing(full);
  return r || { files: [], note: 'no 7-Zip (7zz/7z/7za/7zr) is installed in this container to look inside a .zip or .7z archive' };
}

// Everything that decides whether an archive can be deleted, and what the
// dialog shows about it: its volumes, the packages inside and whether each is
// unpacked next to it, and the other files that would go with it. `why` is null
// when it can go, otherwise the first reason it cannot.
async function reviewArchive(src, rel) {
  const out = { src: src.id, path: rel, name: '', why: null, volumes: [], bytes: 0, packages: [], others: null, moreOthers: 0, inner: [] };
  const stop = why => { out.why = why; return out; };
  const full = typeof rel === 'string' && rel ? path.resolve(src.root, rel) : null;
  if (!full || full === src.root || !underRoot(src.root, full) || rel.includes(ARC)) return stop('that is not an archive in this library');
  rel = out.path = path.relative(src.root, full).split(path.sep).join('/');      // ./PS4//X.rar and PS4/X.rar are one file
  out.name = path.basename(full);
  if (!/\.rar$/i.test(full)) return stop('only a .rar archive can be deleted from here');
  if (isLaterVolume(full)) return stop('that is a later volume of a set; the set is deleted from its first volume');
  let st;
  try { st = await fsp.stat(full); } catch { return stop('not found'); }
  if (!st.isFile()) return stop('not found');

  const dir = path.dirname(full);
  const vols = volumesFor(full) || [full];
  for (const v of vols) {
    let size = 0;
    try { size = (await fsp.stat(v)).size; } catch {}
    out.volumes.push({ name: path.basename(v), path: path.relative(src.root, v).split(path.sep).join('/'), size });
    out.bytes += size;
  }

  const inUse = archiveInUse(src, rel, full);
  if (inUse) stop(inUse);
  else { try { fs.accessSync(dir, fs.constants.W_OK); } catch { stop(`${src.label} is mounted read-only, so nothing in it can be deleted. Change that library's mapping to read/write in Unraid.`); } }

  const list = await listArchive(vols, out.volumes.map(v => v.size));
  const pkgs = list.files.filter(f => /\.pkg$/i.test(f.name)).map(f => ({ inner: f.name, name: f.name.split('/').pop(), size: f.size }));
  const beside = await sizesBeside(dir, pkgs.map(p => p.name));
  out.packages = pkgs.map(p => ({ name: p.name, size: p.size, unpacked: beside.get(p.name) === p.size }));
  if (!list.note) {
    const others = list.files.filter(f => !/\.pkg$/i.test(f.name));
    out.others = others.slice(0, 200);
    out.moreOthers = Math.max(0, others.length - 200);
  }
  out.inner = pkgs.map(p => p.inner);     // the names as stored, for the caller's housekeeping

  // A set with a volume separated from the rest (a gap in the numbering) would leave that one behind, unseen.
  const have = new Set(vols.map(v => path.basename(v).toLowerCase()));
  const stem = stemOf(path.basename(full)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const like = new RegExp(`^${stem}\\.(?:part\\d+\\.rar|r\\d\\d)$`, 'i');
  let strays = [];
  try { strays = (await fsp.readdir(dir)).filter(n => like.test(n) && !have.has(n.toLowerCase())); } catch {}

  if (out.why) return out;
  if (list.note) return stop(`ShadowPKG could not read everything inside it (${list.note}), so it cannot tell what else would be lost`);
  if (strays.length) return stop(`${strays.slice(0, 3).join(', ')} looks like part of the same set but is not joined to it, so deleting would leave it behind`);
  // Unpacked packages are found beside it by file name and size, so two inside that share a name cannot be told apart.
  if (new Set(pkgs.map(x => x.name.toLowerCase())).size !== pkgs.length) return stop('two packages inside it have the same file name, so ShadowPKG cannot tell which one is unpacked next to it');
  const leftPkgs = notUnpacked(pkgs, beside);
  if (leftPkgs.length) return stop(`${leftPkgs.length === 1 ? 'a package' : leftPkgs.length + ' packages'} inside ${leftPkgs.length === 1 ? 'is' : 'are'} not unpacked next to it yet: ${leftPkgs.slice(0, 3).map(p => p.name).join(', ')}${leftPkgs.length > 3 ? ', …' : ''}`);
  // A dump-only archive (no .pkg entries of its own — the usual shape for a
  // "PS5 Dump" release) has nothing for the check above to compare, so it used
  // to be refused outright here, even once its dump was genuinely extracted and
  // built from. dumpAccountingFor() covers that case the same way pkgs/beside
  // covers packages: every entry not already accounted for by an unpacked
  // package is checked against an extracted dump root instead. Scoped to
  // pkgs.length === 0 on purpose — an archive that DOES have a real package
  // keeps the exact old rule above: only the package needs to be unpacked, any
  // other loose file inside (a readme, a sample) stays purely informational
  // (out.others, shown but never a blocker), the same as it always has been.
  // A version of this that ran for every archive regardless of pkgs.length
  // shipped briefly and silently broke "Delete archive" for any ordinary
  // release that ships so much as one extra file alongside its package —
  // caught in review before anyone hit it in the field.
  if (!pkgs.length) {
    const dumpAccounted = await dumpAccountingFor(dir, out.name, list);
    for (const n of await builtAccounting(src.id, rel, dir, list)) dumpAccounted.add(n);
    if (!dumpAccounted.size) return stop('there is no package or extracted dump inside it to compare with what is already out');
    const leftOthers = list.files.filter(f => !dumpAccounted.has(f.name));
    if (leftOthers.length) {
      const names = leftOthers.map(f => f.name.split('/').pop());
      return stop(`${names.length === 1 ? 'a file' : names.length + ' files'} inside ${names.length === 1 ? 'is' : 'are'} not out on disk yet: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`);
    }
  }
  return out;
}

// One folder level: subfolders plus .pkg files. Hidden entries are skipped —
// unless `hidden` is asked for, which lists names starting with a dot (folders,
// packages, archives and, with `others`, other files). `others` lists the files
// that are neither packages nor archives, after the packages, up to a cap. They
// get no package details and cannot be sent or served (ALLOW_ANY_FILE is what
// widens that); they can be selected, renamed, deleted and looked at.
const HIDDEN_FILE_CAP = 2000;
async function browse(src, rel, hidden = false, others = false) {
  const dir = safeDir(src.root, rel);
  if (!dir) return null;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [], pkgs = [], archives = [], files = [];
  const spare = [];                // other files, named here and looked at after the sort
  const holds = new Map();         // archive path -> every package in it, listed or not, for the delete test
  let other = 0, moreFiles = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') && !hidden) continue;
    const full = path.join(dir, e.name);
    const relPath = path.relative(src.root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      let mtime = 0;
      try { mtime = (await fsp.stat(full)).mtimeMs; } catch {}
      const d = { name: e.name, path: relPath, mtime };
      if (e.name.startsWith('.')) d.hidden = true;
      const dump = await dumpSummary(full);
      if (dump) d.dump = dump;
      dirs.push(d);
    }
    else if (e.isFile() && /\.(rar|r\d\d)$/i.test(e.name)) {
      try {
        const st = await fsp.stat(full);
        const r = await rarPkgs(full, st);
        if (r.part) continue;                       // a later volume of a set listed elsewhere
        for (const x of r.entries) pkgs.push(withMeta(src, { name: x.name.split('/').pop(), path: relPath + ARC + x.name, size: x.size, mtime: st.mtimeMs, inArchive: e.name, parts: r.parts }));
        const inside = r.blocked.length ? r.blocked : r.entries;
        // Not offered for one that could not be read whole, or that continues in a volume that is not here.
        if (!r.note && !r.blocked.some(b => /^(incomplete set|split across)/.test(b.reason))) holds.set(relPath, [...r.blocked, ...r.entries].map(b => ({ name: b.name.split('/').pop(), size: b.size })));
        const dc = await dumpCandidatesFor(full, st);
        // A set is one row, standing for all its volumes; its size is theirs together, not the first file's.
        let setSize = st.size, volumes = null;
        if (r.parts > 1) {
          const vols = volumesFor(full);
          if (vols) {
            let n = 0; volumes = [];
            for (const v of vols) { let sz = 0; try { sz = (await fsp.stat(v)).size; } catch {} n += sz; volumes.push({ name: path.basename(v), size: sz }); }
            setSize = n || st.size;
          }
        }
        archives.push({
          name: e.name, path: relPath, size: setSize, mtime: st.mtimeMs, parts: r.parts || 0,
          ...(volumes && volumes.length > 1 ? { volumes } : {}),
          ...(e.name.startsWith('.') ? { hidden: true } : {}),
          reason: r.blocked.length ? r.blocked[0].reason
                : r.entries.length ? 'served from here'
                : 'no package inside',
          pkgs: inside.map(b => ({ name: b.name.split('/').pop(), size: b.size })),
          // Nothing a console can install in it, but it can still be unpacked whole.
          canExtractAll: !r.blocked.length && !r.entries.length,
          // A dump (loose game files, not a .pkg) found sitting inside it.
          ...(dc.candidates.length ? { dumps: dc.candidates } : {}),
        });
      } catch { other++; }
    }
    else if (e.isFile() && /\.(zip|7z)$/i.test(e.name)) {
      // Compressed, so nothing inside can be served straight to a console the
      // way a stored .rar entry can — but its contents CAN be looked at and
      // picked from (Open, GET /api/archive/peek*), same as .rar now gets.
      try {
        const st = await fsp.stat(full);
        archives.push({
          name: e.name, path: relPath, size: st.size, mtime: st.mtimeMs, parts: 0, kind: e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase(),
          ...(e.name.startsWith('.') ? { hidden: true } : {}),
          reason: e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() + ' archive', pkgs: [], canExtractAll: true,
        });
      } catch { other++; }
    }
    else if (e.isFile() && (ANY_FILE || /\.pkg$/i.test(e.name))) {
      try {
        const st = await fsp.stat(full);
        if (st.size > 0) pkgs.push(withMeta(src, { name: e.name, path: relPath, size: st.size, mtime: st.mtimeMs }));
        else other++;
      } catch {}
    } else if (others && e.isFile()) spare.push({ name: e.name, full, path: relPath });
    else other++;
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  // Sized only once they are in order, so past the cap it is the first by name that are kept, not
  // whichever the disk happened to list first; sized a few at a time, as a folder can hold thousands.
  if (others) {
    spare.sort((a, b) => nameOrder(a.name, b.name));
    moreFiles = Math.max(0, spare.length - HIDDEN_FILE_CAP);
    const keep = spare.slice(0, HIDDEN_FILE_CAP);
    for (let i = 0; i < keep.length; i += 64) {
      await Promise.all(keep.slice(i, i + 64).map(async f => {
        try {
          const st = await fsp.stat(f.full);
          files.push({ name: f.name, path: f.path, size: st.size, mtime: st.mtimeMs, hidden: f.name.startsWith('.'), ext: extOf(f.name) });
        } catch { other++; }
      }));
    }
  }
  const extracted = new Map(pkgs.filter(p => !p.inArchive).map(p => [p.name, p.size]));
  const list = pkgs.filter(p => !p.inArchive || !extracted.has(p.name));
  for (const a of archives) {
    if (!a.pkgs.length) continue;
    const remaining = notUnpacked(a.pkgs, extracted);
    if (!remaining.length) a.reason = 'already extracted';
    else if (a.reason !== 'served from here') a.pkgs = remaining;
    // The row offers to delete the archive only when nothing in it is left, the ones it does not list included.
    if (!remaining.length && holds.has(a.path) && !notUnpacked(holds.get(a.path), extracted).length) a.deletable = true;
  }
  dirs.sort(byName); list.sort(byName); archives.sort(byName); files.sort(byName);
  const here = await dumpSummary(dir);
  return { src: src.id, label: src.label, dir: path.relative(src.root, dir).split(path.sep).join('/'), dirs, pkgs: list, archives, other, reading: metaQueue.length, extract: extractCapability(), ...(here ? { dump: here } : {}), ...(hidden || others ? { files, moreFiles } : {}) };
}

const encodePath = rel => rel.split('/').map(encodeURIComponent).join('/');

// Link handed to the PS5. Some installers (Elf Arsenal passes the URL to the
// system installer) reject URLs with spaces or %-escapes, so the library and
// path are carried as base64url and the file name is reduced to [A-Za-z0-9._-]:
//   /p/<base64url("<library id>\n<relative path>")>/<clean-name>.pkg
// Tokens without "\n" (older links) refer to the main library.
function cleanPkgPath(src, rel) {
  const token = Buffer.from(`${src.id}\n${rel}`, 'utf8').toString('base64url');
  // Keep the real extension (.pkg unless ALLOW_ANY_FILE widened the library).
  const file = rel.split('/').pop();
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(file);
  const ext = m ? m[1].toLowerCase() : 'pkg';
  const base = m ? file.slice(0, -m[0].length) : file;
  const name = (base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'package').slice(0, 120);
  return `/p/${token}/${name}.${ext}`;
}

function decodePkgToken(token) {
  const s = Buffer.from(token, 'base64url').toString('utf8');
  const nl = s.indexOf('\n');
  if (nl < 0) return { src: SOURCES[0], rel: s };
  return { src: findSource(s.slice(0, nl)), rel: s.slice(nl + 1) };
}

// Whether the client will take a gzipped body. "gzip;q=0" is a refusal, an
// explicit gzip beats a "*", and no header at all means identity only.
function acceptsGzip(req) {
  let q = null;
  for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(s => s.trim());
    if (name !== 'gzip' && name !== '*') continue;
    const given = params.find(s => s.startsWith('q='));
    const v = given ? parseFloat(given.slice(2)) : 1;
    if (name === 'gzip') q = v; else if (q === null) q = v;
  }
  return q !== null && q > 0;
}

// If-None-Match can list several tags, and a proxy may have made ours weak
// (W/"..."); a match either way means the client already has this.
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some(t => { t = t.trim(); return t === '*' || t.replace(/^W\//, '') === bare; });
}

// Bodies smaller than this are sent as they are: compressing them saves less
// than the headers cost, and most answers are a few hundred bytes.
const GZIP_OVER = 16 * 1024;

// The compression is the async one, on the thread pool, never gzipSync: the
// same loop is streaming multi-GB files to consoles, and a library list runs to
// megabytes. A HEAD is answered uncompressed, since nobody is going to read
// what it would have weighed. Extra headers (an ETag) are passed as the fourth
// argument. res.req is the request this answers, so the 140-odd callers do not
// need to hand it over.
function sendJson(res, code, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = { 'Content-Type': 'application/json', ...headers };
  const req = res.req;
  const plain = () => { res.writeHead(code, { ...head, 'Content-Length': body.length }); res.end(body); };
  if (body.length < GZIP_OVER || !req || req.method === 'HEAD') return plain();
  head.Vary = 'Accept-Encoding';
  if (!acceptsGzip(req)) return plain();
  zlib.gzip(body, { level: 5 }, (err, gz) => {
    if (res.destroyed || res.writableEnded) return;   // the client went away while it was compressing
    if (err || gz.length >= body.length) return plain();
    res.writeHead(code, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
  });
}

// A client that opens a request and then says nothing, or stops halfway through
// its body, would otherwise hold the handler (and its socket) until the
// server's own five-minute limit. Real bodies here are a few hundred bytes.
function readBody(req, limit = 64 * 1024, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let data = '', over = false, seen = 0, bytes = 0;
    req.setEncoding('utf8');          // a character split across two chunks is put back together, not replaced
    const timer = setTimeout(() => { reject(new Error('the request body did not arrive in time')); req.destroy(); }, timeoutMs);
    // Too large: what is left is read and thrown away (up to a point), so the caller can still answer instead of the connection being cut.
    req.on('data', c => {
      seen += Buffer.byteLength(c);
      if (over) { if (seen > 32 * 1024 * 1024) { clearTimeout(timer); reject(Object.assign(new Error('body too large'), { tooLarge: true })); req.destroy(); } return; }
      data += c;
      bytes += Buffer.byteLength(c);
      if (bytes > limit) { over = true; data = ''; }      // (bytes, not characters: 4 MiB of accented text is 8 MiB on the wire)
    });
    req.on('end', () => { clearTimeout(timer); over ? reject(Object.assign(new Error('body too large'), { tooLarge: true })) : resolve(data); });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// The same idea for a body that is bytes rather than text (a payload uploaded from a
// person's computer): readBody sets a UTF-8 encoding, which would corrupt an .elf, so
// this one collects raw chunks. A payload is small, so the limit only ever has to stop
// something absurd; the upload route answers 413 from the `tooLarge` flag.
function readRaw(req, limit = 64 * 1024 * 1024, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0, over = false;
    const timer = setTimeout(() => { reject(new Error('the upload did not arrive in time')); req.destroy(); }, timeoutMs);
    req.on('data', c => {
      bytes += c.length;
      if (over) return;
      if (bytes > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); over ? reject(Object.assign(new Error('body too large'), { tooLarge: true })) : resolve(Buffer.concat(chunks)); });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// The JSON object a request carries ({} when it carries nothing). JSON that is null, a number,
// a string or a list is valid JSON but no route can read a field out of it: it used to reach
// `'x' in body` and body.x and come out as a 500 with the interpreter's own words.
function parseJsonObject(text) {
  const v = JSON.parse(text || '{}');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { const e = new Error('expected a JSON object'); e.notObject = true; throw e; }
  return v;
}

// A JSON body, as {body} or as the answer to give ({status, error}). A body over the limit is
// its own answer: it used to be called "invalid JSON", which tells a person who ticked a great
// many files nothing about what to do.
async function readJson(req, limit) {
  try { return { body: parseJsonObject(await readBody(req, limit)) }; }
  catch (e) { return e && e.tooLarge ? { status: 413, error: 'that request is too large' } : { status: 400, error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }; }
}

// A reachability check runs on a timer per configured console, repeatedly
// hitting the same host — worth reusing the connection rather than a fresh
// TCP handshake every poll. Discover, hitting a different IP each time, gets
// no benefit from this, but costs nothing extra either.
const ps5Agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function ps5Request(target, method, pathname, body, timeout = 15000, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const [host, port] = target.split(':');
    const req = http.request({
      host, port: port || 80, method, path: pathname, timeout, agent: ps5Agent,
      headers: body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('PS5 did not respond (timeout)')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- DPI flavours -----------------------------------------------------------
// Different PS5 payloads expose different install APIs. Each driver knows how to
// recognise its web page and how to queue a URL install.
const DRIVERS = {
  // Elf Arsenal DPI v2: JSON POST /api/install {url} -> {"res":"0"} on success.
  elf: {
    label: 'Elf Arsenal DPI v2',
    platforms: ['PS4', 'PS5'],
    matches: html => html.includes('/api/install'),
    async install(host, pkgUrl) {
      const r = await ps5Request(host, 'POST', '/api/install', JSON.stringify({ url: pkgUrl }));
      let reply; try { reply = JSON.parse(r.body); } catch { reply = r.body; }
      const ok = r.status === 200 && reply && reply.res === '0';
      return { ok, status: r.status, reply, hint: ok ? null : dpiHint(typeof reply === 'string' ? reply : JSON.stringify(reply)) };
    },
    // Only a request that never reached the console is repeated: a reply that is merely slow
    // may already have queued the install, and a second one would queue it twice.
    retryAfter: e => UNREACHABLE.includes(e && e.code),
    noReply: 'the installer did not answer in time. It may have queued the install anyway, so look in its Downloads queue before sending again',
  },
  // etaHEN DPIv2: multipart POST /upload with an empty "file" part and a "url"
  // field (exactly what its own page's form sends) -> text containing SUCCESS/FAILED.
  etahen: {
    label: 'etaHEN DPIv2',
    platforms: ['PS4', 'PS5'],
    matches: html => html.includes("'/upload'") || html.includes('"/upload"') || /etaHEN\s+DPIv2/i.test(html),
    async install(host, pkgUrl) {
      const boundary = '----ShadowPKG' + crypto.randomBytes(12).toString('hex');
      const body =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="url"\r\n\r\n${pkgUrl}\r\n` +
        `--${boundary}--\r\n`;
      const r = await ps5Request(host, 'POST', '/upload', body, 60000, `multipart/form-data; boundary=${boundary}`);
      const text = r.body.trim();
      const ok = r.status === 200 && text.includes('SUCCESS') && !text.includes('FAILED');
      return { ok, status: r.status, reply: text.slice(0, 500), hint: ok ? null : dpiHint(text) };
    },
    retryAfter: e => UNREACHABLE.includes(e && e.code),
    noReply: 'the installer did not answer in time. It may have queued the install anyway, so look in its Downloads queue before sending again',
  },
  // Remote Package Installer on a PS4 (flatz's app, also what DirectPackageInstaller
  // talks to): port 12800, JSON POST /api/install {type: "direct", packages: [url]}
  // -> {"status": "success", "task_id": n}, or "status": "fail" with a reason. It
  // has no home page to recognise it by; see probeRpi.
  //
  // It only answers after it has read the package's header, entry table, param.sfo
  // and icon from our link, which from a cold archive or a slow disk takes a while,
  // hence the long timeout. One port answers 503 while it is still busy with the
  // previous install, which is worth a short wait rather than a failure.
  rpi: {
    label: 'Remote Package Installer (PS4)',
    platforms: ['PS4'],
    matches: () => false,
    async install(host, pkgUrl) {
      let r;
      for (let i = 0; ; i++) {
        r = await ps5Request(host, 'POST', '/api/install', JSON.stringify({ type: 'direct', packages: [pkgUrl] }), 120000);
        if (r.status !== 503 || i >= 3) break;
        await sleep(3000);
      }
      const reply = parseRpiReply(r.body) || r.body;
      if (!(r.status === 200 && reply && reply.status === 'success')) return { ok: false, status: r.status, reply, hint: rpiHint(reply) };
      // Task -1 is how RPI passes on the console's "this is already installed"
      // (0x80990088): a success to it, but nothing will be downloaded.
      if (reply.task_id === -1) return { ok: false, status: r.status, reply, hint: 'it is already installed on the PS4, so there is nothing to download' };
      // Most builds start the download as soon as it is registered, and the usual
      // senders never ask; one build's documentation says it has to be started.
      // So it is started only if the PS4 has not come for the file shortly after.
      const taskId = Number.isInteger(reply.task_id) ? reply.task_id : parseInt((/"task_id"\s*:\s*(-?\d+)/.exec(String(r.body)) || [])[1], 10);
      if (taskId >= 0) {
        const ip = host.split(':')[0], repliedAt = Date.now();
        setTimeout(async () => {
          if ((lastFetch.get(ip) || 0) > repliedAt) return;
          try {
            const st = await ps5Request(host, 'POST', '/api/start_task', JSON.stringify({ task_id: taskId }), 15000);
            console.log(`RPI on ${host}: no download 25 s after task ${taskId} was registered, so it was started -> ${st.status} ${String(st.body).trim().slice(0, 200)}`);
          } catch (e) { console.log(`RPI on ${host}: starting task ${taskId} failed: ${e.message}`); }
        }, 25000).unref?.();
      }
      return { ok: true, status: r.status, reply };
    },
    // The request is only retried if it never reached the console. RPI has no
    // guard against a second install running beside the first, and a reply that
    // is merely slow would otherwise start one.
    retryAfter: e => ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(e && e.code),
    noReply: 'Remote Package Installer did not answer. It is probably not in the foreground on the PS4 (it is paused when you leave it): open it and send again',
    // What to tell someone whose send was refused without the console fetching anything.
    rejected: "open Remote Package Installer on the PS4 and keep it in the foreground until the download has started, and check the PS4's Notifications > Downloads for a stuck or failed item",
  },
};

// RPI's replies look like JSON but are not always JSON: a console error code is
// written as a bare hex number ("error_code": 0x80990088), and so is a size. Read
// what can be read rather than give up on the whole reply.
function parseRpiReply(body) {
  const text = String(body || '');
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return j; } catch {}
  const status = (/"status"\s*:\s*"(\w+)"/.exec(text) || [])[1];
  if (!status) return null;
  const out = { status };
  const code = (/"error_code"\s*:\s*"?(0x[0-9A-Fa-f]+)/.exec(text) || [])[1];
  const error = (/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text) || [])[1];
  const exists = (/"exists"\s*:\s*"(\w+)"/.exec(text) || [])[1];
  if (code) out.error_code = code.toLowerCase();
  if (error) out.error = error;
  if (exists) out.exists = exists;
  return out;
}

// Console error codes as reported by the people who wrote PS4 installers (not
// Sony's own documentation), turned into something a person can act on.
const RPI_CODES = {
  '0x80990085': 'the PS4 does not have enough free space',
  '0x80990039': 'the PS4 does not have enough free space',
  '0x80a30026': 'the PS4 does not have enough free space',
  '0x80990086': "old downloads are stuck in the PS4's Notifications > Downloads list; delete them and try again",
};
function rpiHint(reply) {
  if (!reply || typeof reply !== 'object') return null;
  if (reply.error_code && RPI_CODES[reply.error_code]) return RPI_CODES[reply.error_code];
  if (/Invalid package format/i.test(reply.error || '')) return 'the PS4 only installs PS4 packages, and this is not one';
  if (/Unexpected total file size/i.test(reply.error || '')) return 'the pieces of a split package are missing or out of order';
  if (/Unable to download package header/i.test(reply.error || '')) return 'the PS4 could not download the package from ShadowPKG: check that the address in the setup panel (PUBLIC_BASE) is one the PS4 can reach';
  return null;
}

// PS5 installer (etaHEN/Elf DPI) error signatures, in the text the payload sends
// back, turned into something a person can act on. The reply is a free-form string
// like "FAILED: Install failed with error SCE_PLAYGO_ERROR_CORE_DEVICE_NOSPC, code
// -2135813884 (0x80B21104)…", so these match on the NAME and the hex code, not on
// any one exact wording. Order matters: first match wins.
const DPI_ERROR_HINTS = [
  [/NOSPC|NO_SPACE|DEVICE_NOSPC|0x80B21104/i, 'the console does not have enough free space — uninstall something or clear its Downloads queue, then send again'],
  [/TIMEOUT|HTTP_ERROR_TIMEOUT|0x80431068/i, 'the console could not download the link in time — check that the address it was given (PUBLIC_BASE) is reachable from the console'],
  [/0x80F0[0-9A-Fa-f]{4}/i, 'the console rejected the package as the wrong format or region for this console'],
];
function dpiHint(reply) {
  const text = String(reply || '');
  for (const [re, msg] of DPI_ERROR_HINTS) if (re.test(text)) return msg;
  return null;
}

// Remote Package Installer serves no page at "/" (it answers with an error), so it
// is recognised by how it answers a question that changes nothing: whether an app
// it cannot have exists. A reply carrying "status": "success" or "fail" is taken
// to be it, read leniently because a failure carries a bare hex error code.
async function probeRpi(host, timeout = 3000) {
  try {
    const r = await ps5Request(host, 'POST', '/api/is_exists', JSON.stringify({ title_id: 'CUSA00000' }), timeout);
    const j = parseRpiReply(r.body);
    return !!j && ((j.status === 'success' && 'exists' in j) || (j.status === 'fail' && !!j.error_code));
  } catch { return false; }
}

// What every RPI build says to a GET of "/": 400 "Unsupported method" (flatz's
// and the ports made from it) or 404 "Unknown endpoint" (mk990's). Enough to
// know it without asking anything else.
const rpiSaysSo = r => !!r && (r.status === 400 || r.status === 404)
  && /"status"\s*:\s*"fail"/.test(r.body) && /Unsupported method|Unknown endpoint/.test(r.body);

// Detected driver per host, refreshed by status checks. {host: {type, at}}
const detected = new Map();

// ---- Send queue ---------------------------------------------------------------
// A console's own installer only really copes with one request at a time — four
// installs fired at one within 20ms all failed, even though each individually
// reaches the console fine over a slower link. Requests to the same console are
// serialized here and spaced out, regardless of how many the client fires at
// once (a multi-select batch, or two browser tabs open on the same console).
const sendQueues = new Map();      // profile id -> queued jobs
const sendRunning = new Set();     // profile ids currently draining their queue

// waitFor lets a job hold up the next item behind it in the same console's
// line until the console has actually finished downloading this one, not
// just accepted it — a second install fired while the first is still being
// fetched is exactly the kind of overlap this queue exists to prevent, just
// at the transfer level rather than the install-request level. Only path-
// based sends (ones served by us, so the transfer is one we can watch in
// `transfers`) can be waited on; a raw URL send has nothing to watch and
// moves on right away, same as before this existed.
function queueSend(profileId, run, waitFor) {
  return new Promise(resolve => {
    if (!sendQueues.has(profileId)) sendQueues.set(profileId, []);
    sendQueues.get(profileId).push({ run, resolve, waitFor });
    if (!sendRunning.has(profileId)) { sendRunning.add(profileId); sendStep(profileId); }
  });
}

// No progress on the watched transfer for this long is treated as the
// console never actually going to fetch it (rejected silently, stuck,
// whatever) — the queue moves on rather than jamming everything behind a
// single dead item forever.
const TRANSFER_STALL_MS = 90 * 1000;

// Says how it went: 'done' once the console has all of it, or (until: 'started')
// 'started' once it has clearly begun, a few MiB, more than a package's header and
// icon being read. Otherwise 'stalled' (it began and stopped) or 'never' (it did not
// come for the file at all within the wait), which the queue moves on from.
// A transfer only counts if the console has asked for something since this send began (w.since):
// an old one, finished a minute ago or a second ago, is not this send. Bytes already there from a
// download that stopped part way still count, since a console resumes and asks for the rest.
async function waitForTransfer(w) {
  const key = `${w.ip}|${w.srcId}|${w.rel}`;
  let lastCovered = -1, sawBytes = false;
  let stallDeadline = Date.now() + TRANSFER_STALL_MS;
  while (Date.now() < stallDeadline) {
    const t0 = transfers.get(key);
    const t = t0 && t0.lastAt >= (w.since || 0) ? t0 : null;
    if (t) inferFinished(t);
    const have = t ? covered(t) : 0;
    const need = t ? (w.until === 'started' ? Math.min(t.size, 4 * 1024 * 1024) : t.size) : Infinity;
    if (have > 0) sawBytes = true;
    if (t && have >= need) return w.until === 'started' ? 'started' : 'done';
    if (have !== lastCovered) { lastCovered = have; stallDeadline = Date.now() + TRANSFER_STALL_MS; }
    await sleep(1000);
  }
  return sawBytes ? 'stalled' : 'never';
}
const reachedIt = outcome => outcome === 'done' || outcome === 'started';

// A package that finished downloading is sent again: what the console asks for next is a new
// download, so the finished one is put in the history and taken off the live list first. (A
// transfer that stopped part way is left, since the console carries on from where it was.)
function retireFinishedTransfer(w) {
  const key = `${w.ip}|${w.srcId}|${w.rel}`, t = transfers.get(key);
  if (!t || t.open.size) return;
  // One that was stopped by request refuses the console for good ("will not resume"); sending it again is a new intent.
  if (stoppedTransfers.has(t.id) && covered(t) < t.size) {
    if (!t.recorded) { t.recorded = true; recordHistory({ type: 'download', status: 'aborted', src: t.srcId, dir: dirOf(t.rel), path: t.rel, name: t.name, meta: fileMeta(t.srcId, t.rel), size: t.size, received: covered(t), ps5: ps5NameFor(t.ip) || t.ip, startedAt: t.firstAt, endedAt: t.lastAt, abortsTotal: t.abortsTotal }); }
    noteTransferGone(t);
    transfers.delete(key); stoppedTransfers.delete(t.id);
    return;
  }
  if (covered(t) < t.size) return;
  if (!t.recorded) recordDoneTransfer(t);
  if (!t.noted && t.lastAt - t.firstAt >= NOTE_LONG_MS) { t.noted = true; noteTransfer('finished', t); }
  noteTransferGone(t);
  transfers.delete(key); stoppedTransfers.delete(t.id);
}

async function sendStep(profileId) {
  const queue = sendQueues.get(profileId);
  const job = queue && queue.shift();
  if (!job) { sendRunning.delete(profileId); return; }
  // Whatever goes wrong with one job, the line must go on: an exception here used to end this function before its
  // last line, and the console's queue then never drained again (every later send sat on "waiting").
  let result = { ok: false, quiet: true };
  try {
    if (job.waitFor) { retireFinishedTransfer(job.waitFor); job.waitFor.since = Date.now(); }
    result = await job.run();
    job.resolve(result);
    if (result.ok && job.waitFor) {
      const outcome = await waitForTransfer(job.waitFor);
      if (job.waitFor.onOutcome) try { job.waitFor.onOutcome(outcome); } catch {}
    }
  } catch (e) {
    console.error(`send queue for ${profileId}: a job failed unexpectedly, the line carries on: ${e && e.stack || e}`);
    job.resolve({ ok: false, quiet: true, payload: { ok: false, url: null, error: 'stopped by an unexpected error: ' + (e && e.message || e) } });      // (a no-op if it was already answered)
  }
  // The failure this exists to fix was four requests inside 20ms, not four
  // requests inside a few seconds — so the gap only needs to be a beat.
  setTimeout(() => sendStep(profileId), result.quiet ? 0 : 1500).unref?.();      // nothing was asked of the console, so no beat
}

// ---- Sends held for a PS4 whose installer is not open --------------------------
// Remote Package Installer is an app: it answers only while it is open. A send
// to a console known to run it, made while it is closed, is kept here instead of
// failing, and is handed over by itself as soon as the app answers, so the
// person only needs it open for the few seconds the hand-over takes. This never
// touches the console; it only asks the installer's own address whether it is up.
const HELD_FILE = path.join(CONFIG_DIR, 'held.json');
let held = [];                        // [{id, profile, src, rel, name, size, base, addedAt}]
const handovers = new Map();          // profile id -> {at, count, failed, ready}
const HELD_MAX = 500;

function loadHeld() {
  try { const j = JSON.parse(fs.readFileSync(HELD_FILE, 'utf8')); if (Array.isArray(j.held)) held = j.held.filter(h => h && h.profile && h.src && h.rel).slice(0, HELD_MAX); } catch {}
}
function saveHeld() { if (profilesWritable) saveAtomic(HELD_FILE, () => JSON.stringify({ held }), 'held sends'); }
loadHeld();

const heldFor = id => held.filter(h => h.profile === id);
const heldMessage = prof => `Waiting for Remote Package Installer on ${prof.name}. Open it on the PS4 and this is sent by itself.`;

function addHeld(prof, src, rel, size, base) {
  if (held.some(h => h.profile === prof.id && h.src === src.id && h.rel === rel)) return;   // already waiting
  if (held.length >= HELD_MAX) return;
  held.push({ id: newId(), profile: prof.id, src: src.id, rel, name: rel.split('/').pop(), size, base, addedAt: Date.now() });
  saveHeld();
  console.log(`send to ${prof.name} held until Remote Package Installer is open: ${rel}`);
}

// Packages a hand-over is dealing with right now (taken off the held list, not yet accepted by the console).
const handingOver = new Set();
const lineKeyOf = (profId, srcId, rel) => `${profId}\n${srcId}\n${path.posix.normalize(String(rel)).replace(/^(\.\/)+/, '')}`;
let draining = false;
async function drainHeld(onlyProfile) {
  if (draining) return;
  draining = true;
  try {
    for (const id of new Set(held.map(h => h.profile))) {
      if (onlyProfile && id !== onlyProfile) continue;
      const prof = findProfile(id);
      if (!prof) { held = held.filter(h => h.profile !== id); saveHeld(); continue; }
      if (!(await probeRpi(prof.host, 2500))) continue;         // the app is not open yet
      console.log(`Remote Package Installer is open on ${prof.name}: handing over ${heldFor(id).length} held send(s)`);
      let count = 0, failed = 0, last = null;
      let closedAgain = false;
      for (const item of heldFor(id)) {
        if (closedAgain) break;
        if (!held.includes(item)) continue;          // taken off the list (cancelled) while an earlier one was being handed over
        // While it is out of the held list and on its way to the console, a fresh ask for the same package must not
        // hold it again behind us: it is being handed over (see handingOver).
        const hk = lineKeyOf(prof.id, item.src, item.rel);
        handingOver.add(hk);
        try {
          held = held.filter(h => h !== item); saveHeld();
          const src = findSource(item.src);
          const t0 = Date.now();
          const r = src ? await sendLibraryFile(prof, src, item.rel, item.base || PUBLIC_BASE() || '', true, null, item.addedAt) : null;
          // It closed again: back to the front of what is left for this console (not behind the rest, so the game still goes
          // before its updates), unless the same package was held again meanwhile, and keep the rest.
          if (r && r.duplicate) continue;              // already on its way by another route: nothing to hand over
          if (r && r.held) {
            if (!held.some(h => h.profile === item.profile && h.src === item.src && h.rel === item.rel)) {
              const first = held.findIndex(h => h.profile === item.profile);
              held.splice(first < 0 ? held.length : first, 0, item);
            }
            saveHeld(); closedAgain = true; continue;
          }
          if (src) settleHeldAutoSends(src.id, item.rel, !!(r && r.ok), r && r.payload && r.payload.error);
          if (r && r.ok) { count++; last = { ip: prof.host.split(':')[0], srcId: src.id, rel: item.rel, size: item.size, until: 'started', since: t0 }; } else failed++;
        } finally { handingOver.delete(hk); }
      }
      if (last) {
        // Tell the person when the PS4 has really come for the last one: from then on the app can be left.
        const started = reachedIt(await waitForTransfer(last));
        handovers.set(id, { at: Date.now(), count, failed, ready: started, name: prof.name });
        console.log(`hand-over to ${prof.name}: ${count} sent, ${failed} failed, downloads ${started ? 'started' : 'not seen starting'}`);
      } else if (failed) handovers.set(id, { at: Date.now(), count: 0, failed, ready: false, name: prof.name });
    }
  } catch (e) { console.error('held sends:', e); }
  finally { draining = false; }
}
// Only asks while something is waiting, and not often: Remote Package Installer
// keeps a thread for every connection it is given, so it is asked gently.
setInterval(() => { if (held.length) drainHeld(); }, 20000).unref?.();

// A structured reply from the console, ok or not, is its own answer — retrying
// would not change it and risks queuing the same install twice. Only a
// failure to even reach it (a network hiccup, the console mid-reboot) is worth
// trying again, the same distinction the title lookup makes for its own retries.
const UNREACHABLE = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'];
// A console that is asleep costs about half a minute per package to find that out (three
// tries, a detection wait between them), and a batch of twenty would spend ten minutes on it.
// So once one could not be reached, the packages behind it in the line fail at once, for a minute.
const unreachableAt = new Map();      // console address -> when it last could not be reached (an edited address, or any answer from it, clears it)
const UNREACHABLE_HOLD_MS = 60000;
async function attemptInstall(prof, pkgUrl, pathGiven, platform) {
  let lastErr, lastDrv = null;
  const was = unreachableAt.get(prof.host);
  if (prof.installer !== 'rpi' && was && Date.now() - was < UNREACHABLE_HOLD_MS) {
    return { ok: false, quiet: true, payload: { ok: false, url: pkgUrl, error: `Could not reach ${prof.name} at ${prof.host} a moment ago, so this was not tried: wake it, check the address, and send again.` } };
  }
  // A console running zftpd with its HTTP layer installs through it, and that is a
  // different address (its FTP host/port) from the DPI host above, so it is handled
  // here rather than by one of the DPI drivers below. Only builds compiled with
  // pkg-install support (features.pkg_install) can do this; the official zftpd
  // releases ship with it off, in which case the send falls through to the DPI.
  if (prof.ftpHost) {
    const z = await zftpdProbe(prof);
    const canInstall = z && z.present && z.features && (z.features.pkg_install === true || z.features.pkg_install === 'true');
    if (canInstall) return await zftpdInstall(prof, pkgUrl, z.port);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let d = detected.get(prof.host);
      if (!d || !d.type || Date.now() - d.at > 5 * 60 * 1000) d = await detect(prof.host, 8000);
      if (!d.type) {
        return { ok: false, payload: { ok: false, url: pkgUrl, error: `${prof.name} is online, but its installer page isn't one ShadowPKG recognises (supported: ${Object.values(DRIVERS).map(x => x.label).join(', ')})` } };
      }
      const drv = DRIVERS[d.type];
      // A PS4 installer refuses anything that is not a PS4 package, after fetching
      // part of it; saying so here is quicker and clearer.
      if (drv.platforms && platform && !drv.platforms.includes(platform)) {
        return { ok: false, payload: { ok: false, url: pkgUrl, profile: prof.name, installer: drv.label, error: `Not sent — this is a ${platform} package, and ${prof.name} (${drv.label}) only installs ${drv.platforms.join('/')} packages.` } };
      }
      const sentAt = Date.now();
      lastDrv = drv;
      const r = await drv.install(prof.host, pkgUrl);
      console.log(`${new Date().toISOString()} install ${r.ok ? 'queued' : 'FAILED'} on ${prof.name} (${prof.host}, ${drv.label}) ${pkgUrl} -> ${r.status} ${typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply)}`);
      let error;
      if (!r.ok) {
        error = `${prof.name} (${drv.label}) replied: ${typeof r.reply === 'string' ? r.reply || 'HTTP ' + r.status : JSON.stringify(r.reply)}`;
        // Only meaningful for links served by us; the console fetches from its own IP.
        const consoleIp = prof.host.split(':')[0];
        if (r.hint) error += ` — ${r.hint}.`;
        else if (pathGiven && !((lastFetch.get(consoleIp) || 0) >= sentAt)) {
          error += ` — the console rejected it without requesting the file from ShadowPKG, so the problem is on the console: ${drv.rejected || `reload the ${drv.label} payload (or reboot the console), and check for a stuck item in its Downloads queue or low storage`}.`;
        }
      }
      unreachableAt.delete(prof.host);
      return { ok: r.ok, payload: { ok: r.ok, url: pkgUrl, profile: prof.name, installer: drv.label, ps5: r.reply, error } };
    } catch (e) {
      lastErr = e;
      if (lastDrv && lastDrv.retryAfter && !lastDrv.retryAfter(e)) {
        const silent = !e.code || /timeout/i.test(e.message);
        return { ok: false, payload: { ok: false, url: pkgUrl, profile: prof.name, installer: lastDrv.label,
          error: silent && lastDrv.noReply ? `${prof.name}: ${lastDrv.noReply}.` : `Could not reach ${prof.name} at ${prof.host}: ${e.message}` } };
      }
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  if (prof.installer === 'rpi' && (!lastDrv || UNREACHABLE.includes(lastErr && lastErr.code))) detected.delete(prof.host);   // its app has closed: stop reporting it as open
  if (prof.installer === 'rpi' && (!lastDrv || UNREACHABLE.includes(lastErr && lastErr.code))) return { ok: false, held: true, payload: { ok: false, held: true, url: pkgUrl, error: heldMessage(prof) } };
  if (prof.installer !== 'rpi' && UNREACHABLE.includes(lastErr && lastErr.code)) unreachableAt.set(prof.host, Date.now());
  return { ok: false, payload: { ok: false, url: pkgUrl, error: `Could not reach ${prof.name} at ${prof.host}: ${lastErr.message}` } };
}

// Send one file in a library to a console: checked first, queued behind whatever
// else is going to that console, and written to the history. Null when the file
// is not there. Used by the Send button and by "send when done" on a build.
// waitFor lets the queue hold the next item in this console's line until this one
// is actually finished downloading, not just accepted - only possible for our own
// served links, where the transfer is one we can watch (see waitForTransfer).
const sends = new Map();          // id -> a send the console accepted, until it is old news
const SEND_SILENT_MS = 3 * 60000; // accepted this long ago and the console has not come for the file
function noteSendOutcome(rec, outcome) {
  if (rec.outcome === 'done' && outcome !== 'done') return;      // once it is known to have finished, a late "stalled" does not undo it
  if (rec.outcome !== outcome) rec.outcomeAt = Date.now();
  rec.outcome = outcome;
  syncSendEntry(rec);
}
// What the history says about how a send went on: the outcome, when it was known, and the console's first and last byte of it.
function syncSendEntry(rec) {
  const e = rec.entry;
  if (!e) return;
  e.outcome = rec.outcome;
  if (rec.outcomeAt) e.outcomeAt = rec.outcomeAt;
  if (rec.dl) { e.dlStartedAt = rec.dl.firstAt; if (rec.outcome === 'done') e.dlEndedAt = rec.dl.lastAt; }
  saveHistorySoon();
}
// What the feed says about each send that was accepted: waiting for the console to ask for the
// file, downloading (with how far), done, or silent (three minutes and it has not asked; a busy
// console can start late, so this is worded as a question, not a failure).
// Only a transfer the console began after this send counts as this send's (r.since). Once a download
// was seen done or under way, or the wait ended 'done', the answer does not go back to "waiting" when
// the transfer drops off the live list (ten minutes after it ends, or Clear in Activity).
//   waiting      accepted, the console has not asked for the file yet
//   downloading  under way
//   paused       it began and has been quiet as long as the queue waits (a console gave up, or was stopped)
//   done         all of it
//   silent       three minutes, or the queue gave up, and the console never asked
// Only waiting and downloading count as "on its way": a paused or silent send can be sent again.
function sendLive(r, now) {
  const t0 = transfers.get(`${r.ip}|${r.src}|${r.rel}`);
  const t = t0 && t0.lastAt >= (r.since || 0) ? t0 : null;
  if (t) {
    r.dl = { firstAt: t.firstAt, lastAt: t.lastAt };
    const got = Math.min(covered(t), t.size), pct = r.size ? Math.floor(got / r.size * 1000) / 10 : 0;
    if (got >= t.size) { r.seen = { state: 'done', percent: 100 }; return r.seen; }
    // Paused: no bytes for as long as the queue waits, whether or not the console still holds a connection open, or it was stopped.
    if (got > 0) { r.seen = { state: now - t.lastAt >= TRANSFER_STALL_MS || stoppedTransfers.has(t.id) ? 'paused' : 'downloading', percent: pct }; return r.seen; }
  } else if (r.outcome === 'done' || (r.seen && r.seen.state === 'done')) return { state: 'done', percent: 100 };
  else if (r.seen && r.seen.state !== 'waiting') return { state: 'paused', percent: r.seen.percent };      // it left the live list part way
  return { state: now - r.acceptedAt >= SEND_SILENT_MS || r.outcome === 'never' ? 'silent' : 'waiting', percent: 0 };
}
// A transfer is leaving the live list (Clear, ten minutes after it ended, or a new send of the same package):
// what each send that watched it read is settled now, from what the transfer really was, so it is not guessed later.
function noteTransferGone(t) {
  const done = covered(t) >= t.size, pct = t.size ? Math.floor(Math.min(covered(t), t.size) / t.size * 1000) / 10 : 0;
  for (const r of sends.values()) {
    if (r.ip !== t.ip || r.src !== t.srcId || r.rel !== t.rel || t.lastAt < (r.since || 0)) continue;
    r.dl = { firstAt: t.firstAt, lastAt: t.lastAt };
    r.seen = done ? { state: 'done', percent: 100 } : { state: 'paused', percent: pct };
    if (done && r.outcome !== 'done') noteSendOutcome(r, 'done');
  }
}
function sendsView() {
  const now = Date.now(), out = [];
  for (const [id, r] of sends) {
    const live = sendLive(r, now);
    // Old news after half an hour, unless the console is still pulling it (a big game over slow Wi-Fi).
    if (now - r.acceptedAt > 30 * 60000 && live.state !== 'downloading') { sends.delete(id); continue; }
    out.push({
      id, profile: r.profile, console: r.console, src: r.src, path: r.rel, name: r.name, size: r.size, acceptedAt: r.acceptedAt,
      state: live.state, percent: live.percent, outcome: r.outcome || null,
    });
  }
  return out;
}

// The history entry of a send to this console that the console finished downloading, for this very file (same
// place and size) or the same package under the same file name elsewhere (content ID and version alone are shared
// by different packages of a collection, so the name and size have to agree too). null when there is none.
function alreadyDelivered(prof, src, rel, t) {
  const m = fileMeta(src.id, rel), base = rel.split('/').pop();
  const id = m && !m.tentative && m.contentId && m.version ? m : null;
  return history.find(e => e.type === 'send' && e.status === 'done' && e.outcome === 'done' && e.profile === prof.id && e.size === t.size && e.path && (
    (e.src === src.id && e.path === rel) ||
    (id && e.path.split('/').pop() === base && e.meta && !e.meta.tentative && e.meta.contentId === id.contentId && e.meta.version === id.version))) || null;
}

// Is this package already on its way to this console: accepted and not yet done or given up on. (One
// merely waiting in a batch is not: whichever asks first sends it, and the other finds it on its way.)
function inFlight(profId, srcId, rel) {
  const now = Date.now();
  for (const r of sends.values()) {
    if (r.profile !== profId || r.src !== srcId || r.rel !== rel) continue;
    const st = sendLive(r, now).state;
    if (st === 'waiting' || st === 'downloading') return true;
  }
  return false;
}
// "console|library|path" of sends that have been asked for and are not yet accepted or refused, each with the
// hooks of whoever asked (null for a single send). An entry whose owner has been cancelled does not hold the package.
const inLine = new Map();

// The one place a send starts, so two asks for one package (two tabs, a batch and a single send, a second batch,
// a held send being handed over) cannot both get through: the second finds the first in the line, or on its way.
// hooks (a batch's): cancelled() says it has been cancelled, started() says it has been handed to the console.
async function sendLibraryFile(prof, src, rel, base, fromHeld = false, hooks = null, askedAt = 0, opts = {}) {
  rel = path.posix.normalize(String(rel)).replace(/^(\.\/)+/, '');      // ./A.pkg and sub/../A.pkg are A.pkg
  const lineKey = `${prof.id}\n${src.id}\n${rel}`;
  // Someone else has already asked for this package and is waiting its turn in the console's line: wait for that
  // to be accepted, refused or cancelled, rather than guess. If it is accepted the package is on its way (below);
  // if it fails or is cancelled, this one sends it, so a package is neither sent twice nor lost.
  for (;;) {
    const owner = inLine.get(lineKey);
    if ((!inLine.has(lineKey) || (owner && owner.cancelled())) && !(handingOver.has(lineKey) && !fromHeld)) break;
    if (hooks && hooks.cancelled()) return { ok: false, cancelled: true, payload: { ok: false, url: null, error: 'cancelled' } };      // cancelled while waiting
    await sleep(300);
  }
  if (inFlight(prof.id, src.id, rel)) {
    return { ok: false, duplicate: true, payload: { ok: false, url: null, profile: prof.name, error: `Already on its way to ${prof.name}: it was sent a moment ago and is still downloading or waiting for the console to ask.` } };
  }
  inLine.set(lineKey, hooks);
  try { return await sendLibraryFileNow(prof, src, rel, base, fromHeld, hooks, askedAt, opts); }
  finally { if (inLine.get(lineKey) === hooks) inLine.delete(lineKey); }
}

async function sendLibraryFileNow(prof, src, rel, base, fromHeld, hooks, askedAt, opts = {}) {
  const asked = askedAt || Date.now();      // when the person asked (for a held send, when it was put on hold), for the history
  // Asked at the moment of no return (its turn in the line, or before it is held): a cancelled batch does not send it.
  const cancelledNow = () => !!hooks && (hooks.cancelled() ? true : (hooks.started(), false));
  const t = await resolveTarget(src, rel);
  if (!t || t.error) return null;
  // A package this console has already finished downloading is not offered again unless asked for: a console
  // handed one it already has can refuse it and stop taking further requests until its download list is cleared.
  if (!fromHeld && !opts.again) {
    const prev = alreadyDelivered(prof, src, rel, t);
    if (prev) {
      console.log(`${new Date().toISOString()} send skipped: ${rel} was already downloaded by ${prof.name}`);
      return { ok: false, already: true, payload: { ok: false, url: null, profile: prof.name, already: true, error: `Already sent to ${prof.name} on ${new Date(prev.endedAt || prev.at).toISOString().slice(0, 10)} and it finished downloading, so it was not sent again: a console offered a package it already has can refuse it and stop taking further requests. If you removed it from the console, send it again anyway.` } };
    }
  }
  const preflight = await preflightCheck(t);
  let platform = null;
  try { const h = await readPkgRange(t, 0, 4); if (h.length === 4) platform = PLATFORMS[h.readUInt32BE(0)] || null; } catch {}
  if (!platform) platform = platformFromName(rel);
  const pkgUrl = base + cleanPkgPath(src, rel);
  // For an installer that is an app, "sent" means it has begun downloading, which
  // is when the app can be left; for the others it means the file has arrived.
  const rec = { id: newId(), profile: prof.id, console: prof.name, ip: prof.host.split(':')[0], src: src.id, rel, name: rel.split('/').pop(), size: t.size, acceptedAt: 0, outcome: null, entry: null };
  const waitFor = { ip: rec.ip, srcId: src.id, rel, size: t.size, ...(prof.installer === 'rpi' ? { until: 'started' } : {}), onOutcome: o => {
    const tr = transfers.get(`${rec.ip}|${src.id}|${rel}`);      // the console's own first and last byte, for the history
    if (tr && tr.lastAt >= (waitFor.since || 0)) rec.dl = { firstAt: tr.firstAt, lastAt: tr.lastAt };
    noteSendOutcome(rec, o);
  } };
  // Others are already waiting for this console: join the line rather than try
  // (and wait out a failed attempt) for every one of them.
  const holdNow = !fromHeld && prof.installer === 'rpi' && !preflight && heldFor(prof.id).length > 0;
  const res = preflight
    ? { ok: false, payload: { ok: false, url: pkgUrl, error: `Not sent — ${preflight}.` } }
    : holdNow ? { ok: false, held: true, payload: { ok: false, held: true, url: pkgUrl } }
    // The console may have been deleted, or the batch cancelled, while this waited its turn in the line.
    : await queueSend(prof.id, () => cancelledNow() ? { ok: false, skipped: true, payload: { ok: false, url: pkgUrl, error: 'cancelled' } }
      : !findProfile(prof.id) ? { ok: false, quiet: true, payload: { ok: false, url: pkgUrl, error: 'That console no longer exists.' } }
      : attemptInstall(prof, pkgUrl, true, platform), waitFor);
  if (res.skipped) return { ok: false, cancelled: true, payload: res.payload };
  if (res.held) {
    if (!fromHeld) {
      if (cancelledNow()) return { ok: false, cancelled: true, payload: { ok: false, url: pkgUrl, error: 'cancelled' } };     // cancelled: not held either
      // The same package is being handed over this very moment: holding it again would send it twice.
      if (handingOver.has(lineKeyOf(prof.id, src.id, rel))) return { ok: false, duplicate: true, payload: { ok: false, url: pkgUrl, profile: prof.name, error: `Already on its way to ${prof.name}: it is being handed over now.` } };
      addHeld(prof, src, rel, t.size, base);
    }
    return { ok: false, held: true, payload: { ok: true, held: true, url: pkgUrl, profile: prof.name, message: heldMessage(prof) } };
  }
  const { ok, payload } = res;
  // Not recorded when it was not even tried (the console could not be reached a moment ago, or is gone): one
  // failure says so, and a batch of five hundred must not fill the history with the same line.
  if (!res.quiet) rec.entry = recordHistory({
    type: 'send', status: ok ? 'done' : 'failed', ps5: prof.name, profile: prof.id,
    src: src.id, dir: dirOf(rel), path: rel, name: rel.split('/').pop(),
    meta: fileMeta(src.id, rel),
    size: t.size, message: payload.error || null,
    queuedAt: asked, startedAt: waitFor.since || undefined, endedAt: Date.now(),      // asked for, the console's turn began, the console answered
  });
  if (ok) { rec.acceptedAt = Date.now(); rec.since = waitFor.since || rec.acceptedAt; sends.set(rec.id, rec); if (rec.outcome && rec.entry) syncSendEntry(rec); }
  return { ok, payload };
}

// ---- Send batches ---------------------------------------------------------------
// The page used to drive a batch itself, one request per package, each waiting for
// the console to finish downloading the one before. Shut the tab or lock the phone
// and everything after the current one was never asked for, with nothing to say it
// had been meant to go. A batch is now handed to the server in one request and
// worked through here, in the order given, through the same checks and the same
// per-console line as a single send (sendLibraryFile). The page only watches.
// Kept in memory: after a restart the packages not yet handed to the console are
// not remembered (the ones the console has taken carry on by themselves).
const batches = [];               // newest first
const BATCH_MAX_ITEMS = 500;
const BATCH_ITEMS_MAX = 200;      // packages one rename or delete request works on; the rest are refused by name, not ignored
const TOO_MANY_MSG = `too many in one request (${BATCH_ITEMS_MAX} at most): select fewer and do it again`;

function startBatch(prof, list, base) {
  const seen = new Set(), items = [];
  for (const x of list) {                       // one package twice in a batch is one send
    const key = x.src + '\n' + x.path;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ src: x.src, rel: x.path, name: x.path.split('/').pop(), state: 'queued', message: '', running: false, again: x.again === true });
  }
  const b = { id: newId(), profile: prof.id, console: prof.name, base, createdAt: Date.now(), endedAt: 0, cancelled: false, items };
  batches.unshift(b);
  runBatch(b).catch(e => { console.error('send batch:', e); b.endedAt = Date.now(); for (const it of b.items) if (it.state === 'queued' || it.state === 'sending') { it.state = 'failed'; it.message = 'stopped by an unexpected error'; } });
  return b;
}

async function runBatch(b) {
  let failStreak = 0;
  for (const it of b.items) {
    if (b.cancelled || it.state === 'cancelled') { it.state = 'cancelled'; continue; }
    const prof = findProfile(b.profile), src = findSource(it.src);
    if (!prof) { it.state = 'failed'; it.message = 'That console no longer exists.'; continue; }
    if (!src) { it.state = 'failed'; it.message = 'library not found'; continue; }
    it.state = 'sending';      // it is next in line (it may still wait behind another send to this console: it.running says it has been handed over)
    try {
      const r = await sendLibraryFile(prof, src, it.rel, b.base, false, { cancelled: () => b.cancelled || it.state === 'cancelled', started: () => { it.running = true; } }, b.createdAt, { again: it.again });
      if (it.state === 'cancelled') continue;         // cancelled while it was in line: whatever came back, it stays cancelled
      if (r && r.already) { it.state = 'skipped'; it.already = true; it.message = r.payload.error; }
      else if (r && r.duplicate) { it.state = 'skipped'; it.message = `Already on its way to ${prof.name}`; }
      else if (r && r.cancelled) it.state = 'cancelled';
      else if (!r) { it.state = 'failed'; it.message = 'file not found'; }
      else if (r.held) { it.state = 'held'; it.message = (r.payload && r.payload.message) || ''; }
      else if (r.ok) it.state = 'sent';
      else { it.state = 'failed'; it.message = (r.payload && r.payload.error) || `${prof.name} did not accept it`; }
    } catch (e) { it.state = 'failed'; it.message = e.message; }
    // Three in a row that the console did not answer (a refusal of one package for its own reasons does not count): stop, rather than take fifteen seconds and a
    // history line for each of the rest. Activity offers to send the ones that did not go again.
    if (it.state === 'failed' && /Could not reach|did not answer|no longer exists|a moment ago/.test(it.message || '')) failStreak++; else failStreak = 0;
    if (failStreak >= 3) {
      for (const rest of b.items) if (rest.state === 'queued') { rest.state = 'failed'; rest.message = `Stopped: ${b.console} failed ${failStreak} in a row. Check it, then send the rest again.`; }
      break;
    }
  }
  b.endedAt = b.endedAt || Date.now();
  const n = st => b.items.filter(i => i.state === st).length;
  console.log(`send batch to ${b.console}: ${n('sent')} sent, ${n('held')} held, ${n('failed')} failed, ${n('cancelled')} cancelled of ${b.items.length}`);
}

function pruneBatches() {
  const now = Date.now();
  for (let i = batches.length - 1; i >= 0; i--) if (batches[i].endedAt && now - batches[i].endedAt > 30 * 60000) batches.splice(i, 1);
}
// These only used to be trimmed when a page asked for the feed, so they grew with nobody looking.
setInterval(() => { pruneBatches(); sendsView(); }, 60000).unref();

function batchesView() {
  const now = Date.now();
  pruneBatches();
  return batches.filter(b => !b.endedAt || now - b.endedAt < 10 * 60000).map(b => {
    const counts = {};
    for (const it of b.items) { counts[it.state] = (counts[it.state] || 0) + 1; if (it.already) counts.already = (counts.already || 0) + 1; }
    return {
      id: b.id, profile: b.profile, console: b.console, createdAt: b.createdAt, endedAt: b.endedAt || null, cancelled: b.cancelled, total: b.items.length, counts,
      // Every item, and only what a row needs: a page left on "waiting in line" for the ones past a cap would be wrong.
      items: b.items.map(it => ({ src: it.src, path: it.rel, state: it.state, ...(it.message ? { message: it.message } : {}), ...(it.running ? { running: true } : {}), ...(it.already ? { already: true } : {}) })),
    };
  });
}

// Health checks: a PS5 is asked to install a link that deliberately points at
// nothing. A working installer fetches the URL (and then fails on its own, with
// nothing installed); a broken one refuses before touching the network. Each
// check gets its own id so we can tell whose console called back.
const probes = new Map();   // id -> {at, hits, ip}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A console that moves from Wi-Fi to a cable (or just gets a new lease) keeps
// running the same installer on the same port at a different address, which
// looks exactly like "not reachable". Rather than have someone hunt for the new
// number, knock on that port across the local networks and see who answers.
function subnetsToSearch(hints) {
  const nets = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      // Docker's own bridge is in here too; scanning it costs a moment and finds
      // nothing, while the hints carry the network the console is actually on.
      if (ni.family === 'IPv4' && !ni.internal) nets.add(ni.address.split('.').slice(0, 3).join('.'));
    }
  }
  for (const h of hints) {
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(String(h || ''));
    if (m) nets.add(m[1]);
  }
  return [...nets];
}

async function findConsoles(port, hints) {
  const targets = [];
  for (const net of subnetsToSearch(hints)) {
    for (let i = 1; i < 255; i++) targets.push(`${net}.${i}`);
  }
  const found = [];
  let next = 0;
  const knock = async () => {
    while (next < targets.length) {
      const ip = targets[next++];
      try {
        let r = null, hungUp = false;
        try { r = await ps5Request(`${ip}:${port}`, 'GET', '/', null, 700); } catch (e) { hungUp = listeningAnyway(e); }
        const type = r && r.status === 200 ? Object.keys(DRIVERS).find(k => DRIVERS[k].matches(r.body)) : null;
        if (type) found.push({ host: `${ip}:${port}`, installer: DRIVERS[type].label });
        else if (rpiSaysSo(r)) found.push({ host: `${ip}:${port}`, installer: DRIVERS.rpi.label });
        // Something answered "/" without being a known installer page, or hung up on it.
        else if ((r || hungUp) && await probeRpi(`${ip}:${port}`, 900)) found.push({ host: `${ip}:${port}`, installer: DRIVERS.rpi.label });
        // Some Remote Package Installer builds listen on 12801 instead. (ShadowPKG
        // itself defaults to 12801, but it answers "/" with its page, not this.)
        else if (port === 12800) {
          let r2 = null; try { r2 = await ps5Request(`${ip}:12801`, 'GET', '/', null, 700); } catch {}
          if (rpiSaysSo(r2)) found.push({ host: `${ip}:12801`, installer: DRIVERS.rpi.label });
        }
      } catch {}
    }
  };
  // A machine with a VPN and a couple of virtual adapters has several networks
  // to cover, so knock on many doors at once rather than waiting door by door.
  await Promise.all(Array.from({ length: 96 }, knock));
  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  return found;
}

// A console that swaps Wi-Fi for a cable keeps downloading — it just asks from
// a new address — but its profile still points at the old one, so sending and
// testing break and the transfer shows up under a bare IP. These two keep the
// profile pointed at wherever the console actually is.
//
// Nothing here guesses: a move is only followed when the new address answers
// with an installer page and no other profile already claims it. Set
// FOLLOW_MOVES=0 to be asked instead.
let FOLLOW_MOVES = !/^(0|false|no|off)$/i.test(process.env.FOLLOW_MOVES || '');
const lastLookFor = new Map();        // profile id -> when we last went looking
const LOOK_EVERY_MS = 5 * 60000;

function claimedBy(host, exceptId) {
  return ipTaken(host, exceptId);      // the whole address, not just this port: a console is never followed onto one another has
}

function followMove(prof, newHost, why) {
  const from = prof.host;
  if (from === newHost || claimedBy(newHost, prof.id)) return false;
  prof.movedFrom = from;
  prof.movedAt = Date.now();
  prof.host = newHost;
  saveProfiles();
  detected.delete(from);
  console.log(prof.name + ' moved: ' + from + ' -> ' + newHost + ' (' + why + ')');
  return true;
}

// Someone we don't recognise is downloading from us. If a console has gone
// missing from where it used to be, this is very likely it, so ask that
// address whether it is running an installer.
const askedAbout = new Map();         // ip -> when we last asked
async function considerMovedConsole(ip) {
  if (!FOLLOW_MOVES) return;
  if (profiles.some(p => p.host.split(':')[0] === ip)) return;      // already known
  if (Date.now() - (askedAbout.get(ip) || 0) < 60000) return;
  askedAbout.set(ip, Date.now());

  // Only consoles we have lost track of are candidates.
  // A PS4's installer answers "/" with an error rather than a page, so "still
  // there" and "found it" are both what detect() makes of the address.
  const lost = [];
  for (const prof of profiles) {
    try { if ((await detect(prof.host, 2000)).ok) continue; } catch {}   // still there
    lost.push(prof);
  }
  // A PS4 and a PS5 are told apart by their installer: a PS4 whose app is closed
  // is missing all the time, which must not stop a PS5 that moved from being
  // followed, and a stranger is only ever matched with a console of its own kind.
  // Within a kind, two missing consoles are two possible answers.
  for (const group of [lost.filter(p => p.installer !== 'rpi'), lost.filter(p => p.installer === 'rpi')]) {
    if (group.length !== 1) continue;
    const prof = group[0];
    const port = prof.host.split(':')[1] || '12800';
    try {
      const d = await detect(ip + ':' + port, 2500);
      if (!d.type || (d.type === 'rpi') !== (prof.installer === 'rpi')) continue;
      if (followMove(prof, ip + ':' + port, 'it is downloading from here')) return;
    } catch {}
  }
}

// Nothing is downloading, but a console stopped answering: look for it on the
// local networks, and adopt the answer when there is exactly one it could be.
async function lookForMovedConsole(prof) {
  if (!FOLLOW_MOVES) return;
  // A PS4 is looked for less often: its app is closed far more often than it has
  // moved, and each look asks every installer it finds.
  const isPs4 = prof.installer === 'rpi';
  if (Date.now() - (lastLookFor.get(prof.id) || 0) < (isPs4 ? 3 : 1) * LOOK_EVERY_MS) return;
  lastLookFor.set(prof.id, Date.now());

  const port = parseInt(prof.host.split(':')[1] || '12800', 10);
  const hints = [prof.host.split(':')[0], ...profiles.map(x => x.host.split(':')[0])];
  // With several consoles of the same kind, one that is merely off (or has its payload closed,
  // for a PS4) cannot be told from one that moved — so a new address is only adopted when no
  // OTHER saved console of this kind is ALSO unreachable right now. This used to be checked for
  // PS4s only; a PS5 household with more than one saved console had no such guard, and that is a
  // real, reproduced gap: while 761-PHAT was off (so always "missing" here) and 1160-PRO's real
  // address changed, PHAT's periodic look could run in the exact window before PRO's own look had
  // corrected PRO's saved host — at that moment PRO's new address did not match anything on
  // record, so claimedBy() saw it as free, and PHAT was followed onto it (stealing PRO's own new
  // address out from under it). Re-checking every other same-kind console live, right here, closes
  // that window: if any of them is ALSO not answering at its own saved host, this bails rather than
  // guess which missing console the stranger actually is.
  for (const other of profiles) {
    if (other === prof || (other.installer === 'rpi') !== isPs4) continue;
    const stillThere = isPs4 ? await probeRpi(other.host, 2000) : (await detect(other.host, 2000)).ok;
    if (!stillThere) return;
  }
  const found = await findConsoles(port, hints);
  const strangers = found.filter(x => !claimedBy(x.host, prof.id) && x.host !== prof.host && (x.installer === DRIVERS.rpi.label) === isPs4);
  if (strangers.length === 1) followMove(prof, strangers[0].host, 'found while looking for it');
  else if (strangers.length > 1) console.log(prof.name + ' is missing and ' + strangers.length + ' consoles answered; leaving it alone');
}

// A device that is listening but answers "/" with something that is not HTTP (or
// hangs up) is worth one more question; one that refuses or does not answer at
// all is not there. (Remote Package Installer itself answers "/" with a JSON
// error, 400 or 404 depending on the build, which the normal path handles.)
const listeningAnyway = e => /hang up|reset|parse|invalid|HPE_|ECONNRESET|EPIPE/i.test(`${e && e.code} ${e && e.message}`);

// Most RPI builds start a thread for every connection they accept and never
// clean them up, and enough of them eventually stop it answering at all. So a
// console known to be running it is looked at every few minutes rather than on
// every status poll (the page asks every 30 s), not at all while it is
// downloading from us, and then with a single GET of "/".
const RPI_RECHECK_MS = 3 * 60000;
const busyFetching = ip => [...transfers.values()].some(t => t.ip === ip && Date.now() - t.lastAt < ACTIVE_MS);

// A console that has once answered as Remote Package Installer is remembered as
// one: that installer only answers while its app is open, so a send to it while
// it is closed is held for later rather than failed.
function rememberInstaller(host, type) {
  const prof = profiles.find(p => p.host === host);
  if (!prof) return;
  const now = type === 'rpi' ? 'rpi' : undefined;
  if (prof.installer === now) return;
  if (now) prof.installer = now; else delete prof.installer;
  saveProfiles();
}

async function detect(host, timeout = 3000) {
  const d = await detectNow(host, timeout);
  if (d.type) rememberInstaller(host, d.type);
  if (d.ok || d.type) unreachableAt.delete(host);      // any answer at all means it can be reached
  return d;
}

async function detectNow(host, timeout = 3000) {
  const prev = detected.get(host);
  if (prev && prev.type === 'rpi' && (Date.now() - prev.at < RPI_RECHECK_MS || busyFetching(host.split(':')[0]))) return { ok: true, type: 'rpi' };
  let r;
  try { r = await ps5Request(host, 'GET', '/', null, timeout); }
  catch (e) {
    if (listeningAnyway(e) && await probeRpi(host, timeout)) { detected.set(host, { type: 'rpi', at: Date.now() }); return { ok: true, type: 'rpi' }; }
    throw e;
  }
  let type = null, ok = r.status === 200;
  if (ok) type = Object.keys(DRIVERS).find(k => DRIVERS[k].matches(r.body)) || null;
  if (!type && rpiSaysSo(r)) { type = 'rpi'; ok = true; }
  // Anything else that answers is asked once more, in case it is an RPI build
  // that words its answer to "/" differently. Not repeated once known.
  if (!type && !(prev && prev.type === 'rpi') && await probeRpi(host, timeout)) { type = 'rpi'; ok = true; }
  detected.set(host, { type, at: Date.now() });
  return { ok, type };
}

// ---- History -----------------------------------------------------------------
// Finished downloads and extractions drop out of the live feed after ten
// minutes (or an hour if they never finished) so that feed stays small. This is
// the record of what happened before that — kept on disk so it survives a
// restart, and shared by both downloads and extractions rather than each
// keeping its own.
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const HISTORY_MAX = 300;
let history = [];         // newest first
let historyDirty = false, historyTimer = null;

function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(j.history)) history = j.history.slice(0, HISTORY_MAX);
    if (history.length) console.log(`history: ${history.length} entr${history.length === 1 ? 'y' : 'ies'} remembered from ${HISTORY_FILE}`);
  } catch {}
}

function saveHistoryNow() {
  if (!historyDirty) return;
  historyDirty = false;
  saveAtomic(HISTORY_FILE, () => JSON.stringify({ history }), 'history');
}

function saveHistorySoon() {
  historyDirty = true;
  if (historyTimer) return;
  historyTimer = setTimeout(() => { historyTimer = null; saveHistoryNow(); }, 5000);
  historyTimer.unref?.();
}
onShutdown(saveHistoryNow);

function recordHistory(entry) {
  const e = { id: newId(), at: Date.now(), ...entry };
  history.unshift(e);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistorySoon();
  return e;
}

// Where a served or extracted file's folder sits, for "open its folder". A
// package inside an archive has no folder of its own — the folder to open is
// wherever the archive sits, not anywhere inside it.
function dirOf(rel) {
  const outer = rel.includes(ARC) ? rel.slice(0, rel.indexOf(ARC)) : rel;
  return outer.includes('/') ? outer.slice(0, outer.lastIndexOf('/')) : '';
}

// ---- Extracting a compressed archive in place --------------------------------
// Only needed for releases that actually compress their package; stored ones are
// served straight from the archive. Runs whatever extractor the container has.
const { spawn } = require('child_process');
// Which tool can actually decompress a .rar varies by build: Alpine's 7-Zip and
// Debian's p7zip both ship without the RAR codec and fail at the last moment, so
// candidates are tried in turn until one produces the expected files.
const RAR_TOOLS = ['unrar', 'unar', 'bsdtar', '7zz', '7z', '7za'];
const ZIP_TOOLS = ['7zz', '7z', '7za', '7zr', 'bsdtar', 'unar', 'unzip'];

function which(name) {
  // path.delimiter is ":" where this really runs; the ".exe" try is only for
  // running the server on Windows while developing.
  const names = process.platform === 'win32' ? [name, name + '.exe'] : [name];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

function findTools(file) {
  const list = /\.rar$/i.test(file || '.rar') ? RAR_TOOLS : ZIP_TOOLS;
  const found = [];
  for (const t of list) {
    const p = which(t);
    if (p) found.push({ tool: t, path: p });
  }
  return found;
}

function argsFor(name, archive, tmp) {
  if (name === 'unrar') return ['e', '-y', '-o+', archive, '*.pkg', tmp + '/'];
  if (name === 'unar') return ['-o', tmp, '-D', archive, '*.pkg'];
  if (name === 'bsdtar') return ['-x', '-f', archive, '-C', tmp, '--include', '*.pkg'];
  return ['e', '-y', '-o' + tmp, archive, '*.pkg', '-r'];       // 7z family
}

// The same tools, told to unpack every file with its folders rather than only
// the packages.
function allArgsFor(name, archive, tmp) {
  if (name === 'unrar') return ['x', '-y', '-o+', archive, tmp + '/'];
  if (name === 'unar') return ['-o', tmp, '-D', archive];
  if (name === 'bsdtar') return ['-x', '-f', archive, '-C', tmp];
  if (name === 'unzip') return ['-o', '-q', archive, '-d', tmp];
  return ['x', '-y', '-o' + tmp, archive];                      // 7z family
}

// A third variant, sibling to argsFor/allArgsFor: unpacks only a dump's own
// folder (dumpRoot) out of the archive, WITH its structure preserved — a dump
// is a tree (sce_sys/, the game's own files), never flattened the way argsFor's
// package extraction flattens. Every tool's own path-mask syntax was proven
// empirically against real fixtures (a single .rar and a real multi-part .rar,
// each with a dump-shaped folder alongside unrelated sibling content):
//   unrar: `x` (not `e`, which drops folders) with a "dumpRoot/*" mask.
//   unar: needs the mask's trailing "/*" too — a bare folder name only matches
//     that folder's own (empty) entry in the archive, not what's inside it.
//   bsdtar: --include with the same "/*" mask; on a real multi-volume set it
//     is the one tool of the four that cannot read past the first volume (a
//     known limitation, see the Dockerfile) — with a mask that shows up as a
//     nonzero exit ("not found in archive"), so the caller's tool-fallback
//     loop moves on to the next tool rather than silently taking a partial
//     result.
//   7z family: the mask needs forward slashes, not backslashes, even though
//   the tool is historically Windows-flavoured — confirmed against a real
//   nested path, because the container (and this codebase's target host) is
//   Linux underneath.
// A dumpRoot of '' means the dump sits at the archive's own root with no
// wrapping folder — there is nothing to isolate, so that falls back to
// unpacking everything, exactly like allArgsFor.
function dumpArgsFor(name, archive, tmp, dumpRoot) {
  if (!dumpRoot) return allArgsFor(name, archive, tmp);
  const mask = dumpRoot + '/*';
  if (name === 'unrar') return ['x', '-y', '-o+', archive, mask, tmp + '/'];
  if (name === 'unar') return ['-o', tmp, '-D', archive, mask];
  if (name === 'bsdtar') return ['-x', '-f', archive, '-C', tmp, '--include', mask];
  return ['x', '-y', '-o' + tmp, archive, mask, '-r'];          // 7z family
}

// A fourth variant: pulls exactly one named entry out, flattened (no folders),
// the same way argsFor's *.pkg mask already flattens — a literal name works
// as its own "mask" for every one of these tools with no wildcard needed.
function peekArgsFor(name, archive, tmp, entry) {
  if (name === 'unrar') return ['e', '-y', '-o+', archive, entry, tmp + '/'];
  if (name === 'unar') return ['-o', tmp, '-D', archive, entry];
  if (name === 'bsdtar') return ['-x', '-f', archive, '-C', tmp, entry];
  // unzip's own syntax puts the archive first, then which member(s) to pull,
  // then -d for where — nothing here needs unzip's -j (junk paths) the way
  // findUnder() below already copes with whatever structure a tool produces.
  if (name === 'unzip') return ['-o', '-q', archive, entry, '-d', tmp];
  return ['e', '-y', '-o' + tmp, archive, entry, '-r'];          // 7z family
}

// A fifth variant: pulls a specific, arbitrary SET of named entries out in
// one pass, WITH each one's own folder structure preserved (like
// dumpArgsFor, unlike peekArgsFor's flattening) — someone picking several
// files scattered across different folders inside an archive expects them
// to land the way they're actually nested, not merged into one flat pile
// with name clashes. Every one of these tools accepts more than one
// explicit name in a single invocation (proven already for a single literal
// name via peekArgsFor above; the same syntax just repeats per name here).
function selectedArgsFor(name, archive, tmp, entries) {
  if (name === 'unrar') return ['x', '-y', '-o+', archive, ...entries, tmp + '/'];
  if (name === 'unar') return ['-o', tmp, '-D', archive, ...entries];
  if (name === 'bsdtar') return ['-x', '-f', archive, '-C', tmp, ...entries.flatMap(e => ['--include', e])];
  if (name === 'unzip') return ['-o', '-q', archive, ...entries, '-d', tmp];
  return ['x', '-y', '-o' + tmp, archive, ...entries, '-r'];         // 7z family
}

// A quick, one-off, read-only pull of a single file out of an archive, for
// looking at its contents without a real extraction job — no queue, no
// progress tracking, no Cancel button, the scratch folder is gone again
// (success or not) before this returns. A different prefix than a real
// extraction's ".shadowpkg-extract-<id>" on purpose: this is never durable
// across a restart the way an unpack-in-progress folder is tracked, so it
// must never be picked up by noteUnpackFolder's leftover-folder reporting.
// Returns the extracted file's bytes directly (nothing is left on disk once
// this returns, so a caller has no path to read again later).
async function peekOneEntry(tools, archive, entry) {
  const tmp = path.join(path.dirname(archive), '.shadowpkg-peek-' + crypto.randomBytes(6).toString('hex'));
  const leaf = entry.split('/').pop();
  try {
    for (const tool of tools) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); } catch (e) { throw new Error(e.message); }
      const args = peekArgsFor(tool.tool, archive, tmp, entry);
      const ok = await new Promise(resolve => {
        const p = spawn(tool.path, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        p.on('error', () => resolve(false));
        p.on('close', code => resolve(code === 0));
      });
      if (ok) {
        // Not a flat path.join(tmp, leaf) — unrar's own `e` flattens, but
        // unar/bsdtar/7z (peekArgsFor's other branches) keep the entry's own
        // folder structure, the same reason findUnder() already exists for
        // package extraction (spawnTool's tools disagree about this).
        try {
          const got = findUnder(tmp, leaf);
          if (got) { const st = fs.statSync(got); if (st.isFile()) return fs.readFileSync(got); }
        } catch {}
      }
    }
    throw new Error(`none of the installed tools (${tools.map(t => t.tool).join(', ')}) could pull that file out of the archive`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// j, when given, gets the running process so that Cancel can end it. `mode` is
// 'packages' (or the legacy `false`), 'all' (or the legacy `true`), 'dump'
// (which also needs `dumpRoot`), or 'selected' (which needs `entries`).
function spawnTool(tool, archive, tmp, mode, j, dumpRoot, entries) {
  const m = mode === true ? 'all' : mode === false ? 'packages' : mode;
  const args = m === 'dump' ? dumpArgsFor(tool.tool, archive, tmp, dumpRoot)
             : m === 'all' ? allArgsFor(tool.tool, archive, tmp)
             : m === 'selected' ? selectedArgsFor(tool.tool, archive, tmp, entries)
             : argsFor(tool.tool, archive, tmp);
  return new Promise(resolve => {
    let err = '';
    const p = spawn(tool.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (j) j.proc = p;
    p.stderr.on('data', c => { err = (err + c).slice(-2000); });
    p.on('error', e => resolve({ err: e.message }));
    p.on('close', code => resolve({ err: code === 0 ? '' : (err.trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'exit code ' + code) }));
  });
}

// How many bytes have landed in the temp folder so far.
function sizeUnder(dir, depth = 6) {
  let total = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isFile()) total += fs.statSync(p).size;
      else if (e.isDirectory() && depth > 0) total += sizeUnder(p, depth - 1);
    } catch {}
  }
  return total;
}

// Tools disagree about whether to keep the folders inside the archive, so look
// for each expected package anywhere under the temp folder.
function findUnder(dir, leaf, depth = 6) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === leaf) return p;
    if (e.isDirectory() && depth > 0) {
      const hit = findUnder(p, leaf, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

// What the app can tell the user up front: whether extracting is possible at all.
function extractCapability() {
  const t = findTools('.rar');
  const scratch = SCRATCH_LIBRARY ? findSource(SCRATCH_LIBRARY) : null;
  return {
    ...(t.length ? { ok: true, tool: t.map(x => x.tool).join(', ') }
                 : { ok: false, why: 'This container has no extractor installed (unrar, unar, bsdtar, 7zz, 7z), so archives have to be unpacked elsewhere.' }),
    // Told to the client so "Build from inside this archive" can say plainly
    // where a dump will actually land before the button is pressed — SCRATCH_LIBRARY
    // is silent otherwise, and this is the one archive feature it changes.
    ...(scratch ? { scratchLibrary: { id: scratch.id, label: scratch.label } } : {}),
  };
}

const extractions = new Map();   // id -> job
const extractQueue = [];
// A RAR unpacks on one core, so a second extraction costs a second core, not a
// slower first one - the reason this is more than one. What they share is the
// disk they read from and write to, which is why a job only starts when the
// room for it is still there once the ones already running have finished
// writing (see reservedOn), and why it is a setting: 1 puts it back to one at a time.
let EXTRACT_PARALLEL = Math.max(1, Math.min(8, parseInt(process.env.EXTRACT_PARALLEL || '2', 10) || 2));
const extractRunningJobs = new Set();
let extractPumping = false, extractPumpAgain = false;
// Why a package is left where it is instead of replacing what already has its name.
const CLASH_WHY = 'a file of that name is already here at a different size; move or rename it first';
const CLASH_OTHER_WHY = 'something of that name is already here; move or rename it first';

// ---- Unpack folders left behind ----------------------------------------------
// Both kinds of extraction unpack into a hidden ".shadowpkg-extract-<id>" folder
// beside the archive and remove it when the job ends. A docker stop, an OOM kill
// or a crash in the middle of a 60-140 GB unpack ends the job without that, and
// leaves tens of GB in a dot-named folder no list shows. So the folder is written
// down before it is made, and at the next start whatever is written down and
// still on disk is reported. Nothing is ever removed unless the person says so.
const EXTRACTING_FILE = path.join(CONFIG_DIR, 'extracting.json');
const EXTRACT_DIR = /^\.shadowpkg-extract-[0-9a-f]{12}$/;
const LEFTOVER_KEEP_MS = 30 * 24 * 3600 * 1000;
const unpackActive = new Map();   // folder -> {path, archive, at}: in use by a job in this process
let leftovers = [];               // {path, archive, at}: written down by an earlier process
const leftoverSizes = new Map();  // folder -> {bytes, capped}, once measured
const leftoverMeasuring = new Map();
const leftoverRemoving = new Set();

function loadExtracting() {
  try {
    const j = JSON.parse(fs.readFileSync(EXTRACTING_FILE, 'utf8'));
    for (const e of Array.isArray(j.folders) ? j.folders : []) {
      // Only what this app could have made: an absolute path to a folder of the hidden kind's own name.
      if (!e || typeof e.path !== 'string' || !path.isAbsolute(e.path) || !EXTRACT_DIR.test(path.basename(e.path))) continue;
      const at = path.resolve(e.path);
      if (leftovers.some(x => x.path === at)) continue;
      leftovers.push({ path: at, archive: typeof e.archive === 'string' ? e.archive : null, at: Number(e.at) || Date.now() });
    }
  } catch {}
  // No job is running yet, so everything written down belongs to a run that ended some other way.
  for (const e of leftovers) measureLeftover(e.path);
}

function saveExtracting() {
  if (!profilesWritable) return Promise.resolve();
  saveAtomic(EXTRACTING_FILE, () => JSON.stringify({ folders: [...leftovers, ...unpackActive.values()] }), 'the unpack folders in use');
  return saveState.get(EXTRACTING_FILE).done;
}

// Resolves once it is on disk, so the folder is only made after it is written down.
function noteUnpackFolder(j, tmp) {
  if (unpackActive.has(tmp)) return Promise.resolve();          // a second tool unpacks into the same folder
  unpackActive.set(tmp, { path: tmp, archive: j.rel, at: Date.now() });
  return saveExtracting();
}

// Forgotten only once it is really gone: a folder that could not be removed is
// still a leftover, and is reported at the next start.
function dropUnpackFolder(tmp) {
  if (fs.existsSync(tmp)) return;
  if (unpackActive.delete(tmp)) saveExtracting();
}

// What a folder holds, without holding anything else up: one directory at a time,
// its files sized in small batches, the loop given back in between. It stops at a
// cap so a huge tree costs a bounded amount, and says so when it did. null when
// the folder cannot be read at all.
const SIZE_ENTRY_CAP = 20000, SIZE_TIME_CAP_MS = 20000;
async function folderBytes(dir) {
  const started = Date.now();
  let bytes = 0, seen = 0, capped = false, first = true;
  const todo = [dir];
  const spent = () => seen >= SIZE_ENTRY_CAP || Date.now() - started > SIZE_TIME_CAP_MS;
  while (todo.length && !capped) {
    if (spent()) { capped = true; break; }
    const d = todo.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { if (first) return null; continue; }
    first = false;
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) todo.push(path.join(d, e.name));
      else if (e.isFile()) files.push(path.join(d, e.name));
    }
    for (let i = 0; i < files.length; i += 32) {
      const sizes = await Promise.all(files.slice(i, i + 32).map(f => fsp.stat(f).then(s => s.size, () => 0)));
      for (const n of sizes) bytes += n;
      seen += sizes.length;
      if (spent() && (i + 32 < files.length || todo.length)) { capped = true; break; }
    }
  }
  return { bytes, capped };
}

function measureLeftover(p) {
  if (leftoverSizes.has(p)) return Promise.resolve(leftoverSizes.get(p));
  let pr = leftoverMeasuring.get(p);
  if (!pr) {
    pr = folderBytes(p).then(r => { if (r) leftoverSizes.set(p, r); leftoverMeasuring.delete(p); return r; });
    leftoverMeasuring.set(p, pr);
  }
  return pr;
}

// The folders to offer for removal: written down, and really there. One that is
// missing is left out but remembered for a month, in case its share is simply not
// mounted at the moment.
async function leftoverList() {
  const rows = await Promise.all([...leftovers].map(async e => {
    const st = await fsp.lstat(e.path).catch(() => null);
    if (!st) {
      if (Date.now() - e.at > LEFTOVER_KEEP_MS) { leftovers = leftovers.filter(x => x !== e); saveExtracting(); }
      return null;
    }
    if (!st.isDirectory()) return null;
    let src = null;
    for (const s of SOURCES) if (e.path !== s.root && underRoot(s.root, e.path) && (!src || s.root.length > src.root.length)) src = s;
    if (!src) return null;
    const size = await Promise.race([measureLeftover(e.path), sleep(1500).then(() => null)]);
    return {
      src: src.id, library: src.label, path: path.relative(src.root, e.path).split(path.sep).join('/'),
      archive: e.archive, at: e.at, bytes: size ? size.bytes : null, capped: !!(size && size.capped),
    };
  }));
  return rows.filter(Boolean);
}

// Removes one leftover folder and its record; returns why not, or null when done.
// Only a folder that was written down by an unpack, is named exactly like one and
// sits inside a library is ever touched, whatever the request says.
async function removeLeftover(srcId, rel) {
  const src = typeof srcId === 'string' && srcId ? findSource(srcId) : null;
  if (!src || typeof rel !== 'string' || !rel) return 'library not found';
  const full = path.resolve(src.root, rel);
  const e = leftovers.find(x => x.path === full);
  if (!e) return 'that is not a folder left behind by an unpack';
  if (!EXTRACT_DIR.test(path.basename(full)) || full === src.root || !underRoot(src.root, full)) return 'refusing to remove that folder';
  if (leftoverRemoving.has(full)) return 'already being removed';
  const st = await fsp.lstat(full).catch(() => null);
  if (!st) return 'that folder is not there right now (is the library mounted?), so nothing was removed and it is still on the list';
  if (!st.isDirectory()) return 'refusing to remove that: it is not a folder';
  leftoverRemoving.add(full);
  try {
    await fsp.rm(full, { recursive: true, force: true });
  } catch (err) {
    // Some of it may have gone before the failure, so what is left is measured again.
    leftoverSizes.delete(full);
    measureLeftover(full);
    // Node words an error "CODE: what happened, syscall 'the path'"; the person only needs the first part.
    return `could not remove it: ${String(err.message).split(', ')[0]}`;
  } finally { leftoverRemoving.delete(full); }
  leftovers = leftovers.filter(x => x !== e);
  leftoverSizes.delete(full);
  saveExtracting();
  console.log(`removed the leftover unpack folder ${src.label}/${path.relative(src.root, full).split(path.sep).join('/')}`);
  return null;
}

function jobView(j) {
  const src = findSource(j.src);
  return {
    id: j.id, src: j.src, path: j.rel, name: j.name, meta: fileMeta(j.src, j.rel), state: j.state, message: j.message,
    startedAt: j.startedAt, endedAt: j.endedAt,
    library: src ? src.label : j.src,
    dir: dirOf(j.rel),
    produced: j.produced || [], skipped: j.skipped || [],
    mode: j.mode || 'packages', outDir: j.outDir || null, ...(j.outSrc ? { outSrc: j.outSrc } : {}),
    total: j.total || 0, bytes: j.bytes || 0, speed: j.speed || 0,
    percent: j.total ? Math.min(100, Math.floor((j.bytes / j.total) * 1000) / 10) : 0,
    // Same shape as a download's or transfer's own eta: null until there is a
    // real speed and a real total to divide by, so the client's existing
    // "j.eta != null" check already does the right thing with no client change
    // needed for the "nothing to estimate yet" case.
    eta: j.speed > 0 && j.total ? Math.max(0, Math.round((j.total - j.bytes) / j.speed)) : null,
    // Only set once a 'dump' mode extraction ends: whether the build that
    // should follow it automatically actually started, and why not if it didn't.
    ...(j.mode === 'dump' ? { buildState: j.buildState || null, buildId: j.buildId || null, buildMessage: j.buildMessage || null, chainDone: !!j.chainDone } : {}),
  };
}

// Total unpacked size of everything in an archive (or set of volumes), for the
// progress bar and for checking there is room. 0 when it cannot be worked out.
async function archiveTotal(full) {
  try {
    const seen = new Map();
    for (const v of volumesFor(full) || [full]) {
      for (const e of (await scanRar(v)).entries || []) if (!seen.has(e.name)) seen.set(e.name, e.size);
    }
    return [...seen.values()].reduce((n, x) => n + (Number.isFinite(x) ? x : 0), 0);
  } catch { return 0; }
}

// The unpacked size of a .zip or .7z, from a 7-Zip listing's summary line, so the
// room next to it can be checked and the bar has something to measure against.
// 0 when no tool can say; that only costs the check and the percentage.
function listedTotal(tools, full) {
  const t = tools.find(x => /^7z/.test(x.tool));
  if (!t) return Promise.resolve(0);
  return new Promise(resolve => {
    let out = '';
    const p = spawn(t.path, ['l', full], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.stdout.on('data', c => { out = (out + c).slice(-4000); });
    p.on('error', () => { clearTimeout(timer); resolve(0); });
    p.on('close', () => {
      clearTimeout(timer);
      // "<size> <packed> N files": the size is the first number with "files" after it.
      const m = [...out.matchAll(/(\d+)[ \t]+(?:\d+[ \t]+)?\d+ files/g)].pop();
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

// Free and total bytes on the filesystem holding `dir`, or null when it cannot
// say. Only ever a guide: on Unraid, /mnt/user reports the pooled share, not the
// one disk a file will really be written to.
async function spaceAt(dir) {
  try {
    if (!fsp.statfs) return null;
    const s = await fsp.statfs(dir);
    const bsize = Number(s.bsize);
    if (!Number(s.blocks) || !bsize) return null;      // FUSE and cloud mounts that do not report answer with zeros: unknown, not full
    return { free: Number(s.bavail) * bsize, total: Number(s.blocks) * bsize };
  } catch { return null; }
}

// The refusal for an extraction that cannot fit, or null. The temp folder needs
// the whole size before anything is moved out (the final rename costs nothing).
// The pooled share reports at least as much as any one disk holds, so when it
// says there is not enough, that is true; the reverse can still fail late.
async function noRoomFor(dir, needed, self) {
  if (!needed) return null;
  const sp = await spaceAt(dir);
  const held = sp ? reservedOn(dir, self) : 0;
  return sp && sp.free - held < needed
    ? `Not enough room next to the archive: extracting needs about ${fmtGb(needed)} and ${fmtGb(sp.free)} is free${held ? ` (${fmtGb(held)} of it still to be written by other extractions running now)` : ''}.`
    : null;
}

// What the extractions already running are still going to write to the disk
// `dir` is on: their expected size less what is already there. The free space
// figure only shows what they have written so far, so without this two jobs
// that each fit on their own could together run the disk out partway.
function reservedOn(dir, except) {
  let dev;
  try { dev = fs.statSync(dir).dev; } catch { return 0; }
  let n = 0;
  for (const r of extractRunningJobs) {
    if (r === except || !r.roomDir) continue;
    try { if (fs.statSync(r.roomDir).dev !== dev) continue; } catch { continue; }
    n += Math.max(0, (r.roomNeeded || 0) - (r.bytes || 0));
  }
  return n;
}

// "Game.part01.rar" and "Game.rar" both unpack into a folder called "Game", and a
// name already taken gets a number rather than being merged into or overwritten.
const stemOf = name => name.replace(/\.part\d+\.rar$/i, '').replace(/\.(rar|zip|7z)$/i, '') || 'extracted';
function freeName(dir, stem) {
  let n = stem, i = 2;
  while (fs.existsSync(path.join(dir, n))) n = `${stem}-${i++}`;
  return n;
}

// Unpacks every file into a hidden folder next to the archive, and only when a
// tool has finished cleanly renames that into a folder of its own, so a failed
// or interrupted run leaves nothing half-unpacked where it can be mistaken for
// the real thing. This is for archives with no package inside (a dump, say).
async function runExtractAll(j) {
  const dest = path.dirname(j.full);
  const dirRel = j.rel.includes('/') ? j.rel.slice(0, j.rel.lastIndexOf('/')) : '';
  const tmp = path.join(dest, '.shadowpkg-extract-' + j.id);
  let lastErr = '', used = null, finalName = null;
  for (const tool of j.tools) {
    j.message = 'extracting with ' + tool.tool;
    await noteUnpackFolder(j, tmp);
    if (stopping) return;
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); }
    catch (e) { lastErr = e.message; break; }
    j.bytes = 0; j.speed = 0;
    let lastAt = Date.now(), lastBytes = 0, lastRescan = 0;
    const isRarJob = /\.rar$/i.test(j.full);
    const ticker = setInterval(() => {
      const now = Date.now(), bytes = sizeUnder(tmp), dt = (now - lastAt) / 1000;
      if (dt >= 0.5) { j.speed = Math.max(0, Math.round((bytes - lastBytes) / dt)); lastAt = now; lastBytes = bytes; }
      j.bytes = bytes;
      // archiveTotal() genuinely sums each entry's real uncompressed size from
      // the archive's own headers — not the compressed/on-disk size — but it
      // is only ever a snapshot taken once, when the job was created. A later
      // volume that finishes downloading (or simply wasn't scanned yet) after
      // that snapshot means the true total was undercounted from the start,
      // not just close to it: the old fix here only corrected once real bytes
      // caught up to the stale number, which for a long extraction meant
      // showing the wrong total for nearly the whole job. Re-scan periodically
      // instead of only reacting at the very end.
      if (isRarJob && now - lastRescan > 8000) {
        lastRescan = now;
        archiveTotal(j.full).then(fresh => { if (fresh > j.total) j.total = fresh; });
      }
      if (bytes > j.total) j.total = bytes;
    }, 1000);
    let r;
    try { r = await spawnTool(tool, j.full, tmp, true, j); }
    finally { clearInterval(ticker); }
    if (stopping) return;         // the process is ending: the folder stays, written down, for the next start
    j.speed = 0; j.proc = null;
    if (j.cancelled) break;
    if (r.err) lastErr = r.err;
    let entries = 0; try { entries = fs.readdirSync(tmp).length; } catch {}
    if (!r.err && entries) {
      const name = freeName(dest, stemOf(j.name));
      try { fs.renameSync(tmp, path.join(dest, name)); finalName = name; used = tool; break; }
      catch (e) { lastErr = e.message; }
    } else {
      console.log(`extract: ${tool.tool} did not unpack all of ${j.name}${r.err ? ' — ' + r.err : ' — nothing came out'}`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  dropUnpackFolder(tmp);

  j.endedAt = Date.now();
  const secs = Math.round((j.endedAt - j.startedAt) / 1000);
  if (j.cancelled) {
    j.state = 'cancelled';
    j.message = 'cancelled; nothing was left behind';
  } else if (finalName) {
    j.state = 'done';
    j.bytes = j.total || j.bytes;
    j.outDir = (dirRel ? dirRel + '/' : '') + finalName;
    j.message = `unpacked everything into "${finalName}" in ${secs}s with ${used.tool}`;
  } else {
    j.state = 'failed';
    j.message = /cannot open the file as archive|unsupported method/i.test(lastErr)
      ? `none of the installed tools (${j.tools.map(t => t.tool).join(', ')}) can decompress this archive — they are built without RAR support.`
      : lastErr || 'nothing came out';
  }
  console.log(`extract ${j.state} ${j.name}: ${j.message}`);
  recordHistory({
    type: 'extract', status: j.state, src: j.src, dir: dirRel, path: j.rel,
    name: j.name, meta: fileMeta(j.src, j.rel), size: j.total, message: j.message, startedAt: j.startedAt, endedAt: j.endedAt, queuedAt: j.createdAt, mode: j.mode || 'packages', tool: used ? used.tool : undefined,
  });
}

// Once a dump has been pulled out of an archive, it gets exactly the same look
// a dump found on real disk already gets before a build can start: dumpSummary()
// first (cheap — just param.json), then the full check (runDumpCheck, the same
// one "Check this dump" runs) before touching the job/queue handoff at all. A
// false-positive candidate, or a genuinely corrupted/partial dump, is reported
// plainly and left exactly where it landed — nothing is deleted and no build starts.
async function autoBuildAfterExtract(j, dir, src, moveBackTo, sendTo) {
  const dump = await dumpSummary(dir);
  if (!dump || dump.error) {
    j.buildState = 'not-a-dump';
    j.buildMessage = dump ? dump.error : 'not a game dump';
    j.message += ` — but it is not a valid dump (${j.buildMessage}), so no build was started; the extracted files were left in place.`;
    return;
  }
  const key = `${src.id}|${dir}`;
  const check = { state: 'running', startedAt: Date.now(), endedAt: 0, files: 0, bytes: 0, checks: [], notes: [] };
  dumpChecks.set(key, check);
  if (dumpChecks.size > 50) dumpChecks.delete(dumpChecks.keys().next().value);
  try { await runDumpCheck(check, dir); } catch (e) { check.checks.push({ level: 'error', text: `The check stopped: ${e.message}.` }); }
  check.state = 'done'; check.endedAt = Date.now();
  const errors = check.checks.filter(c => c.level === 'error');
  if (errors.length) {
    j.buildState = 'check-failed';
    j.buildMessage = errors.map(c => c.text).join(' ');
    j.message += ` — the extracted dump did not pass the check the repack kit needs (${j.buildMessage}), so no build was started; the extracted files were left in place.`;
    return;
  }
  // The check above already looks at free space where the package will land
  // and warns if it is short — but a warning only helps someone who is there to
  // read it. "Build .pkg" clicked by a person leaves that as a warning they can
  // choose to run past; this path has nobody watching, so short of room is
  // treated as a hard stop here instead of quietly starting a build that runs
  // for hours and then fails on disk pressure the check already saw coming.
  if (check.free != null && check.free < check.bytes) {
    j.buildState = 'check-failed';
    j.buildMessage = `not enough room where the package would be written (about ${fmtGb(check.free)} free, up to ${fmtGb(check.bytes)} may be needed)`;
    j.message += ` — ${j.buildMessage}, so no build was started; the extracted files were left in place.`;
    return;
  }
  const dumpRel = path.relative(src.root, dir).split(path.sep).join('/');
  // j.hostHeader: the real Host header from when "Build from inside this
  // archive" was actually clicked (see POST /api/extract) — this call itself
  // runs hours later with no request of its own, so without carrying it
  // through, a console with no PUBLIC_BASE set would be handed a host-less
  // URL it cannot fetch.
  const r = await prepareBuildJob(src, dumpRel, dump, check, sendTo ? { sendTo } : {}, j.hostHeader || null, moveBackTo);
  if (r.error) {
    j.buildState = 'check-failed';
    j.buildMessage = r.error;
    j.message += ` — ${r.error}`;
    return;
  }
  j.buildState = 'started';
  j.buildId = r.job.id;
  const linked = builds.find(x => x.id === r.job.id);
  if (linked) { linked.extractJobId = j.id; saveBuilds(); }
  j.message += ' — build started automatically.';
}

// The third extraction mode: only a dump's own folder (j.dumpRoot) comes out of
// the archive, with its structure intact (see dumpArgsFor for the proven,
// per-tool mask syntax). Modelled closely on runExtractAll — a hidden temp
// folder, renamed only once a tool has genuinely produced the dump's folder —
// except what gets renamed beside the archive is the dump's own leaf folder
// (found at tmp/<dumpRoot>), not the whole temp wrapper, and success runs
// straight into the build handoff above rather than just ending the job.
async function runExtractDump(j) {
  const src = findSource(j.src);
  const dirRel = j.rel.includes('/') ? j.rel.slice(0, j.rel.lastIndexOf('/')) : '';
  // SCRATCH_LIBRARY redirects only this one path: the dump lands in that
  // library's own root instead of beside the archive, so the build that
  // follows reads it from fast local storage instead of whatever share the
  // archive lives on. Never itself (an archive already inside the scratch
  // library extracts beside itself as always — nothing to gain there).
  const scratchSrc = SCRATCH_LIBRARY ? findSource(SCRATCH_LIBRARY) : null;
  const useScratch = !!(scratchSrc && src && scratchSrc.id !== src.id);
  const dest = useScratch ? scratchSrc.root : path.dirname(j.full);
  const tmp = path.join(dest, '.shadowpkg-extract-' + j.id);
  const leafName = j.dumpRoot ? j.dumpRoot.split('/').pop() : stemOf(j.name);
  let lastErr = '', used = null, finalName = null, finalDir = null;
  for (const tool of j.tools) {
    j.message = 'extracting with ' + tool.tool;
    await noteUnpackFolder(j, tmp);
    if (stopping) return;
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); }
    catch (e) { lastErr = e.message; break; }
    j.bytes = 0; j.speed = 0;
    let lastAt = Date.now(), lastBytes = 0;
    const ticker = setInterval(() => {
      const now = Date.now(), bytes = sizeUnder(tmp), dt = (now - lastAt) / 1000;
      if (dt >= 0.5) { j.speed = Math.max(0, Math.round((bytes - lastBytes) / dt)); lastAt = now; lastBytes = bytes; }
      j.bytes = bytes;
    }, 1000);
    let r;
    try { r = await spawnTool(tool, j.full, tmp, 'dump', j, j.dumpRoot); }
    finally { clearInterval(ticker); }
    if (stopping) return;         // the process is ending: the folder stays, written down, for the next start
    j.speed = 0; j.proc = null;
    if (j.cancelled) break;
    if (r.err) lastErr = r.err;
    const gotDir = j.dumpRoot ? path.join(tmp, ...j.dumpRoot.split('/')) : tmp;
    let ok = false;
    try { ok = fs.statSync(gotDir).isDirectory() && fs.readdirSync(gotDir).length > 0; } catch {}
    if (!r.err && ok) {
      const name = freeName(dest, leafName);
      try { fs.renameSync(gotDir, path.join(dest, name)); finalName = name; finalDir = path.join(dest, name); used = tool; break; }
      catch (e) { lastErr = e.message; }
    } else {
      console.log(`extract: ${tool.tool} did not unpack the dump out of ${j.name}${r.err ? ' — ' + r.err : ' — nothing came out'}`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  dropUnpackFolder(tmp);

  j.endedAt = Date.now();
  const secs = Math.round((j.endedAt - j.startedAt) / 1000);
  if (j.cancelled) {
    j.state = 'cancelled';
    j.message = 'cancelled; nothing was left behind';
  } else if (finalName) {
    j.state = 'done';
    j.bytes = j.total || j.bytes;
    // useScratch: the dump landed at the scratch library's own root, not
    // nested under the archive's folder — outSrc tells the client which
    // library outDir is actually in, since it is not necessarily j.src here.
    j.outDir = useScratch ? finalName : (dirRel ? dirRel + '/' : '') + finalName;
    if (useScratch) j.outSrc = scratchSrc.id;
    j.message = `unpacked the dump into "${finalName}" in ${secs}s with ${used.tool}` + (useScratch ? ` on ${scratchSrc.label}` : '');
    const buildSrc = useScratch ? scratchSrc : src;
    // Checked against the archive's own listing now, while the dump is still on
    // disk: once the build has moved its package back the dump is gone from
    // scratch, and this is what lets the archive be offered for deletion then.
    let verified = false;
    if (useScratch && src && finalName === leafName) {
      try {
        const list = await archiveListingFor(j.full);
        if (!list.note) {
          const prefix = j.dumpRoot ? j.dumpRoot + '/' : '';
          const members = list.files.filter(f => !prefix || f.name.startsWith(prefix));
          const acc = await dumpAccountingFor(dest, j.name, list);
          verified = members.length > 0 && members.every(f => acc.has(f.name));
        }
      } catch { /* not verified: the archive simply is not offered for deletion afterwards */ }
    }
    const moveBackTo = useScratch && src ? { srcId: src.id, rel: dirRel, archive: verified ? { path: j.rel, root: j.dumpRoot || '' } : null } : null;
    if (buildSrc) await autoBuildAfterExtract(j, finalDir, buildSrc, moveBackTo, j.sendTo);
  } else {
    j.state = 'failed';
    j.message = /cannot open the file as archive|unsupported method/i.test(lastErr)
      ? `none of the installed tools (${j.tools.map(t => t.tool).join(', ')}) can decompress this archive — they are built without RAR support.`
      : lastErr || 'nothing came out';
  }
  console.log(`extract ${j.state} ${j.name}: ${j.message}`);
  recordHistory({
    type: 'extract', status: j.state, src: j.src, dir: dirRel, path: j.rel,
    name: j.name, meta: fileMeta(j.src, j.rel), size: j.total, message: j.message, startedAt: j.startedAt, endedAt: j.endedAt, queuedAt: j.createdAt, mode: j.mode || 'packages', tool: used ? used.tool : undefined,
  });
}

// Up to EXTRACT_PARALLEL jobs at once. Whatever happens inside a job, the queue
// must not stay stuck behind it: an error nobody expected (a tool that cannot be
// started, a share that went away) is logged and carried on from rather than
// ending the process, and the job leaves the running set either way.
async function runNextExtraction() {
  if (extractPumping) { extractPumpAgain = true; return; }      // a look at the queue is under way: it will look again
  extractPumping = true;
  try {
    do {
      extractPumpAgain = false;
      while (!stopping && extractRunningJobs.size < EXTRACT_PARALLEL && extractQueue.length) {
        const j = extractQueue[0];
        // The room was promised when it was asked for; the jobs running now may
        // have used it up. With none running the earlier answer stands.
        if (extractRunningJobs.size && j.roomDir && await noRoomFor(j.roomDir, j.roomNeeded, j)) {
          j.message = 'waiting for room: the extractions running now are still writing to that disk';
          break;
        }
        if (extractQueue[0] !== j) continue;                     // cancelled while the room was being looked at
        extractQueue.shift();
        launchExtraction(j);
      }
    } while (extractPumpAgain && !stopping);
  } finally { extractPumping = false; }
}

async function launchExtraction(j) {
  extractRunningJobs.add(j);
  j.state = 'running';
  j.startedAt = Date.now();
  try {
    await runOneExtraction(j);
  } catch (e) {
    console.error(`extract: ${j.name} stopped by an unexpected error: ${e && e.stack || e}`);
    if (j.proc) try { j.proc.kill('SIGKILL'); } catch {}
    j.proc = null; j.speed = 0;
    if (j.state === 'running') {
      j.state = 'failed';
      j.endedAt = Date.now();
      j.message = `stopped by an unexpected error (${String(e && e.message || e).slice(0, 120)}); see the log`;
      recordHistory({
        type: 'extract', status: j.state, src: j.src, dir: dirOf(j.rel), path: j.rel,
        name: j.name, meta: fileMeta(j.src, j.rel), size: j.total, message: j.message, startedAt: j.startedAt, endedAt: j.endedAt, queuedAt: j.createdAt, mode: j.mode || 'packages',
      });
    }
  } finally {
    extractRunningJobs.delete(j);
  }
  if (!stopping) runNextExtraction();
}

// The fourth extraction mode: one or more specific entries (j.entries),
// picked by hand from the archive's own listing (the Open dialog), each with
// its own folder structure preserved. Modelled closely on runExtractAll and
// runExtractDump — a hidden temp folder, nothing renamed into place until a
// tool has genuinely produced every requested entry — except, unlike those
// two, a tool that only produces SOME of what was asked is not trusted at
// all: its output is discarded and the next tool is tried, rather than
// mixing partial results from more than one tool together. Once one tool
// produces everything, each entry is moved individually to sit beside the
// archive at its own relative path, refusing to overwrite anything already
// there at a different size — the same convention every other extraction
// mode already keeps.
async function runExtractSelected(j) {
  const dest = path.dirname(j.full);
  const dirRel = j.rel.includes('/') ? j.rel.slice(0, j.rel.lastIndexOf('/')) : '';
  const tmp = path.join(dest, '.shadowpkg-extract-' + j.id);
  let lastErr = '', used = null, produced = null, skipped = [];
  for (const tool of j.tools) {
    j.message = 'extracting with ' + tool.tool;
    await noteUnpackFolder(j, tmp);
    if (stopping) return;
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); }
    catch (e) { lastErr = e.message; break; }
    j.bytes = 0; j.speed = 0;
    let lastAt = Date.now(), lastBytes = 0;
    const ticker = setInterval(() => {
      const now = Date.now(), bytes = sizeUnder(tmp), dt = (now - lastAt) / 1000;
      if (dt >= 0.5) { j.speed = Math.max(0, Math.round((bytes - lastBytes) / dt)); lastAt = now; lastBytes = bytes; }
      j.bytes = bytes;
    }, 1000);
    let r;
    try { r = await spawnTool(tool, j.full, tmp, 'selected', j, null, j.entries); }
    finally { clearInterval(ticker); }
    if (stopping) return;         // the process is ending: the folder stays, written down, for the next start
    j.speed = 0; j.proc = null;
    if (j.cancelled) break;
    if (r.err) lastErr = r.err;
    const found = j.entries.map(entry => ({ entry, got: findUnder(tmp, entry.split('/').pop()) }));
    if (!r.err && found.every(f => f.got)) {
      const results = [];
      for (const { entry, got } of found) {
        let st; try { st = fs.statSync(got); } catch { results.push({ entry, ok: false, why: 'went missing before it could be moved' }); continue; }
        const to = path.join(dest, ...entry.split('/'));
        let already = null;
        try { already = fs.lstatSync(to); } catch {}
        if (already) {
          const same = already.isFile() && already.size === st.size;
          results.push({ entry, ok: same, why: same ? 'already here' : 'a file of that name is already here at a different size; move or rename it first' });
          continue;
        }
        try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(got, to); results.push({ entry, ok: true, size: st.size }); }
        catch (e) { results.push({ entry, ok: false, why: e.message }); }
      }
      const good = results.filter(x => x.ok && x.size !== undefined);
      if (good.length || results.some(x => x.ok)) { produced = results.filter(x => x.ok); skipped = results.filter(x => !x.ok); used = tool; break; }
      lastErr = (results[0] && results[0].why) || 'nothing could be moved into place';
    } else {
      console.log(`extract: ${tool.tool} did not produce every selected entry from ${j.name}${r.err ? ' — ' + r.err : ''}`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  dropUnpackFolder(tmp);

  j.endedAt = Date.now();
  const secs = Math.round((j.endedAt - j.startedAt) / 1000);
  if (j.cancelled) {
    j.state = 'cancelled';
    j.message = 'cancelled; nothing was left behind';
  } else if (produced && produced.length) {
    j.state = 'done';
    j.bytes = produced.reduce((n, p) => n + (p.size || 0), 0);
    j.produced = produced.map(p => p.entry);
    j.skipped = skipped;
    j.message = skipped.length
      ? `pulled out ${produced.length} of ${j.entries.length} in ${secs}s with ${used.tool} — ${skipped.length} skipped: ${skipped.slice(0, 3).map(s => s.entry.split('/').pop()).join(', ')}${skipped.length > 3 ? ', …' : ''}`
      : `pulled out ${produced.length} file${produced.length === 1 ? '' : 's'} in ${secs}s with ${used.tool}`;
  } else {
    j.state = 'failed';
    j.message = /cannot open the file as archive|unsupported method/i.test(lastErr)
      ? `none of the installed tools (${j.tools.map(t => t.tool).join(', ')}) can decompress this archive — they are built without RAR support.`
      : lastErr || 'nothing came out';
  }
  console.log(`extract ${j.state} ${j.name}: ${j.message}`);
  recordHistory({
    type: 'extract', status: j.state, src: j.src, dir: dirRel, path: j.rel,
    name: j.name, meta: fileMeta(j.src, j.rel), size: j.bytes || 0, message: j.message, startedAt: j.startedAt, endedAt: j.endedAt, queuedAt: j.createdAt, mode: 'selected', tool: used ? used.tool : undefined,
  });
}

async function runOneExtraction(j) {
  if (j.mode === 'all') { await runExtractAll(j); return; }
  if (j.mode === 'dump') { await runExtractDump(j); return; }
  if (j.mode === 'selected') { await runExtractSelected(j); return; }

  const dest = path.dirname(j.full);
  const dirRel = j.rel.includes('/') ? j.rel.slice(0, j.rel.lastIndexOf('/')) : '';
  const tmp = path.join(dest, '.shadowpkg-extract-' + j.id);
  j.total = j.expect.reduce((n, x) => n + x.size, 0);
  j.skipped = j.skipped || [];     // {name, why}: packages left alone rather than replacing what is in the way
  let moved = 0, lastErr = '', used = null;

  // What was promised when this was asked for may have been used up by the job
  // ahead of it in the queue, so the room is looked at again now.
  const noRoom = await noRoomFor(dest, j.total, j);
  if (noRoom) lastErr = noRoom;

  const done = new Set();          // came out, or was already there at the right size
  const skippedNow = new Set();    // this run's own skips, so a second tool is not asked for them again
  for (const tool of noRoom || j.cancelled ? [] : j.tools) {      // (Cancel may have arrived while the room was being looked at)
    const missing = j.expect.filter(x => !done.has(x.name) && !skippedNow.has(x.name));
    if (!missing.length) break;
    j.message = 'extracting with ' + tool.tool;
    await noteUnpackFolder(j, tmp);
    if (stopping) return;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
    } catch (e) { lastErr = e.message; break; }

    // Sample the temp folder while the tool works, for the progress bar.
    j.bytes = 0; j.speed = 0;
    let lastAt = Date.now(), lastBytes = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      const bytes = sizeUnder(tmp);
      const dt = (now - lastAt) / 1000;
      if (dt >= 0.5) { j.speed = Math.max(0, Math.round((bytes - lastBytes) / dt)); lastAt = now; lastBytes = bytes; }
      j.bytes = bytes;
    }, 1000);

    let r;
    try { r = await spawnTool(tool, j.full, tmp, false, j); }
    finally { clearInterval(ticker); }
    if (stopping) return;         // the process is ending: the folder stays, written down, for the next start
    j.speed = 0; j.proc = null;
    if (j.cancelled) break;

    // Only packages that came out at exactly the size recorded in the archive
    // index are moved next to it; everything else dies with the temp folder.
    j.produced = j.produced || [];
    let got = 0, settled = 0;
    for (const x of missing) {
      const leaf = x.name.split('/').pop();
      const from = findUnder(tmp, leaf);
      if (!from) continue;
      const target = path.join(dest, leaf), at = dirRel ? dirRel + '/' + leaf : leaf;
      const skip = why => { j.skipped.push({ name: leaf, why }); skippedNow.add(x.name); settled++; };
      try {
        if (fs.statSync(from).size !== x.size) continue;
        // A file already at that name is never replaced: it may be hand-fixed, newer, or another package that shares
        // the name. And a console pulling it right now keeps reading the old inode on its open request while the next
        // range request reads the new file, so the install would corrupt with nothing to say why.
        const busy = busyTransfer(j.src, rel => rel === at);
        if (busy) { skip(`${ps5NameFor(busy.ip) || busy.ip} is downloading it right now; try again when that finishes`); continue; }
        let there = null;
        try { there = fs.lstatSync(target); } catch {}
        if (there) {
          // The same size is what "already extracted" means everywhere else, so that counts as done.
          if (there.isFile() && there.size === x.size) { done.add(x.name); settled++; }
          else skip(there.isFile() ? CLASH_WHY : CLASH_OTHER_WHY);
          continue;
        }
        fs.renameSync(from, target);
        j.produced.push({ name: leaf, path: at, size: x.size });
        done.add(x.name);
        got++; settled++;
      } catch {}
    }
    if (got) used = tool;
    if (r.err) lastErr = r.err;
    if (settled < missing.length) {
      console.log(`extract: ${tool.tool} left ${missing.length - settled} of ${missing.length} package(s) in ${j.name}${r.err ? ' — ' + r.err : ''}`);
    }
  }
  moved = done.size;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  dropUnpackFolder(tmp);

  j.endedAt = Date.now();
  const secs = Math.round((j.endedAt - j.startedAt) / 1000);
  if (j.cancelled) {
    j.state = 'cancelled';
    j.message = moved ? `cancelled after ${moved} package${moved === 1 ? '' : 's'} came out; those stay` : 'cancelled; nothing was left behind';
  } else if (noRoom) {
    j.state = 'failed';
    j.message = noRoom;
  } else if (moved && moved === j.expect.length && !j.skipped.length) {
    j.state = 'done';
    j.bytes = j.total;
    j.message = `extracted ${moved} package${moved === 1 ? '' : 's'} in ${secs}s${used ? ' with ' + used.tool : ''}`;
  } else if (moved || j.skipped.length) {
    // Partly out is not done: say what was left alone and why, and which packages are still stuck.
    const stuck = j.expect.filter(x => !done.has(x.name) && !skippedNow.has(x.name)).map(x => x.name.split('/').pop());
    const why = [...new Set(j.skipped.map(s => s.why))];
    j.state = 'failed';
    j.message = [
      moved ? `only ${moved} of ${j.packages} package${j.packages === 1 ? '' : 's'} came out${used ? ' (' + used.tool + ')' : ''}` : 'nothing was extracted',
      !j.skipped.length ? '' : why.length === 1 ? `skipped ${j.skipped.map(s => s.name).join(', ')}: ${why[0]}` : `skipped ${j.skipped.map(s => `${s.name} (${s.why})`).join('; ')}`,
      stuck.length ? `still packed: ${stuck.join(', ')}` : '',
      stuck.length || !moved ? lastErr : '',
    ].filter(Boolean).join(' — ');
  } else {
    j.state = 'failed';
    j.message = /cannot open the file as archive|unsupported method/i.test(lastErr)
      ? `none of the installed tools (${j.tools.map(t => t.tool).join(', ')}) can decompress this archive — they are built without RAR support. Install unrar or libarchive-tools in the ShadowPKG container.`
      : lastErr || 'nothing came out at the expected size';
  }
  console.log(`extract ${j.state} ${j.name}: ${j.message}`);
  recordHistory({
    type: 'extract', status: j.state, src: j.src, dir: dirOf(j.rel), path: j.rel,
    name: j.name, meta: fileMeta(j.src, j.rel), size: j.total, message: j.message, startedAt: j.startedAt, endedAt: j.endedAt, queuedAt: j.createdAt, mode: j.mode || 'packages', tool: used ? used.tool : undefined, count: moved,
  });
}

// A tool left running would go on filling its hidden folder after this process is
// gone. The folder itself is left alone: it is written down, so the next start
// offers to remove it.
onShutdown(() => {
  for (const j of extractions.values()) if (j.proc) try { j.proc.kill('SIGKILL'); } catch {}
});

// ---- Active downloads ------------------------------------------------------------
// A PS5 fetches a package as many Range requests (16 MiB each, sometimes two at
// once, retries overlap). Requests for the same file from the same IP are folded
// into one transfer; progress is the union of byte ranges served.
const transfers = new Map();      // "ip|library|path" -> transfer
const lastFetch = new Map();      // ip -> time of its last /p/ request (any outcome)
const ACTIVE_MS = 15000;          // no traffic for this long = paused/stalled
// The console itself cannot be told to cancel — there is no such call in
// either DPI flavour — but refusing the next range request ends a mistaken
// send in practice within moments, since a console re-requests every few
// seconds. Keyed by transfer id, cleaned up wherever the transfer itself is.
const stoppedTransfers = new Set();
let reqSeq = 0;

function mergeIntervals(list) {
  const out = [];
  for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) {
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

function covered(t) {
  return mergeIntervals([...t.intervals, ...t.open.values()]).reduce((n, [s, e]) => n + (e - s), 0);
}

// A console that has the whole file can still leave this record a little short of it: it kept part
// from an earlier try and asked only for the rest, or this app was stopped without a clean exit and
// lost the last few seconds of what it had written down. From here that looks like a console that gave
// up, and the row sat on Paused a hair under 100% with the next package waiting behind it. What tells
// them apart is how it ended: a console that gave up dies part way through a request, while one that has
// what it needs finishes its last request in full - one that ran to the very end of the file - and then
// stops asking. So when it has been quiet for a while, nothing is open, the last request was served in
// full, the end of the file has been served, and only a small part was never asked for, it is finished.
// A console that was wrong about being done simply asks again, and is served as ever.
// Two ways to qualify, both needing the last request to have been served in full: the end of the file
// was served and no more than 5% was never asked for (the usual shape - the console resumed from what it
// had, or this record lost its last seconds), or, when the end of the file was never asked for at all
// (a downloader that treats the last piece differently), the quiet has lasted longer and at most 1.5%
// is missing. Anything more than that is left as Paused: a console that gave up, or was paused by hand.
// A third, quicker way: what was never asked for is only a small trailing piece (a console fetching in
// 64 KiB steps never asks for the last part of a small package), so a few seconds of quiet is enough.
const INFER_QUIET_MS = 30000, INFER_QUIET_NOTAIL_MS = 60000, INFER_MAX_GAP = 0.05, INFER_MAX_GAP_NOTAIL = 0.015;
const INFER_QUIET_SMALL_MS = 5000, INFER_SMALL_GAP_BYTES = 1 << 20, INFER_SMALL_GAP = 0.02;
function inferFinished(t, now = Date.now()) {
  if (t.inferredDone || stoppedTransfers.has(t.id) || t.open.size || now - t.lastAt < INFER_QUIET_SMALL_MS) return false;
  const got = covered(t);
  if (got >= t.size || t.lastOk !== true) return false;
  const missed = t.size - got;
  const small = missed <= Math.min(INFER_SMALL_GAP_BYTES, t.size * INFER_SMALL_GAP);
  if (!small && now - t.lastAt < INFER_QUIET_MS) return false;
  const ok = small ? true : t.tailOkAt ? missed <= t.size * INFER_MAX_GAP
    : now - t.lastAt >= INFER_QUIET_NOTAIL_MS && missed <= t.size * INFER_MAX_GAP_NOTAIL;
  if (!ok) return false;
  t.intervals = mergeIntervals([...t.intervals, [0, t.size]]);
  t.inferredDone = { at: now, missed };
  console.log(`${new Date().toISOString()} download complete ${t.ip} ${t.rel} ${fmtGb(t.size)} - the console stopped asking after its last request was served in full${t.tailOkAt ? ', end of file included' : ''}, with ${fmtSize(missed)} of it never requested (kept from an earlier try, or lost from this record across a restart), so it is taken as finished`);
  return true;
}

// The stretches of the file no request ever asked for: [{at, bytes}] in order. A console that
// stops with a few of these left has either not finished, or already had those bytes (it resumes
// a download it kept part of) - a server cannot tell which, so the list is shown rather than guessed at.
function gapsOf(t) {
  const out = [];
  let at = 0;
  for (const [s, e] of mergeIntervals([...t.intervals, ...t.open.values()])) {
    if (s > at) out.push({ at, bytes: s - at });
    at = Math.max(at, e);
  }
  if (at < t.size) out.push({ at, bytes: t.size - at });
  return out;
}

// A console pulling a file of this library right now, if there is one; `match` is
// given each transfer's path. The same test rename and delete apply: a stalled
// or finished transfer is not in the way. A transfer is recorded under the
// library its link was made from, and one folder can be mapped as two libraries,
// so a caller that has the file's identity (fileIdentity) passes it and a
// transfer of the same file through another library counts too, as does one of
// a package inside it when it is an archive.
function busyTransfers(srcId, match, id = null) {
  const now = Date.now();
  return [...transfers.values()].filter(t => ((t.srcId === srcId && match(t.rel)) || (id && t.fileId && (t.fileId === id || t.fileId.startsWith(id + ARC)))) && covered(t) < t.size && (t.open.size || now - t.lastAt < ACTIVE_MS));
}
function busyTransfer(srcId, match, id = null) { return busyTransfers(srcId, match, id)[0]; }

function trackStart(ip, src, rel, size, start, mtime = null) {
  const key = `${ip}|${src.id}|${rel}`;
  const now = Date.now();
  let t = transfers.get(key), fresh = false;
  // A finished file requested again a minute later is a new download.
  if (!t || (covered(t) >= t.size && now - t.lastAt > 60000)) {
    t = { key, id: crypto.randomBytes(4).toString('hex'), ip, srcId: src.id, fileId: fileIdentitySync(src, rel), library: src.label, rel, name: rel.split('/').pop(), size, mtime: mtime == null ? null : +new Date(mtime),
          intervals: [], open: new Map(), sent: 0, samples: [[now, 0]], firstAt: now, lastAt: now, recorded: false,
          abortsTotal: 0, abortsRecent: [], completeLogged: false };
    transfers.set(key, t);
    fresh = true;
  }
  const rid = ++reqSeq;
  t.open.set(rid, [start, start]);
  t.lastAt = now;
  considerMovedConsole(ip);     // deliberately not awaited: serving comes first
  return { t, rid, fresh };
}

function trackData({ t, rid }, n) {
  const iv = t.open.get(rid);
  if (iv) iv[1] += n;
  t.sent += n;
  const now = Date.now();
  t.lastAt = now;
  const last = t.samples[t.samples.length - 1];
  if (now - last[0] >= 1000) { t.samples.push([now, t.sent]); if (t.samples.length > 30) t.samples.shift(); }
}

// ok is whether this one range request delivered everything it promised. A
// console retrying the same range over and over, dying partway through every
// time, looks identical to a merely slow transfer from intervals and lastAt
// alone — both are "still getting requests" — so that pattern is counted
// separately rather than folded into the same numbers as real progress.
function trackEnd({ t, rid }, ok) {
  const iv = t.open.get(rid);
  if (iv) { t.intervals = mergeIntervals([...t.intervals, iv]); t.open.delete(rid); }
  const now = Date.now();
  t.lastAt = now;
  // How the console's last request ended, and whether one ran to the end of the file and was served in full:
  // what inferFinished reads to tell a console that has everything from one that gave up.
  t.lastOk = !!ok;
  if (ok && iv && iv[1] >= t.size) t.tailOkAt = now;
  if (!ok) {
    t.abortsTotal++;
    t.abortsRecent.push(now);
    if (t.abortsRecent.length > 200) t.abortsRecent.shift();     // a hard cap, not the real window
  }
  // The one line a whole transfer gets when it is over, however many ranges it took.
  if (!t.completeLogged && covered(t) >= t.size) {
    t.completeLogged = true;
    const secs = Math.max(0.1, (now - t.firstAt) / 1000);
    console.log(`${new Date().toISOString()} download complete ${t.ip} ${t.rel} ${fmtGb(t.size)} in ${secs.toFixed(secs < 10 ? 1 : 0)}s (${(t.size / secs / 1e6).toFixed(1)} MB/s)${t.abortsTotal ? `, ${t.abortsTotal} range(s) cut short along the way` : ''}`);
  }
}

// How many of t.abortsRecent landed in roughly the last minute — the live
// count, as opposed to abortsTotal which never resets. Filtered here rather
// than trimmed on push, since nothing pushes while the console has given up
// and gone quiet, and that quiet is itself worth being able to see.
function recentAbortCount(t, now = Date.now()) {
  return t.abortsRecent.filter(ts => now - ts < 60000).length;
}

function ps5NameFor(ip) {
  const p = profiles.find(x => x.host.split(':')[0] === ip);
  return p ? p.name : null;
}

// Finished jobs stay in the feed for a while, like finished downloads do.
function extractionsView() {
  const now = Date.now();
  for (const [id, j] of extractions) {
    // A dump whose build is still going stays, up to half a day: the page asks about deleting the archive when the build is over, and needs the job to see that.
    const waitingOnBuild = j.mode === 'dump' && j.buildState === 'started' && !j.chainDone && now - (j.endedAt || 0) < 12 * 3600000;
    if ((j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') && !waitingOnBuild && now - Math.max(j.endedAt || 0, j.chainDoneAt || 0) > 10 * 60000) extractions.delete(id);
  }
  return [...extractions.values()].map(jobView)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

// What is waiting for a PS4's installer to be opened, and hand-overs that have
// just happened (kept ten minutes, so the "you can leave the app" note is seen).
function heldView() {
  const now = Date.now();
  for (const [id, h] of handovers) if (now - h.at > 10 * 60000) handovers.delete(id);
  const byProfile = new Map();
  for (const h of held) {
    const prof = findProfile(h.profile);
    if (!byProfile.has(h.profile)) byProfile.set(h.profile, { profile: h.profile, name: prof ? prof.name : 'console', items: [] });
    byProfile.get(h.profile).items.push({ id: h.id, name: h.name, size: h.size, addedAt: h.addedAt, meta: fileMeta(h.src, h.rel), path: h.rel, src: h.src });
  }
  return { waiting: [...byProfile.values()], handovers: [...handovers.entries()].map(([profile, v]) => ({ profile, ...v })) };
}

function recordDoneTransfer(t) {
  t.recorded = true;
  recordHistory({
    type: 'download', status: 'done', src: t.srcId, dir: dirOf(t.rel), path: t.rel,
    name: t.name, meta: fileMeta(t.srcId, t.rel), size: t.size, ps5: ps5NameFor(t.ip) || t.ip,
    startedAt: t.firstAt, endedAt: t.lastAt, abortsTotal: t.abortsTotal,
    ...(t.inferredDone ? { inferred: true, missedBytes: t.inferredDone.missed } : {}),
  });
}

// ---- Settling transfers ---------------------------------------------------------
// A transfer is written to the history the moment it is seen to be done, and one
// that went quiet without finishing an hour later. That used to happen only when
// a page asked for the feed, and a page that is hidden (a locked phone) does not,
// so a finished 60 GB download could sit unrecorded until the next look, or be
// lost with the container. A timer does it now, whether or not anyone is looking,
// and the same pass is where NOTIFY_URL is told about long downloads finishing
// and about one that has gone quiet part way (both opt-in, see NOTIFY_ON).
const NOTE_LONG_MS = 2 * 60000;     // a download that ran this long is worth a message
const NOTE_STUCK_MS = 5 * 60000;    // quiet this long, part way through, is stuck
const NOTE_HOLD_MS = 60000;         // messages wait this long, so ten packages are one message
const transferNotes = { finished: [], stuck: [], timer: null };
const notifying = new Set();        // messages sent and not yet answered, so a stop can wait for them a moment

function noteTransfer(kind, t) {
  if (!NOTIFY_URL) return;
  if (kind === 'finished' ? !NOTIFY_ON.has('downloads') : !(NOTIFY_ON.has('problems') || NOTIFY_ON.has('downloads'))) return;
  transferNotes[kind].push({ console: ps5NameFor(t.ip) || t.ip, name: t.name, size: t.size, got: Math.min(covered(t), t.size), secs: Math.round((t.lastAt - t.firstAt) / 1000), quiet: Math.round((Date.now() - t.lastAt) / 60000) });
  if (!transferNotes.timer) { transferNotes.timer = setTimeout(flushTransferNotes, NOTE_HOLD_MS); transferNotes.timer.unref?.(); }
}

function flushTransferNotes() {
  transferNotes.timer = null;
  const sent = [];
  const say = (title, lines) => {
    if (!lines.length) return;
    const pr = notify(title, lines.join('\n')).catch(() => {});
    notifying.add(pr); pr.then(() => notifying.delete(pr)); sent.push(pr);
  };
  const list = xs => xs.slice(0, 6).join(', ') + (xs.length > 6 ? `, and ${xs.length - 6} more` : '');
  for (const kind of ['finished', 'stuck']) {
    const items = transferNotes[kind].splice(0);
    if (!items.length) continue;
    const lines = [];
    for (const who of [...new Set(items.map(x => x.console))]) {
      const mine = items.filter(x => x.console === who);
      if (kind === 'finished') lines.push(`${who}: ${list(mine.map(x => `${x.name} (${fmtGb(x.size)}, ${x.secs >= 90 ? Math.round(x.secs / 60) + ' min' : x.secs + ' s'})`))}`);
      else lines.push(`${who} stopped asking for ${list(mine.map(x => `${x.name} at ${x.size ? Math.floor(x.got / x.size * 100) : 0}%`))} ${mine[0].quiet} minutes ago. It carries on by itself if the console asks again; otherwise check the console's Downloads list.`);
    }
    if (kind === 'finished') say(items.length === 1 ? 'ShadowPKG: download finished' : `ShadowPKG: ${items.length} downloads finished`, lines);
    else say(items.length === 1 ? 'ShadowPKG: a download has stopped' : `ShadowPKG: ${items.length} downloads have stopped`, lines);
  }
  return Promise.all(sent);
}
// A message still inside its minute of waiting when the app is stopped would be lost with it.
onShutdown(async () => {
  if (transferNotes.timer) { clearTimeout(transferNotes.timer); flushTransferNotes(); }
  if (notifying.size) await Promise.race([Promise.allSettled([...notifying]), new Promise(r => setTimeout(r, 3000))]);
});

function settleTransfers() {
  const now = Date.now();
  // A console that came late, or resumed, and finished: the history entry no longer says it never did.
  for (const r of sends.values()) if (r.outcome && r.outcome !== 'done' && r.outcome !== 'started' && sendLive(r, now).state === 'done') noteSendOutcome(r, 'done');
  for (const [k, t] of transfers) {   // forget finished after 10 min, stalled after 1 h
    inferFinished(t, now);
    const done = covered(t) >= t.size;
    // Recorded once, the moment it is first seen done — not lazily when it
    // finally ages out of the live list, which could be ten minutes later.
    if (done && !t.recorded) recordDoneTransfer(t);
    // A download that has gone quiet short of the end and was not taken as finished: one line with what it looked like.
    if (!done && !t.open.size && !stoppedTransfers.has(t.id) && now - t.lastAt >= 60000 && t.quietLogged !== t.lastAt) {
      t.quietLogged = t.lastAt;
      const g = gapsOf(t);
      console.log(`${new Date().toISOString()} download quiet short of the end ${t.ip} ${t.rel}: ${Math.floor(covered(t) / t.size * 1000) / 10}% asked for, ${g.length} gap(s) ${g.slice(0, 4).map(x => `${x.at}+${x.bytes}`).join(' ')}, last request ${t.lastOk === undefined ? 'unknown' : t.lastOk ? 'served in full' : 'cut short'}, end of file ${t.tailOkAt ? 'served' : 'not served'}, ${t.abortsTotal} range(s) cut short in all`);
    }
    if (done && !t.noted && t.lastAt - t.firstAt >= NOTE_LONG_MS) { t.noted = true; noteTransfer('finished', t); }
    if (!done && !t.open.size && !stoppedTransfers.has(t.id) && now - t.lastAt >= NOTE_STUCK_MS && t.stuckNoted !== t.lastAt) { t.stuckNoted = t.lastAt; noteTransfer('stuck', t); }
    if (now - t.lastAt > (done ? 10 : 60) * 60000) {
      // One that never finished is worth a record too — an interrupted
      // transfer going quiet without ever completing is exactly the kind of
      // thing worth being able to look back at.
      if (!done && !t.recorded) {
        recordHistory({
          type: 'download', status: 'aborted', src: t.srcId, dir: dirOf(t.rel), path: t.rel,
          name: t.name, meta: fileMeta(t.srcId, t.rel), size: t.size, received: covered(t), ps5: ps5NameFor(t.ip) || t.ip,
          startedAt: t.firstAt, endedAt: t.lastAt, abortsTotal: t.abortsTotal,
        });
      }
      noteTransferGone(t);
      transfers.delete(k);
      stoppedTransfers.delete(t.id);
    }
  }
}
setInterval(() => { if (transfers.size) { try { settleTransfers(); } catch (e) { console.error('settling transfers:', e); } } }, 10000).unref();

// ---- Transfers across a restart -------------------------------------------------
// A console that is part way through a package keeps going when this app restarts,
// and asks only for what is left. With the progress forgotten, Activity counted up
// from zero, never reached "done", and an hour later wrote an "Incomplete" entry for
// a game that had installed. So progress is written down every fifteen seconds while
// it changes and when the app is stopped, and picked up again if the file is the same
// size and was last changed at the same time. A byte range served is never trusted
// beyond that: what a console does with a resumed download is its own affair.
const TRANSFERS_FILE = path.join(CONFIG_DIR, 'transfers.json');
let transfersSaved = '';

function transfersSnapshot() {
  const now = Date.now(), out = [];
  for (const t of transfers.values()) {
    if (covered(t) >= t.size && t.recorded) continue;           // nothing left to find out about it
    if (now - t.lastAt > 60 * 60000) continue;
    out.push({
      key: t.key, id: t.id, ip: t.ip, srcId: t.srcId, rel: t.rel, size: t.size, mtime: t.mtime || null,
      firstAt: t.firstAt, lastAt: t.lastAt, recorded: !!t.recorded, abortsTotal: t.abortsTotal, noted: !!t.noted, stuckNoted: t.stuckNoted || 0,
      stopped: stoppedTransfers.has(t.id), intervals: mergeIntervals([...t.intervals, ...t.open.values()]),
    });
  }
  return JSON.stringify({ schema: 1, transfers: out });
}
function saveTransfers(force = false) {
  if (!profilesWritable) return;
  const text = transfersSnapshot();
  if (!force && text === transfersSaved) return;
  transfersSaved = text;
  saveAtomic(TRANSFERS_FILE, () => text, 'transfer progress');
}
setInterval(() => { if (transfers.size || transfersSaved) saveTransfers(); }, 15000).unref();
onShutdown(() => {
  // What finished is recorded first, so what is written down says so and it is not recorded again after the restart.
  for (const t of transfers.values()) if (!t.recorded && covered(t) >= t.size) recordDoneTransfer(t);
  saveTransfers(true);
});

async function loadTransfers() {
  let j;
  try { j = JSON.parse(await fsp.readFile(TRANSFERS_FILE, 'utf8')); } catch { return; }
  const now = Date.now();
  let kept = 0;
  for (const e of Array.isArray(j && j.transfers) ? j.transfers : []) {
    if (!e || typeof e.key !== 'string' || transfers.has(e.key) || !Number.isFinite(e.size) || !(now - e.lastAt < 60 * 60000)) continue;
    const src = findSource(e.srcId);
    const t = src && typeof e.rel === 'string' ? await resolveTarget(src, e.rel) : null;
    if (!t || t.error || t.size !== e.size || (e.mtime && +new Date(t.mtime) !== e.mtime)) continue;      // not the file it was
    const intervals = (Array.isArray(e.intervals) ? e.intervals : []).filter(iv => Array.isArray(iv) && iv[0] >= 0 && iv[1] > iv[0] && iv[1] <= e.size).map(iv => [iv[0], iv[1]]);
    const got = intervals.reduce((n, iv) => n + iv[1] - iv[0], 0);
    transfers.set(e.key, {
      key: e.key, id: String(e.id), ip: e.ip, srcId: src.id, fileId: fileIdentitySync(src, e.rel), library: src.label, rel: e.rel, name: e.rel.split('/').pop(), size: e.size, mtime: e.mtime || null,
      intervals, open: new Map(), sent: got, samples: [[now, got]], firstAt: e.firstAt, lastAt: e.lastAt, recorded: !!e.recorded,
      abortsTotal: e.abortsTotal || 0, abortsRecent: [], completeLogged: got >= e.size, noted: !!e.noted, stuckNoted: e.stuckNoted || 0,
    });
    if (e.stopped) stoppedTransfers.add(String(e.id));
    kept++;
  }
  if (kept) console.log(`picked up ${kept} transfer(s) that were under way when the app last stopped`);
}
loadTransfers().catch(e => console.error('reading transfers.json:', e.message));

function downloadsView() {
  const now = Date.now();
  settleTransfers();
  const list = [...transfers.values()].map(t => {
    const got = Math.min(covered(t), t.size);
    const done = got >= t.size;
    const status = stoppedTransfers.has(t.id) ? 'stopped'
      : done ? 'done' : (t.open.size || now - t.lastAt < ACTIVE_MS) ? 'downloading' : 'stalled';
    // Speed over the last ~5 s of samples plus the live counter.
    const samples = [...t.samples, [now, t.sent]];
    const base = samples.find(([ts]) => now - ts <= 6000) || samples[samples.length - 1];
    const dt = (now - base[0]) / 1000;
    const speed = status === 'downloading' && dt >= 1 ? Math.max(0, (t.sent - base[1]) / dt) : 0;
    // A console retrying the same range over and over, dying partway through
    // every time, holds an open connection exactly like healthy progress does
    // — status alone can't tell the two apart. Three or more failed attempts
    // inside a minute is retrying-and-failing, not just a slow link.
    const recent = recentAbortCount(t, now);
    return {
      id: t.id, ps5: ps5NameFor(t.ip) || t.ip, ip: t.ip, library: t.library, path: t.rel, name: t.name,
      meta: fileMeta(t.srcId, t.rel),
      size: t.size, received: got, percent: t.size ? Math.floor((got / t.size) * 1000) / 10 : 100,
      status, speed: Math.round(speed), eta: speed > 0 ? Math.round((t.size - got) / speed) : null,
      startedAt: t.firstAt, lastAt: t.lastAt, connections: t.open.size,
      struggling: recent >= 3, abortsRecent: recent, abortsTotal: t.abortsTotal,
      ...(got < t.size ? (g => ({ gapCount: g.length, gapBytes: g.reduce((n, x) => n + x.bytes, 0), gaps: g.slice(0, 4) }))(gapsOf(t)) : {}),
      ...(t.inferredDone ? { inferred: true } : {}),
    };
  });
  const rank = { downloading: 0, stalled: 1, stopped: 2, done: 3 };
  list.sort((a, b) => rank[a.status] - rank[b.status] || b.lastAt - a.lastAt);
  const extracting = extractionsView();
  const building = buildsFeed();
  return {
    active: list.filter(d => d.status === 'downloading').length,
    downloads: list.slice(0, 50),
    extractions: extracting,
    builds: building,
    transfers: xfersView(),
    held: heldView(),
    batches: batchesView(),
    sends: sendsView(),
    busy: extracting.filter(j => j.state === 'running' || j.state === 'queued').length,
    buildsBusy: building.filter(j => !TERMINAL.has(j.state)).length,
    // Not really a download, but polled the same way and wanted on the same
    // cadence, so it rides along on the endpoint the client already asks
    // every few seconds regardless of what folder is open.
    titles: {
      done: titleDone, pending: titleQueue.length, running: titleRunning,
      retrying: titleFailures.size, recent: titleHistory.slice(0, 30),
    },
  };
}

// A download that finished since anyone last looked is only put in the history
// when the feed is next built, so a stop would lose it.
onShutdown(() => {
  for (const t of transfers.values()) if (!t.recorded && covered(t) >= t.size) recordDoneTransfer(t);
  saveHistoryNow();
});

// Reads a byte range that spans several volumes, one file after another, and
// looks enough like a read stream for the caller to treat them alike.
function segmentStream(segments, start, end, res, onData) {
  let sent = 0, cancelled = false, current = null;
  (async () => {
    let at = 0;                                   // where this segment starts in the whole file
    for (const seg of segments) {
      if (cancelled) return;
      const segStart = at, segEnd = at + seg.length - 1;
      at += seg.length;
      if (segEnd < start || segStart > end) continue;
      const from = seg.offset + Math.max(start, segStart) - segStart;
      const to = seg.offset + Math.min(end, segEnd) - segStart;
      await new Promise((resolve, reject) => {
        const s = fs.createReadStream(seg.path, { start: from, end: to, highWaterMark: 1024 * 1024 });
        current = s;
        s.on('data', c => { sent += c.length; onData(c.length); });
        s.on('error', reject);
        s.on('end', resolve);
        s.pipe(res, { end: false });
      });
    }
    if (!cancelled) res.end();
  })().catch(e => {
    if (!cancelled) { console.error(`serve error across volumes: ${e.message}`); res.destroy(); }
  });
  return { destroy() { cancelled = true; if (current) current.destroy(); }, get bytesRead() { return sent; } };
}

// ---- ZIP writing (STORE method, no compression) ---------------------------
// A download-to-device ZIP is built here, not on the console: the files are
// already local, so each is read once for its CRC-32 and once for the stream.
// Entries are stored uncompressed — a package is already compressed, and
// re-compressing it would just burn CPU for nothing.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipDateTime(mtime) {
  const d = mtime ? new Date(mtime) : new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function zipLocalHeader(nameBuf, crc, size, mtime) {
  const dt = zipDateTime(mtime);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);              // version needed to extract
  h.writeUInt16LE(0x0800, 6);          // flags: UTF-8 filename
  h.writeUInt16LE(0, 8);               // method: store
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(size, 18);           // compressed size (store = raw)
  h.writeUInt32LE(size, 22);           // uncompressed size
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);              // extra field length
  return Buffer.concat([h, nameBuf]);
}
function zipCentralEntry(nameBuf, crc, size, mtime, offset) {
  const dt = zipDateTime(mtime);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(0x031E, 4);          // version made by (unix, 3.0)
  h.writeUInt16LE(20, 6);              // version needed
  h.writeUInt16LE(0x0800, 8);          // flags
  h.writeUInt16LE(0, 10);              // method: store
  h.writeUInt16LE(dt.time, 12);
  h.writeUInt16LE(dt.date, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(0, 30);              // extra
  h.writeUInt16LE(0, 32);              // comment
  h.writeUInt16LE(0, 34);              // disk number start
  h.writeUInt16LE(0, 36);              // internal attrs
  h.writeUInt32LE(0, 38);              // external attrs
  h.writeUInt32LE(offset, 42);         // local header offset
  return Buffer.concat([h, nameBuf]);
}
function zipEocd(entryCount, centralSize, centralOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(entryCount, 8);
  h.writeUInt16LE(entryCount, 10);
  h.writeUInt32LE(centralSize, 12);
  h.writeUInt32LE(centralOffset, 16);
  h.writeUInt16LE(0, 20);              // comment length
  return h;
}
async function fileCrc(full, base, size) {
  if (size === 0) return 0;
  let crc = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(full, { start: base, end: base + size - 1, highWaterMark: 1024 * 1024 });
    s.on('data', c => { crc = crc32(c, crc); });
    s.on('error', reject);
    s.on('end', resolve);
  });
  return crc;
}
async function streamZip(res, entries) {
  // entries: [{name, full, base, size, mtime, crc}] — crc already computed
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = zipLocalHeader(nameBuf, e.crc, e.size, e.mtime);
    res.write(local);
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(e.full, { start: e.base, end: e.base + e.size - 1, highWaterMark: 1024 * 1024 });
      s.on('data', c => res.write(c));
      s.on('error', reject);
      s.on('end', resolve);
    });
    central.push(zipCentralEntry(nameBuf, e.crc, e.size, e.mtime, offset));
    offset += local.length + e.size;
  }
  const centralBuf = Buffer.concat(central);
  res.write(centralBuf);
  res.end(zipEocd(entries.length, centralBuf.length, offset));
}

async function serveFile(req, res, src, rel) {
  const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const t = src ? await resolveTarget(src, rel) : { error: 'forbidden' };
  if (t.error === 'forbidden') { console.log(`download REFUSED ${from} ${req.method} ${req.url} (outside root or not a package)`); return sendJson(res, 403, { error: 'forbidden' }); }
  if (t.error) { console.log(`download NOT FOUND ${from} ${req.method} ${req.url}`); return sendJson(res, 404, { error: 'not found' }); }

  // Checked by key, not by the transfer object trackStart would build — this
  // runs before deciding to serve anything, and trackStart's own bookkeeping
  // (a new open interval) is exactly what a stopped transfer should not get.
  const existing = transfers.get(`${from}|${src.id}|${rel}`);
  if (existing && stoppedTransfers.has(existing.id)) {
    console.log(`download REFUSED ${from} ${rel} (stopped by request)`);
    return sendJson(res, 403, { error: 'This transfer was stopped and will not resume.' });
  }

  const { full = null, base = 0 } = t;
  const st = { size: t.size, mtime: t.mtime };

  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); }
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  // A profile's host is always configured as a plain IPv4 address, but a
  // loopback connection (only ever seen testing against a fake console on
  // the same machine) can arrive as "::1" rather than "127.0.0.1" - normalized
  // here so it still matches the key waitForTransfer builds from prof.host.
  const who = (req.socket.remoteAddress || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  const want = end - start + 1;
  const track = trackStart(who, src, rel, size, start, st.mtime);
  if (LOG_RANGES || track.fresh) console.log(`${new Date().toISOString()} download start ${who} ${status} ${rel} bytes ${start}-${end}/${size} range=${range || '-'} ua=${req.headers['user-agent'] || '-'}`);
  let stream;
  if (t.segments) {
    stream = segmentStream(t.segments, start, end, res, n => trackData(track, n));
  } else {
    stream = fs.createReadStream(full, { start: base + start, end: base + end, highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => trackData(track, chunk.length));
    stream.on('error', e => { console.error(`download read error ${rel}: ${e.message}`); res.destroy(); });
  }
  res.on('close', () => {
    stream.destroy();
    const sent = stream.bytesRead;
    const ok = sent >= want && res.writableFinished;
    // RPI reads the first 8 KB of a package with a plain GET, then hangs up on
    // purpose; that is it checking the file, not a download going wrong.
    const headerCheck = !range && /^Download\/1\.00/.test(req.headers['user-agent'] || '');
    trackEnd(track, ok || headerCheck);
    // A range cut short is always worth a line — the "struggling" diagnosis is made of them.
    if (LOG_RANGES || !ok) console.log(`${new Date().toISOString()} download ${ok ? 'done' : 'ABORTED'} ${who} ${rel} sent ${sent}/${want}`);
  });
  if (!t.segments) stream.pipe(res);
}

// Walking a library of tens of thousands of files takes a while on its own,
// before any archive is opened. So the list behind the search box is built in
// the background and served from the last snapshot: the first search after a
// restart may be short, and fills in within seconds rather than blocking.
const listCache = new Map();          // library id -> snapshot
const LIST_FRESH_MS = 10 * 60000;     // rebuild on demand after this long

function snapshotFor(src) {
  let snap = listCache.get(src.id);
  if (!snap) {
    snap = { files: [], builtAt: 0, building: false, pending: 0 };
    listCache.set(src.id, snap);
  }
  return snap;
}

function buildList(src, force) {
  const snap = snapshotFor(src);
  const stale = !snap.builtAt || Date.now() - snap.builtAt > LIST_FRESH_MS;
  if (snap.building || (!force && !stale)) return snap;

  snap.building = true;
  (async () => {
    const started = Date.now();
    try {
      const ctx = { pending: 0 };
      const all = await walk(src, src.root, [], ctx);
      const folderOf = p => p.slice(0, p.lastIndexOf('/') + 1);
      const nameOf = p => p.split('/').pop();
      const extracted = new Set(all.filter(x => !x.inArchive).map(x => folderOf(x.path) + nameOf(x.path)));
      const files = all.filter(x => !x.inArchive || !extracted.has(folderOf(x.path.slice(0, x.path.indexOf(ARC))) + nameOf(x.path)));
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }));
      snap.files = files;
      snap.pending = ctx.pending;
      snap.builtAt = Date.now();
      listRev++;
      console.log(`search list for ${src.label}: ${files.length} package(s) in ${Math.round((Date.now() - started) / 1000)}s${ctx.pending ? `, ${ctx.pending} archive(s) still to read` : ''}`);
    } catch (e) {
      console.error(`could not build the search list for ${src.label}: ${e.message}`);
    } finally { snap.building = false; }
  })();
  return snap;
}

loadIndex();
loadMeta();
loadTitles();
loadHistory();
loadExtracting();

// A package already read before this existed, or before its title id's page
// had been fetched, never gets rescanned just because the answer showed up
// later — apply what is known now and queue what isn't.
for (const [key, entry] of metaCache) if (entry.meta) enrichTitle(key, entry.meta);
saveMetaSoon();

// Walk each library shortly after start rather than on the first search.
setTimeout(() => { for (const src of SOURCES) buildList(src, true); }, 3000).unref?.();

// ---- Who can reach the app ---------------------------------------------------
// A browser will send a "simple" cross-site POST (a text/plain body, no
// preflight) from any page open on the network, and it lands here as if the
// person had clicked. So anything that changes something must carry no Origin
// at all (curl, the builders: not a page in someone's browser) or one that is
// this server. This is not authentication and does not stop DNS rebinding;
// ACCESS_PASSWORD is the part that does.
//   ACCESS_PASSWORD  HTTP Basic in front of everything but what a console fetches
//   ACCESS_USER      the user name that goes with it (default shadow)
//   ALLOWED_ORIGINS  more sites a browser may post from, e.g. a proxy's name
//   BIND_ADDRESS     listen on one address of this machine instead of all
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const ACCESS_USER = process.env.ACCESS_USER || 'shadow';
const BIND_ADDRESS = (process.env.BIND_ADDRESS || '').trim().replace(/^\[(.*)\]$/, '$1');
const NAME_CHARS = /^[a-z0-9._\-[\]:]+$/i;
const clip = s => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
const peerOf = req => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// "host[:port]" the way two of them can be compared: lower case, and without
// the port when it is the scheme's own, since a browser leaves that out of an
// Origin (http://nas.lan, not http://nas.lan:80).
function hostKey(text, scheme = 'http') {
  if (!NAME_CHARS.test(text)) return '';
  try { return new URL(`${scheme}://${text}`).host; } catch { return ''; }
}
function originHost(origin) {
  const m = /^(https?):\/\/([^/]+)$/i.exec(origin);
  return m ? hostKey(m[2], m[1].toLowerCase()) : '';
}
function publicBaseHost() {
  try { return new URL(PUBLIC_BASE()).host; } catch { return ''; }
}

// Entries are full origins (http://nas.lan:12801) or a bare host[:port]. A bare
// one has no scheme to say which default port it means, so it counts for both.
const ALLOWED_HOSTS = new Set();
for (const raw of (process.env.ALLOWED_ORIGINS || '').split(',')) {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) continue;
  const keys = /^https?:\/\//i.test(s) ? [originHost(s)] : [hostKey(s, 'http'), hostKey(s, 'https')];
  if (keys.some(Boolean)) keys.filter(Boolean).forEach(k => ALLOWED_HOSTS.add(k));
  else console.log(`ALLOWED_ORIGINS: ignoring "${clip(s)}", which is not a host or an origin`);
}

// The reason a state-changing request is refused, or null. Requests without an
// Origin pass: a script is not a page riding on a browser. Content-Type is not
// looked at, so curl -d keeps working.
function crossSiteRule(req) {
  const origin = req.headers.origin;
  let listed = false;
  if (origin !== undefined) {
    if (origin === 'null') return 'Origin is "null" (a sandboxed frame or a local file)';
    const oh = originHost(origin);
    listed = !!oh && ALLOWED_HOSTS.has(oh);
    const hostText = String(req.headers.host || '');
    if (!oh || (oh !== hostKey(hostText, 'http') && oh !== hostKey(hostText, 'https') && oh !== publicBaseHost() && !listed)) {
      return `Origin ${clip(origin)} is not this server, PUBLIC_BASE or ALLOWED_ORIGINS`;
    }
  }
  // A site the owner named has been let in on purpose, so it is not turned away
  // for being another site.
  if (req.headers['sec-fetch-site'] === 'cross-site' && !listed) return 'Sec-Fetch-Site says cross-site';
  return null;
}

// First look at DNS rebinding, and only a look: a page on some other name that
// has been pointed at this server arrives with that name in Host. Names a home
// network really uses are not worth a line (addresses, localhost, short names
// like nas, the public base, anything the owner listed), so what is left is
// logged once per distinct value. Capped, since the value is the sender's.
const oddHosts = new Set();
function noteOddHost(req) {
  const raw = String(req.headers.host || '');
  if (!raw || oddHosts.has(raw) || oddHosts.size >= 50) return;
  const name = raw.toLowerCase().replace(/:\d+$/, '');
  // Cheapest tests first: this runs for every request, package range requests included.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:.]+\]$/.test(name) || name === 'localhost' || !name.includes('.')) return;
  const key = hostKey(raw);
  if (key && (key === publicBaseHost() || ALLOWED_HOSTS.has(key))) return;
  oddHosts.add(raw);
  console.log(`Host header "${clip(raw)}" from ${peerOf(req)} is not an address, localhost, a short name or PUBLIC_BASE${oddHosts.size >= 50 ? ' (no more of these will be logged)' : ''}. Nothing was refused. It is usual for a local DNS name or a proxy; if you did not set one up, something may be pointing a name at this server.`);
}

// What a console fetches, and it cannot send credentials: package links, the
// health-check probe and the liveness check. /files/ is the older way to fetch
// a file by its path, so it is not on this list.
const openToAll = (req, p) => (req.method === 'GET' || req.method === 'HEAD') && (p.startsWith('/p/') || p.startsWith('/probe/') || p === '/healthz');

// Digests, so what is compared is always 32 bytes and the comparison takes as
// long for a short guess as for a long one.
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const ACCESS_USER_SHA = sha(ACCESS_USER), ACCESS_PASSWORD_SHA = sha(ACCESS_PASSWORD);
if (ACCESS_PASSWORD) console.log(`a password is needed to use the page (user "${clip(ACCESS_USER)}"); package links and the health check stay open`);

// 'ok', 'wrong' (credentials were sent and are not right), 'none', or 'locked'
// (credentials were sent from an address that has been shut out; not read).
function checkAccess(req) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return 'none';
  if (lockedOut(peerOf(req))) return 'locked';
  const pair = Buffer.from(m[1], 'base64').toString('utf8');
  const i = pair.indexOf(':');
  // Both are always compared, so a right user name is not told apart by timing.
  const userOk = crypto.timingSafeEqual(sha(i < 0 ? pair : pair.slice(0, i)), ACCESS_USER_SHA);
  const passOk = crypto.timingSafeEqual(sha(i < 0 ? '' : pair.slice(i + 1)), ACCESS_PASSWORD_SHA);
  return userOk && passOk ? 'ok' : 'wrong';
}

// A wrong guess is answered half a second late, and a second one from the same
// address waits behind the first. That alone would not slow anyone down who
// opens many connections at once and only reads the answer, so an address that
// gets ten wrong in a minute is shut out for a minute: while it is, anything it
// sends with a user name and password is refused unread, the right one included,
// so the refusal cannot be used to tell a right guess from a wrong one. (Two
// people behind one address, a proxy for one, share that lock.) The log line
// never carries what was typed, and comes at most every ten seconds per address
// so a run of guesses cannot push everything else out of the log.
const AUTH_DELAY_MS = 500, AUTH_STRIKES = 10, AUTH_WINDOW_MS = 60000, AUTH_LOCK_MS = 60000;
const authFails = new Map();   // address -> { next: when its next refusal may go out, strikes, since, lockUntil }
const lastLogged = new Map();  // key -> { at, muted }: one line per key per ten seconds, with a count of what was held back
function logSometimes(key, text) {
  const now = Date.now();
  if (lastLogged.size > 500) for (const [k, v] of lastLogged) if (now - v.at > 10000) lastLogged.delete(k);
  const l = lastLogged.get(key) || { at: 0, muted: 0 };
  lastLogged.set(key, l);
  if (now - l.at < 10000) { l.muted++; return; }
  console.log(l.muted ? `${text} (${l.muted} more since the last line)` : text);
  l.at = now; l.muted = 0;
}
const lockedOut = ip => { const f = authFails.get(ip); return !!f && f.lockUntil > Date.now(); };
async function refuseAccess(req, res, p, got) {
  const head = { 'WWW-Authenticate': 'Basic realm="ShadowPKG", charset="UTF-8"', 'Content-Type': 'application/json' };
  let code = 401, body = { error: 'a user name and password are needed' };
  const ip = peerOf(req), now = Date.now();
  if (got === 'locked') {
    const f = authFails.get(ip);
    code = 429; body = { error: 'too many wrong passwords from this address, wait a minute' };
    head['Retry-After'] = String(Math.max(1, Math.ceil((f.lockUntil - now) / 1000)));
    logSometimes('lock:' + ip, `refused ${req.method} ${p} from ${ip}: shut out for a minute after wrong passwords`);
  } else if (got === 'wrong') {
    if (authFails.size > 500) for (const [k, v] of authFails) if (v.next < now && v.lockUntil < now) authFails.delete(k);
    const f = authFails.get(ip) || { next: 0, strikes: 0, since: now, lockUntil: 0 };
    authFails.set(ip, f);
    if (now - f.since > AUTH_WINDOW_MS) { f.strikes = 0; f.since = now; }
    f.strikes++;
    if (f.strikes >= AUTH_STRIKES) { f.lockUntil = now + AUTH_LOCK_MS; f.strikes = 0; f.since = now; }
    const at = Math.max(f.next, now) + AUTH_DELAY_MS;
    f.next = at;
    await sleep(at - now);
    logSometimes('wrong:' + ip, `refused ${req.method} ${p} from ${ip}: wrong user name or password${f.lockUntil > now ? ' (that address is now shut out for a minute)' : ''}`);
  }
  const text = JSON.stringify(body);
  head['Content-Length'] = Buffer.byteLength(text);
  res.writeHead(code, head);
  res.end(text);
}

// A held send remembers its package by path. When the package is renamed the
// hand-over would find nothing and count it as a failure, so it follows the file.
function repointHeld(srcId, from, to) {
  let n = 0;
  for (const h of held) if (h.src === srcId && h.rel === from) { h.rel = to; h.name = to.split('/').pop(); n++; }
  if (n) saveHeld();
  return n;
}

// And when it is deleted there is nothing left to hand over, so the entry goes
// too; what went is returned so the answer can say so.
function dropHeld(srcId, rel) {
  const gone = held.filter(h => h.src === srcId && h.rel === rel);
  if (!gone.length) return [];
  held = held.filter(h => !gone.includes(h));
  saveHeld();
  return gone.map(h => { const prof = findProfile(h.profile); return { console: prof ? prof.name : 'a console', name: h.name }; });
}

// ---- Files that are not packages ---------------------------------------------
// Any file in a library can be selected now, not only a package: renamed, deleted,
// and looked at the way Explorer's Properties does. What a file is called, what
// must never be touched from here, what Properties says and the checksum jobs are
// all in this block. Nothing in it changes how packages are listed, read or sent.

// The part after the last dot, lowercase; '' when there is none.
function extOf(name) { const m = /\.([^\s.\/\\]{1,16})$/.exec(name); return m ? m[1].toLowerCase() : ''; }
// The order the folder listing sorts in (File 2 before File 10), without the cost per comparison of localeCompare.
const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
// The two kinds of file a folder listing gives their own rows; anything else is another file.
// With ALLOW_ANY_FILE every file that is not an archive counts as a package, as browse() has it.
const isArchiveName = name => /\.(rar|r\d\d|zip|7z)$/i.test(name);
const isPackageName = name => !isArchiveName(name) && (ANY_FILE || /\.pkg$/i.test(name));
// Where the archive part of "archive.rar!/inner.pkg" ends, or -1 when the path has none: a folder
// called "Sale!" is only a folder, so the marker counts only after something that could be a .rar.
const arcCut = rel => { const i = rel.indexOf(ARC); return i >= 0 && /\.rar$/i.test(rel.slice(0, i)) ? i : -1; };

// What Properties calls a file, and which icon family the page draws for it. {EXT} is the
// extension in capitals ("PNG image"); one nobody listed here is "<EXT> file".
const FILE_TYPES = new Map();
for (const [exts, typeName, iconKind] of [
  ['rar', 'RAR archive', 'archive'], ['zip', 'ZIP archive', 'archive'], ['7z', '7-Zip archive', 'archive'],
  ['txt log md nfo', 'Text document', 'text'],
  ['json xml ini cfg', 'Data file', 'code'],
  ['jpg jpeg png gif webp bmp', '{EXT} image', 'image'],
  ['mp4 mkv avi mov', '{EXT} video', 'video'],
  ['mp3 flac wav ogg', '{EXT} audio', 'audio'],
  ['iso bin img', 'Disk image', 'disk'],
  ['exe dll', 'Windows application', 'file'],
  ['sh js py ps1 bat', 'Script', 'code'],
  ['pdf', 'PDF document', 'document'],
]) for (const e of exts.split(' ')) FILE_TYPES.set(e, { typeName, iconKind });

function typeOf(name, meta, isDir, isLink) {
  if (isDir) return { typeName: 'Folder', iconKind: 'folder' };
  if (isLink) return { typeName: 'Symbolic link', iconKind: 'file' };
  const ext = extOf(name);
  // A package is named after its console when its details say which.
  if (ext === 'pkg') return { typeName: meta && (meta.platform === 'PS4' || meta.platform === 'PS5') ? `${meta.platform} package` : 'Package', iconKind: 'package' };
  const t = FILE_TYPES.get(/^r\d\d$/.test(ext) ? 'rar' : ext);     // name.r00, r01, … are the parts of a RAR set
  if (t) return { typeName: t.typeName.replace('{EXT}', ext.toUpperCase()), iconKind: t.iconKind };
  return { typeName: ext ? `${ext.toUpperCase()} file` : 'File', iconKind: 'file' };
}

// ---- Which file a request names
// Every rule about a file (is it a package? an archive? one of the app's own? being
// built from? somewhere else than this library?) is decided from the file itself, never
// from the string that was sent. On a file system that ignores case, that has short
// names, or that has links, one file has many spellings: "A.pkg/", "./a.PKG", "A.pkg::$DATA"
// (Windows), "GAMEPA~1.PKG", "alias/A.pkg" are one file, and a rule that looks at the
// spelling can be walked around by choosing another.
const CASE_BLIND_FS = process.platform === 'win32' || process.platform === 'darwin';
const foldCase = p => (CASE_BLIND_FS ? p.toLowerCase() : p);
const within = (parent, p) => p === parent || p.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/');
const realOf = async p => { try { return await fsp.realpath(p); } catch { return p; } };
// What the file system said about a failed call, without the host's own paths in it
// (Node's message is "EBUSY: resource busy or locked, unlink 'C:\...'").
const fsErr = e => String(e && e.message).split(', ')[0].replace(/'[^']*'/g, '').trim();
// A file that something else has open, or will not let go of: a conflict, not a fault of the server's.
const BUSY_CODES = new Set(['EBUSY', 'ETXTBSY', 'EAGAIN', 'EPERM', 'EACCES']);
const LEAVES_MSG = 'that is reached through a link that leads outside this library, so ShadowPKG leaves it alone';
// Renaming or deleting a folder is not done from here (a folder holds what a console may be pulling, and there is no undo), and it is said as that, not as "not found".
const FOLDER_MSG = 'A folder cannot be renamed or deleted here';

// The file `raw` (a library-relative path as the page or a caller sent it) really is:
//   asked  the request resolved against the library (dot segments and a trailing slash gone)
//   full   the file in the app's own spelling: the library's root as configured plus the path the
//          disk has it under (case, long names and links resolved); what everything is done to
//   rel    the same, relative to the library: what lists, held sends and the details cache are keyed on
//   real   the real path (links and short names followed; a link itself keeps its own name)
//   names  the names the rules read: as asked and as the disk has it
//   id     the file's identity (device:inode), null when the file system has none
// or {status, error} for a path that is outside. `outside` is set when the folder it is in is,
// through a link, somewhere else than the library. A file that is not there gets what could be
// worked out from the string alone and exists: false.
async function locate(src, raw) {
  if (typeof raw !== 'string' || raw.includes('\0')) return { status: 403, error: 'forbidden' };
  const asked = safeDir(src.root, raw);
  if (!asked) return { status: 403, error: 'forbidden' };
  const realRoot = await realOf(src.root);
  const at = { asked, full: asked, rel: relOf(src.root, asked), real: null, realRoot, exists: false, link: false, outside: false, id: null, names: asked === src.root ? [] : [path.basename(asked)] };
  if (asked === src.root) { at.real = realRoot; at.exists = true; return at; }
  let st;
  try { st = await fsp.lstat(asked); } catch { return at; }
  at.exists = true; at.link = st.isSymbolicLink();
  try {
    // A link is the entry itself (renaming or deleting it leaves what it points to alone), so it is found by its folder.
    at.real = at.link ? path.join(await fsp.realpath(path.dirname(asked)), path.basename(asked)) : await fsp.realpath(asked);
  } catch { return at; }           // a file system that will not say: the rules go by the path as asked
  if (!within(foldCase(realRoot), foldCase(at.real))) { at.outside = true; return at; }
  at.rel = relOf(realRoot, at.real);
  at.full = path.join(src.root, at.rel);
  if (!at.names.includes(path.basename(at.real))) at.names.push(path.basename(at.real));
  try { const s = await fsp.stat(at.full, { bigint: true }); at.id = s.ino ? `${s.dev}:${s.ino}` : null; } catch {}
  return at;
}
const atPackage = at => at.names.some(isPackageName);
const atArchive = at => at.names.some(isArchiveName);

// The same for a check that cannot wait for an answer (nothing may be awaited between looking and acting).
function spotSync(full) {
  const at = { full, real: null, id: null };
  try { at.real = fs.realpathSync.native(full); } catch {}
  try { const st = fs.statSync(full, { bigint: true }); at.id = st.ino ? `${st.dev}:${st.ino}` : null; } catch {}
  return at;
}
// Whether the file a job (an unpack, a checksum) works on is this one, however either was reached:
// the same path without regard to case, the same real path, or the same file on disk.
const sameFile = (j, at) => foldCase(j.full) === foldCase(at.full)
  || !!(j.real && at.real && foldCase(j.real) === foldCase(at.real))
  || !!(j.fileId && at.id && j.fileId === at.id);

// Whether the folder `full` (which a link may have led to) is somewhere other than in this library.
async function leavesLibrary(src, full) {
  try { return !within(foldCase(await realOf(src.root)), foldCase(await fsp.realpath(full))); }
  catch { return false; }          // not there: the read that follows says so
}

// ---- What is never renamed or deleted from here
// Work in progress and the app's own files can be selected like any file, and must
// still be left alone: a build's or an unpack's scratch folder (whatever is in it is
// being written by something else right now), the builder's status files at a
// library's root, ShadowPKG's own files in the config folder, and a game dump that a
// build is reading in place. Names are matched without regard to case on every platform
// (a share is often case-blind whatever this machine is), and on the file's real path.
// Only the exact layouts are protected, so a person's own .shadowpkg-build-notes.txt or
// .shadowpkg-buildlist.txt is an ordinary file: the build folder (a folder of that very name
// and everything under it), an unpack folder (that name and 12 hex digits), and the builder's
// files at a library's root (its status and log, with the temporary name they are written under).
const SCRATCH_NAME = /^\.shadowpkg-(?:build|extract-[0-9a-f]{12}|save-[0-9a-f]+)$/i;      // (save-: the temp file a text save writes beside the original)
const BUILDER_FILE = /^\.shadowpkg-(?:builder\.(?:json|log)(?:\.tmp)?|libraries\.json)$/i;
// Windows reaches a file by more than one spelling: a trailing dot or space is dropped and ":stream" names
// a data stream of it, so a name is judged as Windows would read it, on every platform.
function asWindowsName(name) {
  const colon = name.indexOf(':');
  let end = colon < 0 ? name.length : colon;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end--;
  return name.slice(0, end);
}
const scratchSeg = seg => SCRATCH_NAME.test(asWindowsName(seg));
const builderName = name => BUILDER_FILE.test(asWindowsName(name));
// What ShadowPKG (and the builder, when it shares the folder) writes in CONFIG_DIR, by its first name below it.
// A library may be that folder, or in it: what is not one of these is the library's and goes as any file does.
const OWN_CONFIG_FILE = /^(?:(?:profiles|settings|libraries|packages|archives|titles|history|held|builds|extracting|transfers|dumpbuilds|pins|init|smoke)\.json(?:\.tmp)?|server\.log(?:\.\d+)?|(?:init|smoke|builder)\.log|init|themes)$/i;

// The folders (library-relative, real, lower case: a share may ignore case whatever this machine does) of the game dumps that a build in a library is waiting
// for, running on or has lost touch with: it reads them in place, so nothing in one may change.
async function liveDumps(src) {
  const out = [];
  const realRoot = await realOf(src.root);
  for (const b of builds) {
    if (b.src !== src.id || !b.dumpRel || b.final) continue;      // (a build that has ended has its final view kept)
    // Only whether it is live matters here, and this runs on every rename and delete: not buildView, which measures the work folder.
    const { state } = readBuildState(b);
    if (TERMINAL.has(state) || state === 'gone') continue;
    const dir = safeDir(src.root, b.dumpRel);
    if (!dir) continue;
    let rel = relOf(src.root, dir);
    try { rel = relOf(realRoot, await fsp.realpath(dir)); } catch {}
    out.push(rel.toLowerCase());
  }
  return out;
}

// The folders (library-relative, lower case) that a DLC build still to finish writes its package into. Its job folder is
// kept elsewhere, so nothing else says a folder is spoken for: renaming, moving or deleting it (or one that holds it) would
// send the package to a place that is gone.
function liveOutputDirs(src) {
  const out = [];
  for (const b of builds) {
    if (b.src !== src.id || b.kind !== 'dlc' || b.final || !b.outputDirRel) continue;
    const { state } = readBuildState(b);
    if (TERMINAL.has(state) || state === 'gone') continue;
    out.push(b.outputDirRel.toLowerCase());
  }
  return out;
}

// Whether a build (a job folder of a build that is waiting, running or has stalled) or an unpack (a
// folder a job of this process is unpacking into) is using what `paths` names: the same folder, or
// something inside it, or the folder that holds it.
async function scratchInUse(src, paths, isBuild) {
  const mine = paths.map(foldCase);
  const overlaps = dir => mine.some(p => within(dir, p) || within(p, dir));
  if (!isBuild) return [...unpackActive.keys()].some(dir => overlaps(foldCase(dir)));
  for (const b of builds) {
    if (b.src !== src.id || b.final) continue;
    const { dir, state } = readBuildState(b);
    if (!dir || TERMINAL.has(state) || state === 'gone') continue;
    if (overlaps(foldCase(dir)) || overlaps(foldCase(await realOf(dir)))) return true;
  }
  return false;
}

// {status, error} when `at` (see locate) must not be renamed or deleted (`doing` is the word for the
// sentence: "renamed" or "deleted"), otherwise null. `seen` is kept by the caller for the length of one
// request, so a batch looks at the builds once.
async function untouchable(src, at, doing, seen = {}) {
  const paths = [at.asked, at.real, at.full].filter(Boolean);
  if (!seen.roots) {
    seen.roots = new Set();
    for (const s of SOURCES) { seen.roots.add(foldCase(s.root)); seen.roots.add(foldCase(await realOf(s.root))); }
    seen.configs = [...new Set([path.resolve(CONFIG_DIR), await realOf(CONFIG_DIR)])];
  }
  if (paths.some(p => builderName(path.basename(p)) && seen.roots.has(foldCase(path.dirname(p))))) {
    return { status: 400, error: `that is the builder's own file, so it cannot be ${doing}` };
  }
  const scratch = [at.rel, relOf(src.root, at.asked)].flatMap(r => r.split('/')).find(scratchSeg);
  if (scratch !== undefined) {
    // Its own folder either way; "still going" only when a build or an unpack really is using it.
    if (await scratchInUse(src, paths, asWindowsName(scratch).toLowerCase() === '.shadowpkg-build')) {
      return { status: 409, error: `that belongs to a build or an unpack that is still going, so it cannot be ${doing}` };
    }
    return { status: 400, error: `that is one of ShadowPKG's own scratch folders (no build or unpack is using it now), so it cannot be ${doing} from here` };
  }
  const own = { status: 400, error: `that is one of ShadowPKG's own files, so it cannot be ${doing}` };
  for (const config of seen.configs) {
    for (const p of paths) {
      if (p !== config && within(foldCase(config), foldCase(p)) && OWN_CONFIG_FILE.test(path.relative(config, p).split(path.sep)[0])) return own;
    }
  }
  seen.dumps = seen.dumps || new Map();
  if (!seen.dumps.has(src.id)) seen.dumps.set(src.id, await liveDumps(src));
  const key = at.rel.toLowerCase();
  if (seen.dumps.get(src.id).some(d => key === d || key.startsWith(d + '/'))) {
    return { status: 409, error: `a build is running on this dump, so its files cannot be ${doing}` };
  }
  if (key && doing !== 'added to' && doing !== 'written into' && doing !== 'edited' && liveOutputDirs(src).some(o => o === key || o.startsWith(key + '/'))) {
    return { status: 409, error: `a build is writing its package into this folder, so it cannot be ${doing} until that build has finished` };
  }
  return null;
}

// What is remembered about the packages inside an archive is keyed by the archive's path, so a
// renamed archive takes it along: the details already read, and the held sends that point into it.
function moveArchiveRefs(srcId, from, to) {
  const was = `${srcId}\n${from}${ARC}`;
  for (const [k, v] of [...metaCache]) if (k.startsWith(was)) { metaCache.set(`${srcId}\n${to}${ARC}${k.slice(was.length)}`, v); metaCache.delete(k); }
  let n = 0;
  for (const h of held) if (h.src === srcId && h.rel.startsWith(from + ARC)) { h.rel = to + h.rel.slice(from.length); n++; }
  if (n) saveHeld();
  saveMetaSoon();
  return n;
}

// ---- Properties
// A folder is counted by a walk with hard limits, so a share of millions of files costs
// a bounded amount: async reads, sizes taken a few at a time, the event loop given back
// after every batch, and links never followed (one is counted as a file of no size).
const PROPS_WALK_ENTRIES = 200000, PROPS_WALK_MS = 8000;
async function countFolder(dir, out) {
  const started = Date.now();
  const todo = [dir];
  let seen = 0, first = true;
  walking: while (todo.length) {
    if (Date.now() - started > PROPS_WALK_MS) { out.truncated = true; break; }
    const here = todo.pop();
    let handle;
    try { handle = await fsp.opendir(here, { bufferSize: 512 }); }
    catch (e) { if (first) throw e; continue; }      // a folder inside that cannot be read counts for nothing
    first = false;
    try {
      for (;;) {
        const batch = [];
        for (let e; batch.length < 500 && (e = await handle.read());) batch.push(e);
        if (!batch.length) break;
        if (Date.now() - started > PROPS_WALK_MS) { out.truncated = true; break walking; }
        const sized = [];
        for (const e of batch) {
          if (seen >= PROPS_WALK_ENTRIES) { out.truncated = true; break walking; }
          seen++;
          if (e.isDirectory()) { out.dirs++; todo.push(path.join(here, e.name)); }
          else { out.files++; if (isPackageName(e.name)) out.packages = (out.packages || 0) + 1; if (e.isFile()) sized.push(path.join(here, e.name)); }
        }
        for (let i = 0; i < sized.length; i += 64) {
          for (const n of await Promise.all(sized.slice(i, i + 64).map(f => fsp.lstat(f).then(s => s.size, () => 0)))) out.bytes += n;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { await handle.close().catch(() => {}); }
  }
  return out;
}

// Two people opening the properties of one folder, or one person twice, share one walk. The walk
// looks at the clock between batches, so one read that hangs (a share that has stopped answering)
// would hold it past its limit: the answer is given at the limit plus a few seconds whatever it is doing.
// Counting a folder is a disk read like a download's, so only a few run at once (the rest wait their
// turn, up to a queue's length, and past that the caller is told to come back): a page that asks for
// thousands of folders cannot take the disk, the thread pool or the memory from the consoles.
const PROPS_WALKS_AT_ONCE = 2, PROPS_WALKS_QUEUED = 50;
const propsWalks = new Map();     // the folder's real path (folded where case does not matter) -> the walk in progress or waiting
const walkQueue = [];             // what waits for a turn, in order
let walksRunning = 0;
function folderContents(src, dir, key) {
  let run = propsWalks.get(key);
  if (run) return run;
  let turn;
  if (walksRunning < PROPS_WALKS_AT_ONCE) { walksRunning++; turn = Promise.resolve(); }
  else if (walkQueue.length < PROPS_WALKS_QUEUED) turn = new Promise(resolve => walkQueue.push(resolve));
  else return null;
  let handed = false;
  const hand = () => { if (handed) return; handed = true; const next = walkQueue.shift(); if (next) next(); else walksRunning--; };
  run = turn.then(() => {
    // The limits count from when the walk starts, not from when it asked.
    const out = { files: 0, dirs: 0, bytes: 0, packages: 0, truncated: false };
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve({ ...out, truncated: true }), PROPS_WALK_MS + 5000); });
    return Promise.race([countFolder(dir, out), late]).finally(() => clearTimeout(timer));
  }).then(r => {
    if (r.truncated) console.log(`counting ${src.label}/${relOf(src.root, dir)} stopped at its limit: ${r.files} files, ${r.dirs} folders and ${fmtGb(r.bytes)} so far`);
    return r;
  }).finally(() => { hand(); propsWalks.delete(key); });
  propsWalks.set(key, run);
  return run;
}

const canWrite = f => fsp.access(f, fs.constants.W_OK).then(() => true, () => false);

// ---- Deleting a folder (and everything inside it)
// Two phases, run back-to-back with no await back to the client in between: phase 1 (walkForDelete)
// only ever reads and validates — it never unlinks or removes anything — and phase 2 (in the
// /api/delete route) deletes only once phase 1 has walked the WHOLE tree and found nothing wrong.
// Any problem anywhere in the tree — busy file, a nested ShadowPKG path, something unreadable, too
// much to fully check — aborts the whole folder with nothing removed from it. A folder delete is a
// one-shot, high-stakes operation (unlike Properties, which is asked for over and over as someone
// browses), so it is given a higher entry/time budget than the read-only walk before it gives up.
const DELETE_WALK_ENTRIES = 400000, DELETE_WALK_MS = 15000;

// Whether the subpath `full` (library-relative path `rel`) found mid-walk is one of ShadowPKG's own
// paths or a live game dump — the same rules `untouchable` applies to the one path it is handed, but
// here applied to EVERY subpath discovered while walking a folder that is about to be deleted, so a
// config/scratch/dump folder nested two levels inside what is being deleted still refuses the whole
// thing (untouchable itself is only ever called on the exact item the request named). `seen` must
// already have been populated by a prior call to untouchable() on the folder itself (the /api/delete
// route makes that call before it ever reaches the walk, for files and folders alike).
async function subpathBarred(src, seen, full, rel) {
  const doing = 'deleted';
  const scratch = rel.split('/').find(scratchSeg);
  if (scratch !== undefined) {
    if (await scratchInUse(src, [full], asWindowsName(scratch).toLowerCase() === '.shadowpkg-build')) {
      return `that belongs to a build or an unpack that is still going, so it cannot be ${doing}`;
    }
    return `that is one of ShadowPKG's own scratch folders (no build or unpack is using it now), so it cannot be ${doing} from here`;
  }
  for (const config of seen.configs) {
    if (full !== config && within(foldCase(config), foldCase(full)) && OWN_CONFIG_FILE.test(path.relative(config, full).split(path.sep)[0])) {
      return `that is one of ShadowPKG's own files, so it cannot be ${doing}`;
    }
  }
  const dumps = (seen.dumps && seen.dumps.get(src.id)) || [];
  const key = rel.toLowerCase();
  if (dumps.some(d => key === d || key.startsWith(d + '/'))) return `a build is running on this dump, so its files cannot be ${doing}`;
  if (builderName(path.basename(full)) && seen.roots.has(foldCase(path.dirname(full)))) return `that is the builder's own file, so it cannot be ${doing}`;
  return null;
}

// Phase 1: walk `rootFull` (the folder about to be deleted, in the app's own — config-root-based —
// spelling, same as every other file op in this file) and validate it end to end, changing NOTHING on
// disk. Returns {abort: <message>} the moment anything is wrong, or the full counts and the exact file
// list to remove in phase 2 otherwise: {files, dirs, bytes, packages, fileList, dirList, linkList,
// packageRels}.
//
// Containment is not a check bolted on afterwards — it falls out of how the walk is written: `todo`
// only ever receives a path built from `here` (a directory this same walk already opened) plus a name
// `fsp.opendir` just handed back, and a directory is only ever pushed onto `todo` when the OS says the
// entry itself (not its target) is a real directory. A symlink or junction entry is never pushed onto
// `todo` — dirent.isSymbolicLink() is true for it and dirent.isDirectory() is false, whatever it points
// to — so the walk can never leave `rootFull`'s own real subtree by following a link. That entry is
// instead unlinked AS ITSELF in phase 2 (removing the link, never the thing it points to — the same way
// Node's fs.rm/unlink treats a symlink), and never recursed into. See t-delfolders.js for a test that
// proves this holds for both a symlink and a Windows junction on this platform, BEFORE phase 2 is ever
// trusted to run for real.
//
// `rootReal` is the root's real (resolved) path, taken once by the caller — from locate(), before
// either call to this function ever runs — and passed unchanged into both. Every entry BELOW the
// root gets its containment check for free, from its own parent's already-open directory handle (see
// above); the root itself has no parent handle to have already told us, safely, what it is — it is
// the one directory in this whole walk reached by a fresh, independently re-resolved path, on every
// single call. So it alone is re-verified explicitly, immediately before AND immediately after its
// own opendir: lstat'd first (still a real directory, not now a link), then, once opened, realpath'd
// again and compared against `rootReal` — if the two calls to this function (or a request's own
// phase 1 and phase 2) are ever separated by enough of a gap for the root to be renamed away and
// replaced with a symlink/junction to somewhere else, this catches it right there, before a single
// entry from whatever is now at that path is ever read, let alone deleted.
async function walkForDelete(src, seen, rootFull, rootReal) {
  const out = { files: 0, dirs: 0, bytes: 0, packages: 0 };
  const fileList = [];       // {full, rel, size}: every real file found, unlinked in phase 2
  const dirList = [rootFull]; // every real directory found (root included), removed bottom-up in phase 2
  const linkList = [];       // {full, rel}: symlink/junction entries, unlinked as themselves only
  const packageRels = [];    // rel of every file inside that looks like a package (for metaCache/held cleanup)
  const started = Date.now();
  const todo = [rootFull];
  let seenCount = 0, truncated = false, first = true;
  walking: while (todo.length) {
    if (Date.now() - started > DELETE_WALK_MS) { truncated = true; break; }
    const here = todo.pop();
    const isRoot = first; first = false;
    if (isRoot) {
      let rootLst;
      try { rootLst = await fsp.lstat(here); }
      catch { return { abort: 'could not read everything inside it, so nothing was deleted' }; }
      if (!rootLst.isDirectory()) return { abort: 'changed while this was being checked (it is no longer a real folder), so nothing was deleted' };
    }
    let handle;
    try { handle = await fsp.opendir(here, { bufferSize: 512 }); }
    catch (e) { return { abort: 'could not read everything inside it, so nothing was deleted' }; }
    if (isRoot) {
      let realNow;
      try { realNow = await fsp.realpath(here); }
      catch { await handle.close().catch(() => {}); return { abort: 'could not read everything inside it, so nothing was deleted' }; }
      if (foldCase(realNow) !== foldCase(rootReal)) {
        await handle.close().catch(() => {});
        return { abort: 'changed while this was being checked (it no longer resolves to the same real folder), so nothing was deleted' };
      }
    }
    try {
      for (;;) {
        const batch = [];
        for (let e; batch.length < 500 && (e = await handle.read());) batch.push(e);
        if (!batch.length) break;
        if (Date.now() - started > DELETE_WALK_MS) { truncated = true; break walking; }
        for (const e of batch) {
          if (seenCount >= DELETE_WALK_ENTRIES) { truncated = true; break walking; }
          seenCount++;
          const full = path.join(here, e.name);
          const rel = relOf(src.root, full);
          const barred = await subpathBarred(src, seen, full, rel);
          if (barred) return { abort: barred };
          if (e.isSymbolicLink()) {
            out.files++; linkList.push({ full, rel });
            continue;
          }
          if (e.isDirectory()) {
            out.dirs++; dirList.push(full); todo.push(full);
            continue;
          }
          out.files++;
          const isPkg = isPackageName(e.name);
          if (isPkg) { out.packages++; packageRels.push(rel); }
          let st;
          try { st = await fsp.lstat(full); }
          catch { return { abort: 'could not read everything inside it, so nothing was deleted' }; }
          out.bytes += st.size;
          // A read-only file could well still unlink fine (Windows does not always refuse it), but
          // that is not the point: a read-only flag is a deliberate signal, and the safer, simpler
          // rule — all-or-nothing, like every other guard here — is to refuse the whole folder
          // rather than silently overrule it for some files while leaving others alone.
          if (!(await canWrite(full))) return { abort: `${rel} is read-only, so nothing in this folder was deleted` };
          const busy = busyTransfer(src.id, r => r === rel);
          if (busy) return { abort: `${rel} is downloading right now (${ps5NameFor(busy.ip) || busy.ip}), so nothing in this folder was deleted` };
          if (hashingNow({ full, real: full, id: null })) return { abort: `${rel} is having a checksum worked out on it right now, so nothing in this folder was deleted` };
          if (isArchiveName(e.name)) {
            const inUse = archiveInUse(src, rel, full);
            if (inUse) return { abort: `${rel}: ${inUse}, so nothing in this folder was deleted` };
          }
          fileList.push({ full, rel, size: st.size });
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { await handle.close().catch(() => {}); }
  }
  if (truncated) return { abort: 'too large to delete in one go; delete what is inside it in smaller pieces first' };
  return { ...out, fileList, dirList, linkList, packageRels };
}

// ---- One local item's delete, as its own callable function ---------------------
// This IS the /api/delete route's per-item logic, pulled out so it has exactly one
// definition: the route below loops items and calls this once per item, and the
// transfers feature's Move calls it too, once, on an already-verified source (see
// "Safety invariants for Move" in the transfers section further down). No second,
// parallel deletion mechanism exists anywhere in this file for a local path.
// Returns {ok:true, entry, touched, packageRels} or {ok:false, error, touched?}.
async function deleteLocalOne(src, raw, seen) {
  const fail = error => ({ ok: false, error });
  if (typeof raw !== 'string') return fail('not found');
  if (raw.includes(ARC)) return fail('inside an archive — extract it first, then the archive can be deleted from its own row');
  const at = await locate(src, raw);
  if (at.error) return fail(at.error);
  if (at.outside) return fail(LEAVES_MSG);
  const { full, rel } = at;
  const barred = await untouchable(src, at, 'deleted', seen);
  if (barred) return fail(barred.error);

  let st;
  try { st = await fsp.lstat(full); } catch { return fail('not found'); }
  if (st.isSymbolicLink()) {
    try { fs.accessSync(path.dirname(full), fs.constants.W_OK); }
    catch { return fail(`${src.label} is mounted read-only`); }
    try { await serial(() => fsp.unlink(full)); }
    catch (e) { return fail(`could not delete it: ${fsErr(e)}`); }
    return { ok: true, entry: { link: true }, touched: false, packageRels: [] };
  }
  if (st.isDirectory()) {
    if (rel === '') return fail("a library's root cannot be deleted here");
    try { fs.accessSync(path.dirname(full), fs.constants.W_OK); }
    catch { return fail(`${src.label} is mounted read-only`); }

    // Phase 1, then a fresh re-validation immediately before phase 2 — see the
    // comment on walkForDelete and on the /api/delete route above for why this
    // runs twice, back to back, with nothing awaited from the caller in between.
    const v1 = await walkForDelete(src, seen, full, at.real);
    if (v1.abort) return fail(v1.abort);
    const v = await walkForDelete(src, seen, full, at.real);
    if (v.abort) return fail(v.abort);

    {
      let rootLst2;
      try { rootLst2 = await fsp.lstat(full); }
      catch { return fail('could not read everything inside it, so nothing was deleted'); }
      if (!rootLst2.isDirectory()) return fail('changed while this was being checked (it is no longer a real folder), so nothing was deleted');
      let realNow2;
      try { realNow2 = await fsp.realpath(full); }
      catch { return fail('could not read everything inside it, so nothing was deleted'); }
      if (foldCase(realNow2) !== foldCase(at.real)) return fail('changed while this was being checked (it no longer resolves to the same real folder), so nothing was deleted');
    }

    let partial = null, abortedLate = null;
    try {
      for (const f of v.fileList) {
        const busy2 = busyTransfer(src.id, r => r === f.rel);
        const hashing2 = !busy2 && hashingNow({ full: f.full, real: f.full, id: null });
        const arch2 = !busy2 && !hashing2 && isArchiveName(path.basename(f.full)) && archiveInUse(src, f.rel, f.full);
        if (busy2 || hashing2 || arch2) {
          abortedLate = busy2 ? `${f.rel} started downloading partway through this delete`
            : hashing2 ? `${f.rel} started having a checksum worked out on it partway through this delete`
            : `${f.rel}: ${arch2}`;
          break;
        }
        try { await serial(() => fsp.unlink(f.full)); }
        catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      }
      if (!abortedLate) for (const l of v.linkList) {
        try { await serial(() => fsp.unlink(l.full)); }
        catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      }
      if (!abortedLate) for (let i = v.dirList.length - 1; i >= 0; i--) {
        let leftover = null;
        try { leftover = await fsp.readdir(v.dirList[i]); }
        catch (e) { if (e && e.code !== 'ENOENT') throw e; }
        if (leftover && leftover.length) {
          abortedLate = `${relOf(src.root, v.dirList[i]) || rel} has something new in it that was not there a moment ago, so it was left as is`;
          break;
        }
        try { await serial(() => fsp.rmdir(v.dirList[i])); }
        catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      }
    } catch (e) { partial = e; }
    if (partial || abortedLate) {
      const why = partial ? fsErr(partial) : abortedLate;
      const msg = `could not finish deleting it — it is now PARTIALLY deleted (some of what was inside is gone, some is not): ${why}`;
      console.error(`deleting ${src.label}/${rel} stopped partway through: ${why}`);
      return { ok: false, error: msg, touched: true };
    }

    console.log(`deleted folder ${src.label}/${rel} (${v.files} files, ${v.dirs} dirs, ${fmtGb(v.bytes)})`);
    return { ok: true, entry: { folder: true, files: v.files, dirs: v.dirs, bytes: v.bytes }, touched: v.packageRels.length > 0, packageRels: v.packageRels };
  }
  if (!st.isFile()) return fail('not found');
  if (at.names.some(n => /\.(rar|r\d\d)$/i.test(n))) return fail('an archive is deleted from its own row, which checks that what is inside it is unpacked and takes every part of the set');

  try { fs.accessSync(path.dirname(full), fs.constants.W_OK); }
  catch { return fail(`${src.label} is mounted read-only`); }

  const busy = busyTransfer(src.id, r => r === rel, at.id);
  if (busy) return fail(`${ps5NameFor(busy.ip) || busy.ip} is downloading this right now`);
  if (hashingNow(at)) return fail('a checksum is being worked out on it right now; wait for that to finish, or cancel it');
  const unpacking = atArchive(at) && archiveInUse(src, rel, full);
  if (unpacking) return fail(unpacking);

  try { await serial(() => fsp.unlink(full)); }
  catch (e) { return fail(`could not delete it: ${fsErr(e)}`); }

  const isPkg = atPackage(at);
  return { ok: true, entry: {}, touched: isPkg, packageRels: isPkg ? [rel] : [] };
}

// What an archive row says about itself, worked out the way the folder listing works it out for
// the row: how many parts, why it can or cannot be served, the packages it holds that are not
// unpacked beside it yet, and whether it can be deleted.
async function archiveFacts(full, st, name) {
  if (/\.(zip|7z)$/i.test(name)) return { parts: 0, reason: extOf(name) + ' archive', pkgs: [], deletable: false };
  if (isLaterVolume(full)) return { parts: 0, reason: 'a later volume of a set', pkgs: [], deletable: false };
  const r = await rarPkgs(full, st);
  const leaf = b => ({ name: b.name.split('/').pop(), size: b.size });
  const all = [...r.blocked, ...r.entries].map(leaf);
  let pkgs = (r.blocked.length ? r.blocked : r.entries).map(leaf);
  let reason = r.blocked.length ? r.blocked[0].reason : r.entries.length ? 'served from here' : 'no package inside';
  let deletable = false;
  if (pkgs.length) {
    const beside = await sizesBeside(path.dirname(full), all.map(x => x.name));
    const remaining = notUnpacked(pkgs, beside);
    if (!remaining.length) reason = 'already extracted';
    else if (reason !== 'served from here') pkgs = remaining;
    // Offered for deletion only when nothing in it is left, the ones the row does not list included.
    const whole = !r.note && !r.blocked.some(b => /^(incomplete set|split across)/.test(b.reason));
    deletable = !remaining.length && whole && !notUnpacked(all, beside).length;
  }
  return { parts: r.parts || 0, reason, pkgs, deletable };
}

// Who is using a file right now: consoles pulling it (or a package out of it, for an archive),
// sends waiting for a console to come back, and an unpack running on it.
async function inUseOf(src, rel, full) {
  const inside = r => r === rel || r.startsWith(rel + ARC);
  const at = spotSync(full);
  return {
    downloading: busyTransfers(src.id, inside, await fileIdentity(src, rel)).map(t => ({ console: ps5NameFor(t.ip) || t.ip, percent: t.size ? Math.min(100, Math.floor(covered(t) * 100 / t.size)) : 0 })),
    held: held.filter(h => h.src === src.id && inside(h.rel)).map(h => { const prof = findProfile(h.profile); return { console: prof ? prof.name : 'a console' }; }),
    extracting: [...extractions.values()].some(j => (j.state === 'queued' || j.state === 'running') && sameFile(j, at)),
  };
}

// The properties of a file, a folder, or a package inside a .rar (archive.rar!/inner.pkg).
// Returns {props} or {status, error}. A link is described by itself, never followed.
async function propertiesOf(src, relRaw) {
  const no = (status, error) => ({ status, error });
  if (typeof relRaw !== 'string' || relRaw.includes('\0')) return no(403, 'forbidden');
  const cut = arcCut(relRaw);
  // The file it is, however the path was spelled (see locate), and never one reached through a link that leaves the library.
  const at = await locate(src, cut < 0 ? relRaw : relRaw.slice(0, cut));
  if (at.error) return no(at.status, at.error);
  if (at.outside) return no(403, LEAVES_MSG);
  const outer = at.full;
  let st;
  try { st = outer === src.root ? await fsp.stat(outer) : await fsp.lstat(outer); } catch { return no(404, 'not found'); }

  const relOuter = at.rel;    // (a member sits in the folder its archive is in)
  let rel = relOuter;
  let name = outer === src.root ? src.label : path.basename(outer);
  let size = st.size, inArchive = null;
  const isDir = st.isDirectory(), isLink = st.isSymbolicLink();
  if (cut >= 0) {
    const inner = relRaw.slice(cut + ARC.length);
    const entry = st.isFile() && /\.rar$/i.test(outer) ? (await rarPkgs(outer, st)).entries.find(x => x.name === inner) : null;
    if (!entry) return no(404, 'not found');
    // It has no dates or attributes of its own: they are the archive's.
    inArchive = name;
    rel += ARC + inner; name = inner.split('/').pop(); size = entry.size;
  }
  const isPkg = !isDir && !isLink && (cut >= 0 || isPackageName(name));
  const meta = isPkg ? withMeta(src, { path: rel, size, mtime: st.mtimeMs }).meta || null : null;
  const type = typeOf(name, meta, isDir, isLink);
  const props = {
    src: src.id, library: src.label, path: rel, name, dir: relOuter.split('/').slice(0, -1).join('/'), kind: isDir ? 'dir' : 'file',
    ext: isDir ? '' : extOf(name), typeName: type.typeName, iconKind: type.iconKind, size: isDir ? null : size,
    created: st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : null, modified: Math.round(st.mtimeMs), accessed: Math.round(st.atimeMs),
    readOnly: !(await canWrite(outer)), hidden: name.startsWith('.'), inArchive, meta, archive: null,
    inUse: isDir ? { downloading: [], held: [], extracting: false } : await inUseOf(src, rel, outer), contains: null,
  };
  if (!isDir && !isLink && cut < 0 && isArchiveName(name)) props.archive = await archiveFacts(outer, st, name);
  if (isDir) {
    // One walk per real folder, whatever the spelling of the path (case, short names, links) that asked for it.
    const walk = folderContents(src, outer, foldCase(at.real || outer));
    if (!walk) return no(429, 'busy, try again');
    try { props.contains = await walk; }
    catch (e) { props.contains = { files: 0, dirs: 0, bytes: 0, truncated: false, error: `could not read it: ${fsErr(e)}` }; }
    if (!props.contains.error) props.size = props.contains.bytes;
  }
  return { props };
}

// ---- Checksums
// SHA-256 of one file, worked out on request: the file is read a megabyte at a time into
// two buffers used over and over (never held whole), so the next read is under way while
// the last one is worked on. The requests waiting get their turn between reads, and only
// one job runs at a time on the whole server, since reading a big file at full speed is
// what a console's download is waiting for too. A job that finished is kept for a while
// so the page can ask again; one that nobody is asking about is not left reading.
const HASH_CHUNK = 1 << 20;
const HASH_IDLE_MS = 2 * 60000;       // no one has asked how it is going for this long: it is cancelled
const HASH_KEEP_MS = 10 * 60000;      // a finished one is remembered this long
const HASH_KEEP_MAX = 100;
const HASH_WINDOW_MS = 5000;          // the speed is what was read over about the last five seconds
const hashJobs = new Map();           // id -> {id, srcId, rel, full, real, fileId, total, bytes, state, startedAt, endedAt, polledAt, samples, ...}
// `at` is the file as locate (or spotSync) has it, so a short name, another case or a link to it is caught as well.
const hashingNow = at => [...hashJobs.values()].some(j => j.state === 'running' && sameFile(j, at));
// The job holding the one slot, as anyone may be told of it.
const hashRunning = () => { const j = [...hashJobs.values()].find(x => x.state === 'running'); return j ? { id: j.id, src: j.srcId, path: j.rel, since: j.startedAt, bytes: j.bytes, total: j.total } : null; };

function hashView(j, now = Date.now()) {
  const ms = (j.endedAt || now) - j.startedAt;
  let speed = 0;
  if (j.state === 'running') { const from = j.samples[0]; if (from && now > from[0]) speed = (j.bytes - from[1]) / ((now - from[0]) / 1000); }
  else if (ms > 0) speed = j.bytes / (ms / 1000);
  return { state: j.state, bytes: j.bytes, total: j.total, speed: Math.max(0, Math.round(speed)), ms, ...(j.sha256 ? { sha256: j.sha256 } : {}), ...(j.error ? { error: j.error } : {}) };
}

function endHash(j, state, error) {
  if (j.state !== 'running') return;
  j.state = state; j.endedAt = Date.now();
  if (error) j.error = error;      // (the read in progress finishes and sees the state; it is not waited for)
}

async function runHash(j) {
  const hash = crypto.createHash('sha256');
  const bufs = [Buffer.allocUnsafe(HASH_CHUNK), Buffer.allocUnsafe(HASH_CHUNK)];
  let file, next = null;      // next: the read in progress (only ever one, so each starts where the last ended)
  try {
    file = await fsp.open(j.full, 'r');
    next = file.read(bufs[0], 0, HASH_CHUNK, null);
    for (let at = 0; ; at ^= 1) {
      const { bytesRead } = await next;
      next = null;
      if (!bytesRead || j.state !== 'running') break;
      next = file.read(bufs[at ^ 1], 0, HASH_CHUNK, null);
      hash.update(bufs[at].subarray(0, bytesRead));
      j.bytes += bytesRead;
      const now = Date.now();
      if (now - j.samples[j.samples.length - 1][0] >= 500) {
        j.samples.push([now, j.bytes]);
        while (j.samples.length > 1 && now - j.samples[0][0] > HASH_WINDOW_MS) j.samples.shift();
      }
      // A console that starts pulling this file part way through has the disk first.
      if (now - j.checkedAt >= 1000) {
        j.checkedAt = now;
        const busy = busyTransfer(j.srcId, r => r === j.rel, j.fileId);
        if (busy) return endHash(j, 'failed', `${ps5NameFor(busy.ip) || busy.ip} started downloading this, so the check was stopped to keep the download quick. Try again when it is done.`);
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    if (j.state !== 'running') return;
    j.total = j.bytes;                 // a file that changed size while it was read: the bar still ends full
    j.sha256 = hash.digest('hex');
    j.state = 'done'; j.endedAt = Date.now();
  } catch (e) {
    if (j.state === 'running') endHash(j, 'failed', `could not read it: ${String(e.message).split(', ')[0]}`);
  } finally {
    if (next) await next.catch(() => {});      // closed once the read that is under way has come back
    if (file) file.close().catch(() => {});
  }
}

// Returns {job} or {status, error}.
async function startHash(src, relRaw) {
  const no = (status, error) => ({ status, error });
  if (typeof relRaw !== 'string' || !relRaw) return no(400, 'say which file to check');
  if (relRaw.includes('\0')) return no(403, 'forbidden');
  if (arcCut(relRaw) >= 0) return no(400, 'that package is inside an archive, so there is no file of its own to check. Extract it first.');
  // The file it is, however the path was spelled, and never one reached through a link that leaves the library.
  const at = await locate(src, relRaw);
  if (at.error) return no(at.status, at.error);
  if (at.outside) return no(403, LEAVES_MSG);
  const { full, rel } = at;
  let st;
  try { st = await fsp.lstat(full); } catch { return no(404, 'not found'); }
  if (st.isDirectory()) return no(400, 'a folder has no checksum of its own; check the files inside it');
  if (!st.isFile()) return no(400, 'only an ordinary file can be checked');
  const fileId = at.id;
  const busy = busyTransfer(src.id, r => r === rel, fileId);
  if (busy) return no(409, `${ps5NameFor(busy.ip) || busy.ip} is downloading this now; try again when it is done`);
  // Nothing is awaited from here to the job being in the table, so two starts cannot both get in.
  // The one slot is anyone's, so whoever is refused is told what holds it and since when, and can cancel it (POST /api/hash/cancel).
  const running = hashRunning();
  if (running) {
    const held = findSource(running.src), secs = Math.max(0, Math.round((Date.now() - running.since) / 1000));
    const ago = secs < 90 ? `${secs} seconds` : secs < 5400 ? `${Math.round(secs / 60)} minutes` : `${(secs / 3600).toFixed(1)} hours`;
    return { status: 409, error: `Already calculating one (${held ? held.label + '/' : ''}${running.path}, started ${ago} ago); wait or cancel it`, running };
  }
  const now = Date.now();
  const j = { id: newId(), srcId: src.id, rel, full, real: at.real, fileId, total: st.size, bytes: 0, state: 'running', startedAt: now, endedAt: 0, polledAt: now, checkedAt: now, samples: [[now, 0]] };
  for (const [id, old] of hashJobs) { if (hashJobs.size < HASH_KEEP_MAX) break; if (old.state !== 'running') hashJobs.delete(id); }
  hashJobs.set(j.id, j);
  runHash(j);
  return { job: j };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of hashJobs) {
    if (j.state === 'running') { if (now - j.polledAt > HASH_IDLE_MS) endHash(j, 'cancelled', 'nobody was watching it, so it was stopped'); }
    else if (now - j.endedAt > HASH_KEEP_MS) hashJobs.delete(id);
  }
}, 5000).unref();

// One file's rename (a package, an archive or any other file), with every rule a
// rename has: a name and not a path, the extension kept, no archive member, a
// writable library, nothing being downloaded, nothing already there. Returns
// {ok, to, name} or {ok: false, status, error}.
// A file that is neither a package nor an archive may change its extension, when
// ctx.allowExtChange says the person was asked and agreed; never into one that
// makes it a package or an archive, which have their own rules.
// A batch passes ctx so that packages in it cannot take one another's names:
// claimed holds the names taken so far, freed the paths given up, and dryRun
// checks all of it without touching a file.
// One at a time: whether a name is taken is looked at, and then the file is
// renamed, and rename() replaces a file that turned up in between without a word,
// so two requests giving different packages one name could lose one of them.
// Is a copy or move that is queued or running reading or writing this folder, or something in it, or a folder that holds it?
function xferTouches(srcId, rel) {
  const hit = e => e && e.srcId === srcId && typeof e.path === 'string' && (e.path === rel || e.path.startsWith(rel + '/') || rel.startsWith(e.path + '/'));
  return [...xfers.values()].some(j => (j.state === 'running' || j.state === 'queued') && (hit(j.src) || hit(j.dst)));
}
// A folder has been renamed (nothing in it was in use): what is remembered under the old path follows it.
function renameFolderRefs(src, from, to, fullFrom, fullTo) {
  const swap = p => (typeof p === 'string' && (p === from || p.startsWith(from + '/'))) ? to + p.slice(from.length) : p;
  let touched = false;
  for (const b of builds) {
    if (b.src !== src.id) continue;
    for (const k of ['outputDirRel', 'jobRel', 'dumpRel']) { const v = swap(b[k]); if (v !== b[k]) { b[k] = v; touched = true; } }
  }
  if (touched) saveBuilds();
  const was = src.id + '\n' + from, now = src.id + '\n' + to;
  let meta = false;
  for (const [k, v] of [...metaCache]) if (k.startsWith(was + '/')) { metaCache.set(now + k.slice(was.length), v); metaCache.delete(k); meta = true; }
  if (meta) saveMetaSoon();
  let scanned = false;
  for (const [k, v] of [...rarCache]) if (typeof k === 'string' && k.startsWith(fullFrom + path.sep)) { rarCache.set(fullTo + k.slice(fullFrom.length), v); rarCache.delete(k); scanned = true; }
  if (scanned) saveIndexSoon();
}
let renameChain = Promise.resolve();
function renamePackage(src, rel, wantRaw, ctx = {}) {
  const run = renameChain.then(() => renameOnePackage(src, rel, wantRaw, ctx));
  renameChain = run.catch(() => {});
  return run;
}
// Windows will not open, list or delete these whatever follows them, and a library is very often on a share.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\..*)?$/i;

async function renameOnePackage(src, raw, wantRaw, ctx) {
  const fail = (status, error) => ({ ok: false, status, error });
  const want = typeof wantRaw === 'string' ? wantRaw.trim() : '';
  if (raw.includes(ARC)) return fail(400, 'this package is inside an archive, so it has no name of its own to change. Extract it first.');
  // Every rule below is about the file, not the string that named it: "A.pkg/" and "A.pkg" are one file (see locate).
  const at = await locate(src, raw);
  if (at.error) return fail(at.status, at.error);
  if (at.outside) return fail(403, LEAVES_MSG);
  const { full, rel } = at;
  const barred = await untouchable(src, at, 'renamed', ctx);
  if (barred) return fail(barred.status, barred.error);
  if (hashingNow(at)) return fail(409, 'a checksum is being worked out on it right now; wait for that to finish, or cancel it');
  let isDir = false;
  try { isDir = (await fsp.stat(full)).isDirectory(); } catch {}
  if (isDir && !rel) return fail(400, 'the top of a library cannot be renamed here');

  // A name, not a path: no folders, no traversal, nothing hidden.
  if (!want) return fail(400, 'give it a name');
  if (Buffer.byteLength(want) > 255) return fail(400, 'that name is too long (a file name is at most 255 bytes, which is fewer characters in Japanese, say)');
  if (/[\\/]/.test(want) || want === '.' || want === '..' || want.startsWith('.')) {
    return fail(400, 'a name only — no folders, and it cannot start with a dot');
  }
  // Windows and SMB refuse these, and a library is very often on a share.
  if (/[<>:"|?*\x00-\x1f]/.test(want)) return fail(400, 'a name cannot contain < > : " | ? * or control characters');
  if (/[. ]$/.test(want)) return fail(400, 'a name cannot end in a space or a dot');
  if (WINDOWS_DEVICE_NAME.test(want)) return fail(400, 'a name cannot be a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension)');
  const ext = a => (/\.([A-Za-z0-9]{1,8})$/.exec(a) || [, ''])[1].toLowerCase();
  const name = path.basename(full);
  if (!isDir && ext(want) !== ext(name)) {
    if (!(ctx.allowExtChange && !atPackage(at) && !atArchive(at))) {
      return fail(400, ext(name) ? `keep the .${ext(name)} extension — the console decides what a file is by it` : 'keep the name without an extension — the console decides what a file is by it');
    }
    if (/\.(pkg|rar|r\d\d|zip|7z)$/i.test(want)) return fail(400, 'that would make it a package or an archive: use the package rename for that');
  }

  let st;
  try { st = await fsp.stat(full); } catch { return fail(404, 'not found'); }
  if (isDir ? !st.isDirectory() : !st.isFile()) return fail(404, 'not found');

  const dir = path.dirname(full);
  const target = path.join(dir, want);
  if (target === full) return { ok: true, unchanged: true, to: rel, name };
  if (!safeDir(src.root, relOf(src.root, target))) return fail(403, 'forbidden');
  try { fs.accessSync(dir, fs.constants.W_OK); }
  catch { return fail(400, `${src.label} is mounted read-only, so nothing in it can be renamed. Change that library's mapping to read/write in Unraid.`); }

  const busy = busyTransfer(src.id, isDir ? (r => r === rel || r.startsWith(rel + '/')) : (r => r === rel), at.id);
  if (busy) return fail(409, `${ps5NameFor(busy.ip) || busy.ip} is downloading ${isDir ? 'something in it' : 'this'} right now — renaming it would break the transfer. Wait for it to finish, or stop it first.`);
  if (isDir) {
    // What is working in a folder, or waiting to be sent from it, keeps it where it is.
    if (await scratchInUse(src, [full], true) || await scratchInUse(src, [full], false)) return fail(409, 'a build or an unpack is using this folder, so it cannot be renamed until that is over');
    const key = rel.toLowerCase();
    if ((await liveDumps(src)).some(d => d === key || d.startsWith(key + '/') || key.startsWith(d + '/'))) return fail(409, 'a build is running on a dump in this folder, so it cannot be renamed');
    if (held.some(h => h.src === src.id && h.rel.startsWith(rel + '/'))) return fail(409, 'a send is held for a package in this folder (a PS4 whose installer is not open), so it cannot be renamed');
    if (xferTouches(src.id, rel)) return fail(409, 'a copy or move is using this folder, so it cannot be renamed until that is over');
  }
  // An archive's parts are found by their names, so one part cannot be renamed alone, and
  // nothing is renamed while it is being unpacked or a console is pulling a package out of it.
  if (atArchive(at)) {
    if (isLaterVolume(full) || volumesFor(full)) return fail(409, 'that is one part of a set of archive volumes, which are found by their names, so renaming it would split the set');
    const inUse = archiveInUse(src, rel, full);
    if (inUse) return fail(409, inUse);
  }

  // Compared without regard to case: a library is often a share, and two names
  // that differ only in case are one name to whatever reads it next.
  const key = target.toLowerCase();
  if (ctx.claimed && ctx.claimed.has(key)) return fail(409, 'another package in this batch is being given that name');
  if (!(ctx.freed && ctx.freed.has(key))) {
    let taken = false;
    try { await fsp.access(target); taken = true; } catch {}
    // A change of capitals only (note.txt to NOTE.txt): on a file system that ignores case
    // the target then names this very file, which is a new spelling, not a clash. It is one
    // only when it is the same file (dev and ino) and the folder does not list the new
    // spelling as an entry of its own (where two names are two links to one file, a rename
    // would do nothing at all).
    if (taken && !(target.toLowerCase() === full.toLowerCase() && await isSameEntry(full, target, dir, want))) return fail(409, 'something of that name is already here');
  }
  const to = relOf(src.root, target);
  if (ctx.dryRun) {
    if (ctx.claimed) ctx.claimed.add(key);
    if (ctx.freed) ctx.freed.add(full.toLowerCase());
    return { ok: true, to, name: want };
  }
  try {
    await fsp.rename(full, target);
  } catch (e) {
    // What the file system said, without the host's paths in it; a file that is busy or locked is a conflict, not a fault.
    return fail(BUSY_CODES.has(e && e.code) ? 409 : 500, `could not rename it: ${fsErr(e)}`);
  }
  if (ctx.claimed) ctx.claimed.add(key);
  // Carry what was read about it across, rather than reading the package
  // again for a change that touched none of its bytes.
  const was = metaCache.get(`${src.id}\n${rel}`);
  if (was) { metaCache.set(`${src.id}\n${to}`, was); metaCache.delete(`${src.id}\n${rel}`); saveMetaSoon(); }
  // Only what the package list holds changes its ETag and needs the list walked again: a text file's
  // new name is in no list.
  const listed = isDir || atPackage(at) || at.names.some(n => /\.(rar|r\d\d)$/i.test(n));
  if (isDir) renameFolderRefs(src, rel, to, full, target);
  if (listed) listRev++;    // the package list's ETag has to move with what a row would say
  let heldMoved = repointHeld(src.id, rel, to);
  if (at.names.some(n => /\.rar$/i.test(n))) {
    // What was read about the archive (a lone volume's key is its size and time, which a rename keeps) and
    // about the packages inside it goes with it.
    const scanned = rarCache.get(full);
    if (scanned) { rarCache.delete(full); rarCache.set(target, scanned); saveIndexSoon(); }
    heldMoved += moveArchiveRefs(src.id, rel, to);
  }
  console.log(`renamed ${src.label}: ${rel} -> ${to}${heldMoved ? ` (${heldMoved} held send(s) follow it)` : ''}`);
  return { ok: true, to, name: want, heldMoved, listed };
}

// ---- A new folder in a local library
// The folder `dirRaw` (a library-relative path, '' for the top) gets an empty folder called `wantRaw`, under the
// rules a rename already keeps for a name (nothing a Windows share would refuse, nothing hidden) and the ones
// that keep ShadowPKG's own work folders apart from a person's (none is made inside a build's or an unpack's
// scratch folder, and none is given one of their names). Nothing is ever replaced: a name taken, in any spelling
// of its capitals, is refused. Returns { ok, rel, name } or { ok: false, status, error }.
async function createFolder(src, dirRaw, wantRaw) {
  const fail = (status, error) => ({ ok: false, status, error });
  const want = typeof wantRaw === 'string' ? wantRaw.trim() : '';
  const at = await locate(src, typeof dirRaw === 'string' ? dirRaw : '');
  if (at.error) return fail(at.status, at.error);
  if (at.outside) return fail(403, LEAVES_MSG);
  if (!at.exists) return fail(404, 'that folder is not there');
  try { if (!(await fsp.stat(at.full)).isDirectory()) return fail(400, 'that is not a folder'); } catch { return fail(404, 'that folder is not there'); }
  const barred = await untouchable(src, at, 'added to');
  if (barred) return fail(barred.status, barred.error);

  if (!want) return fail(400, 'give it a name');
  if (Buffer.byteLength(want) > 255) return fail(400, 'that name is too long (a folder name is at most 255 bytes, which is fewer characters in Japanese, say)');
  if (/[\\/]/.test(want) || want === '.' || want === '..' || want.startsWith('.')) return fail(400, 'a name only — no folders, and it cannot start with a dot');
  if (/[<>:"|?*\x00-\x1f]/.test(want)) return fail(400, 'a name cannot contain < > : " | ? * or control characters');
  if (/[. ]$/.test(want)) return fail(400, 'a name cannot end in a space or a dot');
  if (WINDOWS_DEVICE_NAME.test(want)) return fail(400, 'a name cannot be a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)');
  if (scratchSeg(want) || builderName(want)) return fail(400, 'that name is one ShadowPKG keeps for its own files');

  const target = path.join(at.full, want);
  if (!safeDir(src.root, relOf(src.root, target))) return fail(403, 'forbidden');
  try { fs.accessSync(at.full, fs.constants.W_OK); }
  catch { return fail(400, `${src.label} is mounted read-only, so nothing can be created in it. Change that library's mapping to read/write in Unraid.`); }
  // Compared without regard to case: a library is often a share, and two names that differ only in capitals are one name to it.
  let names;
  try { names = await fsp.readdir(at.full); } catch (e) { return fail(500, `could not read that folder: ${fsErr(e)}`); }
  const key = want.toLowerCase();
  if (names.some(n => n.toLowerCase() === key)) return fail(409, 'something of that name is already here');
  try { await fsp.mkdir(target); }
  catch (e) { return fail(e && (e.code === 'EEXIST' || BUSY_CODES.has(e.code)) ? 409 : 500, `could not create it: ${fsErr(e)}`); }
  // The PC and the console reach a library as other users than this one; a folder this app makes must be writable to them
  // (the same as the folders it makes for a build, and what the builder does to the packages it writes).
  try { fs.chmodSync(target, 0o777); } catch {}
  try { fs.chownSync(target, 99, 100); } catch {}
  const rel = relOf(src.root, target);
  console.log(`created folder ${src.label}: ${rel}`);
  return { ok: true, rel, name: want };
}

async function isSameEntry(full, target, dir, want) {
  try {
    const [a, b] = await Promise.all([fsp.stat(full, { bigint: true }), fsp.stat(target, { bigint: true })]);
    if (a.ino && b.ino ? a.dev !== b.dev || a.ino !== b.ino : foldCase(await fsp.realpath(full)) !== foldCase(await fsp.realpath(target))) return false;
    return !(await fsp.readdir(dir)).includes(want);
  } catch { return false; }
}

// ---- Reading and editing text files (GET and PUT /api/text)
// A chunk of a text file is read (never the whole file, except a small one that is being edited), decoded
// the way the file says it is written, and cut where a character or a line break is not split. Only a
// few reads run at once, so a page that asks for many cannot take the disk from the consoles.
const TEXT_DEFAULT = 256 * 1024, TEXT_MAX = 1 << 20, TEXT_SNIFF = 64 * 1024;
const TEXT_READS_AT_ONCE = 4, TEXT_READS_QUEUED = 50;
const EDIT_MAX = 2 * 1024 * 1024, EDIT_NO_EXT_MAX = 256 * 1024, EDIT_BODY_MAX = 4 * 1024 * 1024;
// The same list the page opens as text (a file with no extension is edited only when it is small and passes the check).
const TEXT_EXTS = new Set('txt log md nfo json xml ini cfg conf csv tsv yml yaml toml html htm css js mjs sh bat cmd ps1 py rb lua c h cpp hpp cs java srt sub diz'.split(' '));
// Opened for reading only: never through a link at the last step, and never waiting on a pipe someone swapped in.
const OPEN_READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
let textReading = 0, textSaving = 0, textBodies = 0;
const TEXT_SAVES_AT_ONCE = 8, TEXT_BODIES_MAX = 256 * 1024 * 1024;
const textWaiting = [];
// A turn to read, as a promise of the function that gives it back; null when fifty are already waiting.
function textTurn() {
  let done = false;
  const release = () => { if (done) return; done = true; const next = textWaiting.shift(); if (next) next(); else textReading--; };
  if (textReading < TEXT_READS_AT_ONCE) { textReading++; return Promise.resolve(release); }
  if (textWaiting.length >= TEXT_READS_QUEUED) return null;
  return new Promise(resolve => textWaiting.push(() => resolve(release)));
}

// windows-1252 is Latin-1 except for these (written out here: a Node without full ICU has no such decoder).
const CP1252_HI = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178].map(c => String.fromCharCode(c));
const CP1252_BACK = new Map(CP1252_HI.map((c, i) => [c.charCodeAt(0), 0x80 + i]));
const decode1252 = buf => buf.toString('latin1').replace(/[\x80-\x9f]/g, c => CP1252_HI[c.charCodeAt(0) - 0x80]);

// How many bytes of `buf` (from `from`) are whole UTF-8 characters, and whether every one of them is valid
// (no overlong forms, no surrogates, nothing past U+10FFFF). A character cut short by the end is left out of
// the count and is not called wrong, unless `atEof`: the buffer ends where the file does, so nothing is coming to finish it.
function utf8Span(buf, from = 0, atEof = false) {
  let i = from, valid = true;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let need, min, cp;
    if (b >= 0xC2 && b <= 0xDF) { need = 1; min = 0x80; cp = b & 0x1F; }
    else if (b >= 0xE0 && b <= 0xEF) { need = 2; min = 0x800; cp = b & 0x0F; }
    else if (b >= 0xF0 && b <= 0xF4) { need = 3; min = 0x10000; cp = b & 0x07; }
    else { valid = false; i++; continue; }
    if (n - i - 1 < need) {
      let k = 1;
      while (i + k < n && (buf[i + k] & 0xC0) === 0x80) k++;
      if (i + k >= n) return atEof ? { whole: n, valid: false } : { whole: i, valid };       // what is there so far is the start of a character
    }
    let k = 1;
    for (; k <= need; k++) { const c = buf[i + k]; if (c === undefined || (c & 0xC0) !== 0x80) break; cp = (cp << 6) | (c & 0x3F); }
    if (k <= need || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { valid = false; i += k; continue; }
    i += need + 1;
  }
  return { whole: n, valid };
}

// What a file is written in, from the first 64 KiB of it: {binary: true}, or {enc, bom} (bom: the bytes of a byte order mark).
// `whole`: the file is no longer than what is given, so a character cut short at its end is a wrong one.
function sniffText(head, whole = false) {
  if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return { enc: 'utf-8', bom: 3 };
  const u16 = head.length >= 2 ? ((head[0] === 0xFF && head[1] === 0xFE) ? 'utf-16le' : (head[0] === 0xFE && head[1] === 0xFF) ? 'utf-16be' : '') : '';
  if (u16) {
    let buf = head.subarray(2, head.length - ((head.length - 2) & 1));
    if (u16 === 'utf-16be') buf = Buffer.from(buf).swap16();
    const s = buf.toString('utf16le');
    let bad = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) return { binary: true };
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27 && c !== 8) bad++;
      if (c >= 0xD800 && c <= 0xDBFF) { const d = s.charCodeAt(i + 1); if (d >= 0xDC00 && d <= 0xDFFF) i++; else if (i + 1 < s.length) bad++; }
      else if (c >= 0xDC00 && c <= 0xDFFF) bad++;
    }
    if (s.length && bad / s.length > 0.05) return { binary: true };
    return { enc: u16, bom: 2 };
  }
  let ctl = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) return { binary: true };
    if ((b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27 && b !== 8) || b === 0x7F) ctl++;
  }
  if (head.length && ctl / head.length > 0.05) return { binary: true };
  return { enc: utf8Span(head, 0, whole).valid ? 'utf-8' : 'windows-1252', bom: 0 };
}

function lineEndingOf(t) {
  const crlf = (t.match(/\r\n/g) || []).length, lf = (t.match(/(?<!\r)\n/g) || []).length, cr = (t.match(/\r(?!\n)/g) || []).length;
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  return kinds > 1 ? 'mixed' : crlf ? 'CRLF' : cr ? 'CR' : lf ? 'LF' : 'none';
}

// The bytes actually there at an offset (fewer than asked only at the end of the file).
async function readChunkAt(fh, at, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, at + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

// The file a text request names, as {at, full, st} (full: what is opened) or {status, error}. Resolved the way
// Properties resolves it (see locate), and never through a link that leads out of the library.
async function textTarget(src, relRaw, what) {
  const no = (status, error) => ({ status, error });
  if (typeof relRaw !== 'string' || relRaw.includes('\0')) return no(403, 'forbidden');
  if (arcCut(relRaw) >= 0) return no(400, 'that is inside an archive, so there is no file of its own to open');
  const at = await locate(src, relRaw);
  if (at.error) return no(at.status, at.error);
  if (at.outside) return no(403, LEAVES_MSG);
  let st;
  try { st = await fsp.lstat(at.full); } catch { return no(404, 'not found'); }
  let full = at.full;
  if (st.isSymbolicLink()) {
    if (what === 'edit') return no(400, 'that is a link, not a file of its own; edit the file it points to');
    try { full = await fsp.realpath(at.full); } catch { return no(404, 'not found'); }
    if (!within(foldCase(at.realRoot), foldCase(full))) return no(403, LEAVES_MSG);
    try { st = await fsp.stat(full); } catch { return no(404, 'not found'); }
  }
  if (st.isDirectory()) return no(400, 'that is a folder, not a file');
  if (!st.isFile()) return no(400, 'only an ordinary file can be opened as text');
  // On Windows "name:stream" is a hidden stream of a file, which no rule here reads by that spelling ("name::$DATA" is the file, and resolves to it).
  if (process.platform === 'win32' && path.basename(full).includes(':')) return no(400, 'a data stream is not a file of its own');
  return { at, full, st };
}

// ShadowPKG's own files in the config folder (see untouchable, which this is the reading half of).
async function isOwnConfigFile(at) {
  const configs = [...new Set([path.resolve(CONFIG_DIR), await realOf(CONFIG_DIR)])];
  for (const config of configs) {
    for (const p of [at.asked, at.real, at.full].filter(Boolean)) {
      if (p !== config && within(foldCase(config), foldCase(p)) && OWN_CONFIG_FILE.test(path.relative(config, p).split(path.sep)[0])) return true;
    }
  }
  return false;
}
// The identity of a file (device:inode) for comparing what was looked at with what was opened; null where the system gives none.
const idOf = st => (st.ino ? `${st.dev}:${st.ino}` : null);
// Whether the file that was just opened is the one at `full` now, and that is inside the library: a link swapped in
// between the containment check and the open leads somewhere else, and is caught here (the descriptor is what is read
// or copied from, so nothing changes after this). A hard link made to a file outside is not a link to look through.
async function openedIsInside(fh, at, full) {
  try {
    const [a, real] = await Promise.all([fh.stat({ bigint: true }), fsp.realpath(full)]);
    if (!within(foldCase(at.realRoot), foldCase(real))) return false;
    const b = await fsp.stat(real, { bigint: true });
    return !(a.ino && b.ino) || idOf(a) === idOf(b);
  } catch { return false; }
}
const OWN_TEXT_MSG = "that is one of ShadowPKG's own files, so it is not opened here";
const NOT_TEXT_MSG = 'This does not look like a text file';

// {out} or {status, error}. offset and limit come as the strings the query had (or null).
// `gone()`: whether the one who asked has hung up (a read that is only now given its turn is then not made).
async function readTextChunk(src, relRaw, offsetRaw, limitRaw, gone = () => false) {
  const no = (status, error, extra) => ({ status, error, ...extra });
  const num = s => (/^\d{1,16}$/.test(String(s).trim()) ? Number(String(s).trim()) : NaN);
  let offset = 0, limit = TEXT_DEFAULT;
  if (offsetRaw !== null && offsetRaw !== undefined && offsetRaw !== '') {
    offset = num(offsetRaw);
    if (Number.isNaN(offset)) return no(400, 'offset is a number of bytes, 0 or more');
  }
  if (limitRaw !== null && limitRaw !== undefined && limitRaw !== '') {
    const l = num(limitRaw);
    if (l > 0) limit = Math.min(TEXT_MAX, Math.max(4, l));      // (not a number, or none: the usual size)
  }
  const t = await textTarget(src, relRaw, 'read');
  if (t.error) return t;
  if (await isOwnConfigFile(t.at)) return no(403, OWN_TEXT_MSG);
  const turn = textTurn();
  if (!turn) return no(429, 'busy, try again');
  const release = await turn;
  if (gone()) { release(); return no(499, 'the request was cancelled'); }
  let fh;
  try {
    try { fh = await fsp.open(t.full, OPEN_READ); } catch (e) { return e && e.code === 'ELOOP' ? no(403, LEAVES_MSG) : e && e.code === 'ENOENT' ? no(404, 'not found') : no(BUSY_CODES.has(e && e.code) ? 409 : 500, `could not read it: ${fsErr(e)}`); }
    const st = await fh.stat();
    if (!st.isFile()) return no(400, 'only an ordinary file can be opened as text');
    if (!(await openedIsInside(fh, t.at, t.full))) return no(403, LEAVES_MSG);
    const size = st.size;
    const kind = sniffText(await readChunkAt(fh, 0, Math.min(size, TEXT_SNIFF)), size <= TEXT_SNIFF);
    if (kind.binary) return no(415, NOT_TEXT_MSG);
    const { enc, bom } = kind;
    const wide = enc === 'utf-16le' || enc === 'utf-16be';
    const end = wide ? size - ((size - bom) & 1) : size;         // (a stray last byte of a UTF-16 file is not a character)
    const asked = Math.min(offset, size);
    let start = Math.min(Math.max(asked, bom), end);
    if (wide && ((start - bom) & 1)) start++;
    let want = Math.min(limit, end - start);
    if (wide) want -= want & 1;
    const buf = want > 0 ? await readChunkAt(fh, start, want) : Buffer.alloc(0);
    const atEnd = start + buf.length >= end;
    // Where the chunk begins and ends must be between characters.
    let from = 0, to = buf.length, lossy = false;
    if (enc === 'utf-8') {
      while (from < 3 && from < to && (buf[from] & 0xC0) === 0x80) from++;     // an offset in the middle of a character
      const span = utf8Span(buf.subarray(from, to), 0, atEnd);
      lossy = !span.valid;
      if (!atEnd) to = from + span.whole;
    } else if (wide && to - from >= 2) {
      const be = enc === 'utf-16be';
      const unit = at => be ? (buf[at] << 8) | buf[at + 1] : (buf[at + 1] << 8) | buf[at];
      if (start > bom && (unit(from) & 0xFC00) === 0xDC00) from += 2;          // the second half of a pair
      if (!atEnd && to - from >= 2 && (unit(to - 2) & 0xFC00) === 0xD800) to -= 2;   // the first half of one
    }
    const piece = buf.subarray(from, to);
    let text = enc === 'utf-8' ? piece.toString('utf8') : enc === 'windows-1252' ? decode1252(piece) : enc === 'utf-16le' ? piece.toString('utf16le') : Buffer.from(piece).swap16().toString('utf16le');
    let next = start + to;
    // A CR at the very end may be the first half of a CRLF that the next chunk finishes: it goes there.
    if (!atEnd && text.length > 1 && text.endsWith('\r')) { text = text.slice(0, -1); next -= wide ? 2 : 1; }
    if (atEnd) next = size;
    const out = {
      text, encoding: enc, bom: bom > 0, size, offset: asked < bom ? asked : start + from, nextOffset: next, eof: next >= size,
      truncated: next < size, lineEnding: lineEndingOf(text), name: path.basename(t.full), mtime: Math.round(st.mtimeMs),
    };
    if (lossy) out.lossy = true;      // some bytes are not valid UTF-8 (past what was looked at first) and show as U+FFFD
    return { out };
  } catch (e) {
    return no(500, `could not read it: ${fsErr(e)}`);
  } finally {
    if (fh) fh.close().catch(() => {});
    release();
  }
}

// One at a time, and in line with renames and deletes (they share the chain): a save and a rename of one
// file cannot interleave, and the second of two saves looks at what the first left.
function serial(fn) {
  const run = renameChain.then(fn);
  renameChain = run.catch(() => {});
  return run;
}

const BAD_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const bomOf = enc => enc === 'utf-8' ? Buffer.from([0xEF, 0xBB, 0xBF]) : enc === 'utf-16le' ? Buffer.from([0xFF, 0xFE]) : enc === 'utf-16be' ? Buffer.from([0xFE, 0xFF]) : Buffer.alloc(0);

// The bytes a save writes: {buf}, or {status, error, unencodable}. 'mixed' keeps the text's own line breaks as they are.
function encodeText(text, enc, bom, lineEnding) {
  const eol = lineEnding === 'CRLF' ? '\r\n' : lineEnding === 'CR' ? '\r' : '\n';
  const t = lineEnding === 'mixed' ? text : text.replace(/\r\n|\r|\n/g, eol);
  if (enc === 'windows-1252') {
    const bad = [], seen = new Set(), bytes = Buffer.allocUnsafe(t.length * 2 + 2);
    let n = 0;
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) bytes[n++] = c;
      else if (CP1252_BACK.has(c)) bytes[n++] = CP1252_BACK.get(c);
      else if (!seen.has(ch)) { seen.add(ch); if (bad.length < 20) bad.push(ch); }
    }
    if (seen.size) return { status: 400, error: `Some characters cannot be saved in this file's encoding (${bad.join(' ')})`, unencodable: bad };
    return { buf: bytes.subarray(0, n) };
  }
  const broken = BAD_SURROGATE.exec(t);
  if (broken) return { status: 400, error: 'The text has a broken character that no encoding can hold', unencodable: [broken[0]] };
  let body = enc === 'utf-8' ? Buffer.from(t, 'utf8') : Buffer.from(t, 'utf16le');
  if (enc === 'utf-16be') body = body.swap16();
  return { buf: bom ? Buffer.concat([bomOf(enc), body]) : body };
}

// {ok} or {status, error, ...}. Everything is looked at again inside the queue, so it is about the file as it is then.
function saveText(src, body) {
  return serial(() => saveTextNow(src, body));
}
async function saveTextNow(src, b) {
  const no = (status, error, extra) => ({ status, error, ...extra });
  const enc = b.encoding;
  if (!['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'].includes(enc)) return no(400, 'say which encoding the file is in (utf-8, utf-16le, utf-16be or windows-1252)');
  if (typeof b.text !== 'string') return no(400, 'there is no text to save');
  if (b.text.includes('\0')) return no(400, 'The text has a NUL character in it, which a text file cannot have here (it would no longer open as text)');
  if (b.bom !== undefined && typeof b.bom !== 'boolean') return no(400, 'bom is true or false');
  const eolName = b.lineEnding === 'none' || b.lineEnding === undefined ? 'LF' : b.lineEnding;
  if (!['LF', 'CRLF', 'CR', 'mixed'].includes(eolName)) return no(400, 'lineEnding is LF, CRLF or CR');
  if (b.overwrite !== undefined && typeof b.overwrite !== 'boolean') return no(400, 'overwrite is true or false');
  if (b.keepBackup !== undefined && typeof b.keepBackup !== 'boolean') return no(400, 'keepBackup is true or false');
  if (b.convert !== undefined && typeof b.convert !== 'boolean') return no(400, 'convert is true or false');
  const ex = b.expect;
  if (!(ex && Number.isFinite(ex.size) && Number.isFinite(ex.mtime)) && b.overwrite !== true) return no(400, 'say what the file looked like when it was opened (expect: {size, mtime})');

  const t = await textTarget(src, b.path, 'edit');
  if (t.error) return t;
  const { at, full, st } = t;
  const name = path.basename(full);
  // (by name, not atPackage: with ALLOW_ANY_FILE every file that is not an archive counts as a package there)
  if (at.names.some(n => /\.pkg$/i.test(n)) || atArchive(at)) return no(403, 'a package or an archive is not edited here');
  const ext = extOf(name);
  if (ext && !TEXT_EXTS.has(ext)) return no(403, `a .${ext} file is not one that is edited here`);
  // The rename and delete guards: ShadowPKG's own files, scratch, the builder's, a dump under a running build.
  const barred = await untouchable(src, at, 'edited');
  if (barred) return no(barred.status === 400 ? 403 : barred.status, barred.error);
  if (st.size > EDIT_MAX || (!ext && st.size >= EDIT_NO_EXT_MAX)) return no(413, 'too big to edit here');
  const rel = at.rel;
  const busy = busyTransfer(src.id, r => r === rel, at.id);
  if (busy) return no(409, `${ps5NameFor(busy.ip) || busy.ip} is downloading this right now; save when it is done`);
  if (hashingNow(at)) return no(409, 'a checksum is being worked out on it right now; wait for that to finish, or cancel it');
  const spot = spotSync(full);
  if ([...extractions.values()].some(j => (j.state === 'queued' || j.state === 'running') && sameFile(j, spot))) return no(409, 'it is being unpacked right now');
  const dir = path.dirname(full);
  if (!(await canWrite(dir))) return no(403, `${src.label} is mounted read-only, so nothing in it can be saved. Change that library's mapping to read/write in Unraid.`);
  if (!(await canWrite(full))) return no(403, 'This file is read-only, so it cannot be saved. Clear its read-only attribute or permissions and try again.');

  // What is on disk now: text, and the same as when the page opened it.
  let cur, fhSt, fileId, fh;
  try {
    fh = await fsp.open(full, OPEN_READ);
    fhSt = await fh.stat();
    fileId = idOf(await fh.stat({ bigint: true }));
    if (!(await openedIsInside(fh, at, full))) return no(403, LEAVES_MSG);
    if (!fhSt.isFile()) return no(400, 'only an ordinary file can be opened as text');
    // A save writes a new file and moves it into place, which would leave the file's other names as they were.
    if (fhSt.nlink > 1) return no(409, 'This file has more than one name (a hard link), and a save would change only one of them, so it is not saved here');
    if (fhSt.size > EDIT_MAX || (!ext && fhSt.size >= EDIT_NO_EXT_MAX)) return no(413, 'too big to edit here');
    cur = await readChunkAt(fh, 0, fhSt.size);
  } catch (e) { return e && e.code === 'ELOOP' ? no(403, LEAVES_MSG) : e && e.code === 'ENOENT' ? no(404, 'not found') : no(BUSY_CODES.has(e && e.code) ? 409 : 500, `could not read it: ${fsErr(e)}`); }
  finally { if (fh) await fh.close().catch(() => {}); }
  const same = s => !!ex && s.size === ex.size && Math.round(s.mtimeMs) === ex.mtime;
  if (b.overwrite !== true && !same(fhSt)) return no(409, 'This file changed on disk since you opened it', { current: { size: fhSt.size, mtime: Math.round(fhSt.mtimeMs) } });
  const kind = sniffText(cur.subarray(0, TEXT_SNIFF), cur.length <= TEXT_SNIFF);
  if (kind.binary) return no(415, NOT_TEXT_MSG);
  const wideNow = kind.enc === 'utf-16le' || kind.enc === 'utf-16be';
  // Bytes the viewer never looked at must not be lost by a save that writes what it saw.
  if (!wideNow && cur.includes(0)) return no(415, NOT_TEXT_MSG);
  if (kind.enc === 'utf-8' && !utf8Span(cur, kind.bom, true).valid) return no(409, 'This file has bytes further on that are not valid UTF-8, so saving it here could damage it');
  if (wideNow && ((cur.length - kind.bom) & 1)) return no(409, 'This file does not end on a whole UTF-16 character, so saving it here could damage it');

  // The file is saved in the encoding it has, so a page working from stale or wrong information cannot turn it into mojibake.
  // Changes that are meant: windows-1252 to UTF-8 (what the page offers when a character does not fit), or convert: true.
  if (cur.length && b.convert !== true && (kind.enc !== enc || (kind.bom > 0) !== (b.bom === true)) && !(kind.enc === 'windows-1252' && enc === 'utf-8')) {
    return no(409, `This file is stored as ${kind.enc}${kind.bom ? ' with a byte order mark' : ''}, and the save says ${enc}${b.bom === true ? ' with one' : ''}, so nothing was saved. Reload it and try again`);
  }
  const enco = encodeText(b.text, enc, b.bom === true, eolName);
  if (enco.error) return enco;
  if (enco.buf.length > EDIT_MAX || (!ext && enco.buf.length >= EDIT_NO_EXT_MAX)) return no(413, 'too big to edit here: the saved file would be over the size this page can open again');
  // A save is a new file moved over the old one, so what belongs to the old file itself is not carried over: on Windows its hidden or
  // system attribute and its alternate data streams (mode and owner are copied below where the system allows).
  const mode = fhSt.mode & 0o7777;
  // Everything below goes through the folder's real path, taken once now, so a link put in place of the folder (or of a folder
  // above it) after this point is seen by the checks that follow instead of being written through.
  let realDir;
  try { realDir = await fsp.realpath(dir); } catch { return no(404, 'not found'); }
  if (!within(foldCase(at.realRoot), foldCase(realDir))) return no(403, LEAVES_MSG);
  const target = path.join(realDir, path.basename(full));
  const scratchName = () => '.shadowpkg-save-' + crypto.randomBytes(8).toString('hex');
  const tmp = path.join(realDir, scratchName());
  const btmp = b.keepBackup === true ? path.join(realDir, scratchName()) : null;
  const stay = tag => Object.assign(new Error(tag.error), { answer: tag });
  // The folder, the temp file and the file are still where they were when they were looked at.
  const stillThere = async () => {
    let now;
    try {
      if (foldCase(await fsp.realpath(dir)) !== foldCase(realDir) || foldCase(await fsp.realpath(tmp)) !== foldCase(path.join(realDir, path.basename(tmp)))) throw stay(no(409, 'The folder changed while it was being saved, so nothing was saved'));
      const lst = await fsp.lstat(target);
      if (lst.isSymbolicLink() || !lst.isFile()) throw stay(no(409, 'The file was replaced while it was being saved, so nothing was saved'));
      now = await fsp.stat(target);
      const id = idOf(await fsp.stat(target, { bigint: true }));
      if (id !== fileId) throw stay(no(409, 'The file was replaced while it was being saved, so nothing was saved'));
    } catch (e) {
      if (e && e.answer) throw e;
      throw stay(no(409, 'This file changed on disk since you opened it'));
    }
    if (b.overwrite !== true && !same(now)) throw stay(no(409, 'This file changed on disk since you opened it', { current: { size: now.size, mtime: Math.round(now.mtimeMs) } }));
  };
  let bak = null, made = false, madeBak = false;
  try {
    const out = await fsp.open(tmp, 'wx', mode || 0o644);
    made = true;
    try {
      await out.writeFile(enco.buf);
      await out.sync();
      // The mode and owner of the original (a share's files are not root's), as far as this system lets them be.
      await out.chmod(mode).catch(() => {});
      if (process.platform !== 'win32') await out.chown(fhSt.uid, fhSt.gid).catch(() => {});
    } finally { await out.close(); }
    await stillThere();
    if (btmp) {
      // Copied beside the file and then moved into place, so an older .bak that is a link is replaced, not written through.
      bak = path.basename(full) + '.bak';
      await fsp.copyFile(target, btmp, fs.constants.COPYFILE_EXCL);
      madeBak = true;
      await fsp.rename(btmp, path.join(realDir, bak));
      madeBak = false;
    }
    // The last look before the swap: what is left after it is the few microseconds between this and the rename itself.
    await stillThere();
    await fsp.rename(tmp, target);
    made = false;
  } catch (e) {
    if (made) await fsp.rm(tmp, { force: true }).catch(() => {});
    if (madeBak) await fsp.rm(btmp, { force: true }).catch(() => {});
    if (e && e.answer) return e.answer;
    return no(BUSY_CODES.has(e && e.code) ? 409 : 500, `could not save it: ${fsErr(e)}. The file is as it was.`);
  }
  const after = await fsp.stat(target).catch(() => null);
  listRev++;
  console.log(`edited ${src.label}/${rel.replace(/[\u0000-\u001f\u007f]/g, '?')} (${enco.buf.length} bytes)`);      // (a name is the only thing of the file that is logged)
  return { ok: { ok: true, size: after ? after.size : enco.buf.length, mtime: after ? Math.round(after.mtimeMs) : Date.now(), encoding: enc, lineEnding: eolName, ...(bak ? { backup: bak } : {}) } };
}

// ---- FTP-connected consoles --------------------------------------------------
// A SEPARATE, parallel path from every local-disk library above — deliberately.
// An FTP connection to a live, jailbroken console (goldhen/etaHEN's built-in FTP
// server) is a fundamentally less reliable and less provable thing than a local
// disk: no atomic rename on most embedded FTP daemons, connections drop, no real
// symlinks (but a console may expose the same content under more than one mount),
// no realpath/inode containment the way locate()/untouchable()/walkForDelete()
// get for free from the local filesystem. Reusing those hardened local functions
// here would either weaken what two adversarial review rounds closed for local
// disks, or give FTP a false sense of a safety it cannot actually have. So:
//   - this module never calls locate(), untouchable(), walkForDelete(),
//     buildList(), and never reads or writes SOURCES or findSource().
//   - every FTP source has its own id (findFtpSource, below) and its own routes
//     (/api/ftp/*), so the client can never confuse the two kinds of connection.
//   - nothing above this section knows FTP exists; nothing below reaches back
//     into local-library code.
//
// basic-ftp is the one, deliberate, owner-approved exception to "Node standard
// library alone, no npm install, no lockfile" — see the Dockerfile's top comment
// for why (a real FTP protocol client, not worth hand-rolling against real-world
// server quirks). Nothing else in the app gained a dependency because of this.
const ftpClient = require('basic-ftp');

// ---- What "containment" means here, and what it plainly does NOT prove -------
// There is no local root/realpath to compare an FTP path against, no inode, and
// no reliable symlink information most FTP servers expose. So the guarantee this
// module gives is deliberately narrower than the local feature's, and is stated
// here, not just assumed:
//   - every path a request supplies is rejected outright if any segment is
//     exactly ".." or "." (never silently normalized away, never partially
//     accepted) — same spirit as LEAVES_MSG locally, but this IS the entire
//     guarantee. There is no way to prove a path stayed inside wherever the FTP
//     login lands the way realpath+inode comparison proves it for a local disk.
//   - every path is treated as relative to the FTP login's home directory and is
//     always sent to the server as an absolute path from THAT root (a leading
//     "/" plus the segments) — this module never issues CWD/CDUP, so there is no
//     per-request server-side cursor to get out of sync across the pooled
//     connection below, and no ambiguity about what a relative path resolves to.
//   - a console can expose the same content under more than one mount point
//     (bind mounts, a homebrew's own symlinked folders); this module has no way
//     to detect that, and does not try to.
// This must ALSO be said in the client UI, not just here (see ftp-spec.md) — a
// person deleting a folder over FTP needs to know this is not the same
// guarantee the local delete gives them.
const FTP_LEAVES_MSG = "that path reaches outside where this FTP connection lands, so ShadowPKG won't send it";
const FTP_CONTROL_CHAR = /[\x00-\x1f\x7f]/;
function ftpSafeRel(raw) {
  if (typeof raw !== 'string' || FTP_CONTROL_CHAR.test(raw)) return null;
  const norm = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (norm === '') return '';
  const segs = norm.split('/');
  if (segs.some(s => s === '' || s === '..' || s === '.')) return null;
  return segs.join('/');
}
const ftpPathOf = rel => '/' + rel;   // always absolute-from-login-root; this module never CWDs
const ftpParentOf = rel => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
const ftpNameOf = rel => rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;

// A path with nothing above it (a top-level entry right under wherever the FTP
// login lands) gets an extra, louder confirmation before it can be deleted or
// renamed — a depth-based gate, not a naming one: this module still has no
// reliable, general way to tell a game folder from something more sensitive at
// that depth, so anything at depth 0 must say so explicitly
// (`confirmTopLevel: true`) or is refused. The client UI is expected to ask the
// person outright when this happens.
const isFtpTopLevel = rel => rel !== '' && !rel.includes('/');
const FTP_TOPLEVEL_MSG = "that is a top-level item right where this FTP connection lands — ShadowPKG can't tell a game folder from something more sensitive at that depth on this console, so it needs an extra confirmation before touching it";

// UNCONDITIONAL block, layered on top of the depth gate above and never
// overridable by confirmTopLevel: these specific names are not a guess. They
// were observed directly at the FTP login root of a real, live PS4/PS5
// (a 1160-PRO, etaHEN, anonymous FTP) during read-only reconnaissance — the
// login root there is the console's raw device root, not a sandboxed
// user-data folder, and alongside a normal, safe `data/` folder (containing
// etaHEN, homebrew, save_files, etc. — exactly as expected) it also exposes
// these system-partition-adjacent names and executables. Anything whose TOP
// segment matches one of these, case-insensitively, is refused for
// rename/delete, and no confirmation flag skips this check.
//
// IMPORTANT — what this does NOT prove, demonstrated by a real, reproduced
// bypass: this check is a NAME comparison only. It has no realpath/inode
// equivalent over FTP (see the module comment at the top of this section) to
// tell whether a path that ISN'T named after anything on this list is
// secretly an alias — a junction, a bind mount, anything a console's FTP
// daemon can expose — that actually leads into `system/` or another blocked
// folder underneath. A directory named e.g. `data/EscapeLink` passes this
// check (its own name isn't blocked) and then everything inside it is walked
// and deleted with no awareness that it physically resolves into a blocked
// system folder. This was reproduced against a real console: a real file
// inside `system/` was deleted this way. There is no way to close this gap
// completely over FTP the way the local-disk feature's TOCTOU gap was
// closed (that fix relied on realpath+inode comparison, which FTP simply
// does not offer) — so this check blocks a DIRECT, named reference to a
// known system-adjacent path, and nothing more than that. See
// ftpNestedBlockedName() below for one cheap, partial extra layer, and its
// own comment for exactly what it does and doesn't catch.
const FTP_SYSTEM_BLOCKED_NAMES = new Set([
  'system', 'system_ex', 'system_data', 'system_tmp', 'preinst', 'preinst2', 'update',
  'original_system_data', 'original_user', 'adm', 'dev', 'devbin', 'devlog',
  'host', 'host0', 'hostapp', 'app_temp0', 'app_temp1', 'app_tmp',
].map(s => s.toLowerCase()));
const ftpTopSegment = rel => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel).toLowerCase();
const isFtpSystemBlocked = rel => rel !== '' && FTP_SYSTEM_BLOCKED_NAMES.has(ftpTopSegment(rel));
const FTP_SYSTEM_BLOCKED_MSG = "that is a direct reference to a system-partition-adjacent name observed on real PS4/PS5 hardware, so ShadowPKG refuses to rename or delete it by that name — but this is a name check only: it cannot detect a folder that LOOKS ordinary yet is actually an alias, mount, or link into a blocked location underneath (a real, reproduced gap, not a hypothetical one), so this is not a complete guarantee";

// ---- Sending a payload to a console's loader --------------------------------
// A jailbroken console's payload loader — elfldr, and the several all-in-one chains
// that bundle one — listens on a port of its own and takes a payload as raw bytes
// over a plain TCP connection: no HTTP, no reply, nothing to parse. This is the one
// place ShadowPKG puts a program on a console, and it is deliberately separate from
// the DRIVERS below: a driver is a client of an installer that is already running,
// while this starts one. It never runs on its own, and it only ever sends a file a
// person picked on the page (a library file, or one uploaded from their computer);
// nothing is installed and the console is not otherwise changed.
const PAYLOAD_EXTS = ['.elf', '.bin', '.js', '.lua', '.jar'];
const PAYLOAD_PORT_DEFAULT = 9021;              // elfldr, the common ELF loader
const PAYLOAD_MAX = 64 * 1024 * 1024;           // payloads are small; this is a guard, not a limit anyone should hit
const isPayloadName = n => PAYLOAD_EXTS.includes(path.extname(String(n)).toLowerCase());

// The port a console's loader listens on, from the profile, or elfldr's 9021 when
// none was saved. A send can still pass its own port for a one-off.
function payloadPortOf(prof) {
  const n = parseInt(prof && prof.payloadPort, 10);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : PAYLOAD_PORT_DEFAULT;
}

// Write buf to host:port and resolve once every byte is handed to the OS. The loaders
// acknowledge nothing, so "sent" means the bytes left this machine and the connection
// did not fail — the loader may still reject the program on the console, which nothing
// here can see. A short grace after the flush lets a loader that reads to the end of
// the stream take what it needs before the socket closes.
function sendPayloadBytes(host, port, buf, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = err => {
      if (settled) return; settled = true;
      clearTimeout(timer); sock.destroy();
      err ? reject(err) : resolve(buf.length);
    };
    const timer = setTimeout(() => finish(new Error('the console did not answer on this port (timeout)')), timeout);
    sock.on('connect', () => sock.end(buf, () => setTimeout(() => finish(null), 500)));
    sock.on('error', e => finish(Object.assign(e, { unreachable: ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(e.code) })));
  });
}

// Shared tail of both payload routes: resolve the port, send, and answer the page the
// way /api/test does — a 200 carrying ok:false and a plain sentence, so the dialog can
// show the reason without treating it as a failed request.
async function sendPayloadTo(res, prof, portOverride, buf, name) {
  const p = parseInt(portOverride, 10);
  const port = Number.isFinite(p) && p >= 1 && p <= 65535 ? p : payloadPortOf(prof);
  const host = ipOf(prof.host);
  const mb = (buf.length / (1024 * 1024)).toFixed(2);
  try {
    await sendPayloadBytes(host, port, buf);
    console.log(`payload ${name} (${buf.length} bytes) sent to ${prof.name} at ${host}:${port}`);
    return sendJson(res, 200, { ok: true, bytes: buf.length, port,
      message: `${name} (${mb} MB) was sent to ${prof.name} at ${host}:${port}.` });
  } catch (e) {
    console.log(`payload ${name} to ${prof.name} at ${host}:${port} failed: ${e.message}`);
    return sendJson(res, 200, { ok: false, port,
      message: e && e.unreachable
        ? `${prof.name} did not answer on port ${port}. Check the port, and that the console is awake with its payload loader running.`
        : `Could not send to ${prof.name} at ${host}:${port}: ${e.message}` });
  }
}

// Payloads kept by SPKG itself: a folder in the config dir, so a payload uploaded once is
// there to pick again from any device instead of being re-chosen off someone's computer
// every time. Made at startup; a config folder that is not writable simply means nothing
// can be kept, which the dialog says rather than failing silently.
// Payloads live in the /payloads mount when the template provides one, else in a
// subfolder of the config dir (the old place). PAYLOADS_DIR overrides both.
const PAYLOADS_DIR = process.env.PAYLOADS_DIR || (fs.existsSync('/payloads') ? '/payloads' : path.join(CONFIG_DIR, 'payloads'));
let payloadsWritable = false;
try { fs.mkdirSync(PAYLOADS_DIR, { recursive: true }); payloadsWritable = true; } catch { payloadsWritable = false; }

// A stored payload's name, or null if it is not one we would keep: no path in it (either
// separator), no leading dot, a name a Windows share will take, and a suffix we send.
function storedPayloadName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 200 || n.startsWith('.') || !isPayloadName(n)) return null;
  if (/[<>:"|?*\\/\x00-\x1f]/.test(n)) return null;
  return n;
}

const payloadPathOf = name => path.join(PAYLOADS_DIR, name);

async function listPayloads() {
  let names = [];
  try { names = await fsp.readdir(PAYLOADS_DIR); } catch {}
  const files = [];
  for (const n of names) {
    if (!storedPayloadName(n)) continue;
    try {
      const st = await fsp.stat(payloadPathOf(n));
      if (st.isFile()) files.push({ name: n, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { files, writable: payloadsWritable, dir: PAYLOADS_DIR };
}

// Written whole, under a temporary name, then renamed over — so a payload is never seen
// half-written if the container is stopped mid-upload (the same way state files are saved).
async function savePayload(name, buf) {
  const file = payloadPathOf(name);
  const tmp = `${file}.part-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, buf);
  try { await fsp.rename(tmp, file); }
  catch (e) { try { await fsp.unlink(tmp); } catch {} throw e; }
}

// ---- GitHub payloads: fetch a release and watch repos ------------------------
// The owner can pull a payload from a GitHub repo's latest release straight into
// the stored-payloads folder, and keep a small watch list of repos to re-check for
// a newer tag (checked on demand, and again on a slow timer). The watch list lives
// in CONFIG_DIR so it survives restarts.
const WATCH_FILE = path.join(CONFIG_DIR, 'github-watch.json');
let githubWatch = [];                            // [{repo, tag, name, at}]
try {
  const w = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
  if (Array.isArray(w)) githubWatch = w.filter(x => x && typeof x.repo === 'string' && typeof x.tag === 'string');
} catch {}

async function saveGithubWatch() {
  try {
    const tmp = `${WATCH_FILE}.part-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, JSON.stringify(githubWatch, null, 2));
    try { await fsp.rename(tmp, WATCH_FILE); } catch (e) { try { await fsp.unlink(tmp); } catch {} throw e; }
  } catch {}
}

const GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The latest release of an owner/name repo, or {error} on any problem. Only the
// fields the dialog shows plus the payload-ready assets (a browser_download_url) are
// kept; nothing else is forwarded, so a repo full of unrelated files just shows
// nothing downloadable.
async function githubRelease(repo) {
  if (!GH_REPO_RE.test(repo)) return { error: 'a repo looks like owner/name' };
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'ShadowPKG', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { error: 'could not reach GitHub: ' + (e && e.message || e) }; }
  if (res.status === 404) return { error: 'no releases there (or the repo does not exist)' };
  if (res.status === 403) return { error: 'GitHub refused the request (rate limit, or the repo is blocked)' };
  if (!res.ok) return { error: `GitHub answered ${res.status}` };
  let j;
  try { j = await res.json(); } catch { return { error: 'GitHub sent something that was not JSON' }; }
  const assets = (Array.isArray(j.assets) ? j.assets : [])
    .filter(a => a && a.browser_download_url)
    .map(a => ({ name: a.name, size: a.size || 0, url: a.browser_download_url }));
  return { repo, tag: j.tag_name || null, name: j.name || repo, publishedAt: j.published_at || null, draft: !!j.draft, prerelease: !!j.prerelease, assets };
}

// Re-check every watched repo for a newer tag. Returns the list of {repo, from, to}
// that moved; the watch list itself is updated in place and re-saved.
async function checkGithubWatch() {
  const updated = [];
  for (const wi of githubWatch) {
    const rel = await githubRelease(wi.repo);
    if (rel.error || !rel.tag || rel.tag === wi.tag) continue;
    updated.push({ repo: wi.repo, from: wi.tag, to: rel.tag });
    wi.tag = rel.tag; wi.name = rel.name || wi.repo; wi.at = Date.now();
  }
  if (updated.length) {
    saveGithubWatch();
    for (const u of updated) console.log(`GitHub watch: ${u.repo} ${u.from} -> ${u.to}`);
  }
  return updated;
}
setInterval(() => { checkGithubWatch().catch(() => {}); }, 12 * 60 * 60 * 1000).unref?.();

// Curated "recommended" repos shown in the GitHub dialog, each with a reason. The
// list ships in the repo (recommended.json, next to server.js); a CONFIG_DIR/
// recommended.json, when present, replaces it so the owner can curate without a code
// change.
const RECOMMENDED_OVERRIDE = path.join(CONFIG_DIR, 'recommended.json');
let recommendedRepos = [];
try {
  const f = fs.existsSync(RECOMMENDED_OVERRIDE) ? RECOMMENDED_OVERRIDE : path.join(__dirname, 'recommended.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(j)) recommendedRepos = j
    .filter(x => x && typeof x.repo === 'string' && GH_REPO_RE.test(x.repo))
    .map(x => ({ repo: x.repo, reason: typeof x.reason === 'string' ? x.reason : '', build: typeof x.build === 'string' ? x.build : '' }));
} catch {}

// ---- Profiles with an FTP source ----------------------------------------------
// Fields that carry "not set" as null are dropped rather than saved, so a profile
// stays a plain record of what was actually configured. FTP and the payload loader
// port both work this way.
function dropNullProfileFields(prof) {
  for (const k of ['ftpHost', 'ftpPort', 'ftpUser', 'ftpPass', 'payloadPort']) if (prof[k] === null) delete prof[k];
}
const ftpSourceId = profileId => `ftp:${profileId}`;
// `defaultPath`: real reconnaissance against a live PS4/PS5 (see
// FTP_SYSTEM_BLOCKED_NAMES above) found the FTP login root to be the
// console's raw device root, not a sandboxed user-data folder — `data/` is
// the normal, safe, expected folder (etaHEN, homebrew, save_files, ...)
// sitting alongside a lot of system-partition-adjacent clutter. So the
// client is told to open a fresh FTP source there by default, with an
// explicit, clearly-labeled way to still reach the true root if wanted —
// this is only ever a suggested starting view, never an access restriction:
// every /api/ftp/* route above still works on any path a request supplies
// (subject to the containment and system-blocklist rules already in place).
const FTP_DEFAULT_PATH = 'data';
function ftpSourcesList() {
  return profiles.filter(p => p.ftpHost).map(p => ({ id: ftpSourceId(p.id), label: `${p.name} (FTP)`, kind: 'ftp', defaultPath: FTP_DEFAULT_PATH }));
}
// Maps an FTP source id back to its profile, or null. Kept entirely separate
// from findSource()/SOURCES, per the spec — an FTP id can never resolve to a
// local library, and vice versa.
function findFtpSource(id) {
  if (typeof id !== 'string' || !id.startsWith('ftp:')) return null;
  const prof = findProfile(id.slice(4));
  return prof && prof.ftpHost ? prof : null;
}

// ---- Connection pool -----------------------------------------------------------
// One basic-ftp Client per profile, opened lazily and reused. basic-ftp requires
// exactly one command in flight per Client at a time (issuing a second while the
// first is still running corrupts the connection, per its own docs) — withFtp()
// below serializes every operation for a given profile through a small queue,
// the same spirit as serial() above but scoped per FTP profile, not global.
const FTP_CONNECT_TIMEOUT_MS = 8000;      // connect + login: bounded, so a console that is off doesn't hang a request
const FTP_OP_TIMEOUT_MS = 20000;          // list/mkdir/rename/delete-one-entry: bounded, generous
const FTP_TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000;  // upload/download: real transfers can be large and slow, but still bounded
const FTP_IDLE_CLOSE_MS = 60000;          // an idle connection is closed rather than held open against the console indefinitely
const ftpConns = new Map();               // profile id -> { client, loggedIn, idleTimer }
const ftpQueues = new Map();               // profile id -> tail of its serialized operation chain

function ftpOptsFor(prof) {
  // Many goldhen/etaHEN FTP setups are anonymous with no login; blank user/pass
  // (the default when a profile has no ftpUser/ftpPass) attempts exactly that.
  return { host: prof.ftpHost, port: prof.ftpPort || 2121, user: prof.ftpUser || 'anonymous', password: prof.ftpPass || 'anonymous@', secure: false };
}
// The ports a console's FTP is most likely on, in order: the profile's own setting,
// then the common defaults. zftpd's console default is 2120 while ftpsrv/etaHEN's is
// 2121, so a profile that never set a port still finds a console that chose the
// other one instead of failing with "could not connect".
function ftpPortsOf(prof) {
  const out = [];
  for (const p of [prof.ftpPort, 2121, 2120]) if (p && !out.includes(p)) out.push(p);
  return out;
}
// zftpd's FTP answers its 220 greeting with "Service ready for new user.", while
// ftpsrv/etaHEN's announces "ftpsrv.elf ...". Reading the greeting is the only way
// to tell a zftpd FTP-only build (no HTTP) apart from plain FTP, so the chip can
// say "zFTPd" for it even without the HTTP layer.
function ftpBanner(host, port) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    sock.setTimeout(3000);
    let settled = false;
    const done = v => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.once('connect', () => sock.once('data', d => done(String(d))));
    sock.on('error', () => done(null));
    sock.on('timeout', () => done(null));
  });
}
const ftpBannerCache = new Map();    // profile id -> { at, zftpd }
async function ftpBannerIsZftpd(prof) {
  const hit = ftpBannerCache.get(prof.id);
  if (hit && Date.now() - hit.at < 60000) return hit.zftpd;
  let zftpd = false;
  for (const port of ftpPortsOf(prof)) {
    const b = await ftpBanner(prof.ftpHost, port);
    if (b) { zftpd = /Service ready for new user/i.test(b); break; }
  }
  ftpBannerCache.set(prof.id, { at: Date.now(), zftpd });
  return zftpd;
}
function closeFtpConn(profileId) {
  const c = ftpConns.get(profileId);
  if (!c) return;
  ftpConns.delete(profileId);
  clearTimeout(c.idleTimer);
  try { c.client.close(); } catch {}
}
function armIdle(profileId, entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => closeFtpConn(profileId), FTP_IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}
// Gets a logged-in client for this profile, connecting (or reconnecting) as
// needed. Only ever called from inside withFtp()'s per-profile queue, so two
// calls for the same profile never race each other. Returns {client, reused} —
// `reused` says whether this was an already-logged-in connection handed back
// as-is, or one this call just freshly connected — see withFtp for why that
// distinction matters for its retry decision.
async function ensureFtpClient(prof) {
  let entry = ftpConns.get(prof.id);
  if (entry && entry.client.closed) entry = null;
  if (!entry) {
    const client = new ftpClient.Client(FTP_CONNECT_TIMEOUT_MS);
    client.ftp.verbose = false;
    entry = { client, loggedIn: false, idleTimer: null };
    ftpConns.set(prof.id, entry);
  }
  const reused = entry.loggedIn;
  if (!entry.loggedIn) {
    let lastErr = null;
    for (const port of ftpPortsOf(prof)) {
      try {
        await entry.client.access({ ...ftpOptsFor(prof), port });
        entry.loggedIn = true;
        if (port !== prof.ftpPort) prof.ftpPort = port;   // remember the port that actually answered
        break;
      } catch (e) { lastErr = e; }
    }
    if (!entry.loggedIn) throw lastErr || new Error('could not connect to the console');
  }
  armIdle(prof.id, entry);
  return { client: entry.client, reused };
}
const FTP_RECONNECT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);
function ftpLooksDisconnected(e) {
  if (!e) return false;
  if (FTP_RECONNECT_CODES.has(e.code)) return true;
  return /closed|disconnect|not connected|control socket|socket.*end/i.test(String(e.message || ''));
}
// Runs fn(client) for this profile, serialized behind whatever else is already
// queued for it. On a dropped connection (ECONNRESET/timeout/"closed"-looking
// error) the pooled client is discarded and ONE reconnect+retry is attempted
// transparently, not by crashing the route; a second failure is reported to the
// caller honestly rather than retried forever. `timeoutMs` bounds fn() itself so
// nothing here can hang a request indefinitely if the console goes offline
// mid-operation.
function withFtp(prof, fn, timeoutMs = FTP_OP_TIMEOUT_MS) {
  const prev = ftpQueues.get(prof.id) || Promise.resolve();
  // The whole attempt — connecting/logging in (if not already) AND running fn —
  // is under one race with its own timer, not just fn(). basic-ftp's own
  // constructor timeout is a second line of defence, but this module does not
  // rely on it alone: a console that accepts the TCP connection and then never
  // sends so much as its FTP greeting must still not hang a request forever.
  // `attempt()` reports back whether the client it used was a REUSED, already
  // logged-in connection (`reused: true`) or one it had to freshly connect just
  // now. That distinction matters for deciding whether a retry is worth it: a
  // reused connection that suddenly errors may really have been dropped by the
  // console (idle timeout, a reset) — worth one transparent reconnect. A BRAND
  // NEW connection attempt that fails (the console is off, unreachable, or
  // silently not answering at all) will almost certainly fail again in exactly
  // the same way; retrying it would just make a request that is never going to
  // succeed take twice as long to fail, which is its own way of not honestly
  // bounding the wait. So only a reused connection's failure gets the retry.
  const attempt = async () => {
    let timer, timedOut = false, reused = false;
    const guarded = Promise.race([
      (async () => { const r = await ensureFtpClient(prof); reused = r.reused; return fn(r.client); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error('the console stopped answering'), { code: 'ETIMEDOUT' })); }, timeoutMs); }),
    ]);
    try { const r = await guarded; clearTimeout(timer); return r; }
    catch (e) { clearTimeout(timer); if (timedOut) closeFtpConn(prof.id); e.ftpWasReused = reused; throw e; }
  };
  const run = prev.catch(() => {}).then(async () => {
    try { return await attempt(); }
    catch (e) {
      if (!e.ftpWasReused || !ftpLooksDisconnected(e)) throw e;
      closeFtpConn(prof.id);
      return await attempt();   // exactly one transparent reconnect+retry, only for a connection that WAS working, then this is reported honestly
    }
  });
  ftpQueues.set(prof.id, run.catch(() => {}));
  return run;
}
// A human-readable reason for an FTP error, the same spirit as fsErr() locally.
function ftpErr(e) {
  if (!e) return 'unknown error';
  if (e.code === 'ETIMEDOUT') return e.message || 'timed out';
  return String(e.message || e).replace(/^Client is closed because.*$/, 'the connection was closed');
}

// ---- Listing --------------------------------------------------------------
// {name, path, isDir, isLink, size, mtime?} per entry — the same general shape
// the local browse/list responses use where it is meaningful, so the client can
// reuse rendering, but nothing is invented: a field the console's FTP server does
// not actually provide (a created date, for instance) is left out rather than
// faked. mtime is only present when the server answered MLSD (modifiedAt set);
// basic-ftp negotiates MLSD vs. LIST-parsing on its own, so which one ran is not
// this module's concern beyond "did we get a date or not".
function ftpEntryView(dirRel, f) {
  const rel = dirRel ? `${dirRel}/${f.name}` : f.name;
  const out = { name: f.name, path: rel, isDir: f.isDirectory, isLink: f.isSymbolicLink, size: f.size };
  if (f.modifiedAt instanceof Date && !isNaN(f.modifiedAt)) out.mtime = f.modifiedAt.getTime();
  return out;
}
async function ftpList(prof, rel) {
  return withFtp(prof, async client => {
    // basic-ftp's list(path) is not reliable about a path that does not exist:
    // it can answer with whatever the connection last successfully listed
    // instead of a clean error (seen directly, on real hardware, while this
    // feature was built). cd() to the same absolute path first does throw
    // cleanly on a bad path, so that runs first, purely to prove the path is
    // real before trusting anything list() returns — it never CDs the
    // connection to somewhere RELATIVE, only ever to the exact absolute path
    // this call was asked for, so the "never CWDs to somewhere the caller
    // didn't ask for" guarantee above still holds.
    await client.cd(ftpPathOf(rel));
    const list = await client.list();
    return list.filter(f => f.name !== '.' && f.name !== '..').map(f => ftpEntryView(rel, f));
  });
}

// ---- Deleting a folder (and everything inside it) over FTP --------------------
// Same two-phase SPIRIT as the local feature (list everything first, delete only
// once the whole tree has been walked and nothing refused it) — but the
// guarantees are necessarily weaker, and are NOT overstated as equal:
//   - there is no atomic validate-then-delete on a remote FTP server the way
//     there is on a local disk with real syscalls; between listing a folder's
//     contents here and removing each entry, the console's own filesystem can
//     change (a save auto-written, a screenshot taken, another connection
//     touching it) and there is no way to fully close that gap over FTP the way
//     the local feature's two adversarial-review rounds closed it for local
//     disks.
//   - a dropped connection mid-delete leaves a partially-deleted folder with no
//     journal to recover from — this is reported to the caller PLAINLY as a
//     possible outcome (`partial: true` with what was and wasn't removed), never
//     silently retried into looking like a clean success.
//   - recursion is depth-first, files before empty directories, same shape as
//     local; if a directory won't come out empty (something is still in it, or
//     appeared mid-delete) the walk stops and reports what's left rather than
//     retrying forever or giving up quietly.
// This is genuinely higher-risk than the local feature. Say so — here, and in
// what is reported back about this feature.
const FTP_DELETE_WALK_MAX_ENTRIES = 50000;   // a bound, not a promise of correctness past it — see below
async function ftpWalk(prof, rootRel) {
  const files = [], dirs = [rootRel], links = [];
  let bytes = 0, truncated = false;
  const todo = [rootRel];
  while (todo.length) {
    const here = todo.pop();
    let entries;
    try { entries = await ftpList(prof, here); }
    catch (e) { return { abort: `could not read everything inside it, so nothing was deleted: ${ftpErr(e)}` }; }
    for (const e of entries) {
      if (files.length + dirs.length + links.length > FTP_DELETE_WALK_MAX_ENTRIES) { truncated = true; break; }
      if (e.isLink) { links.push(e.path); continue; }        // unlinked as itself only, per FTP DELE — never recursed into
      if (e.isDir) { dirs.push(e.path); todo.push(e.path); continue; }
      files.push(e.path); bytes += e.size || 0;
    }
    if (truncated) break;
  }
  return { files, dirs, links, bytes, truncated };
}

// ---- Save-data backups ---------------------------------------------------------
// A console's save data — PS4 saves under /user/home/<uid>/savedata/<title id> and
// PS5 saves under /user/home/<uid>/savedata_prospero/<title id> — can be pulled to
// this server and pushed back, so a console wipe or a bad install doesn't take the
// saves with it. Each backup is a folder under CONFIG_DIR/saves/<id>/ holding the
// save's own files plus a small shadowpkg-save.json describing what and where it was.
const SAVES_DIR = path.join(CONFIG_DIR, 'saves');
const SAVE_META = 'shadowpkg-save.json';
const SAVE_UID_RE = /^[0-9a-f]{8}$/i;      // a console user id, e.g. 1e025929
const SAVE_TITLE_RE = /^[A-Z]{4}\d{5}$/;   // a title id, e.g. CUSA12345 or PPSA12345
const SAVE_KINDS = ['savedata', 'savedata_prospero'];

// The files under a local backup folder, depth-first, as absolute paths — the save's
// own metadata file is never part of the save itself.
function walkLocalSave(id) {
  const root = path.join(SAVES_DIR, id), out = [], todo = [root];
  while (todo.length) {
    const here = todo.pop();
    let ents; try { ents = fs.readdirSync(here, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name === SAVE_META) continue;
      const full = path.join(here, e.name);
      if (e.isDirectory()) todo.push(full); else if (e.isFile()) out.push(full);
    }
  }
  return out;
}
// A backup's metadata, or null when that id is not a real backup. Only the fields the
// restore path needs are trusted here; everything else is re-read from disk.
function readSaveMeta(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const f = readJsonFile(path.join(SAVES_DIR, id, SAVE_META));
  if (!f || typeof f.uid !== 'string' || typeof f.kind !== 'string' || typeof f.titleId !== 'string') return null;
  if (!SAVE_UID_RE.test(f.uid) || !SAVE_KINDS.includes(f.kind) || !SAVE_TITLE_RE.test(f.titleId)) return null;
  return f;
}
function saveBackups() {
  let ids = []; try { ids = fs.readdirSync(SAVES_DIR); } catch { return []; }
  return ids.map(readSaveMeta).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
// The saves a console holds, read-only: each user account's savedata and
// savedata_prospero folders, one entry per title id.
async function listConsoleSaves(prof) {
  let uids = [];
  try {
    uids = (await ftpList(prof, 'user/home')).filter(e => e.isDir && SAVE_UID_RE.test(e.name)).map(e => e.name);
  } catch (e) { return { error: `could not read the console's user folder: ${ftpErr(e)}` }; }
  const saves = [];
  for (const uid of uids) {
    for (const kind of SAVE_KINDS) {
      let entries = [];
      try { entries = await ftpList(prof, `user/home/${uid}/${kind}`); } catch { continue; }
      for (const e of entries) {
        if (!e.isDir || !SAVE_TITLE_RE.test(e.name)) continue;
        saves.push({ uid, kind, titleId: e.name, path: e.path });
      }
    }
  }
  return { uids, saves };
}
// Pull one save folder off the console into CONFIG_DIR/saves. Downloads file by file
// through the shared serialized FTP connection, so it never races another operation.
async function backupSave(prof, uid, kind, titleId) {
  const fullRel = `user/home/${uid}/${kind}/${titleId}`;
  const walk = await ftpWalk(prof, fullRel);
  if (walk.abort) return { error: walk.abort };
  if (!walk.files.length) return { error: 'that save folder is empty or does not exist' };
  const id = newId(), dir = path.join(SAVES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  try {
    for (const f of walk.files) {
      const rel = f.slice(fullRel.length + 1);
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await withFtp(prof, client => client.downloadTo(dst, ftpPathOf(f)), FTP_TRANSFER_TIMEOUT_MS);
      bytes += Number(fs.statSync(dst).size) || 0;
    }
    fs.writeFileSync(path.join(dir, SAVE_META), JSON.stringify({
      id, consoleId: prof.id, consoleName: prof.name, uid, kind, titleId,
      bytes, files: walk.files.length, at: new Date().toISOString(),
    }));
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { error: `the backup was interrupted: ${ftpErr(e)}` };
  }
  return { ok: true, id, bytes, files: walk.files.length };
}
// Push a backed-up save back to its original user + kind + title id on the target
// console, creating parent folders as needed.
async function restoreSave(prof, backup) {
  const fullRel = `user/home/${backup.uid}/${backup.kind}/${backup.titleId}`;
  const files = walkLocalSave(backup.id);
  for (const f of files) {
    const rel = path.relative(path.join(SAVES_DIR, backup.id), f).split(path.sep).join('/');
    await withFtp(prof, async client => {
      const parent = ftpParentOf(`${fullRel}/${rel}`);
      if (parent) { try { await client.ensureDir(ftpPathOf(parent)); } catch {} }
      await client.uploadFrom(f, ftpPathOf(`${fullRel}/${rel}`));
    }, FTP_TRANSFER_TIMEOUT_MS);
  }
  return { ok: true, files: files.length };
}

// Cheap, partial extra layer on top of the direct-name block above: after
// walking a folder marked for delete, if ANY entry found at ANY depth is
// itself named like a blocked system folder, the whole delete is aborted
// before anything is removed. This is NOT the fix for the reported alias
// bypass (an alias/mount/junction pointing into a blocked location, e.g.
// `data/EscapeLink` -> really `system/`, keeps whatever name the alias
// itself was given — not the blocked name — so this check does not see it
// and would not have caught that exploit). It only helps in the narrower
// case where something inside the walked tree happens to still be named
// after a blocked folder (e.g. a mount that kept its original name nested a
// few levels down) — one step better than nothing, nothing more.
function ftpNestedBlockedName(w) {
  for (const rel of [...w.dirs.slice(1), ...w.files, ...w.links]) {
    if (FTP_SYSTEM_BLOCKED_NAMES.has(ftpNameOf(rel).toLowerCase())) return rel;
  }
  return null;
}
const ftpNestedBlockedMsg = rel => `aborted before deleting anything: ${rel} is nested inside this and is itself named like a known system-adjacent folder — this is a cheap extra check, not a complete guard (see the module comment above ftpNestedBlockedName), but ShadowPKG stops rather than risk it`;

// ---- One FTP item's delete, as its own callable function -----------------------
// This IS the /api/ftp/delete route's per-item logic, pulled out so it has exactly
// one definition: the route below loops items and calls this once per item, and
// the transfers feature's Move (further down in this file) calls it too, once, on
// an already-verified FTP source. No second, parallel deletion mechanism exists
// anywhere in this file for an FTP path. Returns {ok:true, entry} or {ok:false,
// error, partial?, removedFiles?, removedDirs?} — same shape the route always did.
async function deleteFtpOne(prof, rawPath, confirmTopLevel) {
  const fail = error => ({ ok: false, error });
  const rel = ftpSafeRel(rawPath);
  if (rel === null) return fail(FTP_LEAVES_MSG);
  if (rel === '') return fail("the connection's own root cannot be deleted here");
  if (isFtpSystemBlocked(rel)) return fail(FTP_SYSTEM_BLOCKED_MSG);   // a direct-name match; confirmTopLevel cannot skip it
  if (isFtpTopLevel(rel) && !confirmTopLevel) return fail(FTP_TOPLEVEL_MSG);
  let entries;
  try { entries = await ftpList(prof, ftpParentOf(rel)); }
  catch (e) { return fail(`could not read it: ${ftpErr(e)}`); }
  const self = entries.find(e => e.name === ftpNameOf(rel));
  if (!self) return fail('not found');
  if (self.isLink) {
    try { await withFtp(prof, client => client.remove(ftpPathOf(rel))); return { ok: true, entry: { path: rel, link: true } }; }
    catch (e) { return fail(`could not delete it: ${ftpErr(e)}`); }
  }
  if (!self.isDir) {
    try { await withFtp(prof, client => client.remove(ftpPathOf(rel))); return { ok: true, entry: { path: rel, files: 1, dirs: 0, bytes: self.size || 0 } }; }
    catch (e) { return fail(`could not delete it: ${ftpErr(e)}`); }
  }
  // Phase 1: walk and validate (read-only). Phase 2: delete files, then links,
  // then empty directories bottom-up — same shape as the local feature, but see
  // the module comment above ftpWalk for exactly which guarantees do NOT carry
  // over here. A dropped connection or a change mid-delete is reported as a
  // partial result, never silently upgraded to a clean success.
  const w = await ftpWalk(prof, rel);
  if (w.abort) return fail(w.abort);
  const nestedBlocked = ftpNestedBlockedName(w);
  if (nestedBlocked) return fail(ftpNestedBlockedMsg(nestedBlocked));
  let removedFiles = 0, removedDirs = 0, removedBytes = 0, stoppedAt = null;
  try {
    for (const f of w.files) {
      try { await withFtp(prof, client => client.remove(ftpPathOf(f))); removedFiles++; }
      catch (e) { stoppedAt = `${f}: ${ftpErr(e)}`; break; }
    }
    if (!stoppedAt) for (const l of w.links) {
      try { await withFtp(prof, client => client.remove(ftpPathOf(l))); removedFiles++; }
      catch (e) { stoppedAt = `${l}: ${ftpErr(e)}`; break; }
    }
    // w.dirs[0] is rel itself (the root being deleted) — removed here like every
    // other directory (bottom-up means it goes last), but not counted in `dirs`:
    // same convention the preview endpoint and the local feature both use.
    if (!stoppedAt) for (let i = w.dirs.length - 1; i >= 0; i--) {
      try { await withFtp(prof, client => client.removeEmptyDir(ftpPathOf(w.dirs[i]))); if (i > 0) removedDirs++; }
      catch (e) { stoppedAt = `${w.dirs[i]}: ${ftpErr(e)}`; break; }
    }
  } catch (e) { stoppedAt = ftpErr(e); }
  removedBytes = w.bytes;   // an honest upper bound when partial — see the "partial" field below
  if (stoppedAt) {
    return { ok: false, error: `could not finish deleting it over FTP — it is now PARTIALLY deleted (some of what was inside is gone, some is not), and there is no way to fully guard against that over FTP the way there is on a local disk: ${stoppedAt}`, partial: true, removedFiles, removedDirs };
  }
  return { ok: true, entry: { path: rel, folder: true, files: removedFiles, dirs: removedDirs, bytes: removedBytes } };
}

// ---- What a console has installed (read over FTP) ------------------------------
// The console keeps what is installed in two small SQLite files: appinfo.db (one row per title and key: TITLE,
// CONTENT_ID, CONTENT_VERSION on a PS5 or APP_VER on a PS4, _org_path for where it lives, #_size) and addcont.db (one
// row per installed DLC, with its name and version). Both are copied over FTP into a temporary folder, read with the
// SQLite that comes with Node, and removed again; nothing on the console is written. An installed update is a patch
// folder holding patch.pkg beside the game's app folder. Node's SQLite module is missing before Node 22.13, and a
// console whose FTP does not reach /system_data (or an older firmware with other tables) gets a plain error.
const INSTALLED_DB_DIR = 'system_data/priv/mms';
const INSTALLED_KEEP_MS = 120000;
const installedCache = new Map();     // profile id -> { at, result }
let sqliteMod;
function loadSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  try { sqliteMod = require('node:sqlite'); } catch { sqliteMod = null; }
  return sqliteMod;
}
// ==== installed-titles (pure) ====
const versionParts = v => String(v || '').split('.').map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n));
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
function storageOf(orgPath) {
  const p = String(orgPath || '');
  if (p.startsWith('/mnt/ext1/')) return 'M.2';
  if (p.startsWith('/mnt/ext0/')) return 'Extended (USB)';
  if (p.startsWith('/mnt/usb')) return 'USB';
  if (p.startsWith('/user/')) return 'Internal';
  return p ? 'Other' : '';
}
// appinfo rows ({titleId, key, val}) and addcont rows into one list of games, each with its DLC.
function installedFromRows(appRows, dlcRows) {
  const byId = new Map();
  for (const r of appRows) {
    const id = String(r.titleId || '');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, {});
    byId.get(id)[String(r.key)] = r.val == null ? '' : String(r.val);
  }
  const games = [];
  for (const [id, m] of byId) {
    if (/^NPXS/.test(id) || !m._org_path) continue;          // the console's own apps, and anything not installed
    const ps5 = /^PP/.test(id) || m.CONTENT_VERSION !== undefined;
    games.push({
      titleId: id, title: m.TITLE || m.TITLE_01 || id, contentId: m.CONTENT_ID || '', platform: /^CUSA|^PCAS|^PLAS|^PCJS/.test(id) ? 'PS4' : ps5 ? 'PS5' : '',
      version: m.CONTENT_VERSION || m.APP_VER || m.VERSION || '', size: Number(m['#_size']) || 0,
      installed: m['#_install_time'] || '', storage: storageOf(m._org_path), orgPath: m._org_path, icon: m._metadata_path ? m._metadata_path.replace(/^\/+/, '') + '/icon0.png' : '', iconStamp: String(m['#_install_time'] || '').replace(/[^0-9]/g, ''), dlc: [], update: null,
    });
  }
  const gameOf = new Map(games.map(g => [g.titleId, g]));
  for (const r of dlcRows) {
    const g = gameOf.get(String(r.title_id || ''));
    const item = { contentId: String(r.content_id || ''), label: String(r.dir_name || ''), title: String(r.title || r.titles_ENGLISH_US || r.dir_name || ''), version: String(r.ac_version || r.version || ''), size: Number(r.size) || 0 };
    if (g) g.dlc.push(item);
    else if (item.contentId || item.label) {      // DLC whose game is not installed (deleted, or installed on another console's drive): listed under its title id
      const id = String(r.title_id || '?');
      const o = { titleId: id, title: '', contentId: '', platform: /^CUSA|^PCAS|^PLAS|^PCJS/.test(id) ? 'PS4' : /^PP/.test(id) ? 'PS5' : '', version: '', size: 0, installed: '', storage: '', orgPath: '', dlc: [item], update: null, notInstalled: true };
      games.push(o); gameOf.set(id, o);
    }
  }
  for (const g of games) g.dlc.sort((a, b) => a.title.localeCompare(b.title));
  games.sort((a, b) => (!!a.notInstalled - !!b.notInstalled) || (a.title || a.titleId).localeCompare(b.title || b.titleId));
  return games;
}
// ==== end installed-titles ====

// The newest version of each title id the local libraries hold (a game or an update), from what is already read.
function libraryVersions() {
  const best = new Map();
  for (const lib of SOURCES) {
    let files;
    try { files = listWithMeta(lib, buildList(lib).files); } catch { continue; }
    for (const f of files) {
      const m = f.meta;
      if (!m || m.tentative || !m.titleId || !m.version || (m.kind !== 'update' && m.kind !== 'game')) continue;
      const was = best.get(m.titleId);
      if (!was || compareVersions(m.version, was.version) > 0) best.set(m.titleId, { version: m.version, kind: m.kind, src: lib.id, path: f.path });
    }
  }
  return best;
}

// ---- zftpd on a console (read-only) --------------------------------------------------------------------------
// zftpd (github.com/seregonwar/zftpd) is an FTP server payload for the console that also answers HTTP on the same port.
// If the console's FTP port is a zftpd, GET /api/status says so (name, version, platform) and GET /api/mounts lists the
// drives that are really connected, with their size and free space. Nothing is ever sent to the console beyond those two
// GETs, and a console running another FTP server just does not answer them as JSON (cached for a minute, so it is not asked often).
// ==== zftpd-probe (pure) ====
// -> { present, version, platform, features, mounts:[{path, name, kind, total, free}] } from the two answers (each parsed JSON or null).
function zftpdFromAnswers(status, mounts) {
  if (!status || status.ok !== true || typeof status.instance_id !== 'string' || typeof status.version !== 'string') return { present: false };
  const list = mounts && mounts.ok === true && Array.isArray(mounts.mounts) ? mounts.mounts : [];
  return {
    present: true, version: status.version.slice(0, 20), platform: String(status.platform || '').slice(0, 20),
    features: status.features && typeof status.features === 'object' ? status.features : {},
    mounts: list.map(m => ({ path: String(m.path || ''), name: String(m.name || ''), kind: String(m.kind || ''), total: Number(m.total) || 0, free: Number(m.free) || 0 })).filter(m => m.path),
  };
}
// ==== end zftpd-probe ====
function httpJson(host, port, pathName, ms, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({ host, port, path: pathName, method, timeout: ms, headers: { 'Accept': 'application/json', 'Connection': 'close' } }, res => {
      if (res.statusCode !== 200 || !/json/i.test(String(res.headers['content-type'] || ''))) { res.resume(); resolve(null); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 1 << 16) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
const httpGetJson = (host, port, pathName, ms) => httpJson(host, port, pathName, ms, 'GET');
// Like httpJson, but never throws away a non-200 answer: returns {status, json} (json null if the body wasn't
// JSON) so a route can say what the console actually said, rather than reporting it as not having answered at
// all — used where that reason matters, such as a CSRF refusal on an action a real browser session would pass.
function httpJsonAny(host, port, pathName, ms, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({ host, port, path: pathName, method, timeout: ms, headers: { 'Accept': 'application/json', 'Connection': 'close' } }, res => {
      const isJson = /json/i.test(String(res.headers['content-type'] || ''));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 1 << 16) req.destroy(); });
      res.on('end', () => { let json = null; if (isJson) { try { json = JSON.parse(data); } catch {} } resolve({ status: res.statusCode, json }); });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
// A real console's zftpd (reproduced against a PS5 build, v1.6.0) can drop an HTTP request made with no gap after
// a previous one on the same port — "socket hang up" on whichever call goes second, not specific to any one path.
// Every zftpd GET after the first one in a sequence goes through this: a short pause first, then one retry after a
// longer one if it still comes back empty. 10/10 clean against the real console in that gap, and a console that is
// genuinely gone still answers "no" just as fast, since the GET underneath still carries its own timeout.
async function zftpdGetAfterAnother(host, port, pathName, timeout, method = 'GET') {
  await sleep(300);
  let r = await httpJson(host, port, pathName, timeout, method);
  if (!r) { await sleep(800); r = await httpJson(host, port, pathName, timeout, method); }
  return r;
}

// Install a package on a console through zftpd's games admin API: the console
// downloads the link itself and installs it, exactly like the DPIv2 drivers do.
// Returns the same shape as a DRIVERS[].install() result so the send flow treats
// it identically.
async function zftpdInstall(prof, pkgUrl, port) {
  const p = port || prof.ftpPort || 2121;
  const pathName = '/api/admin/games/install?url=' + encodeURIComponent(pkgUrl);
  // GET rather than POST: zftpd's install endpoint accepts both, but only POST is
  // behind its CSRF check (a token only its own web page knows), so GET is the one
  // a non-browser caller can pass.
  await sleep(300);
  let r = await httpJsonAny(prof.ftpHost, p, pathName, 30000, 'GET');
  if (!r) { await sleep(800); r = await httpJsonAny(prof.ftpHost, p, pathName, 30000, 'GET'); }
  const j = r && r.json;
  if (!j) return { ok: false, status: r ? r.status : 0, reply: null, payload: { ok: false, url: pkgUrl, profile: prof.name, installer: 'zftpd', error: `${prof.name} (zftpd) did not answer the install request.` } };
  if (j.ok === true) {
    console.log(`${new Date().toISOString()} install queued on ${prof.name} (zftpd) ${pkgUrl} -> ${j.message || 'Install started'}${j.title_id ? ' (' + j.title_id + ')' : ''}`);
    return { ok: true, status: r.status, reply: j, payload: { ok: true, url: pkgUrl, profile: prof.name, installer: 'zftpd', ps5: j } };
  }
  return { ok: false, status: r.status, reply: j, payload: { ok: false, url: pkgUrl, profile: prof.name, installer: 'zftpd', error: `${prof.name} (zftpd) replied: ${j.message || j.error || JSON.stringify(j)}` } };
}
const zftpdCache = new Map();      // profile id -> { at, result }
const zftpdInFlight = new Map();   // profile id -> Promise — dedupes concurrent probes
async function zftpdProbe(prof, force) {
  const hit = zftpdCache.get(prof.id);
  const ttl = hit && hit.result.present ? 20000 : 60000;
  if (hit && !force && Date.now() - hit.at < ttl) return hit.result;
  // Two routes (the /api/ftp/zftpd probe and the /api/status label probe) call this
  // at once; without dedup they hit the console's single port together and one request
  // gets ECONNRESET, then a false present:false is cached for a minute and every
  // zftpd-gated button disappears. Share one in-flight probe instead of racing.
  if (zftpdInFlight.has(prof.id)) return zftpdInFlight.get(prof.id);
  const p = (async () => {
    // A console can answer as a zftpd on a port the profile never set (zftpd's console
    // default 2120 vs the 2121 placeholder), so try each likely port and remember the
    // one that answered.
    for (const port of ftpPortsOf(prof)) {
      // The first HTTP request to a zftpd console can be dropped when it comes with
      // no gap after another connection on the same port (see zftpdGetAfterAnother),
      // so the /api/status probe uses that sleep + retry path rather than one attempt.
      const status = await zftpdGetAfterAnother(prof.ftpHost, port, '/api/status', 2500);
      if (status) {
        if (port !== prof.ftpPort) prof.ftpPort = port;
        const mounts = await zftpdGetAfterAnother(prof.ftpHost, port, '/api/mounts', 4000);
        const result = { ...zftpdFromAnswers(status, mounts), port };
        zftpdCache.set(prof.id, { at: Date.now(), result });
        return result;
      }
    }
    const result = { present: false };
    zftpdCache.set(prof.id, { at: Date.now(), result });
    return result;
  })();
  zftpdInFlight.set(prof.id, p);
  try { return await p; } finally { zftpdInFlight.delete(prof.id); }
}

// ---- Icons of what a console has installed, kept on this server -----------------------------------------------
// An icon is fetched at most once per install: first from a package of the same title ID in a library (local, fast),
// otherwise from the console's own metadata folder over FTP (one connection, one file at a time, so slow), then kept
// in CONFIG_DIR/icons/<console>/<title id>-<install stamp>.png. The stamp is the game's install time, so a reinstall
// gets a fresh icon and the old file is removed. A title with no icon anywhere is not asked about again for ten minutes.
const ICON_MAX_BYTES = 4 * 1048576;
const iconDir = prof => path.join(CONFIG_DIR, 'icons', String(prof.id).replace(/[^A-Za-z0-9_-]/g, '_'));
const iconMissing = new Map();        // "console|title" -> when it was found to have none
const iconPaths = new Map();           // console -> Map(title id -> where its icon is on the console), from the last read of the installed list
const iconFetching = new Map();       // file path -> the promise already fetching it

// A package of this title ID in the libraries that has an icon: a game before an update before anything else.
async function libraryIconFor(titleId) {
  let best = null;
  const rank = k => (k === 'game' ? 0 : k === 'update' ? 1 : 2);
  for (const lib of SOURCES) {
    let files;
    try { files = listWithMeta(lib, buildList(lib).files); } catch { continue; }
    for (const f of files) {
      const m = f.meta;
      if (!m || m.tentative || m.titleId !== titleId || f.dir) continue;
      if (!best || rank(m.kind) < best.r) best = { lib, path: f.path, r: rank(m.kind) };
    }
  }
  if (!best) return null;
  try {
    const t = await resolveTarget(best.lib, best.path);
    if (!t || t.error) return null;
    const cnt = await readCntFor(t);
    const icon = cnt && cnt.entries.find(e => e.name === 'icon0.png' && !e.encrypted);
    if (!icon || !icon.dataSize || icon.dataSize > ICON_MAX_BYTES || cnt.baseOffset + icon.dataOffset + icon.dataSize > t.size) return null;
    return await readPkgRange(t, cnt.baseOffset + icon.dataOffset, icon.dataSize);
  } catch { return null; }
}

function consoleIconOver(prof, titleId) {
  const known = iconPaths.get(prof.id) && iconPaths.get(prof.id).get(titleId);
  const rel = ftpSafeRel(known || ('user/appmeta/' + titleId + '/icon0.png'));
  if (!rel) return Promise.reject(new Error('bad path'));
  return withFtp(prof, async client => {
    const { Writable } = require('stream');
    const chunks = []; let n = 0;
    const sink = new Writable({ write(c, _e, cb) { n += c.length; if (n > ICON_MAX_BYTES) return cb(new Error('too big')); chunks.push(c); cb(); } });
    await client.downloadTo(sink, ftpPathOf(rel));
    return Buffer.concat(chunks);
  }, 60000);
}

// -> { png, from: 'cache' | 'library' | 'console' } or { error }
async function installedIcon(prof, titleId, stamp) {
  if (!/^[A-Z]{4}\d{5}$/.test(titleId)) return { error: 'not a title id' };
  const stampKey = String(stamp || '').replace(/[^0-9]/g, '').slice(0, 20) || '0';
  const dir = iconDir(prof), file = path.join(dir, titleId + '-' + stampKey + '.png');
  try { return { png: fs.readFileSync(file), from: 'cache' }; } catch {}
  const missKey = prof.id + '|' + titleId;
  if (Date.now() - (iconMissing.get(missKey) || 0) < 600000) return { error: 'no icon' };
  if (iconFetching.has(file)) return iconFetching.get(file);
  const job = (async () => {
    let png = await libraryIconFor(titleId), from = 'library';
    if (!png) { try { png = await consoleIconOver(prof, titleId); from = 'console'; } catch { png = null; } }
    if (!png || !png.length || png.slice(0, 4).toString('hex') !== '89504e47') { iconMissing.set(missKey, Date.now()); return { error: 'no icon' }; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const old of fs.readdirSync(dir)) if (old.startsWith(titleId + '-') && old !== path.basename(file)) { try { fs.unlinkSync(path.join(dir, old)); } catch {} }
      const tmp = file + '.tmp'; fs.writeFileSync(tmp, png); fs.renameSync(tmp, file);
    } catch {}      // an unwritable config folder only means it is fetched again next time
    return { png, from };
  })();
  iconFetching.set(file, job);
  try { return await job; } finally { iconFetching.delete(file); }
}

async function installedOnConsole(prof) {
  const sq = loadSqlite();
  if (!sq || !sq.DatabaseSync) return { status: 501, error: 'this server\'s Node has no built-in SQLite (it needs Node 22.13 or newer), so the console\'s list cannot be read' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowpkg-installed-'));
  try {
    for (const name of ['appinfo.db', 'addcont.db']) {
      try { await withFtp(prof, client => client.downloadTo(path.join(tmp, name), ftpPathOf(INSTALLED_DB_DIR + '/' + name)), 120000); }
      catch (e) {
        if (name === 'addcont.db') { try { fs.unlinkSync(path.join(tmp, name)); } catch {} continue; }      // no DLC list: the games alone
        return { status: 502, error: 'could not read the console\'s list of installed titles (' + INSTALLED_DB_DIR + '/' + name + '): ' + ftpErr(e) + '. Its FTP server may not reach the system folders.' };
      }
    }
    const rows = (file, sql) => {
      const db = new sq.DatabaseSync(path.join(tmp, file), { readOnly: true });
      try { const st = db.prepare(sql); st.setReadBigInts(true); return st.all().map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))); }
      finally { db.close(); }
    };
    let appRows, dlcRows = [];
    try { appRows = rows('appinfo.db', "SELECT titleId, key, val FROM tbl_appinfo WHERE key IN ('TITLE','TITLE_01','CONTENT_ID','CONTENT_VERSION','APP_VER','VERSION','#_size','#_install_time','_org_path','_metadata_path')"); }
    catch (e) { return { status: 502, error: 'the console\'s list of installed titles is not in a form this understands: ' + e.message }; }
    if (fs.existsSync(path.join(tmp, 'addcont.db'))) { try { dlcRows = rows('addcont.db', 'SELECT * FROM addcont'); } catch {} }
    const games = installedFromRows(appRows, dlcRows);
    // Installed updates: the patch folder beside each storage's app folder, looked at once per storage, then per game found there.
    const roots = [...new Set(games.map(g => g.orgPath.replace(/\/app\/[^/]+$/, '')).filter(r => r && !r.includes('/app/')))];
    const gameOf = new Map(games.map(g => [g.titleId, g]));
    let looked = 0;
    for (const root of roots) {
      let ents;
      try { ents = await ftpList(prof, ftpSafeRel(root + '/patch')); } catch { continue; }
      for (const e of ents) {
        const g = gameOf.get(e.name);
        if (!g || !e.isDir || looked++ > 300) continue;
        try {
          const inside = await ftpList(prof, ftpSafeRel(root + '/patch/' + e.name));
          const pkg = inside.find(x => x.name === 'patch.pkg');
          if (pkg) g.update = { size: pkg.size || 0, storage: storageOf(root + '/') };
        } catch {}
      }
    }
    iconPaths.set(prof.id, new Map(games.filter(g => g.icon).map(g => [g.titleId, g.icon])));
    const lib = libraryVersions();
    for (const g of games) {
      const b = lib.get(g.titleId);
      if (b && g.version && compareVersions(b.version, g.version) > 0) g.newerInLibrary = b;
      delete g.orgPath;
    }
    return { result: { at: Date.now(), console: prof.name, games, dlcCount: games.reduce((n, g) => n + g.dlc.length, 0) } };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

// ---- Routes --------------------------------------------------------------
// All under /api/ftp/*, clearly namespaced so they can never be confused with
// the local /api/* routes above (which stay completely untouched by this file).
async function handleFtpRoute(req, res, url, p) {
  const bad = (status, error) => { sendJson(res, status, { error }); return true; };

  if (req.method === 'GET' && p === '/api/ftp/list') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const rel = ftpSafeRel(url.searchParams.get('path') || '');
    if (rel === null) return bad(403, FTP_LEAVES_MSG);
    try {
      const entries = await ftpList(prof, rel);
      sendJson(res, 200, { path: rel, entries });
      return true;
    } catch (e) { return bad(FTP_RECONNECT_CODES.has(e && e.code) ? 409 : 502, `could not list it: ${ftpErr(e)}`); }
  }

  // Whether this console's FTP port is a zftpd, and the drives it reports (see zftpdProbe). `refresh=1` asks again.
  if (req.method === 'GET' && p === '/api/ftp/zftpd') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    // Serial, not Promise.all: the banner check's raw TCP connection can drop the
    // probe's HTTP request when both hit the console's single port at once, which
    // then caches a false "not present" for a minute.
    const z = await zftpdProbe(prof, !!url.searchParams.get('refresh'));
    const ftpZftpd = await ftpBannerIsZftpd(prof);
    sendJson(res, 200, { ...z, ftpZftpd });
    return true;
  }

  // Whether this zftpd console has an optical drive at all (so the page can hide Eject on a Digital Edition one).
  // Asked once, when a row first needs to know, not on every probe.
  if (req.method === 'GET' && p === '/api/ftp/disc') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/system/disc', 3000);
    sendJson(res, 200, { present: !!(r && r.ok && r.present) });
    return true;
  }

  // Ejects the disc on a zftpd console (zftpd's own /api/system/eject). Confirmed zftpd first, so this is never
  // sent to a port that merely happens to answer HTTP. A deliberate, console-facing action: the page only ever
  // calls this on a press.
  if (req.method === 'POST' && p === '/api/ftp/eject') {
    const got = await readJson(req, 1 << 12);
    if (got.error) return bad(got.status, got.error);
    const prof = findFtpSource(got.body.src);
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd');
    // A plain POST here is deliberately turned away by zftpd's own CSRF protection, which only a real browser
    // session (its own web UI) can satisfy — the same protection its docs describe for every POST once upload
    // support is on. ShadowPKG does not try to obtain or forge that token: it relays whatever zftpd actually
    // said, rather than reporting "did not answer" for a console that, in fact, refused on purpose.
    await sleep(300);
    let r = await httpJsonAny(prof.ftpHost, prof.ftpPort || 2121, '/api/system/eject', 8000, 'POST');
    if (!r) { await sleep(800); r = await httpJsonAny(prof.ftpHost, prof.ftpPort || 2121, '/api/system/eject', 8000, 'POST'); }
    if (!r) return bad(502, 'the console did not answer');
    if (r.status === 200 && r.json) { sendJson(res, 200, r.json); return true; }
    const reason = r.json && r.json.error ? r.json.error : `HTTP ${r.status}`;
    return bad(409, `the console refused: ${reason}${r.status === 403 ? ' (this zftpd build only allows Eject from its own web page, not from another program)' : ''}`);
  }

  // A short on-screen message on a zftpd console (zftpd's own /api/notify), for trying it by hand — the same call
  // a finished build already makes automatically (see toastConsoles). At most 180 characters, the same limit
  // toastText keeps builds to; zftpd's own limit is 1023 bytes.
  if (req.method === 'POST' && p === '/api/ftp/notify') {
    const got = await readJson(req, 1 << 12);
    if (got.error) return bad(got.status, got.error);
    const prof = findFtpSource(got.body.src);
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd');
    const text = toastText('ShadowPKG', String(got.body.text || 'Hello from ShadowPKG').trim() || 'Hello from ShadowPKG');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/notify?text=' + encodeURIComponent(text), 5000);
    if (!r) return bad(502, 'the console did not answer');
    sendJson(res, 200, r);
    return true;
  }

  // Streams a ZIP of one or more paths on a zftpd console straight through — zftpd builds it while it sends, so
  // nothing is written on the console and ShadowPKG holds nothing of it either; the bytes pass through unchanged.
  // {src, path:[...], name?}. Confirmed zftpd first, same as every other zftpd-only route.
  if (req.method === 'GET' && p === '/api/ftp/zip') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const paths = url.searchParams.getAll('path').map(ftpSafeRel).filter(r => r !== null && r !== '');
    if (!paths.length) return bad(400, 'pick at least one file or folder');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd');
    await sleep(300);      // see zftpdGetAfterAnother: a request made right after the probe's own can be dropped
    const qs = paths.map(r => 'path=' + encodeURIComponent(ftpPathOf(r))).join('&') + '&name=' + encodeURIComponent(String(url.searchParams.get('name') || 'zftpd.zip'));
    const upstream = http.request({ host: prof.ftpHost, port: prof.ftpPort || 2121, path: '/api/archive/zip?' + qs, method: 'GET', timeout: 6 * 60 * 60 * 1000 }, up => {
      if (up.statusCode !== 200) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `the console answered ${up.statusCode}` })); up.resume(); return; }
      const headers = { 'Content-Type': up.headers['content-type'] || 'application/zip' };
      if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
      if (up.headers['content-disposition']) headers['Content-Disposition'] = up.headers['content-disposition'];
      else headers['Content-Disposition'] = `attachment; filename="${String(url.searchParams.get('name') || 'zftpd.zip').replace(/["\\]/g, '_')}"`;
      res.writeHead(200, headers);
      up.pipe(res);
    });
    upstream.on('error', e => { if (!res.headersSent) sendJson(res, 502, { error: `could not reach the console: ${e.message}` }); else res.destroy(); });
    upstream.on('timeout', () => upstream.destroy());
    req.on('close', () => upstream.destroy());
    upstream.end();
    return true;
  }

  // One installed title's icon, from the cache, a library or the console (see installedIcon). `v` is the install stamp, in the
  // address so a new install is a new address and the browser may keep each for a week.
  if (req.method === 'GET' && p === '/api/ftp/icon') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const r = await installedIcon(prof, url.searchParams.get('title') || '', url.searchParams.get('v'));
    if (r.error) return bad(404, r.error);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': r.png.length, 'Cache-Control': (ACCESS_PASSWORD ? 'private' : 'public') + ', max-age=604800', 'X-Icon-From': r.from });
    res.end(r.png);
    return true;
  }

  // What the console has installed: games, their DLC and whether an update is installed (see installedOnConsole).
  if (req.method === 'GET' && p === '/api/ftp/installed') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const hit = installedCache.get(prof.id);
    if (hit && !url.searchParams.get('refresh') && Date.now() - hit.at < INSTALLED_KEEP_MS) { sendJson(res, 200, { ...hit.result, cached: true }); return true; }
    const r = await installedOnConsole(prof);
    if (r.error) return bad(r.status, r.error);
    installedCache.set(prof.id, { at: Date.now(), result: r.result });
    sendJson(res, 200, r.result);
    return true;
  }

  // Uninstall a game. zftpd's games admin API is tried first; when its helper
  // cannot complete the uninstall (the ShellCore-privilege gap on a Relapse
  // loader), fall back to the DPI payload's GET /uninstall?title_id= on the
  // console's installer host, which escalates its own privileges and works.
  if (req.method === 'POST' && p === '/api/ftp/games/uninstall') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 14);
    if (got.error) return bad(got.status, got.error);
    const titleId = String((got.body && got.body.titleId) || '').trim().toUpperCase();
    if (!/^[A-Z]{4}\d{5}$/.test(titleId)) return bad(400, 'a valid title id is required (like CUSA12345 or PPSA12345)');

    const z = await zftpdProbe(prof);
    if (z.present) {
      const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/admin/games/uninstall?id=' + encodeURIComponent(titleId), 30000);
      if (r && r.ok) { sendJson(res, 200, r); return true; }
    }

    if (prof.host) {
      try {
        const dr = await ps5Request(prof.host, 'GET', '/uninstall?title_id=' + encodeURIComponent(titleId), null, 30000);
        if (dr) {
          const text = String(dr.body || '').trim();
          const ok = dr.status === 200 && !/FAILED/i.test(text);
          sendJson(res, 200, { ok, message: ok ? `Uninstalled ${titleId}` : (text.slice(0, 300) || 'the installer refused the uninstall'), via: 'dpi' });
          return true;
        }
      } catch (e) { /* the DPI is not loaded — fall through to the error below */ }
    }

    return bad(502, 'the console could not uninstall through zftpd, and the DPI installer is not answering — load the DPI payload and try again');
  }

  // Launch an installed game on a zftpd console (its games admin API /api/admin/launch).
  if (req.method === 'POST' && p === '/api/ftp/games/launch') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 14);
    if (got.error) return bad(got.status, got.error);
    const titleId = String((got.body && got.body.titleId) || '').trim().toUpperCase();
    if (!/^[A-Z]{4}\d{5}$/.test(titleId)) return bad(400, 'a valid title id is required (like CUSA12345 or PPSA12345)');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer, which is what launches games — load the zhttp build and try again');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/admin/launch?id=' + encodeURIComponent(titleId), 30000);
    if (!r) return bad(502, 'the console did not answer the launch request');
    sendJson(res, 200, r);
    return true;
  }

  // Repair titles that installed but don't show on the home screen (zftpd's
  // /api/admin/games/repair_visibility). No titleId repairs every missing title.
  if (req.method === 'POST' && p === '/api/ftp/games/repair') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 14);
    if (got.error) return bad(got.status, got.error);
    const titleId = String((got.body && got.body.titleId) || '').trim().toUpperCase();
    if (titleId && !/^[A-Z]{4}\d{5}$/.test(titleId)) return bad(400, 'a valid title id is required (like CUSA12345 or PPSA12345)');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer, which is what repairs — load the zhttp build and try again');
    const path = '/api/admin/games/repair_visibility' + (titleId ? '?id=' + encodeURIComponent(titleId) : '');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, path, 30000);
    if (!r) return bad(502, 'the console did not answer the repair request');
    sendJson(res, 200, r);
    return true;
  }

  // Console health (CPU temperature, RAM, uptime) and the DNS filter, all zftpd-HTTP.
  // One combined read powers the "System" panel; the fan is deliberately absent because
  // zftpd's /api/admin/fan opens a Linux-only /dev/icc_fan device, so it can't run on a console.
  if (req.method === 'GET' && p === '/api/ftp/system') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer, which is what reports its health — load the zhttp build and try again');
    const port = prof.ftpPort || 2121;
    const [sys, ram, dns] = await Promise.all([
      zftpdGetAfterAnother(prof.ftpHost, port, '/api/stats/system', 4000),
      zftpdGetAfterAnother(prof.ftpHost, port, '/api/stats/ram', 4000),
      zftpdGetAfterAnother(prof.ftpHost, port, '/api/dns/status', 4000),
    ]);
    sendJson(res, 200, { sys: sys || null, ram: ram || null, dns: dns || null });
    return true;
  }

  // Toggle zftpd's built-in DNS filter (telemetry/ad blocking on the console itself).
  if (req.method === 'POST' && p === '/api/ftp/dns') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 14);
    if (got.error) return bad(got.status, got.error);
    const enable = !!(got.body && got.body.enable);
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer — load the zhttp build and try again');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, enable ? '/api/dns/enable' : '/api/dns/disable', 8000, 'POST');
    if (!r) return bad(502, 'the console did not answer the DNS request');
    sendJson(res, 200, r);
    return true;
  }

  // ---- Save-data backups (console <-> this server) -------------------------------
  if (req.method === 'GET' && p === '/api/ftp/saves') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const s = await listConsoleSaves(prof);
    if (s.error) return bad(502, s.error);
    sendJson(res, 200, s);
    return true;
  }

  if (req.method === 'POST' && p === '/api/ftp/saves/backup') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 12);
    if (got.error) return bad(got.status, got.error);
    const uid = String((got.body && got.body.uid) || '').toLowerCase();
    const kind = String((got.body && got.body.kind) || '');
    const titleId = String((got.body && got.body.titleId) || '').toUpperCase();
    if (!SAVE_UID_RE.test(uid)) return bad(400, 'a valid user id is required');
    if (!SAVE_KINDS.includes(kind)) return bad(400, 'a valid save kind is required (savedata or savedata_prospero)');
    if (!SAVE_TITLE_RE.test(titleId)) return bad(400, 'a valid title id is required (like CUSA12345)');
    const r = await backupSave(prof, uid, kind, titleId);
    if (r.error) return bad(502, r.error);
    sendJson(res, 200, r);
    return true;
  }

  if (req.method === 'POST' && p === '/api/ftp/saves/restore') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const got = await readJson(req, 1 << 12);
    if (got.error) return bad(got.status, got.error);
    const id = String((got.body && got.body.id) || '');
    const backup = readSaveMeta(id);
    if (!backup) return bad(404, 'no such backup');
    const r = await restoreSave(prof, backup);
    if (r.error) return bad(502, r.error);
    sendJson(res, 200, r);
    return true;
  }

  // zftpd's disk usage tree (what is using the console's storage), the current
  // install's progress, and a folder's size — the last of the useful HTTP features.
  if (req.method === 'GET' && p === '/api/ftp/disktree') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer — load the zhttp build and try again');
    const qp = String(url.searchParams.get('path') || '');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/disk/tree' + (qp ? '?path=' + encodeURIComponent(qp) : ''), 8000);
    if (!r) return bad(502, 'the console did not answer the disk-tree request');
    sendJson(res, 200, r);
    return true;
  }

  if (req.method === 'GET' && p === '/api/ftp/install_status') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer — load the zhttp build and try again');
    const id = String(url.searchParams.get('id') || '');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/admin/games/install_status' + (id ? '?id=' + encodeURIComponent(id) : ''), 6000);
    if (!r) return bad(502, 'the console did not answer the install-status request');
    sendJson(res, 200, r);
    return true;
  }

  if (req.method === 'GET' && p === '/api/ftp/dirsize') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const z = await zftpdProbe(prof);
    if (!z.present) return bad(409, 'this console is not running zftpd with its HTTP layer — load the zhttp build and try again');
    const qp = String(url.searchParams.get('path') || '');
    if (!qp) return bad(400, 'a path is required');
    const r = await zftpdGetAfterAnother(prof.ftpHost, prof.ftpPort || 2121, '/api/dirsize?path=' + encodeURIComponent(qp), 20000);
    if (!r) return bad(502, 'the console did not answer the size request');
    sendJson(res, 200, r);
    return true;
  }

  if (req.method === 'POST' && p === '/api/ftp/mkdir') {
    const got = await readJson(req, 1 << 16);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const prof = findFtpSource(body.src);
    if (!prof) return bad(404, 'FTP console not found');
    const dirRel = ftpSafeRel(body.path || '');
    if (dirRel === null) return bad(403, FTP_LEAVES_MSG);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return bad(400, 'give it a name');
    if (/[\\/]/.test(name) || name === '.' || name === '..' || FTP_CONTROL_CHAR.test(name)) return bad(400, 'a name only — no folders, and no control characters');
    const newRel = dirRel ? `${dirRel}/${name}` : name;
    try {
      await withFtp(prof, client => client.send(`MKD ${ftpPathOf(newRel)}`));
      return sendJson(res, 200, { ok: true, path: newRel });
    } catch (e) { return bad(FTP_RECONNECT_CODES.has(e && e.code) ? 409 : 502, `could not create it: ${ftpErr(e)}`); }
  }

  if (req.method === 'POST' && p === '/api/ftp/rename') {
    const got = await readJson(req, 1 << 16);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const prof = findFtpSource(body.src);
    if (!prof) return bad(404, 'FTP console not found');
    const rel = ftpSafeRel(body.path || '');
    if (rel === null || rel === '') return bad(403, rel === '' ? "the connection's own root cannot be renamed" : FTP_LEAVES_MSG);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return bad(400, 'give it a name');
    if (/[\\/]/.test(name) || name === '.' || name === '..' || FTP_CONTROL_CHAR.test(name)) return bad(400, 'a name only — no folders, and no control characters');
    if (isFtpSystemBlocked(rel)) return bad(403, FTP_SYSTEM_BLOCKED_MSG);
    if (isFtpTopLevel(rel) && !body.confirmTopLevel) return bad(409, FTP_TOPLEVEL_MSG);
    const parent = ftpParentOf(rel);
    const newRel = parent ? `${parent}/${name}` : name;
    try {
      await withFtp(prof, client => client.rename(ftpPathOf(rel), ftpPathOf(newRel)));
      return sendJson(res, 200, { ok: true, path: newRel });
    } catch (e) { return bad(FTP_RECONNECT_CODES.has(e && e.code) ? 409 : 502, `could not rename it: ${ftpErr(e)}`); }
  }

  // Uploads FROM a local library file TO this FTP console — chosen over accepting
  // an arbitrary browser-uploaded stream because the app's own use case is "push
  // what's already in a library to this console", the same job the DPI send does
  // for a non-FTP console, and it avoids a second, unrelated file-upload surface
  // (multipart parsing, disk quota for a staged temp file) for a first pass. A
  // straight browser-to-console upload is not offered yet; see the report.
  if (req.method === 'POST' && p === '/api/ftp/upload') {
    const got = await readJson(req, 1 << 16);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const prof = findFtpSource(body.ftpSrc);
    if (!prof) return bad(404, 'FTP console not found');
    const destDir = ftpSafeRel(body.ftpPath || '');
    if (destDir === null) return bad(403, FTP_LEAVES_MSG);
    const localSrc = findSource(body.src);
    if (!localSrc) return bad(404, 'library not found');
    const localRaw = typeof body.path === 'string' ? body.path : '';
    const at = await locate(localSrc, localRaw);
    if (at.error) return bad(at.status, at.error);
    if (at.outside) return bad(403, LEAVES_MSG);
    let st;
    try { st = await fsp.stat(at.full); } catch { return bad(404, 'not found'); }
    if (!st.isFile()) return bad(400, 'only a single file can be sent this way — pick a package or other file, not a folder');
    const rawName = typeof body.ftpName === 'string' && body.ftpName.trim() ? body.ftpName.trim() : path.basename(at.full);
    if (/[\\/]/.test(rawName) || FTP_CONTROL_CHAR.test(rawName)) return bad(400, 'a name only — no folders, and no control characters');
    const destRel = destDir ? `${destDir}/${rawName}` : rawName;
    try {
      await withFtp(prof, client => client.uploadFrom(at.full, ftpPathOf(destRel)), FTP_TRANSFER_TIMEOUT_MS);
      return sendJson(res, 200, { ok: true, path: destRel, size: st.size });
    } catch (e) { return bad(FTP_RECONNECT_CODES.has(e && e.code) ? 409 : 502, `could not send it: ${ftpErr(e)}`); }
  }

  // Streams a remote file straight back to the browser (a save-as, or opening it
  // directly) rather than into a chosen local library — simpler, and matches
  // what a person doing this from a phone or a browser actually wants first; FTP
  // is directly navigable — the point of exposing it at all. Downloading INTO a
  // local library is not offered yet; see the report.
  if (req.method === 'GET' && p === '/api/ftp/download') {
    const prof = findFtpSource(url.searchParams.get('src'));
    if (!prof) return bad(404, 'FTP console not found');
    const rel = ftpSafeRel(url.searchParams.get('path') || '');
    if (rel === null || rel === '') return bad(403, rel === '' ? 'pick a file, not the root' : FTP_LEAVES_MSG);
    try {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${ftpNameOf(rel).replace(/["\\]/g, '_')}"` });
      await withFtp(prof, client => client.downloadTo(res, ftpPathOf(rel)), FTP_TRANSFER_TIMEOUT_MS);   // basic-ftp ends `res` itself once the transfer completes
      return true;
    } catch (e) {
      if (res.headersSent) { res.destroy(); return true; }
      return bad(FTP_RECONNECT_CODES.has(e && e.code) ? 409 : 502, `could not read it: ${ftpErr(e)}`);
    }
  }

  if (req.method === 'POST' && p === '/api/ftp/delete/preview') {
    const got = await readJson(req, 1 << 20);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const asked = Array.isArray(body.items) ? body.items.slice(0, BATCH_ITEMS_MAX) : [];
    if (!asked.length) return bad(400, 'nothing selected');
    const results = [];
    let totalFiles = 0, totalDirs = 0, totalBytes = 0, anyTruncated = false;
    for (const it of asked) {
      const push = (patch) => results.push({ src: it && it.src, path: it && it.path, ...patch });
      const prof = findFtpSource(it && it.src);
      if (!prof) { push({ error: 'FTP console not found' }); continue; }
      const rel = ftpSafeRel(it && it.path);
      if (rel === null) { push({ error: FTP_LEAVES_MSG }); continue; }
      if (rel === '') { push({ error: "the connection's own root cannot be deleted here" }); continue; }
      let entries;
      try { entries = await ftpList(prof, ftpParentOf(rel)); }
      catch (e) { push({ error: `could not read it: ${ftpErr(e)}` }); continue; }
      const self = entries.find(e => e.name === ftpNameOf(rel));
      if (!self) { push({ error: 'not found' }); continue; }
      const blocked = isFtpSystemBlocked(rel);
      if (self.isLink) { results.push({ src: it.src, path: rel, link: true, files: 1, dirs: 0, bytes: self.size || 0, systemBlocked: blocked }); totalFiles++; totalBytes += self.size || 0; continue; }
      if (!self.isDir) { results.push({ src: it.src, path: rel, files: 1, dirs: 0, bytes: self.size || 0, systemBlocked: blocked }); totalFiles++; totalBytes += self.size || 0; continue; }
      const w = await ftpWalk(prof, rel);
      if (w.abort) { push({ error: w.abort }); continue; }
      const nestedBlocked = ftpNestedBlockedName(w);
      results.push({ src: it.src, path: rel, folder: true, files: w.files.length, dirs: w.dirs.length - 1, bytes: w.bytes, truncated: w.truncated, topLevel: isFtpTopLevel(rel), systemBlocked: blocked, ...(nestedBlocked ? { suspiciousNested: true, suspiciousNestedPath: nestedBlocked } : {}) });
      totalFiles += w.files.length; totalDirs += w.dirs.length - 1; totalBytes += w.bytes;
      if (w.truncated) anyTruncated = true;
    }
    return sendJson(res, 200, { items: results, totalFiles, totalDirs, totalBytes, anyTruncated });
  }

  if (req.method === 'POST' && p === '/api/ftp/delete') {
    const got = await readJson(req, 1 << 20);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const asked = Array.isArray(body.items) ? body.items.slice(0, BATCH_ITEMS_MAX) : [];
    if (!asked.length) return bad(400, 'nothing selected');
    const deleted = [], failed = [];
    for (const it of asked) {
      const prof = findFtpSource(it && it.src);
      if (!prof) { failed.push({ src: it && it.src, path: it && it.path, error: 'FTP console not found' }); continue; }
      // The single-item delete itself — see deleteFtpOne, which IS this route's
      // logic, pulled out so Move (in the transfers feature) can call the exact
      // same function for its source-removal step rather than a second one.
      const r = await deleteFtpOne(prof, it && it.path, it && it.confirmTopLevel);
      if (!r.ok) {
        failed.push({ src: it.src, path: it.path, error: r.error, ...(r.partial ? { partial: true, removedFiles: r.removedFiles, removedDirs: r.removedDirs } : {}) });
        continue;
      }
      deleted.push({ src: it.src, ...r.entry });
    }
    return sendJson(res, 200, { deleted, failed });
  }

  return false;
}

// ---- Copy and Move: any combination of local library and FTP-connected console -
// A background JOB, modeled on the same shape builds/extractions already use (a
// Map of id -> job, a queue run one at a time, a *View()/*sView() pair polled from
// GET /api/downloads) so the client's existing bar/row rendering is reused, not
// reinvented. See the spec's "Safety invariants for Move" — restated here in code:
//
//   1. The source is NEVER touched until every file that belongs to this transfer
//      has been copied AND independently verified (size always; checksum too, if
//      asked for). Verification happens per file, inside copyLocalToLocal /
//      copyLocalToFtp / copyFtpToLocal / copyFtpToFtp below — each one THROWS
//      before returning if its own file's destination size (or hash) doesn't
//      match, and the loop in runXferJob stops at the first failure.
//   2. Only once that loop has gone through every file in `files` with nothing
//      thrown does runXferJob reach its "Move: EVERY file..." block, and that is
//      the ONLY place in this whole feature that removes anything from a source —
//      by calling deleteLocalOne() or deleteFtpOne(), the exact same functions
//      /api/delete and /api/ftp/delete themselves call per item. There is no
//      second deletion mechanism anywhere in this file.
//   3. A cancelled or failed job takes the `if (job.cancelled) ... return` or
//      `if (!ok) ... return` branch in runXferJob, both of which return BEFORE
//      that Move block — a source is provably never removed on those paths.
//   4. Every per-file copy writes to a `.shadowpkg-xfer-<id>.tmp` file (local
//      side) or is verified against a real directory listing (FTP side) before
//      being renamed/counted as done; a failure at any point unlinks its own
//      temp file and leaves the destination exactly as it was for that one file.
const xfers = new Map();          // id -> job (kept separate from `transfers`, the PS5-download map above, on purpose)
const xferQueue = [];
let xferRunning = false;
const XFER_DIR_ENTRIES_MAX = DELETE_WALK_ENTRIES, XFER_WALK_MS = DELETE_WALK_MS;

// Read-only, local: every file and directory under `rootFull`, relative to it
// ('' is the root itself). Never opens, never deletes — the same walking shape as
// walkForDelete's phase 1, but nothing here is a guard against anything; the
// guards (untouchable/locate) already ran on the root before this is called, and
// run again on the DESTINATION side by localDestDir. Symlinks are skipped
// entirely (not copied) rather than guessed about.
async function listLocalTree(rootFull) {
  const files = [], dirs = [''];
  let bytes = 0, truncated = false, seen = 0;
  const started = Date.now();
  const todo = [{ full: rootFull, rel: '' }];
  while (todo.length) {
    if (Date.now() - started > XFER_WALK_MS) { truncated = true; break; }
    const { full, rel } = todo.pop();
    let entries;
    try { entries = await fsp.readdir(full, { withFileTypes: true }); }
    catch (e) { return { abort: `could not read ${rel || 'it'}: ${fsErr(e)}` }; }
    for (const e of entries) {
      if (seen++ > XFER_DIR_ENTRIES_MAX) { truncated = true; break; }
      const eRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;        // links are not transferred by this feature
      const eFull = path.join(full, e.name);
      if (e.isDirectory()) { dirs.push(eRel); todo.push({ full: eFull, rel: eRel }); continue; }
      if (!e.isFile()) continue;
      let st; try { st = await fsp.lstat(eFull); } catch { continue; }
      files.push({ rel: eRel, full: eFull, size: st.size });
      bytes += st.size;
    }
    if (truncated) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  if (truncated) return { abort: 'too large to transfer in one go; move what is inside it in smaller pieces first' };
  return { files, dirs, bytes, truncated };
}

// Read-only, over FTP: the same shape as ftpWalk (see above), but keeping each
// file's size — ftpWalk (used only by delete) does not need per-file sizes, so a
// second, equally read-only lister is used here rather than changing the
// hardened delete one. Never deletes, never touches deleteFtpOne/deleteLocalOne.
async function ftpWalkForXfer(prof, rootRel) {
  const files = [], dirs = [rootRel], links = [];
  let bytes = 0, truncated = false;
  const todo = [rootRel];
  while (todo.length) {
    const here = todo.pop();
    let entries;
    try { entries = await ftpList(prof, here); }
    catch (e) { return { abort: `could not read everything inside it: ${ftpErr(e)}` }; }
    for (const e of entries) {
      if (files.length + dirs.length + links.length > FTP_DELETE_WALK_MAX_ENTRIES) { truncated = true; break; }
      if (e.isLink) { links.push(e.path); continue; }
      if (e.isDir) { dirs.push(e.path); todo.push(e.path); continue; }
      files.push({ path: e.path, size: e.size || 0 }); bytes += e.size || 0;
    }
    if (truncated) break;
  }
  return { files, dirs, links, bytes, truncated };
}

// {rel, name} of the local free name in `dir` that is not taken, starting from
// `name` and adding " (2)", " (3)", ... before the extension — same convention as
// freeName()/stemOf() elsewhere in this file, generalized to keep any extension.
async function localFreeName(dir, name) {
  const exists = n => fsp.lstat(path.join(dir, n)).then(() => true, () => false);
  if (!(await exists(name))) return name;
  const dot = name.lastIndexOf('.');
  for (let i = 2; ; i++) {
    const n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    if (!(await exists(n))) return n;
  }
}
async function ftpFreeName(prof, dirRel, name) {
  let entries = []; try { entries = await ftpList(prof, dirRel); } catch { return name; }
  const taken = new Set(entries.map(e => e.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  for (let i = 2; ; i++) {
    const n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    if (!taken.has(n)) return n;
  }
}

// SHA-256 of a local file, read fresh from disk (never reused from a copy's
// in-flight hash) — used only when the caller opted into checksum verify.
async function sha256File(full) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(full, { highWaterMark: 1 << 20 });
    rs.on('data', c => hash.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}
// SHA-256 of a remote file, read fresh over FTP on `client` (the job's own
// dedicated connection, never the shared pool) — never buffers the file whole.
async function ftpSha256(client, rel) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const sink = new Writable({ write(chunk, enc, cb) { hash.update(chunk); cb(); } });
    client.downloadTo(sink, ftpPathOf(rel)).then(() => resolve(hash.digest('hex'))).catch(reject);
  });
}

// Reads a small text file from the console into a string, bounded. Used only for a
// console's own known config file (ps5-tailscale's config.json), never for a path a
// request supplies.
async function ftpReadText(prof, rel, maxBytes = 65536) {
  return withFtp(prof, client => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const sink = new Writable({
      write(chunk, enc, cb) {
        size += chunk.length;
        if (size > maxBytes) { reject(Object.assign(new Error('file too large'), { code: 'ETOOBIG' })); return; }
        chunks.push(chunk); cb();
      }
    });
    client.downloadTo(sink, ftpPathOf(rel)).then(() => resolve(Buffer.concat(chunks).toString('utf8'))).catch(reject);
  }), FTP_OP_TIMEOUT_MS);
}

// A fresh, private basic-ftp connection for one job's duration — see the spec:
// "every transfer job gets its OWN dedicated FTP connection(s), never the shared
// pooled browsing connection" (withFtp/ftpConns above), so a large transfer can
// never block ordinary browsing or another short operation on the same console.
async function openJobFtpClient(prof) {
  const client = new ftpClient.Client(FTP_CONNECT_TIMEOUT_MS);
  client.ftp.verbose = false;
  await client.access(ftpOptsFor(prof));
  return client;
}

function bumpXferSpeed(job) {
  const now = Date.now();
  if (!job._samples) job._samples = [[now, 0]];
  const last = job._samples[job._samples.length - 1];
  if (now - last[0] >= 1000) { job._samples.push([now, job.bytesDone]); if (job._samples.length > 30) job._samples.shift(); }
}

// ---- Per-combination copy of ONE file, always ending in real verification ------
// Every one of these four throws (never resolves) when its destination's size (or,
// with verify:'checksum', its hash) does not match the source — that throw is what
// stops runXferJob's loop before the source is ever touched. `base` is job.bytesDone
// as it stood before this file started, so progress adds up across a whole folder.

// A destination write never appears under its REAL name until it is verified —
// local or FTP alike — so a corrupted, partial or cancelled transfer can never be
// mistaken, in a later listing, for a real (but silently broken) file sitting
// where the real name would be trusted. Hidden (dot-prefixed), the same
// convention the text-save feature's own scratch file already uses (see
// scratchName() near /api/text/save) — every local listing already filters a
// leading-dot name out (browse, the main list, /api/properties's folder walk),
// so a leftover from a hard kill shows up as nothing at all, not as a mystery
// file. A bare ".tmp" SUFFIX on the real name (what an earlier version of this
// file did) is NOT hidden by any of those filters — this is a real fix, not
// cosmetic.
const xferTmpName = (jobId, realName) => `.shadowpkg-xfer-${jobId}-${realName}`;
const ftpTmpRel = (dstRel, jobId) => {
  const parent = ftpParentOf(dstRel), name = xferTmpName(jobId, ftpNameOf(dstRel));
  return parent ? `${parent}/${name}` : name;
};
// Best-effort cleanup of an FTP tmp file, on the POOLED shared connection
// (withFtp) rather than the job's own dedicated one — this runs from a catch
// path where the dedicated connection may already be closed (a cancel, a
// dropped connection), and a short DELE is exactly the kind of quick operation
// the pool exists for. Failure here is swallowed: the tmp name is already
// hidden from every listing, so a cleanup that could not run leaves nothing
// confusing behind, only an invisible, harmless leftover.
async function ftpCleanupTmp(prof, tmpRel) {
  try { await withFtp(prof, client => client.remove(ftpPathOf(tmpRel))); } catch {}
}

// local -> local: an atomic fs.rename when Move can PROVE same device (sameDevice,
// worked out once per job from fs.stat(...).dev on both roots — never guessed), which
// is both the fastest path and, being one atomic syscall, inherently safer than
// copy-then-delete (it can't ever leave a verified-but-undeleted or a deleted-but-
// unverified state). Anything else — Copy, or a cross-device Move, or a same-device
// rename that still somehow reports EXDEV — copies through a temp file, verifies,
// then renames the temp into place; the source file itself is left alone here in
// every case except the same-device Move rename (which is real evidence, not a guess).
// Returns {size, renamed, hash}: `hash` is the confirmed-matching sha256 when
// verify:'checksum' was requested, else null — the caller (runXferJob) keeps
// this alongside the file's REAL destination path so it can re-check that
// exact path (never the tmp name, which no longer exists once this returns)
// one more time, immediately before a Move deletes anything on the source
// side. See the re-verify pass in runXferJob for exactly why: a verify that
// only ever looked at the tmp file, at a moment strictly before the rename
// below, says nothing about what is sitting at the real name by the time the
// source is actually removed — a real, reproduced gap this file's own report
// once treated as closed and was not.
async function copyLocalToLocal(srcFull, dstFull, job, base, sameDevice, isMove) {
  await fsp.mkdir(path.dirname(dstFull), { recursive: true });
  if (isMove && sameDevice) {
    try {
      await serial(() => fsp.rename(srcFull, dstFull));
      const st = await fsp.stat(dstFull);
      job.bytesDone = base + st.size;
      return { size: st.size, renamed: true, hash: null };
    } catch (e) { if (e.code !== 'EXDEV') throw e; }   // fall through to copy+verify on a genuine surprise
  }
  const st = await fsp.stat(srcFull);
  const tmp = path.join(path.dirname(dstFull), xferTmpName(job.id, path.basename(dstFull)));
  try {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(srcFull, { highWaterMark: 1 << 20 });
      const ws = fs.createWriteStream(tmp);
      let done = 0;
      rs.on('data', c => {
        done += c.length; job.bytesDone = base + done; bumpXferSpeed(job);
        if (job.cancelled) { rs.destroy(); ws.destroy(); reject(Object.assign(new Error('cancelled'), { cancelled: true })); }
      });
      rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
      rs.pipe(ws);
    });
  } catch (e) { try { await fsp.unlink(tmp); } catch {} throw e; }
  const outSt = await fsp.stat(tmp).catch(() => null);
  if (!outSt || outSt.size !== st.size) {
    try { await fsp.unlink(tmp); } catch {}
    throw Object.assign(new Error(`size mismatch after copy (${outSt ? outSt.size : 0} of ${st.size} bytes)`), { code: 'VERIFY_FAILED' });
  }
  let hash = null;
  if (job.verify === 'checksum') {
    const [a, b] = await Promise.all([sha256File(srcFull), sha256File(tmp)]);
    if (a !== b) { try { await fsp.unlink(tmp); } catch {} throw Object.assign(new Error('checksum mismatch after copy'), { code: 'VERIFY_FAILED' }); }
    hash = a;
  }
  await serial(() => fsp.rename(tmp, dstFull));
  job.bytesDone = base + outSt.size;
  return { size: outSt.size, renamed: false, hash };
}

// local -> FTP: generalizes /api/ftp/upload — real byte progress via basic-ftp's
// trackProgress (not fire-and-wait), and works for one file of a folder walk too.
// Uploads to a hidden tmp name first, verifies, THEN renames to the real
// destination name — a corrupted/cancelled/dropped upload never appears under
// its real name at all, on the FTP console any more than it would locally.
async function copyLocalToFtp(srcFull, dstClient, dstProf, dstRel, job, base) {
  const st = await fsp.stat(srcFull);
  const tmpRel = ftpTmpRel(dstRel, job.id);
  const rs = fs.createReadStream(srcFull, { highWaterMark: 1 << 20 });
  dstClient.trackProgress(info => { job.bytesDone = base + info.bytes; bumpXferSpeed(job); if (job.cancelled) { try { dstClient.close(); } catch {} } });
  try { await dstClient.uploadFrom(rs, ftpPathOf(tmpRel)); }
  catch (e) { await ftpCleanupTmp(dstProf, tmpRel); throw e; }
  finally { dstClient.trackProgress(); }
  const parentEntries = await dstClient.list(ftpPathOf(ftpParentOf(tmpRel)));
  const found = parentEntries.find(e => e.name === ftpNameOf(tmpRel));
  if (!found || found.size !== st.size) {
    await ftpCleanupTmp(dstProf, tmpRel);
    throw Object.assign(new Error(`size mismatch after upload (${found ? found.size : 0} of ${st.size} bytes)`), { code: 'VERIFY_FAILED' });
  }
  let hash = null;
  if (job.verify === 'checksum') {
    const [srcHash, dstHash] = await Promise.all([sha256File(srcFull), ftpSha256(dstClient, tmpRel)]);
    if (srcHash !== dstHash) { await ftpCleanupTmp(dstProf, tmpRel); throw Object.assign(new Error('checksum mismatch after upload'), { code: 'VERIFY_FAILED' }); }
    hash = srcHash;
  }
  await dstClient.rename(ftpPathOf(tmpRel), ftpPathOf(dstRel));
  return { size: st.size, hash };
}

// FTP -> local: new — pulls straight into a chosen local library path, server-side
// (not a round trip through the browser the way the existing raw download link works).
async function copyFtpToLocal(srcClient, srcRel, dstFull, job, base, expectedSize) {
  await fsp.mkdir(path.dirname(dstFull), { recursive: true });
  const tmp = path.join(path.dirname(dstFull), xferTmpName(job.id, path.basename(dstFull)));
  const ws = fs.createWriteStream(tmp);
  srcClient.trackProgress(info => { job.bytesDone = base + info.bytes; bumpXferSpeed(job); if (job.cancelled) { try { srcClient.close(); } catch {} } });
  try { await srcClient.downloadTo(ws, ftpPathOf(srcRel)); }
  catch (e) { try { await fsp.unlink(tmp); } catch {} throw e; }
  finally { srcClient.trackProgress(); }
  const outSt = await fsp.stat(tmp).catch(() => null);
  if (!outSt || (Number.isFinite(expectedSize) && outSt.size !== expectedSize)) {
    try { await fsp.unlink(tmp); } catch {}
    throw Object.assign(new Error(`size mismatch after download (${outSt ? outSt.size : 0} of ${expectedSize} bytes)`), { code: 'VERIFY_FAILED' });
  }
  let hash = null;
  if (job.verify === 'checksum') {
    const [srcHash, dstHash] = await Promise.all([ftpSha256(srcClient, srcRel), sha256File(tmp)]);
    if (srcHash !== dstHash) { try { await fsp.unlink(tmp); } catch {} throw Object.assign(new Error('checksum mismatch after download'), { code: 'VERIFY_FAILED' }); }
    hash = srcHash;
  }
  await serial(() => fsp.rename(tmp, dstFull));
  return { size: outSt.size, hash };
}

// FTP -> FTP: no FXP (most networks block it, and it is not attempted) — the
// server relays, streamed through a PassThrough that is never allowed to fill up
// with a whole file (backpressure couples the download side to the upload side),
// on two connections dedicated to this job (source console, dest console — even
// when they are the same console: uploadFrom and downloadTo each need their own
// command channel at once). Genuinely the slowest path, two network hops through
// this server — never oversold as fast. Same hidden-tmp-then-rename discipline
// as copyLocalToFtp: a dropped connection on either side, or a failed verify,
// never leaves anything under the real destination name.
async function copyFtpToFtp(srcClient, srcRel, dstClient, dstProf, dstRel, job, base, expectedSize) {
  const tmpRel = ftpTmpRel(dstRel, job.id);
  const pass = new PassThrough({ highWaterMark: 1 << 20 });
  const abortBoth = () => { try { srcClient.close(); } catch {} try { dstClient.close(); } catch {} };
  srcClient.trackProgress(info => { job.bytesDone = base + info.bytes; bumpXferSpeed(job); if (job.cancelled) abortBoth(); });
  const downloadP = srcClient.downloadTo(pass, ftpPathOf(srcRel)).finally(() => srcClient.trackProgress());
  const uploadP = dstClient.uploadFrom(pass, ftpPathOf(tmpRel));
  try { await Promise.all([downloadP, uploadP]); }
  catch (e) { abortBoth(); await ftpCleanupTmp(dstProf, tmpRel); throw e; }
  const parentEntries = await dstClient.list(ftpPathOf(ftpParentOf(tmpRel)));
  const found = parentEntries.find(e => e.name === ftpNameOf(tmpRel));
  if (!found || (Number.isFinite(expectedSize) && found.size !== expectedSize)) {
    await ftpCleanupTmp(dstProf, tmpRel);
    throw Object.assign(new Error(`size mismatch after relay (${found ? found.size : 0} of ${expectedSize} bytes)`), { code: 'VERIFY_FAILED' });
  }
  let hash = null;
  if (job.verify === 'checksum') {
    const [srcHash, dstHash] = await Promise.all([ftpSha256(srcClient, srcRel), ftpSha256(dstClient, tmpRel)]);
    if (srcHash !== dstHash) { await ftpCleanupTmp(dstProf, tmpRel); throw Object.assign(new Error('checksum mismatch after relay'), { code: 'VERIFY_FAILED' }); }
    hash = srcHash;
  }
  await dstClient.rename(ftpPathOf(tmpRel), ftpPathOf(dstRel));
  return { size: found.size, hash };
}

// ---- Resolving the request's src/dst into something safe to act on -------------
// The SOURCE item itself (a file or folder to transfer): validated with the same
// locate()/untouchable() guards local delete/rename already use, or the same
// ftpSafeRel()/isFtpSystemBlocked() guards the FTP module already uses — nothing
// new is invented here. A Copy from an FTP top-level item is allowed (it is only a
// read); Move's eventual deletion of a top-level FTP source is gated by
// deleteFtpOne() itself, exactly as it already is for /api/ftp/delete.
async function resolveXferSource(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'no source given' };
  if (raw.kind === 'local') {
    const src = findSource(raw.srcId);
    if (!src) return { error: 'library not found' };
    const at = await locate(src, typeof raw.path === 'string' ? raw.path : '');
    if (at.error) return { error: at.error };
    if (at.outside) return { error: LEAVES_MSG };
    if (at.rel === '') return { error: "a library's root cannot be transferred" };
    const barred = await untouchable(src, at, 'transferred', {});
    if (barred) return { error: barred.error };
    return { kind: 'local', src, rel: at.rel, full: at.full, name: at.names[at.names.length - 1] || path.basename(at.full) };
  }
  if (raw.kind === 'ftp') {
    const prof = findFtpSource(raw.srcId);
    if (!prof) return { error: 'FTP console not found' };
    const rel = ftpSafeRel(typeof raw.path === 'string' ? raw.path : '');
    if (rel === null) return { error: FTP_LEAVES_MSG };
    if (rel === '') return { error: "the connection's own root cannot be transferred" };
    if (isFtpSystemBlocked(rel)) return { error: FTP_SYSTEM_BLOCKED_MSG };
    return { kind: 'ftp', prof, rel, name: ftpNameOf(rel) };
  }
  return { error: "src.kind must be 'local' or 'ftp'" };
}

// The DESTINATION folder the item is placed into (keeping its own name, same
// convention /api/ftp/upload already uses with ftpName/basename).
async function localDestDir(src, raw) {
  const at = await locate(src, raw);
  if (at.error) return { error: at.error };
  if (at.outside) return { error: LEAVES_MSG };
  const barred = await untouchable(src, at, 'written into', {});
  if (barred) return { error: barred.error };
  let st;
  try { st = await fsp.stat(at.full); } catch { return { error: 'destination folder not found' }; }
  if (!st.isDirectory()) return { error: 'destination is not a folder' };
  return { full: at.full, rel: at.rel };
}
async function ftpDestDir(prof, raw) {
  const rel = ftpSafeRel(raw);
  if (rel === null) return { error: FTP_LEAVES_MSG };
  if (rel !== '') {
    if (isFtpSystemBlocked(rel)) return { error: FTP_SYSTEM_BLOCKED_MSG };
    let entries;
    try { entries = await ftpList(prof, ftpParentOf(rel)); } catch (e) { return { error: `could not read the destination: ${ftpErr(e)}` }; }
    const self = entries.find(e => e.name === ftpNameOf(rel));
    if (!self || !self.isDir) return { error: 'destination folder not found' };
  }
  return { rel };
}
async function resolveXferDestDir(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'no destination given' };
  if (raw.kind === 'local') {
    const src = findSource(raw.srcId);
    if (!src) return { error: 'library not found' };
    const r = await localDestDir(src, typeof raw.path === 'string' ? raw.path : '');
    if (r.error) return { error: r.error };
    return { kind: 'local', src, rel: r.rel, full: r.full };
  }
  if (raw.kind === 'ftp') {
    const prof = findFtpSource(raw.srcId);
    if (!prof) return { error: 'FTP console not found' };
    const r = await ftpDestDir(prof, typeof raw.path === 'string' ? raw.path : '');
    if (r.error) return { error: r.error };
    return { kind: 'ftp', prof, rel: r.rel };
  }
  return { error: "dst.kind must be 'local' or 'ftp'" };
}

// Counts and sizes a source, unchanged — the preview a folder transfer's
// confirmation dialog shows before the job starts (same spirit as /api/delete/preview).
// The other volumes of a multi-part .rar whose first volume is `ep`, as library-relative paths, or [] when
// it is not one. The list shows a set as its first volume, so a Move or Copy of that row has to carry the
// rest along: moved alone, the first would leave the others behind with nothing to open them.
function otherVolumesOf(ep) {
  if (ep.kind !== 'local' || !/\.rar$/i.test(ep.full) || isLaterVolume(ep.full)) return [];
  const vols = volumesFor(ep.full);
  if (!vols) return [];
  const me = path.basename(ep.full).toLowerCase();
  return vols.filter(v => path.basename(v).toLowerCase() !== me).map(v => path.relative(ep.src.root, v).split(path.sep).join('/'));
}

async function transferPreview(ep) {
  if (ep.kind === 'local') {
    let st;
    try { st = await fsp.lstat(ep.full); } catch { return { error: 'not found' }; }
    if (st.isSymbolicLink()) return { error: 'a symlink or junction cannot be transferred' };
    if (!st.isDirectory()) {
      const others = otherVolumesOf(ep);
      let bytes = st.size;
      for (const rel of others) { try { bytes += (await fsp.stat(path.join(ep.src.root, ...rel.split('/')))).size; } catch {} }
      return { files: 1 + others.length, dirs: 0, bytes, folder: false, ...(others.length ? { set: 1 + others.length } : {}) };
    }
    const walk = folderContents(ep.src, ep.full, foldCase(ep.full));
    if (!walk) return { error: 'busy, try again' };
    const counted = await walk;
    if (counted.error) return { error: `could not read it: ${counted.error}` };
    return { files: counted.files, dirs: counted.dirs, bytes: counted.bytes, folder: true, truncated: !!counted.truncated };
  }
  let entries;
  try { entries = await ftpList(ep.prof, ftpParentOf(ep.rel)); } catch (e) { return { error: `could not read it: ${ftpErr(e)}` }; }
  const self = entries.find(e => e.name === ftpNameOf(ep.rel));
  if (!self) return { error: 'not found' };
  if (self.isLink) return { error: 'a link cannot be transferred' };
  if (!self.isDir) return { files: 1, dirs: 0, bytes: self.size || 0, folder: false };
  const w = await ftpWalkForXfer(ep.prof, ep.rel);
  if (w.abort) return { error: w.abort };
  return { files: w.files.length, dirs: w.dirs.length - 1, bytes: w.bytes, folder: true, truncated: w.truncated };
}

function touchLocalAfterXfer(src) { listRev++; saveMetaSoon(); buildList(src, true); }

// ---- The job itself --------------------------------------------------------------
function endXfer(job, state, message, results) {
  job.state = state; job.endedAt = Date.now(); job.phase = state === 'done' ? 'done' : job.phase;
  job.message = message;
  if (state === 'failed') job.error = message;
  if (results) job.results = results;
}

// ---- Copying on a zftpd console itself ------------------------------------------------------------------------
// When both ends of a copy or move are folders on the same console and its FTP port is a zftpd, the console is asked to
// copy by itself (zftpd's CPFR then CPTO): the data never leaves the console, so it goes as fast as its disks allow
// rather than down one FTP connection and up another. zftpd answers at once ("Copy started in background") and says
// nothing more, so ShadowPKG watches the destination until every file is there at its exact size, and for a move only
// then removes the source, after the same re-check a move always gets. A copy that stops growing for two minutes is
// reported as failed with the source untouched. Size only: a checksum copy still goes the long way.
const ZFTPD_COPY_STALL_MS = Number(process.env.ZFTPD_COPY_STALL_MS) || 120000;
let ZFTPD_COPY = !/^(0|false|no|off)$/i.test(process.env.ZFTPD_COPY || '');
// What the destination holds now, as { rel -> size } (rel '' for a single file); empty while it is not there yet.
async function destSizes(prof, dstTopRel, folder) {
  const have = new Map();
  try {
    if (!folder) {
      const e = (await ftpList(prof, ftpParentOf(dstTopRel))).find(x => x.name === ftpNameOf(dstTopRel) && !x.isDir);
      if (e) have.set('', e.size || 0);
    } else {
      const w = await ftpWalkForXfer(prof, dstTopRel);
      if (!w.abort) for (const x of w.files) have.set(x.path === dstTopRel ? '' : x.path.slice(dstTopRel.length + 1), x.size);
    }
  } catch {}
  return have;
}
// Asks the console to start the copy; throws if it refuses (the long way is then used instead).
function zftpdStartCopy(prof, srcRel, dstTopRel) {
  return withFtp(prof, async client => {
    await client.send('CPFR ' + ftpPathOf(srcRel));
    await client.send('CPTO ' + ftpPathOf(dstTopRel));
  }, 30000);
}
// Waits until the copy is complete: every wanted file there at its size, twice running. -> { verified } or throws.
async function zftpdWaitCopy(job, prof, files, dirs, dstTopRel, folder) {
  const want = new Map(files.map(x => [x.rel, x.size]));
  const every = Math.min(10000, 1500 + files.length * 8);
  let last = -1, changed = Date.now(), stable = 0;
  for (;;) {
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    await sleep(every);
    const have = await destSizes(prof, dstTopRel, folder);
    let bytes = 0, exact = 0;
    for (const [rel, size] of want) { const h = have.get(rel); bytes += Math.min(h || 0, size); if (h === size) exact++; }
    job.bytesDone = bytes; job.filesDone = exact;
    if (bytes !== last) { last = bytes; changed = Date.now(); stable = 0; }
    if (exact === want.size) {
      if (++stable >= 2) {
        // Folders that hold no file are made too, so a move does not lose an empty one.
        if (folder) for (const d of dirs) { if (d) { try { await withFtp(prof, c => c.send('MKD ' + ftpPathOf(dstTopRel + '/' + d))); } catch {} } }
        return { verified: files.map(x => ({ dstFull: null, dstRel: x.rel ? dstTopRel + '/' + x.rel : dstTopRel, size: x.size, hash: null })) };
      }
    } else if (Date.now() - changed > ZFTPD_COPY_STALL_MS) {
      throw new Error(`the console stopped copying after ${exact} of ${want.size} file(s) (${fmtGb(bytes)} of ${fmtGb(job.bytesTotal)}); what it wrote is still there at the destination, and the source was left untouched`);
    }
  }
}

async function runXferJob(job) {
  const srcEp = job._srcEp, dstEp = job._dstEp;
  job.phase = 'counting';
  let files, dirs = [''], bytesTotal = 0, folder = false;

  if (srcEp.kind === 'local') {
    let st;
    try { st = await fsp.lstat(srcEp.full); } catch { return endXfer(job, 'failed', 'source no longer exists'); }
    if (st.isSymbolicLink()) return endXfer(job, 'failed', 'a symlink or junction cannot be transferred');
    if (st.isDirectory()) {
      folder = true;
      const w = await listLocalTree(srcEp.full);
      if (w.abort) return endXfer(job, 'failed', w.abort);
      files = w.files; dirs = w.dirs; bytesTotal = w.bytes;
    } else {
      files = [{ rel: '', full: srcEp.full, size: st.size }];
      bytesTotal = st.size;
    }
  } else {
    let entries;
    try { entries = await ftpList(srcEp.prof, ftpParentOf(srcEp.rel)); } catch (e) { return endXfer(job, 'failed', `could not read the source: ${ftpErr(e)}`); }
    const self = entries.find(e => e.name === ftpNameOf(srcEp.rel));
    if (!self) return endXfer(job, 'failed', 'source no longer exists');
    if (self.isLink) return endXfer(job, 'failed', 'a link cannot be transferred');
    if (self.isDir) {
      folder = true;
      const w = await ftpWalkForXfer(srcEp.prof, srcEp.rel);
      if (w.abort) return endXfer(job, 'failed', w.abort);
      const strip = p => p === srcEp.rel ? '' : p.slice(srcEp.rel.length + 1);
      files = w.files.map(f => ({ rel: strip(f.path), ftpRel: f.path, size: f.size }));
      dirs = w.dirs.map(strip);
      bytesTotal = w.bytes;
    } else {
      files = [{ rel: '', ftpRel: srcEp.rel, size: self.size || 0 }];
      bytesTotal = self.size || 0;
    }
  }

  job.filesTotal = files.length;
  job.bytesTotal = bytesTotal;

  // The top-level destination name, resolved ONCE against the overwrite policy —
  // a nested name inside a fresh (or deliberately overwritten) destination folder
  // is not asked about a second time; see the report for why this is a deliberate
  // simplification, not an oversight.
  const baseName = job.name;
  let destName = baseName;
  if (dstEp.kind === 'local') {
    const already = await fsp.lstat(path.join(dstEp.full, baseName)).then(s => s, () => null);
    if (already) {
      if (job.overwrite === 'skip') return endXfer(job, 'done', `skipped: "${baseName}" already exists at the destination`, [{ path: baseName, status: 'skipped', why: 'already exists at the destination' }]);
      if (job.overwrite === 'rename') destName = await localFreeName(dstEp.full, baseName);
    }
  } else {
    let entries = [];
    try { entries = await ftpList(dstEp.prof, dstEp.rel); } catch {}
    if (entries.some(e => e.name === baseName)) {
      if (job.overwrite === 'skip') return endXfer(job, 'done', `skipped: "${baseName}" already exists at the destination`, [{ path: baseName, status: 'skipped', why: 'already exists at the destination' }]);
      if (job.overwrite === 'rename') destName = await ftpFreeName(dstEp.prof, dstEp.rel, baseName);
    }
  }
  const dstTopFull = dstEp.kind === 'local' ? path.join(dstEp.full, destName) : null;
  const dstTopRel = dstEp.kind === 'local' ? null : (dstEp.rel ? `${dstEp.rel}/${destName}` : destName);

  // Refuse a folder transfer whose destination is inside the very folder being
  // transferred (local -> local only — the one case this process can actually
  // prove, by comparing real paths) before a single byte moves.
  if (folder && srcEp.kind === 'local' && dstEp.kind === 'local') {
    const a = foldCase(srcEp.full), b = foldCase(dstTopFull);
    if (b === a || within(a, b)) return endXfer(job, 'failed', 'the destination is inside the folder being transferred, so this was refused before anything was copied');
  }

  let sameDevice = false;
  if (srcEp.kind === 'local' && dstEp.kind === 'local') {
    try {
      const [a, b] = await Promise.all([fsp.stat(srcEp.src.root), fsp.stat(dstEp.src.root)]);
      sameDevice = a.dev === b.dev;
    } catch {}
  }

  // Both ends on one zftpd console: let the console copy by itself (see zftpdWaitCopy).
  let fast = false;
  if (ZFTPD_COPY && srcEp.kind === 'ftp' && dstEp.kind === 'ftp' && srcEp.prof.id === dstEp.prof.id && job.verify !== 'checksum'
      && !(folder && (dstTopRel === srcEp.rel || dstTopRel.startsWith(srcEp.rel + '/')))) {
    try {
      if ((await zftpdProbe(srcEp.prof)).present) { await zftpdStartCopy(srcEp.prof, srcEp.rel, dstTopRel); fast = true; job.serverSide = true; }
    } catch (e) { console.log(`transfer ${job.name}: the console would not copy by itself (${ftpErr(e)}), copying through ShadowPKG instead`); }
  }

  job.phase = 'copying';
  let srcClient = null, dstClient = null;
  try {
    if (srcEp.kind === 'ftp' && !fast) srcClient = await openJobFtpClient(srcEp.prof);
    if (dstEp.kind === 'ftp') dstClient = await openJobFtpClient(dstEp.prof);
  } catch (e) {
    return endXfer(job, 'failed', `could not connect: ${ftpErr(e)}`);
  }

  // A folder landing on an FTP destination needs its whole directory tree
  // created there first — unlike a local destination (mkdir'd per file, on
  // demand, by copyLocalToLocal/copyFtpToLocal), basic-ftp's uploadFrom does
  // NOT create missing parent directories on STOR. MKD every directory this
  // transfer will need, shallowest first, before a single file is uploaded;
  // "already exists" (550) is fine (another job or a retry got there first),
  // anything else fails the job before any file is touched.
  if (folder && dstEp.kind === 'ftp' && !fast) {
    const dirRels = [dstTopRel, ...dirs.slice(1).map(d => `${dstTopRel}/${d}`)].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const d of dirRels) {
      try { await dstClient.send(`MKD ${ftpPathOf(d)}`); }
      catch (e) {
        const already = /^55\d/.test(String(e && e.code || '')) || /exists/i.test(String(e && e.message || ''));
        if (!already) {
          if (srcClient) try { srcClient.close(); } catch {}
          try { dstClient.close(); } catch {}
          return endXfer(job, 'failed', `could not create the destination folder "${d}" on the FTP console: ${ftpErr(e)}`);
        }
      }
    }
  }

  const results = [];
  // Every file's REAL destination path, plus what its verify (right after its
  // own rename) confirmed — size always, hash when verify:'checksum' asked for
  // it. Kept so it can be checked ONE MORE TIME, immediately before a Move
  // deletes anything on the source side — see the re-verify pass below for why
  // this second look is not optional. `dstFull`/`dstRel` here is always the
  // file's REAL name (never a tmp name — every tmp file has already been
  // renamed away, successfully, by the time its entry lands in this list).
  const verified = [];
  let ok = true;
  try {
    if (fast) {
      try {
        const r = await zftpdWaitCopy(job, srcEp.prof, files, dirs, dstTopRel, folder);
        verified.push(...r.verified);
        results.push({ path: baseName, status: 'done', bytes: bytesTotal });
      } catch (e) {
        if (!(job.cancelled || (e && e.cancelled))) { results.push({ path: baseName, status: 'failed', why: String(e && e.message || e) }); }
        ok = false;
      }
    }
    for (const f of (fast ? [] : files)) {
      if (job.cancelled) { ok = false; break; }
      const base = job.bytesDone;
      const relPath = f.rel;
      let dFull = null, dRel = null;
      try {
        let outcome;
        if (srcEp.kind === 'local' && dstEp.kind === 'local') {
          dFull = relPath ? path.join(dstTopFull, ...relPath.split('/')) : dstTopFull;
          outcome = await copyLocalToLocal(f.full, dFull, job, base, sameDevice, job.kind === 'move');
        } else if (srcEp.kind === 'local' && dstEp.kind === 'ftp') {
          dRel = relPath ? `${dstTopRel}/${relPath}` : dstTopRel;
          outcome = await copyLocalToFtp(f.full, dstClient, dstEp.prof, dRel, job, base);
        } else if (srcEp.kind === 'ftp' && dstEp.kind === 'local') {
          dFull = relPath ? path.join(dstTopFull, ...relPath.split('/')) : dstTopFull;
          outcome = await copyFtpToLocal(srcClient, f.ftpRel, dFull, job, base, f.size);
        } else {
          dRel = relPath ? `${dstTopRel}/${relPath}` : dstTopRel;
          outcome = await copyFtpToFtp(srcClient, f.ftpRel, dstClient, dstEp.prof, dRel, job, base, f.size);
        }
        results.push({ path: relPath || baseName, status: 'done', bytes: outcome.size });
        verified.push({ dstFull: dFull, dstRel: dRel, size: outcome.size, hash: outcome.hash || null });
        job.filesDone++;
        job.bytesDone = base + outcome.size;
      } catch (e) {
        if (job.cancelled || (e && e.cancelled)) { ok = false; break; }
        results.push({ path: relPath || baseName, status: 'failed', why: e && e.code === 'VERIFY_FAILED' ? e.message : (e && (e.code || /ftp|closed|control socket/i.test(String(e.message))) ? ftpErr(e) : fsErr(e)) });
        ok = false;
        break;   // all-or-nothing: one failure anywhere in the tree stops the whole job; nothing on the source side is ever touched
      }
    }
  } finally {
    if (srcClient) try { srcClient.close(); } catch {}
    // dstClient stays open a little longer, ONLY for a Move that got through
    // every file with nothing thrown — the re-verify pass right below needs it
    // (list/hash the FTP destination one more time); every other path closes
    // it here, same as before.
    if (dstClient && !(ok && !job.cancelled && job.kind === 'move')) { try { dstClient.close(); } catch {} }
  }
  job.results = results;

  if (job.cancelled) {
    if (dstClient) try { dstClient.close(); } catch {}
    return endXfer(job, 'cancelled', job.filesDone
      ? `cancelled after ${job.filesDone} of ${job.filesTotal} file(s); nothing on the source was removed`
      : 'cancelled; nothing was transferred and nothing on the source was removed');
  }
  if (!ok) {
    if (dstClient) try { dstClient.close(); } catch {}
    return endXfer(job, 'failed',
      `stopped after ${job.filesDone} of ${job.filesTotal} file(s) copied and verified — the source was left untouched: ${results.length ? results[results.length - 1].why : 'transfer failed'}`);
  }

  // Every file in `files` copied AND was independently verified (size, or
  // checksum when asked for) — see the per-combination copy functions above,
  // each of which throws before this point is reachable if its own file's
  // verification did not pass. A Copy is done right here. A Move goes on to
  // the re-verify pass below before it removes anything.
  if (job.kind === 'copy') {
    if (dstClient) try { dstClient.close(); } catch {}
    if (dstEp.kind === 'local') touchLocalAfterXfer(dstEp.src);
    return endXfer(job, 'done', `copied ${job.filesDone} file(s), ${fmtGb(job.bytesTotal)}, verified by ${job.verify === 'checksum' ? 'checksum' : 'size'}${fast ? ', copied on the console itself' : ''}`);
  }

  // ---- Re-verify every REAL-named destination, ONE MORE TIME, right here ----
  // A reproduced, real gap: each copy function above verifies the TMP file,
  // strictly BEFORE renaming it to its real name — that rename is the last
  // thing each of them does before returning. Nothing until now had looked at
  // the file again, under its real name, after that rename. A second process,
  // another transfer, anything that touches that real path in the window
  // between the rename and the source being deleted was invisible: the job
  // would still report a clean "verified" success and delete a source whose
  // copy might, by the time of deletion, no longer match anything that was
  // actually checked. This pass closes exactly that window: every file this
  // job wrote is re-stat'd (size, always) and, if verify:'checksum' was asked
  // for, re-hashed — at its REAL name, not the tmp name (which no longer
  // exists by this point in every case; re-checking it would prove nothing
  // about the file a person would actually see). The FIRST mismatch, missing
  // file, or read error found here stops the whole job before deleteLocalOne
  // or deleteFtpOne is ever called — same all-or-nothing spirit as everywhere
  // else in this feature: one bad file refuses the entire delete-source step,
  // not just that one file.
  job.phase = 'verifying-destination';
  let reverifyErr = null;
  for (const v of verified) {
    try {
      if (dstEp.kind === 'local') {
        const st = await fsp.stat(v.dstFull);
        if (st.size !== v.size) { reverifyErr = `${path.basename(v.dstFull)}: its size changed after it was verified (now ${st.size}, was ${v.size} bytes)`; break; }
        if (v.hash) {
          const h = await sha256File(v.dstFull);
          if (h !== v.hash) { reverifyErr = `${path.basename(v.dstFull)}: its checksum changed after it was verified`; break; }
        }
      } else {
        const parentEntries = await dstClient.list(ftpPathOf(ftpParentOf(v.dstRel)));
        const found = parentEntries.find(e => e.name === ftpNameOf(v.dstRel));
        if (!found) { reverifyErr = `${ftpNameOf(v.dstRel)}: it is no longer at the destination (it was, right after it was verified)`; break; }
        if (found.size !== v.size) { reverifyErr = `${ftpNameOf(v.dstRel)}: its size changed after it was verified (now ${found.size}, was ${v.size} bytes)`; break; }
        if (v.hash) {
          const h = await ftpSha256(dstClient, v.dstRel);
          if (h !== v.hash) { reverifyErr = `${ftpNameOf(v.dstRel)}: its checksum changed after it was verified`; break; }
        }
      }
    } catch (e) {
      reverifyErr = `${v.dstFull ? path.basename(v.dstFull) : ftpNameOf(v.dstRel)}: could not be re-checked (${dstEp.kind === 'local' ? fsErr(e) : ftpErr(e)})`;
      break;
    }
  }
  if (dstClient) try { dstClient.close(); } catch {}
  if (reverifyErr) {
    return endXfer(job, 'failed', `the destination changed after it was verified, so the source was not removed: ${reverifyErr}`);
  }

  job.phase = 'deleting-source';
  if (srcEp.kind === 'local') {
    // A same-device Move may already have moved SOME or ALL of the source away
    // via the fs.rename fast path in copyLocalToLocal — an atomic OS move IS the
    // safe, verified removal for that file, not a copy awaiting a separate
    // delete. If the top-level source item no longer exists at all (a single
    // file that was entirely renamed away), there is nothing left for
    // deleteLocalOne to do, and calling it on a path that is correctly already
    // gone would only report a spurious "not found" failure for a transfer that
    // actually succeeded. If it (or an empty shell of its folder tree, for a
    // folder where only the FILES were renamed away one at a time) still
    // exists, deleteLocalOne runs exactly as it always did, cleaning up
    // whatever is left — real leftover files (the cross-device/copy fallback
    // case) or just the now-empty directories (the same-device fast-path case).
    let stillThere = true;
    try { await fsp.lstat(srcEp.full); } catch { stillThere = false; }
    if (stillThere) {
      const r = await deleteLocalOne(srcEp.src, srcEp.rel, {});
      if (!r.ok) return endXfer(job, 'failed', `copied and verified everything, but could not remove the source: ${r.error}`);
      for (const pkgRel of r.packageRels) { metaCache.delete(`${srcEp.src.id}\n${pkgRel}`); dropHeld(srcEp.src.id, pkgRel); }
    }
    touchLocalAfterXfer(srcEp.src);
  } else {
    const r = await deleteFtpOne(srcEp.prof, srcEp.rel, job.confirmTopLevel);
    if (!r.ok) return endXfer(job, 'failed', `copied and verified everything, but could not remove the source: ${r.error}`);
  }
  if (dstEp.kind === 'local') touchLocalAfterXfer(dstEp.src);
  endXfer(job, 'done', `moved ${job.filesDone} file(s), ${fmtGb(job.bytesTotal)}, verified by ${job.verify === 'checksum' ? 'checksum' : 'size'}${fast ? ' (copied on the console itself)' : ''}, then removed from the source`);
}

async function runNextXfer() {
  if (xferRunning || stopping) return;
  const job = xferQueue.shift();
  if (!job) return;
  xferRunning = true;
  job.state = 'running';
  job.startedAt = Date.now();
  try { await runXferJob(job); }
  catch (e) {
    console.error(`transfer: ${job.name} stopped by an unexpected error: ${e && e.stack || e}`);
    if (job.state === 'running') endXfer(job, 'failed', `stopped by an unexpected error (${String(e && e.message || e).slice(0, 120)}); see the log`);
  }
  finally { xferRunning = false; }
  if (job.state === 'done' || job.state === 'failed') console.log(`transfer ${job.state} ${job.name}: ${job.message}`);
  // An internal, server-started transfer (never a user-facing option) can ask to
  // be told how it went — used to move a scratch-built package back to its real
  // library and only then clean up the scratch copy, never before the move is
  // actually verified done. Errors here are logged, never allowed to break the queue.
  // Awaited: onDone is itself async (moveBuildBackFromScratch's callback does
  // real I/O), and calling an async function never throws synchronously to a
  // plain try/catch — without the await here, a rejection inside it would
  // bypass this catch entirely and surface only as a generic, unattributed
  // "unhandled rejection" instead of the message below.
  if (typeof job.onDone === 'function') { try { await job.onDone(job); } catch (e) { console.error(`transfer onDone for ${job.name}:`, e); } }
  if (!stopping) runNextXfer();
}

function xferView(job) {
  const now = Date.now();
  let speed = 0;
  if (job._samples && job._samples.length && job.state === 'running') {
    const base = job._samples.find(([ts]) => now - ts <= 6000) || job._samples[job._samples.length - 1];
    const dt = (now - base[0]) / 1000;
    if (dt >= 1) speed = Math.max(0, (job.bytesDone - base[1]) / dt);
  }
  const percent = job.bytesTotal ? Math.min(100, Math.floor((job.bytesDone / job.bytesTotal) * 1000) / 10) : (job.state === 'done' ? 100 : 0);
  return {
    id: job.id, kind: job.kind, src: job.src, dst: job.dst, name: job.name,
    state: job.state, phase: job.phase,
    bytesTotal: job.bytesTotal, bytesDone: Math.min(job.bytesDone, job.bytesTotal || job.bytesDone),
    filesTotal: job.filesTotal, filesDone: job.filesDone, percent,
    speed: Math.round(speed), eta: speed > 0 && job.bytesTotal ? Math.round((job.bytesTotal - job.bytesDone) / speed) : null,
    error: job.error || null, message: job.message || null,
    verify: job.verify, overwrite: job.overwrite,
    startedAt: job.startedAt, endedAt: job.endedAt, createdAt: job.createdAt,
    results: job.results && job.results.length ? job.results.slice(-50) : [],
  };
}
// Finished jobs stay in the feed for a while, like finished downloads/extractions do.
function xfersView() {
  const now = Date.now();
  for (const [id, j] of xfers) {
    if ((j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') && now - (j.endedAt || 0) > 10 * 60000) xfers.delete(id);
  }
  return [...xfers.values()].map(xferView).sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
}

// ---- Routes: /api/transfers* -----------------------------------------------------
async function handleTransferRoute(req, res, url, p) {
  const bad = (status, error) => { sendJson(res, status, { error }); return true; };

  if (req.method === 'POST' && p === '/api/transfers/preview') {
    const got = await readJson(req, 1 << 16);
    if (got.error) return bad(got.status, got.error);
    const ep = await resolveXferSource(got.body.src);
    if (ep.error) return bad(400, ep.error);
    const prev = await transferPreview(ep);
    sendJson(res, prev.error ? 400 : 200, prev);
    return true;
  }

  if (req.method === 'POST' && p === '/api/transfers/cancel') {
    let body;
    try { body = parseJsonObject(await readBody(req)); } catch (e) { return bad(400, e && e.notObject ? 'expected a JSON object' : 'invalid JSON'); }
    const job = xfers.get(body.id);
    if (!job) return bad(404, 'transfer not found');
    if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') {
      job.cancelled = true;
      if (job.state === 'queued') {
        const i = xferQueue.indexOf(job); if (i >= 0) xferQueue.splice(i, 1);
        endXfer(job, 'cancelled', 'cancelled before it started');
      }
      // A running job notices job.cancelled at its next chunk/file boundary (see
      // the copy functions above) and stops itself — never here, synchronously,
      // since a copy in flight cannot safely be torn down from outside its own loop.
    }
    sendJson(res, 200, xferView(job));
    return true;
  }

  if (req.method === 'POST' && p === '/api/transfers') {
    const got = await readJson(req, 1 << 16);
    if (got.error) return bad(got.status, got.error);
    const body = got.body;
    const kind = body.kind === 'move' ? 'move' : body.kind === 'copy' ? 'copy' : null;
    if (!kind) return bad(400, "kind must be 'copy' or 'move'");
    const srcEp = await resolveXferSource(body.src);
    if (srcEp.error) return bad(400, srcEp.error);
    const dstEp = await resolveXferDestDir(body.dst);
    if (dstEp.error) return bad(400, dstEp.error);
    if (srcEp.kind === dstEp.kind && (srcEp.kind === 'local' ? srcEp.src.id === dstEp.src.id : srcEp.prof.id === dstEp.prof.id) && srcEp.rel === dstEp.rel) {
      return bad(400, 'source and destination are the same place');
    }
    const verify = body.verify === 'checksum' ? 'checksum' : 'size';
    const overwrite = ['skip', 'overwrite', 'rename'].includes(body.overwrite) ? body.overwrite : 'skip';
    const confirmTopLevel = !!body.confirmTopLevel;

    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id, kind, verify, overwrite, confirmTopLevel,
      src: { kind: srcEp.kind, srcId: body.src.srcId, path: srcEp.rel },
      dst: { kind: dstEp.kind, srcId: body.dst.srcId, path: dstEp.rel },
      name: srcEp.name,
      state: 'queued', phase: 'counting',
      bytesTotal: 0, bytesDone: 0, filesTotal: 0, filesDone: 0,
      error: null, message: null, results: [],
      createdAt: Date.now(), startedAt: null, endedAt: null, cancelled: false,
      _srcEp: srcEp, _dstEp: dstEp,
    };
    xfers.set(id, job);
    xferQueue.push(job);
    // A multi-part set is shown as its first volume; the rest go with it, one job each, queued right behind.
    let also = 0;
    for (const rel of otherVolumesOf(srcEp)) {
      const ep2 = await resolveXferSource({ kind: 'local', srcId: body.src.srcId, path: rel });
      if (ep2.error) { console.log(`transfer of ${srcEp.name}: a volume (${rel}) could not be added - ${ep2.error}`); continue; }
      const id2 = crypto.randomBytes(6).toString('hex');
      const job2 = {
        id: id2, kind, verify, overwrite, confirmTopLevel,
        src: { kind: 'local', srcId: body.src.srcId, path: ep2.rel },
        dst: job.dst, name: ep2.name,
        state: 'queued', phase: 'counting',
        bytesTotal: 0, bytesDone: 0, filesTotal: 0, filesDone: 0,
        error: null, message: null, results: [],
        createdAt: Date.now(), startedAt: null, endedAt: null, cancelled: false,
        _srcEp: ep2, _dstEp: dstEp,
      };
      xfers.set(id2, job2);
      xferQueue.push(job2);
      also++;
    }
    runNextXfer();
    sendJson(res, 200, { ...xferView(job), ...(also ? { alsoQueued: also } : {}) });
    return true;
  }

  return false;
}

// ---- Settings that can be changed from the page ----------------------------------
// The same variables the container is created with, for the ones that can change
// while it runs. A value saved here (settings.app in settings.json) beats the
// environment variable, like the public address already does, and "use the
// environment value" puts the variable back in charge. Each entry says how to
// read the variable, how to check a new value, and how to apply it live - none
// of these needs a restart. What cannot change while running (the folders, the
// port, the password) is listed read-only by fixedSettings() instead.
const envBool = (name, dflt) => { const v = process.env[name]; if (v === undefined || v === '') return dflt; return !/^(0|false|no|off)$/i.test(v); };
const maskUrl = u => { try { const x = new URL(u); return x.protocol + '//' + x.host + '/…'; } catch { return u ? 'set' : ''; } };
const localLibraries = () => SOURCES.filter(x => x.kind !== 'ftp').map(x => ({ id: x.id, label: x.label }));
const NOTIFY_EVENTS = ['builds', 'downloads', 'problems'];
const APP_SETTINGS = [
  { key: 'EXTRACT_PARALLEL', group: 'Extraction and builds', label: 'Extractions at once', kind: 'int', min: 1, max: 8,
    help: 'A RAR unpacks on one core, so a second extraction costs a second core. Keep it low if the archives are on a spinning array, where two readers at once can be slower than one. A job only starts when the room for it is still there.',
    fromEnv: () => Math.max(1, Math.min(8, parseInt(process.env.EXTRACT_PARALLEL || '2', 10) || 2)),
    get: () => EXTRACT_PARALLEL, set: v => { EXTRACT_PARALLEL = v; runNextExtraction(); } },
  { key: 'SCRATCH_LIBRARY', group: 'Extraction and builds', label: 'Scratch library', kind: 'library',
    help: 'A fast local library to unpack a dump into when it is built from inside an archive, so the build reads it from there instead of over a slow share. The package is moved back to sit beside the archive afterwards. Nothing is used when this is empty.',
    fromEnv: () => (process.env.SCRATCH_LIBRARY || '').trim(),
    get: () => SCRATCH_LIBRARY, set: v => { SCRATCH_LIBRARY = v; },
    problem: v => v && !localLibraries().some(l => l.id === v) ? `there is no library called "${v}" here (${localLibraries().map(l => l.id).join(', ') || 'none'})` : '' },
  { key: 'LOW_SPACE_GB', group: 'Library', label: 'Warn below this much free space (GB)', kind: 'number', min: 0, max: 100000,
    help: 'A library with less than this much free gets a quiet warning in Setup. 0 turns the warning off. The figure is what the share reports, so it is a guide.',
    fromEnv: () => { const n = parseFloat(process.env.LOW_SPACE_GB); return Number.isFinite(n) && n >= 0 ? n : 50; },
    get: () => LOW_SPACE_GB, set: v => { LOW_SPACE_GB = v; } },
  { key: 'ALLOW_ANY_FILE', group: 'Library', label: 'Show and serve every file, not just packages', kind: 'bool',
    help: 'Off keeps a library a package list. After changing it, press Refresh in the library so the lists are read again.',
    fromEnv: () => envBool('ALLOW_ANY_FILE', false), get: () => ANY_FILE, set: v => { ANY_FILE = v; listRev++; } },
  { key: 'NOTIFY_URL', group: 'Notifications', label: 'Where to send messages', kind: 'secret',
    help: 'Any URL that accepts a POST (ntfy, a Discord, Slack or Telegram webhook, Home Assistant…). It is never shown again once saved. Remove it to turn messages off, or use the environment value to hand it back to the variable.',
    fromEnv: () => process.env.NOTIFY_URL || '', get: () => NOTIFY_URL,
    set: v => { NOTIFY_URL = v; NOTIFY_FORMAT = notifyFormatOf(NOTIFY_URL, notifyWantFormat); },
    problem: v => v && !/^https?:\/\/[^/\s]+/i.test(v) ? 'that does not look like an http:// or https:// address' : '' },
  { key: 'NOTIFY_ON', group: 'Notifications', label: 'What to send messages about', kind: 'multi', options: NOTIFY_EVENTS,
    help: 'Builds finishing or failing; a long download finishing; a download going quiet part way.',
    fromEnv: () => process.env.NOTIFY_ON === undefined ? 'builds' : process.env.NOTIFY_ON,
    get: () => [...NOTIFY_ON].filter(k => NOTIFY_EVENTS.includes(k)).join(','), set: v => { NOTIFY_ON = notifyOnOf(v); } },
  { key: 'NOTIFY_FORMAT', group: 'Notifications', label: 'Message format', kind: 'select', options: ['auto', 'text', 'json', 'discord', 'slack', 'telegram'],
    help: 'Auto picks from the address; anything unrecognised gets plain text, which is what ntfy wants.',
    fromEnv: () => (process.env.NOTIFY_FORMAT || 'auto').toLowerCase(), get: () => notifyWantFormat,
    set: v => { notifyWantFormat = v; NOTIFY_FORMAT = notifyFormatOf(NOTIFY_URL, v); } },
  { key: 'FOLLOW_MOVES', group: 'Consoles', label: 'Follow a console that moved to another address', kind: 'bool',
    help: 'When a saved console stops answering the app looks for it on your networks, and when an unknown address starts downloading it checks whether it runs an installer. Switch off on a test instance that must not go looking at real consoles.',
    fromEnv: () => envBool('FOLLOW_MOVES', true), get: () => FOLLOW_MOVES, set: v => { FOLLOW_MOVES = v; } },
  { key: 'STORE_LOOKUP', group: 'Advanced', label: 'Look up other releases online', kind: 'bool',
    help: 'In the Change region dialog, a button asks the PlayStation Store which other releases (US, EU, Japan, Asia, Korea) a DLC\'s game has. Only the game\'s concept ID is sent. On by default, and only when the button is pressed; nothing else in the app contacts that site.',
    fromEnv: () => envBool('STORE_LOOKUP', true), get: () => STORE_LOOKUP, set: v => { STORE_LOOKUP = v; } },
  { key: 'ZFTPD_TOAST', group: 'Advanced', label: 'Show a message on a zftpd console when a build finishes', kind: 'bool',
    help: 'A console whose FTP port is a zftpd can show a short on-screen message. When a build finishes or fails one is shown on the console it is being sent to, or on every saved zftpd console. Nothing is sent to a console that is not a zftpd.',
    fromEnv: () => envBool('ZFTPD_TOAST', true), get: () => ZFTPD_TOAST, set: v => { ZFTPD_TOAST = v; } },
  { key: 'ZFTPD_COPY', group: 'Advanced', label: 'Copy and move on a zftpd console by the console itself', kind: 'bool',
    help: 'When both ends of a copy or move are on the same console and its FTP port is a zftpd, the console copies by itself instead of sending the data through this server and back. The result is checked by size before a move removes the source. Switch off to always copy through this server.',
    fromEnv: () => envBool('ZFTPD_COPY', true), get: () => ZFTPD_COPY, set: v => { ZFTPD_COPY = v; } },
  { key: 'LOG_RANGES', group: 'Advanced', label: 'Log every range request', kind: 'bool',
    help: 'A big send is hundreds of ranges, so by default a transfer is logged once when it starts and once when it ends. Turn this on to see each one.',
    fromEnv: () => envBool('LOG_RANGES', false), get: () => LOG_RANGES, set: v => { LOG_RANGES = v; } },
];
const APP_SETTING = new Map(APP_SETTINGS.map(d => [d.key, d]));
const savedApp = () => (settings.app && typeof settings.app === 'object' && !Array.isArray(settings.app)) ? settings.app : {};

// A new value checked against what the setting accepts: {value} or {error}.
function parseAppSetting(d, raw) {
  const bad = error => ({ error });
  switch (d.kind) {
    case 'int': { const n = typeof raw === 'number' ? raw : Number(raw); return Number.isInteger(n) && n >= d.min && n <= d.max ? { value: n } : bad(`${d.label}: a whole number from ${d.min} to ${d.max}.`); }
    case 'number': { const n = typeof raw === 'number' ? raw : Number(raw); return Number.isFinite(n) && n >= d.min && n <= d.max ? { value: n } : bad(`${d.label}: a number from ${d.min} up.`); }
    case 'bool': return typeof raw === 'boolean' ? { value: raw } : bad(`${d.label}: on or off.`);
    case 'select': return d.options.includes(String(raw)) ? { value: String(raw) } : bad(`${d.label}: one of ${d.options.join(', ')}.`);
    case 'multi': {
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/).filter(Boolean);
      return list.every(x => d.options.includes(x)) ? { value: [...new Set(list)].join(',') } : bad(`${d.label}: any of ${d.options.join(', ')}.`);
    }
    case 'library': {
      const v = String(raw || '').trim();
      return !v || localLibraries().some(l => l.id === v) ? { value: v } : bad(`${d.label}: "${v.slice(0, 40)}" is not one of this app's libraries.`);
    }
    case 'secret': {
      const v = String(raw || '').trim();
      return !v || /^https?:\/\/[^/\s]+\S*$/i.test(v) ? { value: v } : bad(`${d.label}: expected an http:// or https:// address, or blank to turn it off.`);
    }
  }
  return bad('unknown setting');
}

// What a saved value says now: applied to the running process. Only saved ones are
// applied at startup - the rest were read from the environment where they are declared.
function applyAppSettings() {
  const saved = savedApp();
  for (const d of APP_SETTINGS) if (d.key in saved) { const p = parseAppSetting(d, saved[d.key]); if (p.error === undefined) d.set(p.value); }
}
applyAppSettings();

function appSettingView(d) {
  const saved = savedApp(), isSaved = d.key in saved;
  const envSet = process.env[d.key] !== undefined && process.env[d.key] !== '';
  const cur = d.get(), envVal = d.fromEnv();
  const show = v => d.kind === 'secret' ? maskUrl(v) : v;
  return {
    key: d.key, group: d.group, label: d.label, kind: d.kind, help: d.help,
    ...(d.min !== undefined ? { min: d.min, max: d.max } : {}),
    ...(d.kind === 'select' || d.kind === 'multi' ? { options: d.options } : {}),
    ...(d.kind === 'library' ? { options: localLibraries() } : {}),
    value: show(cur), envValue: show(envVal), source: isSaved ? 'saved' : envSet ? 'environment' : 'default',
    ...(d.kind === 'secret' ? { isSet: !!cur } : {}),
    problem: (d.problem && d.problem(cur)) || '',
  };
}

// What cannot change while the container runs, with where each value came from.
function fixedSettings() {
  const env = (k, dflt) => process.env[k] !== undefined && process.env[k] !== '' ? { value: process.env[k], source: 'environment' } : { value: dflt, source: 'default' };
  const row = (group, key, label, v, note) => ({ group, key, label, note: note || '', ...v });
  const dt = themeDefault();
  return [
    row('Library', 'ROOT', 'Main library folder', { value: ROOT, source: process.env.ROOT ? 'environment' : 'default' }),
    row('Library', 'ROOT_LABEL', 'Main library name', env('ROOT_LABEL', 'Games'), 'Changing it changes every link handed to a console.'),
    row('Library', 'SOURCES_DIR', 'Extra libraries folder', env('SOURCES_DIR', '/extra-libraries')),
    row('Network', 'PUBLIC_BASE', 'Public address', { value: PUBLIC_BASE() || 'the address you opened the page with', source: settings.publicBase ? 'saved' : PUBLIC_BASE_ENV ? 'environment' : 'default' }, 'Edit it in Setup, under the checks.'),
    row('Network', 'PORT', 'Port', { value: String(PORT), source: process.env.PORT ? 'environment' : 'default' }, 'Set with the WebUI port on the container.'),
    row('Network', 'BIND_ADDRESS', 'Listen on one address only', { value: BIND_ADDRESS || 'all addresses', source: BIND_ADDRESS ? 'environment' : 'default' }),
    row('Network', 'ALLOWED_ORIGINS', 'Extra sites allowed to post', env('ALLOWED_ORIGINS', 'none')),
    row('Consoles', 'PS5_HOST', 'First console (only seeds a fresh install)', env('PS5_HOST', '192.168.1.50:12800'), 'Consoles are managed in the app after that.'),
    row('Appearance', 'DEFAULT_THEME', 'Theme devices start with', { value: dt.id || 'none', source: dt.from === 'setting' ? 'saved' : dt.from === 'env' ? 'environment' : 'default' }, 'Edit it in the Theme window.'),
    row('Security', 'ACCESS_PASSWORD', 'Password for this page', { value: ACCESS_PASSWORD ? 'set' : 'not set', source: ACCESS_PASSWORD ? 'environment' : 'default' }, 'Left out of this window on purpose: changing it wrongly can lock you out.'),
    row('Security', 'ACCESS_USER', 'Password user name', { value: ACCESS_USER, source: process.env.ACCESS_USER ? 'environment' : 'default' }),
    row('Advanced', 'CONFIG_DIR', 'Where settings and state are kept', { value: CONFIG_DIR, source: process.env.CONFIG_DIR ? 'environment' : 'default' }),
    row('Advanced', 'APP_NAME', 'Name of this instance', { value: APP_NAME, source: process.env.APP_NAME ? 'environment' : 'default' }),
  ];
}

const server = http.createServer(async (req, res) => {
  try {
    // A request on a connection that was already open when the stop began would
    // change state after it was written out.
    if (stopping) { res.writeHead(503, { 'Retry-After': '5', 'Connection': 'close' }); return res.end('shutting down\n'); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // For a container health check: answered from memory, with no disk, no
    // console and no library behind it, so it says only that the process is up
    // and its event loop is turning.
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : 'ok');
    }

    // Browsers ask for this on their own; there is no icon to give (the page
    // carries its own), and a line in the log for every visit is noise.
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }

    noteOddHost(req);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const rule = crossSiteRule(req);
      if (rule) {
        logSometimes('xs:' + peerOf(req) + (rule.startsWith('Origin is') ? ':null' : rule.startsWith('Origin ') ? ':origin' : ':fetch'), `refused a cross-site ${req.method} ${p} from ${peerOf(req)}: ${rule}`);
        return sendJson(res, 403, { error: 'cross-site request refused. If you open this page through a proxy or under another name, set PUBLIC_BASE or ALLOWED_ORIGINS to it' });
      }
    }
    if (ACCESS_PASSWORD && !openToAll(req, p)) {
      const got = checkAccess(req);
      if (got !== 'ok') return await refuseAccess(req, res, p, got);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/probe/')) {
      const pr = probes.get(p.split('/')[2] || '');
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (pr) { pr.hits++; pr.ip = ip; }
      console.log(`health check fetched by ${ip} ${req.url}`);
      return sendJson(res, 404, { error: 'health check only — there is no file here' });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/p/')) {
      lastFetch.set((req.socket.remoteAddress || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1'), Date.now());
      const token = p.split('/')[2] || '';
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return sendJson(res, 404, { error: 'not found' });
      const t = decodePkgToken(token);
      return serveFile(req, res, t.src, t.rel);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/files/')) {
      return serveFile(req, res, SOURCES[0], decodeURIComponent(p.slice('/files/'.length)));
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      // no-cache, not no-store: the browser keeps the bytes but must ask
      // first, so an unchanged page costs one small request instead of a
      // full response every load — worth it on a console-adjacent network
      // where phones reload this page a lot. Sent gzipped (about a third of
      // the size) to anything that says it can take it.
      const page = PAGE;
      const gz = !!page.gz && acceptsGzip(req);
      const tag = gz ? page.etagGz : page.etag;
      if (etagMatches(req.headers['if-none-match'], tag)) { res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': tag, 'Vary': 'Accept-Encoding' }); return res.end(); }
      const body = gz ? page.gz : page.plain;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': tag, 'Vary': 'Accept-Encoding',
        'Content-Length': body.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      });
      return res.end(body);
    }

    // The logo easter egg, cut out of the page at startup (see INDEX_HTML). Only ever
    // asked for after ten taps. Already compressed, so sent as it is.
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/egg.gif' && EGG) {
      if (etagMatches(req.headers['if-none-match'], EGG_ETAG)) { res.writeHead(304, { 'ETag': EGG_ETAG }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': EGG.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'ETag': EGG_ETAG });
      return res.end(EGG);
    }

    // Themes: the list, one theme in full, check, install, delete, and a folder theme's pictures and fonts.
    if (p === '/api/themes' || p.startsWith('/api/themes/') || p.startsWith('/themes/')) {
      if (await themeRoute(req, res, p)) return;
    }

    // FTP-connected consoles: its own namespaced routes, own module, own guards —
    // see "---- FTP-connected consoles" above. Never touches SOURCES/findSource()
    // or any local-disk route below.
    if (p === '/api/ftp' || p.startsWith('/api/ftp/')) {
      if (await handleFtpRoute(req, res, url, p)) return;
    }

    // Copy/Move: local<->local, local<->FTP and FTP<->FTP — see "Copy and Move"
    // above. GET /api/downloads carries the running list (the `transfers` array),
    // the same polling the client already does for downloads/extractions/builds.
    if (p === '/api/transfers' || p.startsWith('/api/transfers/')) {
      if (await handleTransferRoute(req, res, url, p)) return;
    }

    if (req.method === 'GET' && p === '/api/browse') {
      try {
        const src = findSource(url.searchParams.get('src'));
        if (!src) return sendJson(res, 404, { error: 'library not found' });
        const dir = url.searchParams.get('dir') || '', others = url.searchParams.get('other') === '1';
        // Listing every file of a folder that a link in the library leads out to would show what is not the library's
        // (the packages-only listing has always been as it was).
        const at = others ? safeDir(src.root, dir) : null;
        if (at && await leavesLibrary(src, at)) return sendJson(res, 403, { error: LEAVES_MSG });
        const r = await browse(src, dir, url.searchParams.get('hidden') === '1', others);
        return r ? sendJson(res, 200, r) : sendJson(res, 403, { error: 'forbidden' });
      } catch (e) {
        return sendJson(res, 404, { error: 'folder not found' });
      }
    }

    if (req.method === 'GET' && p === '/api/list') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const snap = buildList(src, url.searchParams.get('refresh') === '1');
      // The page uses these to say the list is incomplete and to come back for
      // the rest: "building" is the walk, "indexing" is archives still to read,
      // "reading" is packages whose own details have not been read yet.
      // They are in the ETag along with the list's revision, because they are in
      // the body: the same list with a queue one shorter is not "unchanged".
      // Weak, since the gzipped and plain copies are the same answer.
      const tag = `W/"${LIST_BOOT}.${listRev}.${src.id}.${snap.building ? 1 : 0}.${scanQueue.length}.${metaQueue.length}"`;
      const cache = { 'ETag': tag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
      if (etagMatches(req.headers['if-none-match'], tag)) { res.writeHead(304, cache); return res.end(); }
      return sendJson(res, 200, {
        src: src.id, files: listWithMeta(src, snap.files), building: snap.building,
        indexing: scanQueue.length, reading: metaQueue.length, builtAt: snap.builtAt,
      }, cache);
    }

    // Packages that are the same thing more than once, worked out from what the
    // packages say about themselves (so only ones already read count). "same":
    // one content ID and version in several files. "versions": one content ID at
    // several versions, where the older ones are usually not wanted any more.
    // Matching is on the content ID, version and size, never on the bytes, so
    // these are likely copies, not proof of them. src=all looks across every
    // library, and each item says which one it is in.
    // Nothing is deleted here; the page sends what the person ticks to /api/delete.
    if (req.method === 'GET' && p === '/api/duplicates') {
      const wanted = url.searchParams.get('src');
      const libs = wanted === 'all' ? SOURCES : [findSource(wanted)];
      if (!libs[0]) return sendJson(res, 404, { error: 'library not found' });
      let building = false;
      const byId = new Map();
      libs.forEach((src, order) => {
        const snap = buildList(src, false);
        if (snap.building) building = true;
        for (const f of listWithMeta(src, snap.files)) {
          const m = f.meta;
          if (!m || m.tentative || !m.contentId) continue;
          if (!byId.has(m.contentId)) byId.set(m.contentId, []);
          byId.get(m.contentId).push({ src: src.id, lib: src.label, order, path: f.path, name: f.path.split('/').pop(), size: f.size, mtime: f.mtime, version: m.version || null, title: m.title || null, kind: m.kind || null, fromName: m.idFrom === 'name', inArchive: f.path.includes(ARC) });
        }
      });
      const vnum = v => String(v || '').split('.').map(x => parseInt(x, 10) || 0);
      const vcmp = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
      // The one to keep: a real file over one inside an archive, then the first library
      // (the main one, when they are searched together), then the shortest path.
      const keepFirst = (a, b) => (a.inArchive - b.inArchive) || (a.order - b.order) || (a.path.length - b.path.length) || a.path.localeCompare(b.path);
      // Several packages can share one content ID (the themes of a collection, Theme_1 and Theme_2),
      // and then version and content ID say nothing about which are copies. The name does: a number
      // that differs is another package, while a version, an ID, a trailing (2) or "- Copy" is not.
      const nameNumbers = name => {
        const s = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').toLowerCase()
          .replace(/[\s._-]*\bcopy\b[\s._-]*(\(\d+\)|\d+)?\s*$/, '')
          .replace(/\s*\(\d+\)\s*$/, '')
          .replace(/\b[a-z]{2}\d{4}-[a-z]{4}\d{5}_\d\d(?:-[a-z0-9]*)?/g, ' ')       // a content ID
          .replace(/\b[a-z]{4}\d{5}\b/g, ' ')                                        // a title ID
          .replace(/\bv?\d+(?:\.\d+)+\b/g, ' ')                                      // a version
          .replace(/\b[av]\d{4}\b/g, ' ');                                            // A0107, V0100
        return (s.match(/\d+/g) || []).sort().join(',');
      };
      const partsByName = xs => {
        const m = new Map();
        for (const x of xs) { const k = nameNumbers(x.name); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
        const parts = [...m.values()];
        // Two names that differ in a number are two packages only if they are at the same version. At
        // different versions the number is often the version itself (Game v1, Game v2), so those stay together.
        const versionsOf = pt => new Set(pt.map(x => x.version || ''));
        for (let merged = true; merged && parts.length > 1;) {
          merged = false;
          for (let i = 0; i < parts.length && !merged; i++) for (let j = i + 1; j < parts.length && !merged; j++) {
            const vj = versionsOf(parts[j]);
            if (![...versionsOf(parts[i])].some(v => vj.has(v))) { parts[i] = parts[i].concat(parts[j]); parts.splice(j, 1); merged = true; }
          }
        }
        return parts;
      };
      const groups = [];
      for (const [contentId, found] of byId) {
        let items = found;
        if (items.length < 2) continue;
        // Two libraries can be folders of one another, or map one folder twice, and
        // then a single file is listed twice. It is not a copy, and deleting either
        // name deletes it, so the same file is only ever counted once.
        if (new Set(items.map(x => x.src)).size > 1) {
          const ids = await Promise.all(items.map(x => fileIdentity(findSource(x.src), x.path)));
          const seen = new Set();
          items = items.filter((x, i) => {
            if (!ids[i]) return true;
            if (seen.has(ids[i])) return false;
            seen.add(ids[i]);
            return true;
          });
          if (items.length < 2) continue;
        }
        // The list can be minutes old. A file taken away since would leave its twin looking like the extra copy.
        const gone = await Promise.all(items.map(x => x.inArchive ? false : fsp.stat(path.resolve(findSource(x.src).root, x.path)).then(() => false, () => true)));
        items = items.filter((x, i) => !gone[i]);
        if (items.length < 2) continue;
        const parts = partsByName(items);
        for (const part of parts) {
        if (part.length < 2) continue;
        const items = part;
        const newest = items.reduce((v, x) => (vcmp(x.version, v) > 0 ? x.version : v), items[0].version);
        const top = items.filter(x => vcmp(x.version, newest) === 0).sort(keepFirst);
        const keep = top[0];
        const kind = items.every(x => vcmp(x.version, items[0].version) === 0) ? 'same' : 'versions';
        // A game and its update can carry one content ID, and a release can even
        // give a base and its update the same version, so "the same" is not a
        // safe reading unless the sizes agree too. Sizes that differ, or a game
        // beside an update, are shown for a person to look at, and nothing in the
        // group is suggested for deletion. Versions naturally differ in size, but
        // not by half: a big older file beside a much smaller newest one is a base
        // beside its update (a PS5 update can read as a game), and the base is the
        // one that would be ticked. A package that does not say what it is, or
        // whose content ID was only read off its file name, is not trusted either.
        const spread = xs => (Math.max(...xs) - Math.min(...xs)) / Math.max(...xs);
        const mixedKinds = new Set(items.map(x => x.kind).filter(Boolean)).size > 1;
        const sizeMismatch = spread(top.map(x => x.size)) > 0.01 || (kind === 'versions' && items.some(x => x.size > 2 * Math.min(...top.map(t => t.size))));
        const unsure = !mixedKinds && !sizeMismatch && items.some(x => !x.kind || !x.version || x.fromName);
        const check = sizeMismatch || mixedKinds || unsure;
        for (const x of items) {
          x.keep = !check && x === keep;
          // Only an ordinary file can be removed; one inside an archive is part of that archive.
          x.suggest = !check && !x.keep && !x.inArchive;
        }
        items.sort((a, b) => (b.keep - a.keep) || vcmp(b.version, a.version) || keepFirst(a, b));
        for (const x of items) { delete x.order; delete x.fromName; }    // only there to rank the libraries and to judge trust
        groups.push({ contentId, title: items.find(x => x.title)?.title || contentId, kind, ...(parts.length > 1 ? { split: true, label: items[0].name } : {}), ...(sizeMismatch ? { sizeMismatch: true } : {}), ...(mixedKinds ? { mixedKinds: true } : {}), ...(unsure ? { unsure: true } : {}), items, wasted: items.filter(x => x.suggest).reduce((n, x) => n + x.size, 0) });
        }
      }
      groups.sort((a, b) => b.wasted - a.wasted || a.title.localeCompare(b.title));
      return sendJson(res, 200, { groups, wasted: groups.reduce((n, g) => n + g.wasted, 0), building, reading: metaQueue.length, indexing: scanQueue.length });
    }

    if (req.method === 'GET' && p === '/api/sources') {
      loadSources();  // pick up folders mapped since start (they need a container restart anyway)
      publishLibraries();
      return sendJson(res, 200, { sources: SOURCES.map(({ id, label }) => ({ id, label })), ftp: ftpSourcesList(),
        // Told to the client so the library menu can badge it — SCRATCH_LIBRARY
        // is otherwise a silent server setting nothing in the UI ever names.
        ...(SCRATCH_LIBRARY && SOURCES.some(s => s.id === SCRATCH_LIBRARY) ? { scratchLibrary: SCRATCH_LIBRARY } : {}) });
    }

    // Held sends: drop one, or try them now (which asks the installer once).
    if (req.method === 'POST' && p === '/api/held/cancel') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const before = held.length;
      held = held.filter(h => h.id !== body.id);
      if (held.length !== before) saveHeld();
      return sendJson(res, 200, { ok: true, held: heldView() });
    }
    if (req.method === 'POST' && p === '/api/held/now') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const prof = findProfile(body.profile);
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });
      const up = await probeRpi(prof.host, 3000);
      if (!up) return sendJson(res, 200, { ok: false, message: `Remote Package Installer is not answering on ${prof.name}. Open it on the PS4 and try again.` });
      drainHeld(prof.id);        // runs on in the background; the Activity list shows it
      return sendJson(res, 200, { ok: true, message: `Sending what was waiting to ${prof.name}…` });
    }

    if (req.method === 'GET' && p === '/api/downloads') {
      return sendJson(res, 200, downloadsView());
    }

    // The console itself cannot be told to stop — refusing its next range
    // request is what ends this in practice, within however long its own
    // retry interval is. The request already in flight, if any, is left to
    // finish on its own; only what comes after is refused.
    if (req.method === 'POST' && p === '/api/downloads/stop') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const t = [...transfers.values()].find(x => x.id === body.id);
      if (!t) return sendJson(res, 404, { error: 'not found — it may already have finished or been cleared' });
      stoppedTransfers.add(t.id);
      console.log(`stopped ${t.rel} to ${ps5NameFor(t.ip) || t.ip} by request`);
      return sendJson(res, 200, downloadsView());
    }

    // Clears what has finished or given up. Anything still moving is left alone:
    // this tidies the list, it does not stop a console mid-download.
    if (req.method === 'DELETE' && p === '/api/downloads') {
      const now = Date.now();
      let cleared = 0, kept = 0;
      for (const [k, t] of transfers) {
        const moving = t.open.size || now - t.lastAt < ACTIVE_MS;
        if (moving && covered(t) < t.size) { kept++; continue; }
        // Clear can fire before downloadsView() has ever seen this one done —
        // the panel only needs to be open once, not polled first — so record
        // it here too rather than let a manual clear skip history.
        if (!t.recorded) {
          const done = covered(t) >= t.size;
          recordHistory({
            type: 'download', status: done ? 'done' : 'aborted', src: t.srcId, dir: dirOf(t.rel), path: t.rel,
            name: t.name, meta: fileMeta(t.srcId, t.rel), size: t.size, received: covered(t), ps5: ps5NameFor(t.ip) || t.ip,
            startedAt: t.firstAt, endedAt: t.lastAt, abortsTotal: t.abortsTotal,
          });
        }
        noteTransferGone(t);
        transfers.delete(k);
        stoppedTransfers.delete(t.id);
        cleared++;
      }
      for (const [id, j] of extractions) {
        if (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') { extractions.delete(id); cleared++; }
        else kept++;
      }
      console.log(`cleared ${cleared} finished item(s) from the downloads list${kept ? `, ${kept} still going` : ''}`);
      return sendJson(res, 200, { cleared, kept, ...downloadsView() });
    }

    // Everything the live feed has already forgotten: downloads and
    // extractions, done, failed or abandoned, newest first. The library label
    // is resolved fresh rather than stored, since a source's name can change
    // and a stale one would go on being shown forever.
    if (req.method === 'GET' && p === '/api/history') {
      const limit = Math.min(HISTORY_MAX, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const src = url.searchParams.get('src');
      const typeParam = url.searchParams.get('type');
      const types = typeParam ? new Set(typeParam.split(',').map(s => s.trim()).filter(Boolean)) : null;
      const ps5 = url.searchParams.get('ps5');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const matched = history.filter(h =>
        (!src || h.src === src) &&
        (!types || types.has(h.type)) &&
        (!ps5 || h.ps5 === ps5) &&
        (!q || (h.name || '').toLowerCase().includes(q)));
      const rows = matched.slice(offset, offset + limit).map(h => ({ ...h, library: (findSource(h.src) || {}).label || h.src }));
      return sendJson(res, 200, { history: rows, total: matched.length });
    }

    // Look for a console that has moved to another address.
    if (req.method === 'POST' && p === '/api/find') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const prof = body.profile ? findProfile(body.profile) : null;
      const port = parseInt((prof ? prof.host.split(':')[1] : body.port) || '12800', 10);
      const hints = [
        prof && prof.host.split(':')[0],
        ...profiles.map(x => x.host.split(':')[0]),
        (PUBLIC_BASE().match(/\/\/([^:/]+)/) || [])[1],
      ].filter(Boolean);

      const started = Date.now();
      const found = await findConsoles(port, hints);
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`console search on port ${port}: ${found.length} found in ${secs}s`);

      // Which of these is already a console you know about, and which is new.
      return sendJson(res, 200, {
        found: found.map(x => {
          const saved = savedAs(x.host, null);
          return {
            ...x, knownAs: saved ? saved.name : null, knownId: saved ? saved.id : null,
            // The same PS4 saved under its other port: the app has moved ports, so the fix is to update that console.
            otherPort: saved && saved.host !== x.host ? saved.host : null,
            isThisOne: prof ? (x.host === prof.host || !!(saved && saved.id === prof.id)) : false,
          };
        }),
        searched: subnetsToSearch(hints).map(n => n + '.0/24'),
        seconds: secs,
      });
    }

    // Everything needed to answer "why can't my PS5 reach this?" in one place:
    // the addresses this server actually has, the address it hands out, whether
    // the libraries and the config folder are what they should be, and what each
    // console says when asked. Nothing here changes anything.
    if (req.method === 'GET' && p === '/api/diagnostics') {
      const addresses = [];
      for (const [iface, list] of Object.entries(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family !== 'IPv4' || ni.internal) continue;
          // Listening on one address means the others are not ways in.
          if (BIND_ADDRESS && BIND_ADDRESS !== '0.0.0.0' && BIND_ADDRESS !== '::' && ni.address !== BIND_ADDRESS) continue;
          // Docker's own bridge is reachable from the host but not from a
          // console, so it is worth pointing out rather than hiding.
          addresses.push({ iface, address: ni.address, url: `http://${ni.address}:${PORT}`, docker: /^(docker|br-)/.test(iface) || ni.address.startsWith('172.17.') });
        }
      }
      const host = (req.headers.host || '').trim();
      const libraries = await Promise.all(SOURCES.map(async s => {
        const lib = { id: s.id, label: s.label, root: s.root, exists: false, writable: false };
        try { lib.exists = fs.statSync(s.root).isDirectory(); } catch {}
        if (lib.exists) { try { fs.accessSync(s.root, fs.constants.W_OK); lib.writable = true; } catch {} }
        const snap = listCache.get(s.id);
        // Package bytes are what the packages add up to, not what the disk holds: archives, dumps and everything else share it.
        if (snap && snap.builtAt) { lib.packages = snap.files.length; lib.packageBytes = snap.files.reduce((n, f) => n + f.size, 0); }
        const space = lib.exists ? await spaceAt(s.root) : null;
        if (space) { lib.free = space.free; lib.total = space.total; lib.low = LOW_SPACE_GB > 0 && space.free < LOW_SPACE_GB * 1073741824; }
        return lib;
      }));
      const consoles = await Promise.all(profiles.map(async prof => {
        const d = await detect(prof.host).catch(() => null);
        return {
          id: prof.id, name: prof.name, host: prof.host, installer: prof.installer || null,
          reachable: !!(d && d.ok),
          // Answering but unrecognised is its own problem: the console is there,
          // the payload is not, and that is worth telling apart from silence.
          driver: d && d.type ? DRIVERS[d.type].label : null,
        };
      }));
      return sendJson(res, 200, {
        app: { name: APP_NAME, build: BUILD, port: PORT, node: process.version, uptime: Math.round(process.uptime()) },
        // Only whether there is a password, never the password or the user name.
        access: ACCESS_PASSWORD ? 'password' : 'open',
        // Where packages are fetched from. Set (from the Setup panel or the
        // env var), it is used as-is; unset, it is taken from whatever
        // address the page was opened at — right for a browser, wrong for a
        // console if those differ.
        publicBase: {
          value: PUBLIC_BASE() || null,
          from: settings.publicBase ? 'the Setup panel' : PUBLIC_BASE_ENV ? 'the PUBLIC_BASE environment variable' : 'the address you opened this page with',
          effective: PUBLIC_BASE() || (host ? `http://${host}` : null),
          savedValue: settings.publicBase || null,
          settable: profilesWritable,
        },
        addresses,
        config: { dir: CONFIG_DIR, writable: profilesWritable, persistent: profilesPersistent, issue: configIssue() },
        libraries,
        lowSpaceGb: LOW_SPACE_GB,
        indexing: { archives: scanQueue.length, packages: metaQueue.length, building: SOURCES.some(s => (listCache.get(s.id) || {}).building) },
        extract: extractCapability(),
        log: logState(),
        builder: builderOverall(),
        // Hidden unpack folders an interrupted extraction left behind. Listed,
        // never removed by themselves.
        leftovers: await leftoverList(),
        // Every build still using SCRATCH_LIBRARY space right now: a build
        // still has moveBackTo set for as long as its scratch dump copy is
        // still on disk — moveBuildBackFromScratch() removes the build from
        // this array entirely once the move-back-and-cleanup actually
        // finishes, so "still has moveBackTo" already means "still on
        // scratch," no separate bookkeeping needed. Split into 'held' (an
        // auto-send stuck on a console whose installer isn't open — a real,
        // actionable thing to go fix) and the rest (mid-build, or done and
        // about to clean itself up any moment — routine, just visibility
        // into where scratch space is currently going).
        scratchBuilds: builds.filter(b => b.moveBackTo).map(b => ({
          title: b.title || b.contentId, bytes: b.dumpBytes || 0,
          ...(b.autoSend && b.autoSend.state === 'held' ? { held: true, console: b.autoSend.name } : {}),
        })),
        consoles,
      });
    }

    // Remove leftover unpack folders the person picked. Anything that is not one
    // of the recorded folders is refused per item, whatever path it names; the
    // outcome is per item, the same shape /api/delete uses.
    if (req.method === 'POST' && p === '/api/leftovers/remove') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });
      const removed = [], failed = [];
      for (const it of items) {
        const err = await removeLeftover(it && it.src, it && it.path);
        if (err) failed.push({ src: it && it.src, path: it && it.path, error: err });
        else removed.push({ src: it.src, path: it.path });
      }
      if (failed.length) console.log(`leftover removal refused ${failed.length}: ${failed.slice(0, 5).map(f => `${clip(f.path)} (${clip(f.error)})`).join('; ')}${failed.length > 5 ? '; ...' : ''}`);
      return sendJson(res, 200, { removed, failed, leftovers: await leftoverList() });
    }

    // The Settings window: every setting that can change while running, with the value
    // now, where it came from and what the environment says, plus the ones that cannot.
    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, { writable: profilesWritable, settings: APP_SETTINGS.map(appSettingView), fixed: fixedSettings() });
    }

    // A value set here beats the env var and needs no container recreate —
    // the whole reason this exists instead of just documenting the env var
    // better. Blank clears it, falling back to the env var (or the Host
    // header) again.
    if (req.method === 'POST' && p === '/api/settings') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      if (!profilesWritable) return sendJson(res, 409, { error: `${CONFIG_DIR} is not writable, so nothing set here would survive a restart.` });
      // The theme every device without a choice of its own starts with: a built-in or an
      // installed theme, or blank for none. Judged before anything below changes.
      // Settings from the Settings window: {app: {KEY: value}}, or null to hand a key back to
      // its environment variable. All checked first, so a bad one changes nothing.
      let appChange = null;
      if ('app' in body) {
        if (!body.app || typeof body.app !== 'object' || Array.isArray(body.app)) return sendJson(res, 400, { error: 'expected {app: {SETTING: value}}' });
        appChange = new Map();
        for (const [k, raw] of Object.entries(body.app)) {
          const d = APP_SETTING.get(k);
          if (!d) return sendJson(res, 400, { error: `"${String(k).slice(0, 40)}" is not a setting that can be changed here.` });
          if (raw === null) { appChange.set(k, { reset: true }); continue; }
          const parsed = parseAppSetting(d, raw);
          if (parsed.error) return sendJson(res, 400, { error: parsed.error });
          appChange.set(k, { value: parsed.value });
        }
      }
      let wantTheme;
      if ('defaultTheme' in body) {
        const v = body.defaultTheme;
        if (v !== null && typeof v !== 'string') return sendJson(res, 400, { error: 'Expected a theme id, or blank to clear it.' });
        wantTheme = (v || '').trim();
        refreshThemes();
        if (wantTheme && !themeKnown(wantTheme)) return sendJson(res, 400, { error: `"${themeQuote(wantTheme)}" is not a built-in theme or an installed one.` });
      }
      if ('publicBase' in body) {
        const v = String(body.publicBase || '').trim().replace(/\/+$/, '');
        if (v && !/^https?:\/\/[^/]+$/i.test(v)) {
          return sendJson(res, 400, { error: 'Expected something like http://192.168.1.10:12801, or blank to clear it.' });
        }
        if (v) settings.publicBase = v; else delete settings.publicBase;
        saveSettings();
      }
      if (wantTheme !== undefined) {
        if (wantTheme) settings.defaultTheme = wantTheme; else delete settings.defaultTheme;
        saveSettings();
        syncDefault();
      }
      if (appChange) {
        const saved = { ...savedApp() };
        for (const [k, c] of appChange) {
          const d = APP_SETTING.get(k);
          if (c.reset) { delete saved[k]; d.set(d.fromEnv()); }
          else { saved[k] = c.value; d.set(c.value); }
        }
        if (Object.keys(saved).length) settings.app = saved; else delete settings.app;
        saveSettings();
        console.log(`settings changed from the page: ${[...appChange].map(([k, c]) => k + (c.reset ? ' (back to the environment)' : APP_SETTING.get(k).kind === 'secret' ? ' (changed)' : '=' + c.value)).join(', ')}`);
        return sendJson(res, 200, { writable: profilesWritable, settings: APP_SETTINGS.map(appSettingView), fixed: fixedSettings() });
      }
      const dt = themeDefault();
      return sendJson(res, 200, { publicBase: settings.publicBase || null, effective: PUBLIC_BASE() || null, defaultTheme: dt.id, defaultFrom: dt.from });
    }

    // The last few hundred lines this process has produced, or with ?since=boot
    // the tail of the file on disk, which reaches back past restarts. Either way
    // the startup line, which says which build is running, leads.
    if (req.method === 'GET' && p === '/api/log') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      if (url.searchParams.get('since') !== 'boot') return res.end(logText());
      const want = Math.min(4 * 1024 * 1024, Math.max(64 * 1024, parseInt(url.searchParams.get('bytes') || '', 10) || 512 * 1024));
      const tail = tailLog(want);
      if (!tail) return res.end('No log file. ' + logState().why + '\n');
      return res.end(startupLine && !tail.includes(startupLine) ? startupLine + '\n' + tail : tail);
    }

    if (req.method === 'GET' && p === '/api/profiles') {
      return sendJson(res, 200, { profiles, persistent: profilesPersistent, configIssue: configIssue() });
    }

    if (req.method === 'POST' && p === '/api/profiles') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const v = validateProfile(body);
      if (v.error) return sendJson(res, 400, v);
      const dup = savedAs(v.host, null) || ipTaken(v.host, null);
      if (dup) return sendJson(res, 409, { error: duplicateMessage(dup, v.host) });
      const prof = { id: newId(), ...v };
      if (prof.installer === null) delete prof.installer;
      dropNullProfileFields(prof);
      profiles.push(prof);
      saveProfiles();
      return sendJson(res, 200, { profile: prof, profiles, persistent: profilesPersistent, configIssue: configIssue() });
    }

    const pm = /^\/api\/profiles\/([a-f0-9]+)$/.exec(p);
    if (pm && (req.method === 'PUT' || req.method === 'DELETE')) {
      const prof = findProfile(pm[1]);
      if (!prof) return sendJson(res, 404, { error: 'profile not found' });
      if (req.method === 'DELETE') {
        if (profiles.length === 1) return sendJson(res, 400, { error: 'Keep at least one console' });
        profiles = profiles.filter(x => x.id !== prof.id);
        closeFtpConn(prof.id);   // drop any pooled FTP connection for the console just removed
      } else {
        let body;
        try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
        const v = validateProfile(body);
        if (v.error) return sendJson(res, 400, v);
        // (a console already saved beside another at one address can still be edited while its address stays as it is)
        const dup = savedAs(v.host, prof.id) || (ipOf(v.host) !== ipOf(prof.host) ? ipTaken(v.host, prof.id) : null);
        if (dup) return sendJson(res, 409, { error: duplicateMessage(dup, v.host) });
        const hadFtp = { host: prof.ftpHost, port: prof.ftpPort, user: prof.ftpUser, pass: prof.ftpPass };
        Object.assign(prof, v);
        if (prof.installer === null) delete prof.installer;
        dropNullProfileFields(prof);
        // The connection is per {host,port,user,pass}; if editing the profile changed any of
        // those, a pooled connection made under the old values must not be reused for the new ones.
        if (hadFtp.host !== prof.ftpHost || hadFtp.port !== prof.ftpPort || hadFtp.user !== prof.ftpUser || hadFtp.pass !== prof.ftpPass) closeFtpConn(prof.id);
        detected.delete(prof.host);
        unreachableAt.delete(prof.host);
      }
      saveProfiles();
      return sendJson(res, 200, { profiles, persistent: profilesPersistent, configIssue: configIssue() });
    }

    // Reachability and DPI flavour of every profile, checked in parallel.
    if (req.method === 'GET' && p === '/api/status') {
      const results = await Promise.all(profiles.map(async prof => {
        try {
          let d = await detect(prof.host).catch(() => ({ ok: false, type: null }));
          // Remote Package Installer builds use 12800 or 12801: follow a PS4 to the other one.
          const alt = /:12800$/.test(prof.host) ? prof.host.replace(/:12800$/, ':12801') : /:12801$/.test(prof.host) ? prof.host.replace(/:12801$/, ':12800') : null;
          if (!d.ok && alt) {
            let r2 = null; try { r2 = await ps5Request(alt, 'GET', '/', null, 2000); } catch {}
            if (rpiSaysSo(r2) && followMove(prof, alt, `its Remote Package Installer now listens on ${portOf(alt)}`)) {
              detected.set(alt, { type: 'rpi', at: Date.now() });
              d = { ok: true, type: 'rpi' };
            }
          }
          if (!d.ok) lookForMovedConsole(prof);   // in the background; this answer stays current
          // A console whose DPI host isn't a recognised installer but that runs zftpd's
          // zhttp build installs through that instead — so it reads "zhttp", not "unknown".
          let label = d.type ? DRIVERS[d.type].label : (d.ok ? 'Unknown installer' : null);
          if (!d.type && prof.ftpHost) {
            const z = await zftpdProbe(prof).catch(() => null);
            if (z && z.present) { d = { ...d, ok: true, zftpd: true }; label = 'zhttp'; }
          }
          return [prof.id, { ok: d.ok, type: d.type, label }];
        } catch {
          lookForMovedConsole(prof);
          return [prof.id, { ok: false, type: null, label: null }];
        }
      }));
      return sendJson(res, 200, Object.fromEntries(results));
    }

    // Local save-data backups (made by the /api/ftp/saves/backup route): list and delete.
    if (req.method === 'GET' && p === '/api/saves') {
      sendJson(res, 200, { backups: saveBackups() });
      return;
    }
    if (req.method === 'DELETE' && (m = /^\/api\/saves\/([^/]+)$/.exec(p))) {
      let id = ''; try { id = decodeURIComponent(m[1]); } catch {}
      if (!readSaveMeta(id)) return sendJson(res, 404, { error: 'no such backup' });
      try { fs.rmSync(path.join(SAVES_DIR, id), { recursive: true, force: true }); } catch { return sendJson(res, 500, { error: 'could not delete the backup' }); }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Is this PS5's installer actually working? Nothing is installed either way.
    if (req.method === 'POST' && p === '/api/test') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const prof = body.profile ? findProfile(body.profile) : profiles[0];
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });

      for (const [k, v] of probes) if (Date.now() - v.at > 10 * 60000) probes.delete(k);
      const id = newId();
      probes.set(id, { at: Date.now(), hits: 0, ip: null });
      const probeUrl = `${PUBLIC_BASE() || 'http://' + req.headers.host}/probe/${id}/ShadowPKG_health_check.pkg`;

      try {
        const d = await detect(prof.host, 8000);
        if (!d.ok) return sendJson(res, 200, { verdict: 'offline', message: `${prof.name} is not answering at ${prof.host}. Check the console is awake and the payload is running.` });
        if (!d.type) return sendJson(res, 200, { verdict: 'unknown', message: `${prof.name} is online, but its page isn't an installer ShadowPKG knows (supported: ${Object.values(DRIVERS).map(x => x.label).join(', ')}).` });

        const drv = DRIVERS[d.type];
        const r = await drv.install(prof.host, probeUrl);
        for (let i = 0; i < 24 && !probes.get(id).hits; i++) await sleep(250);   // give it 6s to call back
        const hits = probes.get(id).hits;
        const reply = typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply);
        console.log(`health check ${prof.name} (${prof.host}, ${drv.label}) fetched=${hits} reply=${reply}`);

        if (hits) return sendJson(res, 200, { verdict: 'healthy', installer: drv.label, fetched: hits,
          message: `${prof.name} is healthy: its ${drv.label} installer downloaded the test link. Installs from ShadowPKG should work.` });
        if (r.ok) return sendJson(res, 200, { verdict: 'slow', installer: drv.label,
          message: `${prof.name} accepted the test but hasn't downloaded anything within 6 seconds. It may be busy with another install — check its Downloads queue.` });
        return sendJson(res, 200, { verdict: 'broken', installer: drv.label, reply,
          message: `${prof.name} refused the test without downloading anything (${drv.label} replied ${reply}). The console's installer is broken, not ShadowPKG: ${drv.rejected || 'reload the payload or reboot the console, clear any stuck item in its Downloads queue, and check free storage'}.` });
      } catch (e) {
        return sendJson(res, 200, { verdict: 'offline', message: `Could not reach ${prof.name} at ${prof.host}: ${e.message}` });
      }
    }

    // The payloads kept by SPKG itself: a folder in the config dir. Listing, adding and
    // removing; sending one of them goes through the same POST /api/payload as a library
    // file, below.
    // Whether a console is running ps5-tailscale, read from its config file over FTP.
    // Read-only and bounded (one small, fixed file); a console that is off, has no FTP,
    // or has never run tailscale all answer {present:false}, never an error.
    if (req.method === 'GET' && p === '/api/tailscale') {
      const prof = findFtpSource(url.searchParams.get('src'));
      if (!prof) return sendJson(res, 404, { error: 'FTP console not found' });
      try {
        const raw = await ftpReadText(prof, 'data/tailscale/config.json');
        let cfg = null;
        try { cfg = JSON.parse(raw); } catch {}
        if (!cfg || typeof cfg !== 'object') return sendJson(res, 200, { present: false });
        let webPort = 8090;
        const wm = typeof cfg.webAddr === 'string' ? /:(\d{1,5})/.exec(cfg.webAddr) : null;
        if (wm) { const n = parseInt(wm[1], 10); if (n >= 1 && n <= 65535) webPort = n; }
        sendJson(res, 200, { present: true, hostname: typeof cfg.hostname === 'string' ? cfg.hostname : null, webPort });
        return true;
      } catch (e) {
        return sendJson(res, 200, { present: false, error: ftpErr(e) });
      }
    }

    if (req.method === 'GET' && p === '/api/payloads') {
      return sendJson(res, 200, await listPayloads());
    }

    if (req.method === 'POST' && p === '/api/payloads') {
      if (!payloadsWritable) return sendJson(res, 409, { error: `The config folder (${CONFIG_DIR}) is not writable, so a payload cannot be kept` });
      const name = storedPayloadName(url.searchParams.get('name'));
      if (!name) return sendJson(res, 400, { error: `Name it with one of ${PAYLOAD_EXTS.join(', ')}` });
      let buf;
      try { buf = await readRaw(req, PAYLOAD_MAX); }
      catch (e) { return sendJson(res, e && e.tooLarge ? 413 : 400, { error: e && e.tooLarge ? `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` : 'could not read the upload: ' + e.message }); }
      if (!buf.length) return sendJson(res, 400, { error: 'no file was uploaded' });
      try { await savePayload(name, buf); } catch (e) { return sendJson(res, 500, { error: 'could not save the payload: ' + e.message }); }
      console.log(`payload ${name} (${buf.length} bytes) saved to ${PAYLOADS_DIR}`);
      return sendJson(res, 200, { ok: true, name, bytes: buf.length, ...(await listPayloads()) });
    }

    const pdel = /^\/api\/payloads\/(.+)$/.exec(p);
    if (pdel && req.method === 'DELETE') {
      let raw = pdel[1];
      try { raw = decodeURIComponent(raw); } catch {}
      const name = storedPayloadName(raw);
      if (!name) return sendJson(res, 400, { error: 'that is not a stored payload' });
      try { await fsp.unlink(payloadPathOf(name)); } catch { return sendJson(res, 404, { error: 'that payload is not there' }); }
      return sendJson(res, 200, await listPayloads());
    }

    // GitHub payloads: look at a repo's latest release, save one of its assets into the
    // stored-payloads folder, and keep/watch a list of repos to re-check for newer tags.
    if (req.method === 'GET' && p === '/api/github/release') {
      return sendJson(res, 200, await githubRelease(String(url.searchParams.get('repo') || '').trim()));
    }

    if (req.method === 'GET' && p === '/api/github/recommended') {
      return sendJson(res, 200, { repos: recommendedRepos });
    }

    if (req.method === 'POST' && p === '/api/github/save') {
      if (!payloadsWritable) return sendJson(res, 409, { error: `The config folder (${CONFIG_DIR}) is not writable, so a payload cannot be kept` });
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const repo = String(body.repo || '').trim();
      const want = String(body.asset || '').trim();
      if (!want) return sendJson(res, 400, { error: 'pick an asset to save' });
      const rel = await githubRelease(repo);
      if (rel.error) return sendJson(res, 400, { error: rel.error });
      const asset = rel.assets.find(a => a.name === want);
      if (!asset) return sendJson(res, 404, { error: 'that asset is not in the latest release' });
      const name = storedPayloadName(asset.name);
      if (!name) return sendJson(res, 400, { error: `that asset is not a payload (${PAYLOAD_EXTS.join(', ')})` });
      if (asset.size > PAYLOAD_MAX) return sendJson(res, 413, { error: `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` });
      let buf;
      try {
        const dres = await fetch(asset.url, { headers: { 'User-Agent': 'ShadowPKG' }, signal: AbortSignal.timeout(60000) });
        if (!dres.ok) throw new Error('GitHub answered ' + dres.status);
        buf = Buffer.from(await dres.arrayBuffer());
      } catch (e) { return sendJson(res, 502, { error: 'could not download the asset: ' + (e && e.message || e) }); }
      if (!buf.length) return sendJson(res, 502, { error: 'the download came back empty' });
      if (buf.length > PAYLOAD_MAX) return sendJson(res, 413, { error: `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` });
      try { await savePayload(name, buf); } catch (e) { return sendJson(res, 500, { error: 'could not save the payload: ' + e.message }); }
      console.log(`payload ${name} (${buf.length} bytes) fetched from github.com/${repo} and saved to ${PAYLOADS_DIR}`);
      const wi = githubWatch.find(x => x.repo === repo);
      if (wi) { wi.tag = rel.tag; wi.name = rel.name || repo; wi.at = Date.now(); }
      else githubWatch.push({ repo, tag: rel.tag, name: rel.name || repo, at: Date.now() });
      saveGithubWatch();
      return sendJson(res, 200, { ok: true, name, bytes: buf.length, tag: rel.tag, ...(await listPayloads()) });
    }

    if (req.method === 'GET' && p === '/api/github/watch') {
      return sendJson(res, 200, { repos: githubWatch });
    }

    if (req.method === 'POST' && p === '/api/github/watch') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const repo = String(body.repo || '').trim();
      const rel = await githubRelease(repo);
      if (rel.error) return sendJson(res, 400, { error: rel.error });
      const wi = githubWatch.find(x => x.repo === repo);
      if (wi) { wi.tag = rel.tag; wi.name = rel.name || repo; wi.at = Date.now(); }
      else githubWatch.push({ repo, tag: rel.tag, name: rel.name || repo, at: Date.now() });
      saveGithubWatch();
      return sendJson(res, 200, { repos: githubWatch });
    }

    if (req.method === 'POST' && p === '/api/github/watch/check') {
      const updated = await checkGithubWatch();
      return sendJson(res, 200, { updated, repos: githubWatch });
    }

    const ghDel = /^\/api\/github\/watch\/(.+)$/.exec(p);
    if (ghDel && req.method === 'DELETE') {
      let raw = ghDel[1];
      try { raw = decodeURIComponent(raw); } catch {}
      githubWatch = githubWatch.filter(x => x.repo !== raw);
      saveGithubWatch();
      return sendJson(res, 200, { repos: githubWatch });
    }

    // Send a payload (.elf/.bin/.js/.lua/.jar) to a console's own loader port — raw TCP,
    // nothing installed, the console not otherwise changed. Three ways in, matching the
    // three ways a payload can be chosen: one kept by SPKG ({profile, name}), a file
    // already in a library ({profile, src, path}), or bytes uploaded from the person's
    // computer (POST /api/payload/upload, below). All funnel into sendPayloadTo, which
    // answers 200 with ok:false and a sentence on failure.
    if (req.method === 'POST' && p === '/api/payload') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const prof = body.profile ? findProfile(body.profile) : profiles[0];
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });
      let buf, label;
      if (body.name) {
        const name = storedPayloadName(body.name);
        if (!name) return sendJson(res, 400, { error: 'that is not a stored payload' });
        let st;
        try { st = await fsp.stat(payloadPathOf(name)); } catch { return sendJson(res, 404, { error: 'that payload is no longer there' }); }
        if (!st.isFile()) return sendJson(res, 400, { error: 'that is not a file' });
        if (st.size > PAYLOAD_MAX) return sendJson(res, 413, { error: `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` });
        try { buf = await fsp.readFile(payloadPathOf(name)); } catch (e) { return sendJson(res, 500, { error: 'could not read the payload: ' + e.message }); }
        label = name;
      } else {
        const src = findSource(body.src);
        if (!src) return sendJson(res, 404, { error: 'library not found' });
        const rel = String(body.path || '');
        if (!isPayloadName(rel)) return sendJson(res, 400, { error: `Pick a ${PAYLOAD_EXTS.join(', ')} file` });
        const full = safeDir(src.root, rel);
        if (!full) return sendJson(res, 403, { error: 'that file is outside the library' });
        let st;
        try { st = await fsp.stat(full); } catch { return sendJson(res, 404, { error: 'file not found' }); }
        if (!st.isFile()) return sendJson(res, 400, { error: 'that is not a file' });
        if (st.size > PAYLOAD_MAX) return sendJson(res, 413, { error: `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` });
        try { buf = await fsp.readFile(full); } catch (e) { return sendJson(res, 500, { error: 'could not read the file: ' + e.message }); }
        label = path.basename(rel);
      }
      return sendPayloadTo(res, prof, body.port, buf, label);
    }

    // The same send, for a payload uploaded straight from the person's computer: the bytes
    // are the body, ?name= is the file name (for the message and the extension check) and
    // ?profile= / ?port= pick the console. Nothing is written to disk — the bytes go
    // straight to the console and are then dropped.
    if (req.method === 'POST' && p === '/api/payload/upload') {
      const prof = findProfile(url.searchParams.get('profile')) || profiles[0];
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });
      const name = String(url.searchParams.get('name') || 'payload');
      if (!isPayloadName(name)) return sendJson(res, 400, { error: `Pick a ${PAYLOAD_EXTS.join(', ')} file` });
      let buf;
      try { buf = await readRaw(req, PAYLOAD_MAX); }
      catch (e) { return sendJson(res, e && e.tooLarge ? 413 : 400, { error: e && e.tooLarge ? `the payload is larger than ${PAYLOAD_MAX / (1024 * 1024)} MB` : 'could not read the upload: ' + e.message }); }
      if (!buf.length) return sendJson(res, 400, { error: 'no file was uploaded' });
      return sendPayloadTo(res, prof, url.searchParams.get('port'), buf, name);
    }

    // Download a local library file to the person's browser or phone: the same
    // bytes the console would be served, but as a download (Content-Disposition:
    // attachment) instead of a package stream. src + path pick the file, the
    // same as everywhere else; a package inside a stored archive streams too.
    if (req.method === 'GET' && p === '/api/download') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const rel = String(url.searchParams.get('path') || '');
      if (!rel) return sendJson(res, 400, { error: 'no file was asked for' });
      let full = null, base = 0, size = 0, mtime = null, segments = null;
      if (rel.indexOf(ARC) < 0) {
        // Any plain file in the library, whatever the extension — this is a
        // download to a person's device, not a console package stream.
        full = safeDir(src.root, rel);
        if (!full) return sendJson(res, 403, { error: 'that file is outside the library' });
        let st;
        try { st = await fsp.stat(full); } catch { return sendJson(res, 404, { error: 'file not found' }); }
        if (!st.isFile()) return sendJson(res, 404, { error: 'file not found' });
        size = st.size; mtime = st.mtime;
      } else {
        const t = await resolveTarget(src, rel);
        if (t.error === 'forbidden') return sendJson(res, 403, { error: 'that file is outside the library' });
        if (t.error) return sendJson(res, 404, { error: 'file not found' });
        full = t.full || null; base = t.base || 0; size = t.size; mtime = t.mtime; segments = t.segments || null;
      }
      const name = rel.split('!/').pop().split('/').pop() || 'download';
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'Last-Modified': mtime.toUTCString(),
        'Content-Disposition': `attachment; filename="${name.replace(/["\\]/g, '_')}"`,
      });
      if (req.method === 'HEAD') return res.end();
      let stream;
      if (segments) {
        stream = segmentStream(segments, 0, size - 1, res, () => {});
      } else {
        stream = fs.createReadStream(full, { start: base, end: base + size - 1, highWaterMark: 1024 * 1024 });
        stream.on('error', e => { console.error(`download read error ${rel}: ${e.message}`); res.destroy(); });
      }
      stream.pipe(res);
      return;
    }

    // Download several selected files to the person's browser as one ZIP, built
    // here (not on the console). The list and name come in the JSON body; the
    // reply is the ZIP stream itself with Content-Disposition: attachment.
    if (req.method === 'POST' && p === '/api/zip') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJson(res, 400, { error: 'no files were asked for' });
      const name = String(body.name || 'download').replace(/["\\]/g, '_').replace(/\.zip$/i, '');
      const entries = [];
      for (const it of items) {
        const src = findSource(it && it.src);
        if (!src) return sendJson(res, 404, { error: 'library not found' });
        const rel = String((it && it.path) || '');
        if (!rel) continue;
        if (rel.indexOf(ARC) < 0) {
          // Any plain file in the library, whatever the extension.
          const full = safeDir(src.root, rel);
          if (!full) return sendJson(res, 403, { error: 'a file is outside the library' });
          let st;
          try { st = await fsp.stat(full); } catch { return sendJson(res, 404, { error: 'file not found: ' + rel }); }
          if (!st.isFile()) return sendJson(res, 404, { error: 'file not found: ' + rel });
          entries.push({ name: rel.split('/').pop() || 'file', full, base: 0, size: st.size, mtime: st.mtime, crc: 0 });
        } else {
          const t = await resolveTarget(src, rel);
          if (t.error === 'forbidden') return sendJson(res, 403, { error: 'a file is outside the library' });
          if (t.error) return sendJson(res, 404, { error: 'file not found: ' + rel });
          if (t.segments) return sendJson(res, 400, { error: 'a package inside an archive cannot be zipped directly — extract it first' });
          entries.push({ name: rel.split('/').pop() || 'file', full: t.full, base: t.base || 0, size: t.size, mtime: t.mtime, crc: 0 });
        }
      }
      if (!entries.length) return sendJson(res, 400, { error: 'no files to zip' });
      try { for (const e of entries) e.crc = await fileCrc(e.full, e.base, e.size); }
      catch (e) { return sendJson(res, 500, { error: 'could not read a file: ' + e.message }); }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}.zip"`,
      });
      try { await streamZip(res, entries); } catch (e) { console.error(`zip stream error: ${e.message}`); res.destroy(); }
      return;
    }

    if (req.method === 'GET' && p === '/api/extracts') {
      return sendJson(res, 200, { extract: extractCapability(), jobs: [...extractions.values()].slice(-20).map(jobView) });
    }

    // A dump folder's identity, and the result of the last full check if there
    // is one. The check itself walks the whole tree, so it is started on
    // request (POST) and polled here.
    if (req.method === 'GET' && p === '/api/dump') {
      const src = findSource(url.searchParams.get('src'));
      const dir = src && safeDir(src.root, url.searchParams.get('dir') || '');
      if (!dir) return sendJson(res, 404, { error: 'folder not found' });
      const dump = await dumpSummary(dir);
      if (!dump) return sendJson(res, 404, { error: 'not a game dump' });
      const job = dumpChecks.get(`${src.id}|${dir}`);
      return sendJson(res, 200, { dump, check: job ? dumpCheckView(job) : null });
    }

    // Jobs for one dump, newest first.
    if (req.method === 'GET' && p === '/api/builds') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const dumpRel = (url.searchParams.get('dir') || '').replace(/^\/+|\/+$/g, '');
      const builder = builderStatus(src);
      // A builder that is running, but only for other libraries: it cannot see this one, which is the usual
      // reason for "No builder seen" on a library that was added later. Say where to look.
      if (!builder.online) {
        const seen = SOURCES.filter(s => s.id !== src.id && builderStatus(s).online).map(s => s.label);
        if (seen.length) builder.elsewhere = { libraries: seen, path: src.root };
      }
      return sendJson(res, 200, { jobs: buildsFor(src.id, dumpRel), builder, notify: !!(NOTIFY_URL && NOTIFY_ON.has('builds')) });
    }

    // Packages a patch build could use as its base: the .pkg files next to the
    // dump, those for the same title first.
    if (req.method === 'GET' && p === '/api/build/bases') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const dumpRel = (url.searchParams.get('dir') || '').replace(/^\/+|\/+$/g, '');
      const parentRel = dumpRel.includes('/') ? dumpRel.slice(0, dumpRel.lastIndexOf('/')) : '';
      const dd = safeDir(src.root, dumpRel);
      const dump = dd && await dumpSummary(dd);
      const titleId = ((dump && dump.contentId) || '').match(/-([A-Z]{4}\d{5})_/);
      const out = [];
      try {
        for (const e of await fsp.readdir(safeDir(src.root, parentRel), { withFileTypes: true })) {
          if (!e.isFile() || !/\.pkg$/i.test(e.name) || e.name.startsWith('.')) continue;
          const rel = (parentRel ? parentRel + '/' : '') + e.name;
          const m = fileMeta(src.id, rel) || {};
          out.push({ path: rel, name: e.name, title: m.title || null, version: m.version || null, same: !!(titleId && (m.contentId || e.name).includes(titleId[1])) });
        }
      } catch {}
      out.sort((a, c) => (c.same - a.same) || a.name.localeCompare(c.name));
      return sendJson(res, 200, { bases: out.slice(0, 200) });
    }

    if (req.method === 'POST' && p === '/api/notify/test') {
      if (!NOTIFY_URL) return sendJson(res, 409, { error: 'NOTIFY_URL is not set on this container.' });
      const r = await notify('ShadowPKG: test', 'If you can read this, build notifications reach you.');
      return sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `The notification was not delivered: ${r.error}` });
    }

    // The builder's own log, as the container runner leaves it at the library's
    // root. Without ?src it is whichever library has the freshest copy.
    if (req.method === 'GET' && p === '/api/build/log') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      const want = url.searchParams.get('src');
      const pick = want ? [findSource(want)].filter(Boolean) : SOURCES;
      let best = null;
      for (const s of pick) {
        const f = path.join(s.root, '.shadowpkg-builder.log');
        try { const st = fs.statSync(f); if (!best || st.mtimeMs > best.mtime) best = { f, mtime: st.mtimeMs }; } catch {}
      }
      if (!best) return res.end('No builder log has been seen.\n\nThe container builder (ShadowPKG-Builder, version 2 or newer) writes it beside your games and refreshes it every 15 seconds while it runs. The PC builder does not write one; its log is watch.log in its folder.\n');
      try {
        const want = Math.min(1024 * 1024, Math.max(32 * 1024, parseInt(url.searchParams.get('bytes') || '', 10) || 256 * 1024));
        const b = fs.readFileSync(best.f);
        const s = b.length > want ? b.subarray(b.length - want).toString('utf8').replace(/^[^\n]*\n/, '') : b.toString('utf8');
        return res.end(`# builder log, last written ${new Date(best.mtime).toISOString()}\n` + (s || '(empty)\n'));
      } catch (e) { return res.end('Could not read the builder log: ' + e.message + '\n'); }
    }

    // Ask a running build to stop. The builder notices a file called "cancel" in
    // the job folder and ends the packer; one still waiting is just discarded.
    if (req.method === 'POST' && p === '/api/build/cancel') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'bad request' }); }
      const b = builds.find(x => x.id === body.id);
      if (!b) return sendJson(res, 404, { error: 'no such job' });
      const v = buildView(b);
      if (v.state !== 'running' && v.state !== 'stalled') return sendJson(res, 409, { error: 'Only a build that is running can be cancelled; a waiting one can simply be cleared.' });
      const dir = buildDir(b);
      if (!dir) return sendJson(res, 400, { error: 'job folder not found' });
      try {
        const f = path.join(dir, 'cancel');
        fs.writeFileSync(f, new Date().toISOString());
        try { fs.chmodSync(f, 0o666); } catch {}
      } catch (e) { return sendJson(res, 500, { error: `Could not ask the builder to stop: ${e.message}` }); }
      return sendJson(res, 200, { ok: true });
    }

    // What the Windows builder asks for: jobs nobody has picked up yet.
    if (req.method === 'GET' && p === '/api/build/pending') {
      const jobs = builds.map(b => ({ b, v: buildView(b) })).filter(x => x.v.state === 'waiting')
        .map(x => ({ id: x.b.id, library: x.b.src, jobRel: x.b.jobRel }));
      return sendJson(res, 200, { jobs });
    }

    if (req.method === 'POST' && p === '/api/build/prepare') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'bad request' }); }
      const src = findSource(body.src);
      const dumpRel = String(body.dir || '').replace(/^\/+|\/+$/g, '');
      const dir = src && dumpRel && safeDir(src.root, dumpRel);
      const dump = dir && await dumpSummary(dir);
      if (!dump || dump.error) return sendJson(res, 404, { error: 'not a game dump that can be built' });
      const chk = dumpChecks.get(`${src.id}|${dir}`);
      const r = await prepareBuildJob(src, dumpRel, dump, chk, body, req.headers.host);
      return sendJson(res, r.status, r.error ? { error: r.error } : { job: r.job });
    }

    // A DLC unlocker rebuilt for another region of the same game (see "DLC for another region"): one build job
    // per DLC, each answered on its own, so one that cannot be converted does not stop the rest.
    //   {items:[{src, path}], target:{src, path} | {region, titleId}, output?:{mode:'default'} | {mode:'target'} | {mode:'folder', src, path}, sendTo?, compression?}
    if (req.method === 'POST' && p === '/api/build/dlc') {
      const got = await readJson(req, 1 << 16);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const items = (Array.isArray(body.items) ? body.items : []).filter(x => x && typeof x.src === 'string' && typeof x.path === 'string' && x.path).slice(0, 50);
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });
      const results = [];
      for (const it of items) {
        const src = findSource(it.src);
        if (!src) { results.push({ path: it.path, status: 404, error: 'library not found' }); continue; }
        const r = await prepareDlcJob(src, it.path, body.target, { sendTo: body.sendTo, compression: body.compression, output: body.output }, req.headers.host);
        results.push(r.error ? { path: it.path, status: r.status, error: r.error } : { path: it.path, job: r.job });
      }
      return sendJson(res, 200, { results });
    }

    // Which games a DLC could be rebuilt for, from what the libraries hold: see dlcTargets.
    if (req.method === 'GET' && p === '/api/build/dlc/targets') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await dlcTargets(src, url.searchParams.get('path') || '');
      return r.error ? sendJson(res, r.status, { error: r.error }) : sendJson(res, 200, r);
    }

    // The same DLC's other releases according to the PlayStation Store (only when STORE_LOOKUP is on).
    if (req.method === 'GET' && p === '/api/build/dlc/online') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await dlcOnlineTargets(src, url.searchParams.get('path') || '');
      return r.error ? sendJson(res, r.status || 500, { error: r.error }) : sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/build/discard') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'bad request' }); }
      const b = builds.find(x => x.id === body.id);
      if (!b) return sendJson(res, 404, { error: 'no such job' });
      const v = buildView(b);
      if (v.state === 'running') return sendJson(res, 409, { error: 'That build is running. Cancel it first.' });
      const dir = buildDir(b);
      if (!dir || !/(^|\/)\.shadowpkg-build\/[0-9a-f]{12}$/.test(b.jobRel)) return sendJson(res, 400, { error: 'refusing to remove that folder' });
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      if (b.kind === 'dlc' && b.outCreated && b.outputDirRel) { const o = findSource(b.src); const od = o && safeDir(o.root, b.outputDirRel); if (od) { try { await fsp.rmdir(od); } catch {} } }      // (rmdir: only if still empty)
      settleBuild(b, v);
      builds = builds.filter(x => x !== b);
      saveBuilds();
      return sendJson(res, 200, { ok: true });
    }

    // Moves a still-waiting job one place earlier or later in the queue —
    // findPending() (what the builder actually claims next) reads this same
    // `builds` order, so this is a real reprioritise, not just a display change.
    if (req.method === 'POST' && p === '/api/build/reorder') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'bad request' }); }
      const b = builds.find(x => x.id === body.id);
      if (!b) return sendJson(res, 404, { error: 'no such job' });
      if (readBuildState(b).state !== 'waiting') return sendJson(res, 409, { error: 'Only a build that is still waiting can be reordered.' });
      const dir = body.dir === 'up' || body.dir === 'down' ? body.dir : null;
      if (!dir) return sendJson(res, 400, { error: 'dir must be "up" or "down"' });
      const moved = reorderWaitingBuild(body.id, dir);
      return sendJson(res, 200, { ok: moved });
    }

    if (req.method === 'POST' && p === '/api/dump/check') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'bad request' }); }
      const src = findSource(body.src);
      const dir = src && safeDir(src.root, body.dir || '');
      if (!dir || !(await dumpSummary(dir))) return sendJson(res, 404, { error: 'not a game dump' });
      const key = `${src.id}|${dir}`;
      let job = dumpChecks.get(key);
      if (!job || job.state !== 'running') {
        job = { state: 'running', startedAt: Date.now(), endedAt: 0, files: 0, bytes: 0, checks: [], notes: [] };
        dumpChecks.set(key, job);
        if (dumpChecks.size > 50) dumpChecks.delete(dumpChecks.keys().next().value);
        runDumpCheck(job, dir).catch(e => { job.checks.push({ level: 'error', text: `The check stopped: ${e.message}.` }); })
          .finally(() => { job.state = 'done'; job.endedAt = Date.now(); });
      }
      return sendJson(res, 200, { check: dumpCheckView(job) });
    }

    // Everything readable about one package, read fresh — not the cached
    // routine-scan meta, since the entry table this pulls in for PS5 costs
    // reads the routine scan has no reason to pay for every file, every time.
    if (req.method === 'GET' && p === '/api/info') {
      const src = findSource(url.searchParams.get('src'));
      const rel = url.searchParams.get('path') || '';
      const t = src && await resolveTarget(src, rel);
      if (!t || t.error) return sendJson(res, 404, { error: 'file not found' });
      const r = await readPackage(t);
      const meta = metaOf(r, rel);
      const info = { meta, size: t.size, mtime: t.mtime };
      // PS4's own routine scan already has this (r.ps5); a PS4 package does
      // not, since its entry table costs the same extra reads a PS5 one does
      // and the routine scan has no more reason to pay for it there either
      // — so this is read fresh for PS4, same as PS5's is for the icon alone.
      const cnt = r.ps5 || await readPs4Cnt(t);
      if (cnt) {
        info.container = {
          imageType: cnt.signedByte === 0x80 ? 'official' : cnt.signedByte === 0x00 ? 'debug / fake-signed' : cnt.signedByte != null ? `unknown (0x${cnt.signedByte.toString(16)})` : null,
          formatVersion: cnt.formatVersion ?? null,
          compressedSize: cnt.pfsImageSize ?? null,
          drmType: cnt.drmType, contentType: cnt.contentType, contentFlags: cnt.contentFlags,
          icon: cnt.entries.some(e => e.name === 'icon0.png' && !e.encrypted),
        };
        // PS4 already gets the full param.sfo below, which is the same
        // "everything, unabridged" depth for that platform — the entry list
        // is PS5's own equivalent, since it has no param.sfo to dump.
        if (r.ps5) {
          info.container.entries = cnt.entries.map(e => ({
            name: e.name || `id 0x${e.rawId.toString(16)}`, size: e.dataSize,
            encrypted: e.encrypted, keyIndex: e.encrypted ? e.keyIndex : null,
          })).sort((a, b) => b.size - a.size);
        }
      }
      if (r.param) info.param = r.param;   // the raw parsed param.json, unencrypted, straight from the file
      if (r.sfo) info.sfo = r.sfo;         // every field param.sfo has, not just the curated subset metaOf keeps
      return sendJson(res, 200, info);
    }

    // The package's own cover art, straight out of the file — icon0.png is
    // stored unencrypted on both PS4 and PS5 even though the rest of the
    // package is not (only the license/DRM entries carry the encrypted
    // bit), so this needs no lookup anywhere. 404s quietly for anything
    // else, so an <img> tag can just be left to fail rather than the caller
    // needing to ask first.
    if (req.method === 'GET' && p === '/api/icon') {
      const src = findSource(url.searchParams.get('src'));
      const rel = url.searchParams.get('path') || '';
      const t = src && await resolveTarget(src, rel);
      if (!t || t.error) return sendJson(res, 404, { error: 'not found' });
      const cnt = await readCntFor(t);
      const icon = cnt && cnt.entries.find(e => e.name === 'icon0.png' && !e.encrypted);
      if (!icon || cnt.baseOffset + icon.dataOffset + icon.dataSize > t.size) return sendJson(res, 404, { error: 'no icon' });
      const png = await readPkgRange(t, cnt.baseOffset + icon.dataOffset, icon.dataSize);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': (ACCESS_PASSWORD ? 'private' : 'public') + ', max-age=604800' });
      return res.end(png);
    }

    // Everything Explorer's Properties would say about one file or folder, or about a
    // package inside a .rar (archive.rar!/inner.pkg): see propertiesOf. A folder's
    // contents are counted here, so its answer takes as long as the count (at most
    // eight seconds), and asking again while it runs shares that count.
    if (req.method === 'GET' && p === '/api/properties') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await propertiesOf(src, url.searchParams.get('path') || '');
      return r.error ? sendJson(res, r.status, { error: r.error }, r.status === 429 ? { 'Retry-After': '3' } : undefined) : sendJson(res, 200, r.props);
    }

    // The SHA-256 of a file, started here and polled: see startHash. One at a time.
    if (req.method === 'POST' && p === '/api/hash') {
      const got = await readJson(req);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const src = findSource(body.src);
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await startHash(src, body.path);
      return r.error ? sendJson(res, r.status, { error: r.error, ...(r.running ? { running: r.running } : {}) }) : sendJson(res, 200, { id: r.job.id, total: r.job.total });
    }
    // With no id: what holds the one slot, if anything, for a second person (or this page after a reload)
    // who cannot know the id. Asking that does not count as watching it, or one look now and then
    // would keep a check going that its own page has long forgotten.
    if (req.method === 'GET' && p === '/api/hash') {
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, 200, { running: hashRunning() });
      const j = hashJobs.get(id);
      if (!j) return sendJson(res, 404, { error: 'that check is not there any more (a finished one is forgotten after ten minutes)' });
      j.polledAt = Date.now();
      return sendJson(res, 200, hashView(j));
    }
    // Stopping one that has finished changes nothing, and answers with how it ended. With no id it is
    // the one that is running, whoever started it.
    if (req.method === 'POST' && p === '/api/hash/cancel') {
      const got = await readJson(req);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      // (an id that is there but is not a name is a mistake, not "any": it stops nothing)
      const named = body.id !== undefined && body.id !== null && body.id !== '';
      const j = named ? hashJobs.get(typeof body.id === 'string' ? body.id : '') : [...hashJobs.values()].find(x => x.state === 'running');
      if (!j) return sendJson(res, 404, { error: named ? 'that check is not there any more (a finished one is forgotten after ten minutes)' : 'nothing is being calculated right now' });
      j.polledAt = Date.now();
      endHash(j, 'cancelled');
      return sendJson(res, 200, { ...hashView(j), id: j.id });
    }

    // A chunk of a text file (see readTextChunk), and a save of one (see saveText). Same sign-in and
    // cross-site rules as everything else; nothing here is cached.
    if (req.method === 'GET' && p === '/api/text') {
      const noStore = { 'Cache-Control': 'no-store' };
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' }, noStore);
      const r = await readTextChunk(src, url.searchParams.get('path') || '', url.searchParams.get('offset'), url.searchParams.get('limit'), () => req.socket.destroyed);
      return r.error ? sendJson(res, r.status, { error: r.error }, r.status === 429 ? { ...noStore, 'Retry-After': '2' } : noStore) : sendJson(res, 200, r.out, noStore);
    }
    if (req.method === 'PUT' && p === '/api/text') {
      const noStore = { 'Cache-Control': 'no-store' };
      // A save carries up to 4 MiB. Bodies still arriving are held to a total (a slow one holds nothing else up), and only a few
      // saves are in the queue at once, so a burst cannot fill the memory. The slot is taken once the body is in.
      const declared = Math.min(EDIT_BODY_MAX, Math.max(0, parseInt(req.headers['content-length'], 10) || EDIT_BODY_MAX));
      if (textBodies + declared > TEXT_BODIES_MAX) return sendJson(res, 429, { error: 'busy, try again' }, { ...noStore, 'Retry-After': '2' });
      textBodies += declared;
      let got;
      try { got = await readJson(req, EDIT_BODY_MAX); } finally { textBodies -= declared; }
      if (got.error) return sendJson(res, got.status, { error: got.error }, noStore);
      const body = got.body;
      const src = findSource(body.src);
      if (!src) return sendJson(res, 404, { error: 'library not found' }, noStore);
      if (textSaving >= TEXT_SAVES_AT_ONCE) return sendJson(res, 429, { error: 'busy, try again' }, { ...noStore, 'Retry-After': '2' });
      textSaving++;
      try {
        const r = await saveText(src, body);
        if (r.error) { const { status, ...rest } = r; return sendJson(res, status, rest, noStore); }
        return sendJson(res, 200, r.ok, noStore);
      } finally { textSaving--; }
    }

    // Rename a file in place. The link a console is given is derived from the
    // path, so renaming changes it: anything already handed out for the old name
    // stops resolving. That is why a file being downloaded right now is refused
    // rather than renamed out from under the console pulling it.
    // {allowExtChange: true} is the page saying the person confirmed a new extension.
    if (req.method === 'POST' && p === '/api/rename') {
      const got = await readJson(req);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const src = findSource(body.src);
      const rel = typeof body.path === 'string' ? body.path : '';
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await renamePackage(src, rel, body.name, { allowExtChange: body.allowExtChange === true });
      if (!r.ok) return sendJson(res, r.status, { error: r.error });
      if (r.unchanged) return sendJson(res, 200, { path: r.to, name: r.name, unchanged: true });
      if (r.listed) buildList(src, true);
      return sendJson(res, 200, { path: r.to, name: r.name, ...(r.heldMoved ? { heldMoved: r.heldMoved } : {}) });
    }

    // A new, empty folder in a local library: {src, dir, name}. See createFolder for what is refused.
    if (req.method === 'POST' && p === '/api/mkdir') {
      const got = await readJson(req, 1 << 16);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const src = findSource(got.body.src);
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = await createFolder(src, got.body.dir, got.body.name);
      if (!r.ok) return sendJson(res, r.status, { error: r.error });
      return sendJson(res, 200, { ok: true, path: r.rel, name: r.name });
    }

    // Rename several at once: {items:[{src, path, name}]}, each under the rules a
    // single rename has, and each answered on its own — one that cannot be renamed
    // does not stop the rest. Names are checked against one another too, so two
    // packages cannot be given the same one. With dryRun nothing is renamed and
    // what would happen to each is reported, which is what the preview is made of.
    if (req.method === 'POST' && p === '/api/rename/batch') {
      const got = await readJson(req, 1 << 20);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const asked = Array.isArray(body.items) ? body.items : [];
      const items = asked.slice(0, BATCH_ITEMS_MAX);
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });
      const dryRun = body.dryRun === true || body.dryRun === 1 || /^(true|1|yes)$/i.test(String(body.dryRun));
      const ctx = { dryRun, claimed: new Set(), freed: new Set() };
      const results = [], touched = new Set();
      let renamed = 0, failed = 0, heldMoved = 0;
      for (const it of items) {
        const src = findSource(it && it.src);
        const rel = typeof (it && it.path) === 'string' ? it.path : '';
        const name = typeof (it && it.name) === 'string' ? it.name.trim() : '';
        // The confirmation for a new extension is one for the whole request; one on an item counts for that item.
        ctx.allowExtChange = body.allowExtChange === true || (!!it && it.allowExtChange === true);
        const r = src ? await renamePackage(src, rel, name, ctx) : { ok: false, error: 'library not found' };
        if (!r.ok) { failed++; results.push({ src: it && it.src, path: rel, name, ok: false, error: r.error }); continue; }
        if (!r.unchanged) { renamed++; if (r.listed) touched.add(src); heldMoved += r.heldMoved || 0; }
        results.push({ src: src.id, path: rel, name: r.name, ok: true, to: r.to, ...(r.unchanged ? { unchanged: true } : {}) });
      }
      // Past the limit is said, not dropped: the page shows each one as refused and leaves it selected.
      for (const it of asked.slice(BATCH_ITEMS_MAX)) { failed++; results.push({ src: it && it.src, path: typeof (it && it.path) === 'string' ? it.path : '', name: typeof (it && it.name) === 'string' ? it.name.trim() : '', ok: false, error: TOO_MANY_MSG }); }
      // One rebuild of each library's list at the end, not one per package.
      if (!dryRun) for (const src of touched) buildList(src, true);
      if (!dryRun && (renamed || failed)) console.log(`batch rename: ${renamed} renamed, ${failed} refused`);
      return sendJson(res, 200, { dryRun, results, renamed, failed, ...(heldMoved ? { heldMoved } : {}) });
    }

    // What deleting the selection would take with it, worked out without touching the disk at all: for
    // each item, the same resolution and guards /api/delete itself uses (so anything the real delete
    // would refuse, this refuses too, with the same message), and for a folder the same walk /api/properties
    // uses for Info (so asking for both of one folder at once shares a single walk, not two). Nothing here
    // ever removes anything.
    if (req.method === 'POST' && p === '/api/delete/preview') {
      const got = await readJson(req, 1 << 20);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const asked = Array.isArray(body.items) ? body.items : [];
      const items = asked.slice(0, BATCH_ITEMS_MAX);
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });

      const results = [];
      const seen = {};
      let totalFiles = 0, totalDirs = 0, totalBytes = 0, anyTruncated = false;
      for (const it of items) {
        const src = findSource(it && it.src);
        const raw = typeof (it && it.path) === 'string' ? it.path : '';
        const bad = error => results.push({ src: it && it.src, path: raw, error });
        if (!src) { bad('library not found'); continue; }
        if (raw.includes(ARC)) { bad('inside an archive — extract it first, then the archive can be deleted from its own row'); continue; }
        const at = await locate(src, raw);
        if (at.error) { bad(at.error); continue; }
        if (at.outside) { bad(LEAVES_MSG); continue; }
        const { full, rel } = at;
        const barred = await untouchable(src, at, 'deleted', seen);
        if (barred) { bad(barred.error); continue; }

        // lstat, never stat: the selected item ITSELF may be a symlink or junction, and stat/opendir
        // would follow it straight through to whatever it points to (anywhere — even CONFIG_DIR). A
        // link is reported plainly as a link, never as a folder with the target's (deceptive) size,
        // and its contents are never walked into.
        let st;
        try { st = await fsp.lstat(full); } catch { bad('not found'); continue; }
        if (st.isSymbolicLink()) {
          results.push({ src: src.id, path: rel, link: true, files: 1, dirs: 0, bytes: st.size });
          totalFiles++; totalBytes += st.size;
          continue;
        }
        if (!st.isDirectory()) {
          if (!st.isFile()) { bad('not found'); continue; }
          if (at.names.some(n => /\.(rar|r\d\d)$/i.test(n))) { bad('an archive is deleted from its own row, which checks that what is inside it is unpacked and takes every part of the set'); continue; }
          results.push({ src: src.id, path: rel, files: 1, dirs: 0, bytes: st.size });
          totalFiles++; totalBytes += st.size;
          continue;
        }
        if (rel === '') { bad("a library's root cannot be deleted here"); continue; }
        const walk = folderContents(src, full, foldCase(at.real || full));
        if (!walk) return sendJson(res, 429, { error: 'busy, try again' }, { 'Retry-After': '3' });
        let counted;
        try { counted = await walk; }
        catch (e) { bad(`could not read it: ${fsErr(e)}`); continue; }
        const truncated = !!counted.truncated;
        results.push({ src: src.id, path: rel, folder: true, files: counted.files, dirs: counted.dirs, bytes: counted.bytes, packages: counted.packages || 0, truncated });
        totalFiles += counted.files; totalDirs += counted.dirs; totalBytes += counted.bytes;
        if (truncated) anyTruncated = true;
      }
      for (const it of asked.slice(BATCH_ITEMS_MAX)) results.push({ src: it && it.src, path: typeof (it && it.path) === 'string' ? it.path : '', error: TOO_MANY_MSG });
      return sendJson(res, 200, { items: results, totalFiles, totalDirs, totalBytes, anyTruncated });
    }

    // Delete one or more files or folders: packages, any other file that is not a .rar, and now a
    // whole folder too (everything inside it, permanently, with no undo — see walkForDelete for the
    // two-phase validate-then-delete this runs for a folder). Every guard rename has applies here too,
    // for the same reasons — an archive member has no file of its own to remove (a .rar goes
    // through /api/archive/delete, once its packages are unpacked beside it, and
    // takes every volume of its set with it), and a package a console is pulling
    // right now is left alone rather than pulled out from under the transfer.
    if (req.method === 'POST' && p === '/api/delete') {
      // The same limit as a batch rename's: a page that ticked a great many files sends them all in one go.
      const got = await readJson(req, 1 << 20);
      if (got.error) return sendJson(res, got.status, { error: got.error });
      const body = got.body;
      const asked = Array.isArray(body.items) ? body.items : [];
      const items = asked.slice(0, BATCH_ITEMS_MAX);
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });

      const deleted = [], failed = [], heldDropped = [];
      const touched = new Set();     // libraries whose list needs rebuilding
      const seen = {};               // what the guards worked out in this request (see untouchable)
      for (const it of items) {
        const src = findSource(it && it.src);
        const raw = typeof (it && it.path) === 'string' ? it.path : '';
        if (!src) { failed.push({ src: it && it.src, path: raw, error: 'library not found' }); continue; }
        // The single-item delete itself — see deleteLocalOne, which IS this route's
        // logic, pulled out so Move (in the transfers feature) can call the exact
        // same function for its source-removal step rather than a second one.
        const r = await deleteLocalOne(src, raw, seen);
        if (!r.ok) {
          failed.push({ src: src.id, path: raw, error: r.error });
          if (r.touched) touched.add(src.id);   // a partial folder delete may have removed some packages already
          continue;
        }
        deleted.push({ src: src.id, path: raw, ...r.entry });
        if (r.touched) touched.add(src.id);
        for (const pkgRel of r.packageRels) {
          metaCache.delete(`${src.id}\n${pkgRel}`);
          heldDropped.push(...dropHeld(src.id, pkgRel));
        }
      }
      // Past the limit is said, not dropped: the page lists each one as not deleted and leaves it selected.
      for (const it of asked.slice(BATCH_ITEMS_MAX)) failed.push({ src: it && it.src, path: typeof (it && it.path) === 'string' ? it.path : '', error: TOO_MANY_MSG });
      for (const id of touched) { listRev++; saveMetaSoon(); buildList(findSource(id), true); }
      // (worded "package(s)" when that is all it was, as it always was: a support report and the checks built on it read this line)
      if (deleted.length) console.log(`deleted ${deleted.length} ${deleted.every(d => isPackageName(d.path.replace(/\/+$/, ''))) ? 'package(s)' : 'file(s)'}: ${deleted.map(d => `${d.src}/${d.path}`).join(', ')}`);
      if (failed.length) console.log(`delete refused ${failed.length}: ${failed.map(f => `${f.path} (${f.error})`).join('; ')}`);
      if (heldDropped.length) console.log(`dropped ${heldDropped.length} held send(s) for deleted package(s)`);
      // Always 200: this ran, and the outcome per item is in the body, the same
      // shape /api/links uses for a batch that can partly fail. A held send for a
      // package that is gone has nothing to hand over, so it is dropped and said so.
      return sendJson(res, 200, { deleted, failed, ...(heldDropped.length ? { heldDropped } : {}) });
    }

    // Read-only: every entry inside a .rar (or its multi-volume set), .zip or
    // .7z, for looking at what it holds — a stray .nfo, a small .txt —
    // without unpacking or deleting anything. Unlike GET /api/archive below,
    // works on a read-only library and while an extraction of it is running.
    if (req.method === 'GET' && p === '/api/archive/peek') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = resolvePeekArchive(src, url.searchParams.get('path') || '');
      if (r.error) return sendJson(res, 404, { error: r.error });
      const list = await archiveListingFor(r.full);
      return sendJson(res, 200, {
        files: list.files.map(f => ({ name: f.name, size: f.size })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })),
        note: list.note || null,
      });
    }

    // Read-only: the text of ONE named entry inside a .rar/.zip/.7z, pulled to
    // a scratch folder and gone again before this answers (peekOneEntry).
    // Capped and refused the same way a plain text file's own viewer already
    // is — too big, or does not look like text — rather than a second set of
    // rules.
    if (req.method === 'GET' && p === '/api/archive/peek/text') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const r = resolvePeekArchive(src, url.searchParams.get('path') || '');
      if (r.error) return sendJson(res, 404, { error: r.error });
      const entry = url.searchParams.get('entry') || '';
      if (!entry) return sendJson(res, 400, { error: 'say which file inside it' });
      const list = await archiveListingFor(r.full);
      if (list.note) return sendJson(res, 400, { error: `ShadowPKG could not read everything inside it (${list.note})` });
      const found = list.files.find(f => f.name === entry);
      if (!found) return sendJson(res, 404, { error: 'not found inside this archive' });
      if (found.size > TEXT_MAX) return sendJson(res, 413, { error: `too big to open here (${fmtGb(found.size)}); extract it first` });
      const tools = findTools(r.full);
      if (!tools.length) return sendJson(res, 500, { error: 'This container has no extractor installed, so nothing inside an archive can be opened.' });
      let buf;
      try { buf = await peekOneEntry(tools, r.full, entry); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
      const whole = buf.length <= TEXT_SNIFF;
      const kind = sniffText(buf.subarray(0, TEXT_SNIFF), whole);
      if (kind.binary) return sendJson(res, 415, { error: NOT_TEXT_MSG });
      const capped = buf.length > TEXT_MAX ? buf.subarray(0, TEXT_MAX) : buf;
      const piece = capped.subarray(kind.bom || 0);
      const text = kind.enc === 'utf-8' ? piece.toString('utf8')
                 : kind.enc === 'windows-1252' ? decode1252(piece)
                 : kind.enc === 'utf-16le' ? piece.toString('utf16le')
                 : Buffer.from(piece).swap16().toString('utf16le');
      return sendJson(res, 200, { name: entry.split('/').pop(), text, encoding: kind.enc, size: found.size, truncated: capped.length < buf.length });
    }

    // What deleting an archive would take with it, and whether it can go: every
    // volume with its size, the packages inside and whether each is already
    // unpacked beside it, and any other file inside (a readme, a sample). Changes
    // nothing. `others` is null when the inside of it could not be read.
    if (req.method === 'GET' && p === '/api/archive') {
      const src = findSource(url.searchParams.get('src'));
      if (!src) return sendJson(res, 404, { error: 'library not found' });
      const { inner, ...view } = await reviewArchive(src, url.searchParams.get('path') || '');
      return sendJson(res, 200, { ...view, deletable: !view.why });
    }

    // Delete an archive and every volume of its set, once every package inside is
    // unpacked next to it. No undo, the same as deleting a package, and the same
    // refusals applied here as there; like /api/delete it always answers 200, with
    // `deleted` and `failed` lists, so a caller reads one shape whatever happened.
    if (req.method === 'POST' && p === '/api/archive/delete') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const src = findSource(body.src);
      let rel = typeof body.path === 'string' ? body.path : '';
      const refuse = error => { console.log(`archive delete refused ${clip(rel)}: ${error}`); return sendJson(res, 200, { deleted: [], failed: [{ src: body.src, path: rel, error }] }); };
      if (!src) return refuse('library not found');
      const r = await reviewArchive(src, rel);
      if (r.why) return refuse(r.why);
      rel = r.path;
      // Looked at again with nothing awaited since: a job or a transfer may have started while the archive was being read.
      const inUse = archiveInUse(src, rel, path.resolve(src.root, rel));
      if (inUse) return refuse(inUse);

      const deleted = [], failed = [];
      // The last volume first, and the first failure stops it, so what is left is a set that still lists from its
      // first volume and can be tried again, rather than pieces nobody can see. A volume that is already gone (a
      // second click, another tab) is as deleted as one this removed.
      for (const v of [...r.volumes].reverse()) {
        const abs = path.join(src.root, v.path);
        try { await fsp.unlink(abs); }
        catch (e) {
          if (e.code !== 'ENOENT') { failed.push({ src: src.id, path: v.path, error: `could not delete it: ${String(e.message).split(', ')[0]}` }); break; }
        }
        rarCache.delete(abs);
        deleted.unshift({ src: src.id, path: v.path, size: v.size });
      }
      if (deleted.length) {
        for (const name of r.inner) metaCache.delete(`${src.id}\n${rel}${ARC}${name}`);
        saveIndexSoon(); saveMetaSoon();
        buildList(src, true);
        console.log(`deleted archive ${src.label}/${rel}: ${deleted.length} file(s), ${fmtGb(deleted.reduce((n, d) => n + d.size, 0))}`);
      }
      if (failed.length) console.log(`archive delete could not remove ${failed.length}: ${failed.map(f => `${f.path} (${f.error})`).join('; ')}`);
      return sendJson(res, 200, { deleted, failed });
    }

    if (req.method === 'POST' && p === '/api/extract') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const src = findSource(body.src);
      const full = src && typeof body.path === 'string' && path.resolve(src.root, body.path);
      if (!full || !underRoot(src.root, full)) {
        return sendJson(res, 404, { error: 'archive not found' });
      }
      const isRar = /\.rar$/i.test(full);
      // A dump found inside the archive's own listing: pull out only its folder.
      // Scoped to .rar for this pass — the in-process listing this relies on
      // (listArchive/scanRar) only covers RAR; .zip/.7z dumps aren't offered.
      const isDump = typeof body.dumpRoot === 'string';
      // One or more specific entries picked from the archive's own listing
      // (GET /api/archive/peek) — the Open dialog's "select and extract"
      // path. .rar, .zip or .7z, matching what GET /api/archive/peek itself
      // can already read (see archiveListingFor) — unlike isDump below,
      // which stays .rar-only (the sce_sys/param.json scan it relies on has
      // no .zip/.7z equivalent here).
      const isSelected = Array.isArray(body.entries) && body.entries.length > 0;
      if (isDump && !isRar) return sendJson(res, 400, { error: 'a dump found inside an archive can only be built from a .rar for now — .zip and .7z are not wired up for this' });
      if (!isRar && !/\.(zip|7z)$/i.test(full)) {
        return sendJson(res, 400, { error: 'ShadowPKG unpacks .rar, .zip and .7z archives — unpack other formats yourself' });
      }
      // A .zip/.7z can also now be picked into (isSelected), same as .rar —
      // only "unpack the whole thing" (all: true) used to be offered for
      // those two; picking specific entries out cheaply no longer needs that.
      if (!isRar && !isSelected && body.all !== true) return sendJson(res, 400, { error: 'a .zip or .7z can only be unpacked whole (into a folder of its own) unless specific files are picked out of it' });
      let st;
      try { st = await fsp.stat(full); } catch { return sendJson(res, 404, { error: 'archive not found' }); }

      const tools = findTools(full);
      if (!tools.length) return sendJson(res, 400, { error: extractCapability().why });
      const dest = path.dirname(full);
      try { fs.accessSync(dest, fs.constants.W_OK); }
      catch { return sendJson(res, 400, { error: `${src.label} is mounted read-only, so nothing can be written next to the archive. Change that library's mapping to read/write in Unraid.` }); }

      // What the job is on is remembered as the file it is (see sameFile), so nothing that renames or deletes it can miss it by another spelling.
      const spot = spotSync(full);
      const already = [...extractions.values()].find(j => (j.state === 'queued' || j.state === 'running') && sameFile(j, spot));
      if (already) return sendJson(res, 200, { job: jobView(already), queued: true });

      const dir = path.dirname(full);
      // {all: true} unpacks every file into a folder of its own — for an archive
      // with no package inside, where there is nothing else to pull out.
      const all = body.all === true;
      let expect = [], total = 0, clash = [], dumpRoot = null, entries = null;
      let roomDirForJob = dir;      // where it will write: next to the archive, or SCRATCH_LIBRARY for a dump
      if (isSelected) {
        // Read fresh, same reasoning as isDump below: the archive could have
        // changed since whatever listing (GET /api/archive/peek) showed these
        // names in the first place.
        const list = await archiveListingFor(full);
        if (list.note) return sendJson(res, 400, { error: `ShadowPKG could not read everything inside it (${list.note}), so it cannot safely pull specific files out` });
        const wantedNames = [...new Set(body.entries.filter(e => typeof e === 'string'))].slice(0, 200);
        if (!wantedNames.length) return sendJson(res, 400, { error: 'pick at least one file inside it' });
        const found = wantedNames.map(name => ({ name, file: list.files.find(f => f.name === name) }));
        const missing = found.filter(f => !f.file);
        if (missing.length) return sendJson(res, 404, { error: `not found inside this archive: ${missing.slice(0, 3).map(m => m.name.split('/').pop()).join(', ')}${missing.length > 3 ? ', …' : ''}` });
        entries = wantedNames;
        total = found.reduce((n, f) => n + f.file.size, 0);
        const noRoom = await noRoomFor(dir, total);
        if (noRoom) return sendJson(res, 409, { error: noRoom });
      } else if (isDump) {
        // Read fresh rather than trusting the cache a listing may have shown a while
        // ago — the archive could have changed, or no longer be readable whole.
        const dc = await dumpCandidatesFor(full, st);
        if (dc.note) return sendJson(res, 400, { error: `ShadowPKG could not read everything inside it (${dc.note}), so it cannot safely pull just the dump out` });
        const cand = dc.candidates.find(c => c.root === body.dumpRoot);
        if (!cand) return sendJson(res, 404, { error: 'that is not a dump found inside this archive' });
        dumpRoot = cand.root;
        total = cand.bytes;
        // Checked at the real destination, not always `dir`: SCRATCH_LIBRARY
        // (see runExtractDump) redirects a dump-inside-archive job to a
        // different library's root, and checking room next to the archive
        // instead would give the wrong answer in both directions — a false
        // accept when the archive's own library has room but scratch is full,
        // or a false refusal when the reverse is true.
        const scratchSrc = SCRATCH_LIBRARY ? findSource(SCRATCH_LIBRARY) : null;
        const roomDir = scratchSrc && scratchSrc.id !== src.id ? scratchSrc.root : dir;
        // freeName() (in runExtractDump) would otherwise silently extract into
        // "<name>-2" beside whatever is already there — never overwriting, but
        // never saying so either, so a second click (the archive itself stays
        // fully live and buildable after a first extraction) quietly doubles
        // the disk cost of a dump that can be 100+ GB. Checked here, before
        // queuing, with the exact same name runExtractDump itself would land
        // on, so the refusal is accurate rather than a guess.
        const leafName = dumpRoot ? dumpRoot.split('/').pop() : stemOf(path.basename(full));
        if (fs.existsSync(path.join(roomDir, leafName))) {
          return sendJson(res, 409, { error: `${leafName} already sits ${roomDir === dir ? 'next to the archive' : `on ${scratchSrc.label}`} — open it to see if it's already the dump you're after, or move/rename it first.` });
        }
        const noRoom = await noRoomFor(roomDir, total);
        if (noRoom) return sendJson(res, 409, { error: noRoom });
        roomDirForJob = roomDir;
      } else if (all) {
        total = isRar ? await archiveTotal(full) : await listedTotal(tools, full);
        try {
          const s = await fsp.statfs(dir);
          const free = Number(s.bavail) * Number(s.bsize) - reservedOn(dir);
          if (total && free < total) return sendJson(res, 400, { error: `Not enough room next to the archive: it unpacks to about ${fmtGb(total)} and ${fmtGb(free)} is free.` });
        } catch { /* not every filesystem answers */ }
      } else {
        const wanted = (await rarPkgs(full, st)).blocked.filter(x => {
          try { return fs.statSync(path.join(dir, x.name.split('/').pop())).size !== x.size; } catch { return true; }
        });
        if (!wanted.length) return sendJson(res, 400, { error: 'already extracted — the packages are already sitting next to the archive' });
        // Something already at a package's name, at another size, is never replaced (it may be hand-fixed, newer, or
        // another package that shares the name), so there is no point unpacking that one only to throw it away.
        for (const x of wanted) {
          const leaf = x.name.split('/').pop();
          let there = null;
          try { there = fs.lstatSync(path.join(dir, leaf)); } catch {}
          if (!there) expect.push(x);
          else clash.push({ name: leaf, why: there.isFile() ? CLASH_WHY : CLASH_OTHER_WHY });
        }
        if (!expect.length) return sendJson(res, 409, { error: `Not extracted: ${clash.map(c => c.name).join(', ')} — ${clash[0].why}.` });
        total = expect.reduce((n, x) => n + x.size, 0);
        const noRoom = await noRoomFor(dir, total);
        if (noRoom) return sendJson(res, 409, { error: noRoom });
      }
      // Only meaningful for a dump-inside-archive job: the console to send the
      // finished package to once its auto-build finishes, the same choice the
      // real-disk dump's own "Build .pkg" panel already offers. Validated up
      // front (same as /api/build/prepare) so a stale/typo'd console id fails
      // fast rather than only surfacing hours later when the build ends.
      let sendTo = null;
      if (isDump && body.sendTo) {
        const prof = findProfile(String(body.sendTo));
        if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });
        sendTo = prof.id;
      }
      const j = {
        id: newId(), src: src.id, rel: body.path, full, real: spot.real, fileId: spot.id, name: path.basename(full),
        roomDir: roomDirForJob, roomNeeded: total,
        tools, expect, skipped: clash, packages: expect.length + clash.length, mode: isSelected ? 'selected' : isDump ? 'dump' : all ? 'all' : 'packages', dumpRoot, entries, sendTo, total, state: 'queued', message: 'waiting for a free slot',
        createdAt: Date.now(), startedAt: null, endedAt: null,
        // Only meaningful alongside sendTo: this request IS a real one, with a
        // real Host header, unlike the auto-build that follows hours later in
        // the background with no request of its own. Carried through so the
        // eventual autoSendBuild() has a real base URL to hand the console
        // even when PUBLIC_BASE isn't set — the same thing /api/build/prepare
        // already gets for free from being called synchronously inside a request.
        ...(sendTo ? { hostHeader: req.headers.host } : {}),
      };
      extractions.set(j.id, j);
      extractQueue.push(j);
      runNextExtraction();
      return sendJson(res, 200, { job: jobView(j) });
    }

    // Stop an extraction: a queued one is just dropped, a running one has its tool
    // ended and its hidden temp folder removed, so nothing half-unpacked is left.
    if (req.method === 'POST' && p === '/api/extract/cancel') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const j = extractions.get(body.id);
      if (!j) return sendJson(res, 404, { error: 'no such extraction' });
      if (j.state === 'queued') {
        const i = extractQueue.indexOf(j); if (i >= 0) extractQueue.splice(i, 1);
        j.state = 'cancelled'; j.cancelled = true; j.endedAt = Date.now(); j.message = 'cancelled before it started';
      } else if (j.state === 'running') {
        j.cancelled = true; j.message = 'cancelling…';
        try { j.proc && j.proc.kill('SIGKILL'); } catch {}
      } else return sendJson(res, 409, { error: 'That extraction has already finished.' });
      return sendJson(res, 200, { job: jobView(j) });
    }

    if (req.method === 'POST' && p === '/api/links') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      if (!items.length) return sendJson(res, 400, { error: 'nothing selected' });
      const base = PUBLIC_BASE() || `http://${req.headers.host}`;
      const urls = [], missing = [];
      for (const it of items) {
        const src = findSource(it && it.src);
        const t = src && typeof it.path === 'string' ? await resolveTarget(src, it.path) : null;
        if (!t || t.error) { missing.push((it && it.path) || '?'); continue; }
        urls.push(base + cleanPkgPath(src, it.path));
      }
      if (!urls.length) return sendJson(res, 404, { error: 'file not found' });
      return sendJson(res, 200, { urls, missing });
    }

    // A batch of packages for one console, worked through by the server in the order given.
    // Answers at once; what happens to each is in the downloads feed (`batches`).
    if (req.method === 'POST' && p === '/api/send') {
      let body;
      try { body = parseJsonObject(await readBody(req, 2 * 1024 * 1024)); } catch (e) { return sendJson(res, e && e.tooLarge ? 413 : 400, { error: e && e.tooLarge ? `that request is too large (at most ${BATCH_MAX_ITEMS} packages, and about 2 MB)` : 'invalid JSON' }); }
      const prof = body.profile ? findProfile(body.profile) : profiles[0];
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });
      const list = Array.isArray(body.items) ? body.items.filter(x => x && typeof x.src === 'string' && typeof x.path === 'string' && x.path).map(x => ({ ...x, again: x.again === true || body.again === true })) : [];
      if (!list.length) return sendJson(res, 400, { error: 'nothing to send' });
      if (list.length > BATCH_MAX_ITEMS) return sendJson(res, 400, { error: `at most ${BATCH_MAX_ITEMS} packages in one batch` });
      const b = startBatch(prof, list, PUBLIC_BASE() || `http://${req.headers.host}`);
      return sendJson(res, 200, { batch: b.id, count: b.items.length });
    }

    // Stop a batch: what has not been handed to the console yet is not. One already
    // handed over is the console's now, and there is no call to take it back.
    if (req.method === 'POST' && p === '/api/send/cancel') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }
      const b = batches.find(x => x.id === body.id);
      if (!b) return sendJson(res, 404, { error: 'that batch is not there any more' });
      if (b.endedAt) return sendJson(res, 200, { ok: true, cancelled: 0 });      // already over: nothing left to stop
      let n = 0;
      // Queued ones, and one that is waiting in the console's line without having been handed over yet.
      for (const it of b.items) if (it.state === 'queued' || (it.state === 'sending' && !it.running)) { it.state = 'cancelled'; n++; }
      if (n) b.cancelled = true;          // (a cancel that stopped nothing, because the last package was already going over, must not tag the batch)
      // Nothing is being handed over: the batch is over now, not when the download in front of it ends.
      if (!b.endedAt && !b.items.some(it => it.state === 'sending' && it.running)) b.endedAt = Date.now();
      if (n) console.log(`send batch to ${b.console}: ${n} not yet sent were cancelled`);
      return sendJson(res, 200, { ok: true, cancelled: n });
    }

    if (req.method === 'POST' && p === '/api/install') {
      let body;
      try { body = parseJsonObject(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e && e.notObject ? 'expected a JSON object' : 'invalid JSON' }); }

      const prof = body.profile ? findProfile(body.profile) : profiles[0];
      if (!prof) return sendJson(res, 404, { error: 'That console no longer exists — pick another' });

      if (typeof body.path === 'string') {
        const src = findSource(body.src);
        const r = src && await sendLibraryFile(prof, src, body.path, PUBLIC_BASE() || `http://${req.headers.host}`, false, null, 0, { again: body.again === true });
        if (!r) return sendJson(res, 404, { error: 'file not found' });
        return sendJson(res, 200, r.payload);
      }
      if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) return sendJson(res, 400, { error: 'need "path" or "url"' });
      // A link from an arbitrary URL cannot be checked first, or watched, so it
      // goes straight through.
      const { ok, payload } = await queueSend(prof.id, () => attemptInstall(prof, body.url, false), null);
      recordHistory({
        type: 'send', status: ok ? 'done' : 'failed', ps5: prof.name, profile: prof.id,
        src: null, dir: null, path: null, name: body.url, meta: null,
        size: null, message: payload.error || null, endedAt: Date.now(),
      });
      return sendJson(res, 200, payload);
    }

    console.log(`unknown request ${(req.socket.remoteAddress || '').replace(/^::ffff:/, '')} ${req.method} ${req.url} ua=${req.headers['user-agent'] || '-'}`);
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.destroy();
  }
});

// When this file was last written, so the log says which build is running:
// restarting a container keeps the image it was created with, rebuilding does not.
const BUILD = (() => { try { return fs.statSync(__filename).mtime.toISOString().replace('T', ' ').slice(0, 19); } catch { return 'unknown'; } })();

// A BIND_ADDRESS this machine does not have would otherwise end in a stack trace.
server.on('error', e => {
  if (BIND_ADDRESS && ['EADDRNOTAVAIL', 'ENOTFOUND', 'EINVAL'].includes(e.code)) {
    console.error(`BIND_ADDRESS ${BIND_ADDRESS} is not an address this machine has (${e.code}), so nothing is listening.`);
    process.exit(1);
  }
  throw e;
});

// The startup line is kept for /api/log: it is the one that says which build is running.
server.listen(PORT, BIND_ADDRESS || undefined, () => {
  startupLine = `${new Date().toISOString()} ${APP_NAME} on ${BIND_ADDRESS.includes(':') ? '[' + BIND_ADDRESS + ']' : BIND_ADDRESS}:${PORT}, libraries ${SOURCES.map(x => `${x.label}=${x.root}`).join(', ')}, ${profiles.length} console profile(s) ${profilesPersistent ? 'saved in ' + PROFILES_FILE : profilesWritable ? '(WARNING: ' + CONFIG_DIR + ' is not a mapped host folder; profiles are lost if the container is recreated)' : '(NOT saved: ' + CONFIG_DIR + ' is missing or not writable)'}, base ${PUBLIC_BASE() || '(from Host header)'}, build ${BUILD}`;
  console.log(startupLine);
});

// A stray rejected promise (a console that resets a socket at the wrong moment, a
// share that vanishes under a read) should cost one log line, not the server: node
// exits on one by default, in the middle of somebody's 80 GB send.
process.on('unhandledRejection', reason => {
  let why;
  try { why = reason instanceof Error ? reason.stack : String(reason); } catch { why = 'unprintable rejection'; }
  console.error(`unhandled rejection, carrying on: ${why}`);
});

// After an error nobody expected there is no telling what state is half-changed,
// so write out what is known and leave; the container's restart policy brings a
// clean process back.
process.on('uncaughtException', err => {
  console.error(`uncaught exception: ${err && err.stack || err}`);
  shutdown('uncaught exception', 1);
});

// The second signal, from someone at a terminal who has waited long enough, ends it at once.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (stopping) process.exit(1); else shutdown(sig); });
}
