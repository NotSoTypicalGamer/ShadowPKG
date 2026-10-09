#!/usr/bin/env node
// Checks a ShadowPKG theme before it is shared or installed, with the code the app itself uses.
// Node 18 or newer, stdlib only.
//
//   node tools/themes/check.js <theme> [--json] [--allow-low-contrast] [--verbose] [--server <url>]
//
//   <theme>  a single-file theme (sunset.json), a theme folder (aurora/), or the theme.json inside one
//
// What it does, in order:
//   1. Reads the theme the way the page's drop handler does (a .json file becomes {theme}, a folder becomes
//      {files} with theme.json, theme.css and assets/*, pictures as base64), under the page's size limits.
//   2. Starts server.js from this checkout on a free loopback port with a temporary config folder (or asks the
//      running server named by --server) and posts it to /api/themes/check. The server is the only judge of
//      what a theme may contain: nothing of its rules is copied here.
//   3. Cuts the pure theme engine out of index.html (between its two marker comments), runs it in a vm, and
//      derives every token and the readability report for the accepted theme, as the install window does.
//   4. Prints the problems, or the accepted theme and the readability table.
//   The scratch server is always stopped and its folder removed: on success, on an error, on Ctrl-C, and even when
//   this process is killed outright (the server sees its pipe close and stops itself). A folder that a crash still
//   left behind is removed by the next run. The server listens on 127.0.0.1 only, with an environment of its own.
//
// Exit codes:
//   0  valid, and every readability pair passes
//   1  not valid, unreadable, or a pair derived from the palette fails (that is an engine bug, and says so)
//   2  valid, but an explicit override in "tokens" leaves a pair below its minimum (a warning);
//      --allow-low-contrast turns this into 0
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const vm = require('vm');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(REPO, 'server.js');
const INDEX_HTML = path.join(REPO, 'index.html');
const ENGINE_START = '// ==== theme engine (pure) ====';
const ENGINE_END = '// ==== end theme engine ====';
const SCRATCH_PORTS = [13600, 13619];          // tried first; a random free port when all of these are taken
const TMP_PREFIX = 'spkg-theme-check-';
const START_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ANSWER = 64 * 1024 * 1024;           // a server that answers with more than this is not a ShadowPKG

// The page's own wording for what it refuses before it asks the server (index.html, buildThemeRequest).
const NOT_THEME = 'That is not a theme. A theme is one .json file, or a folder with a theme.json in it.';

// Everything the scratch server reads from its environment that a person's shell might already have set:
// none of it may leak in (a NOTIFY_URL would be posted to, an ACCESS_PASSWORD would lock the check out).
const SERVER_ENV = ['ROOT', 'ROOT_LABEL', 'SOURCES_DIR', 'PORT', 'PS5_HOST', 'CONFIG_DIR', 'PUBLIC_BASE', 'DEFAULT_THEME', 'ALLOW_ANY_FILE',
  'LOW_SPACE_GB', 'APP_NAME', 'LOG_RANGES', 'NOTIFY_URL', 'NOTIFY_FORMAT', 'NOTIFY_ON', 'FOLLOW_MOVES', 'ACCESS_PASSWORD', 'ACCESS_USER',
  'BIND_ADDRESS', 'ALLOWED_ORIGINS'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Text that came from a file or a server, made safe to print: no control characters, no escape sequences.
// (Built from code points so that no invisible character sits in this source.)
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const BOM_AT_START = new RegExp('^' + String.fromCharCode(0xfeff));
const clean = s => String(s).replace(CONTROL, '?');
const bytesText = n => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

class Bad extends Error {}

// ---- Arguments ---------------------------------------------------------------------
const USAGE = `Usage: node tools/themes/check.js <theme> [options]

  <theme>                 a theme file (sunset.json), a theme folder (aurora/), or the theme.json inside a folder

Options:
  --json                  print one JSON object, {ok, problems, warnings, theme, report, exit}, instead of text
  --allow-low-contrast    exit 0 instead of 2 when only explicit overrides leave a pair below its minimum
  --server <url>          ask a running ShadowPKG (http://host:port) instead of starting a scratch one
  --port <n>              port for the scratch server (default: a free one from 13600 to 13619, else any free one);
                          it is printed on the "checked by" line. Not with --server
  --verbose, -v           also print every resolved token: the colours the theme ends up with
  --help, -h              this text

Exit codes:
  0  valid, and every readability pair passes
  1  not valid, or unreadable, or a pair derived from the palette fails (an engine bug)
  2  valid, but an explicit override in "tokens" leaves a pair below its minimum (a warning)

Without --server it starts this checkout's server.js on a free loopback port with a temporary config folder,
asks it, and stops it again. Nothing is written outside that folder, and nothing leaves this machine.
`;

function parseArgs(argv) {
  const o = { json: false, allowLow: false, verbose: false, help: false, server: null, port: 0, target: null, error: null };
  const targets = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) targets.push(a);
    else if (a === '--') rest = true;
    else if (a === '--json') o.json = true;
    else if (a === '--allow-low-contrast') o.allowLow = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--server' || a.startsWith('--server=')) {
      const v = a === '--server' ? argv[++i] : a.slice('--server='.length);
      if (!v) o.error = o.error || '--server needs an address, for example --server http://192.168.1.10:12801';
      else o.server = v;
    } else if (a === '--port' || a.startsWith('--port=')) {
      const v = a === '--port' ? argv[++i] : a.slice('--port='.length);
      const n = Number(v);
      if (v === undefined || v === '' || !/^\d{1,5}$/.test(String(v)) || n < 1 || n > 65535) o.error = o.error || `--port needs a whole number from 1 to 65535, not "${clean(v === undefined ? '' : v)}"`;
      else o.port = n;
    } else if (a.startsWith('-') && a !== '-') o.error = o.error || `unknown option ${clean(a)}`;
    else targets.push(a);
  }
  if (targets.length > 1) o.error = o.error || 'give one theme to check, not several';
  if (o.port && o.server) o.error = o.error || '--port is for the scratch server, and --server asks a server that is already running: use one or the other';
  o.target = targets[0] || null;
  if (!o.help && !o.error && !o.target) o.error = 'no theme given';
  return o;
}

// ---- The engine: cut out of index.html and run in a vm ------------------------------
// The block is plain functions and constants with no DOM in it, so a fresh context is all it needs. Calls go
// through vm scripts with a time limit, and pass data as JSON, so nothing is shared with this realm.
function loadEngine() {
  let html;
  try { html = fs.readFileSync(INDEX_HTML, 'utf8'); } catch (e) { throw new Error(`cannot read ${INDEX_HTML} (${e.code || e.message})`); }
  const a = html.indexOf(ENGINE_START), b = html.indexOf(ENGINE_END);
  if (a < 0 || b <= a) throw new Error(`the theme engine is not where it should be: no "${ENGINE_START}" ... "${ENGINE_END}" in ${INDEX_HTML}`);
  const sandbox = vm.createContext({});
  try { vm.runInContext(html.slice(a, b), sandbox, { filename: 'index.html (theme engine)', timeout: 5000 }); }
  catch (e) { throw new Error(`the theme engine in index.html did not load: ${e && e.message}`); }
  const call = (expr, arg) => { sandbox.__arg = arg; return vm.runInContext(expr, sandbox, { timeout: 5000 }); };
  for (const fn of ['deriveTokens', 'contrastReport', 'themeSlug', 'parseColor']) {
    if (call(`typeof ${fn}`) !== 'function') throw new Error(`the theme engine in index.html has no ${fn}()`);
  }
  // The page's own size limits for what it will read (index.html, the TH_MAX_* constants beside the drop handler).
  const pick = name => { const m = new RegExp('\\b' + name + '\\s*=\\s*(\\d+)').exec(html); return m ? parseInt(m[1], 10) : null; };
  const found = { file: pick('TH_MAX_FILE'), folder: pick('TH_MAX_FOLDER'), asset: pick('TH_MAX_ASSET'), files: pick('TH_MAX_FILES') };
  const dflt = { file: 1048576, folder: 4194304, asset: 1572864, files: 24 };
  const missing = Object.keys(found).filter(k => found[k] === null);
  const limits = {};
  for (const k of Object.keys(found)) limits[k] = found[k] === null ? dflt[k] : found[k];
  return {
    limits, limitsNote: missing.length ? `could not read the page's size limits (${missing.join(', ')}) from index.html, so the defaults were used` : '',
    slug: name => String(call('themeSlug(__arg)', String(name))),
    color: v => JSON.parse(call('JSON.stringify(parseColor(__arg))', String(v))),
    // -> {tokens: every token's resolved value, report: the readability rows, names: the catalogue in order}
    derive: theme => JSON.parse(call(
      'JSON.stringify((() => { const t = JSON.parse(__arg); const tokens = deriveTokens(t); return { tokens, report: contrastReport(tokens), names: THEME_TOKEN_LIST.map(x => x[0]) }; })())',
      JSON.stringify(theme))),
  };
}

// ---- Reading the theme, as the page's drop handler does -------------------------------
// -> {form, body, text?, left, label} or {problems}
function readInput(target, eng) {
  const abs = path.resolve(target);
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { problems: [`${clean(target)}: ${e.code === 'ENOENT' ? 'no such file or folder' : e.code || e.message}`] }; }
  try {
    if (st.isDirectory()) return readFolder(abs, eng);
    if (!st.isFile()) return { problems: [NOT_THEME] };
    // theme.json is a folder theme's manifest: the folder around it is the theme, with its css and assets
    if (path.basename(abs).toLowerCase() === 'theme.json') return { ...readFolder(path.dirname(abs), eng), viaManifest: true };
    return readSingle(abs, st, eng);
  } catch (e) {
    if (e instanceof Bad) return { problems: [e.message] };
    return { problems: [`${clean(target)}: could not be read (${e.code || e.message})`] };
  }
}

function readSingle(abs, st, eng) {
  const name = path.basename(abs);
  if (!/\.json$/i.test(name)) throw new Bad(NOT_THEME);
  if (st.size > eng.limits.file) throw new Bad(`${clean(name)} is ${bytesText(st.size)}. A theme file can be up to 1 MB; a theme with pictures or fonts needs to be a folder.`);
  const text = fs.readFileSync(abs).toString('utf8').replace(BOM_AT_START, '');
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Bad(`${clean(name)} is not valid JSON: ${clean(e.message)}`); }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.shadowtheme !== 1) throw new Bad(`${clean(name)} is JSON, but not a ShadowPKG theme: it has no "shadowtheme": 1 in it.`);
  // with no id the page names the theme after its file
  if (m.id === undefined || m.id === null || m.id === '') { const slug = eng.slug(name); if (slug) m.id = slug; }
  return { form: 'file', body: { theme: m }, text, left: [] };
}

// The folder as the page walks a dropped one: files only, four levels down, and no more than 400 entries.
function readFolder(dir, eng) {
  const L = eng.limits;
  const root = path.basename(dir);
  const items = [];
  let seen = 0;
  const walk = (abs, rel, depth) => {
    if (++seen > 400) throw new Bad('That folder has far too many files to be a theme.');
    let st;
    try { st = fs.statSync(abs); } catch { return; }          // a broken link is nothing
    if (st.isFile()) items.push({ rel, abs, size: st.size });
    else if (st.isDirectory() && depth < 4) {
      let names;
      try { names = fs.readdirSync(abs).sort(); } catch { return; }
      for (const n of names) walk(path.join(abs, n), rel ? `${rel}/${n}` : n, depth + 1);
    }
  };
  walk(dir, '', 0);
  const keep = [], left = [];
  for (const i of items) {
    if (i.rel === 'theme.json' || i.rel === 'theme.css' || /^assets\/[^/]+$/.test(i.rel)) keep.push(i); else left.push(i.rel);
  }
  if (!keep.some(i => i.rel === 'theme.json')) throw new Bad(NOT_THEME);
  if (keep.length > L.files) throw new Bad(`That is ${keep.length} files. A theme folder can have up to ${L.files}.`);
  const big = keep.find(i => i.size > L.asset);
  if (big) throw new Bad(`${clean(big.rel)} is ${bytesText(big.size)}. A file in a theme can be up to 1.5 MB.`);
  const total = keep.reduce((n, i) => n + i.size, 0);
  if (total > L.folder) throw new Bad(`The theme is ${bytesText(total)}. A theme folder can be up to 4 MB.`);
  const files = {};
  for (const i of keep) {
    if (i.rel === 'theme.json') {
      let text = fs.readFileSync(i.abs).toString('utf8').replace(BOM_AT_START, '');
      let m = null;
      try { const v = JSON.parse(text); m = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch {}
      if (m && m.shadowtheme !== 1) throw new Bad('theme.json is not a ShadowPKG theme: it has no "shadowtheme": 1 in it.');
      // with no id the page names the theme after its folder
      if (m && (m.id === undefined || m.id === null || m.id === '') && eng.slug(root)) { m.id = eng.slug(root); text = JSON.stringify(m, null, 2); }
      files[i.rel] = text;
    } else if (i.rel === 'theme.css') files[i.rel] = fs.readFileSync(i.abs).toString('utf8');
    else files[i.rel] = fs.readFileSync(i.abs).toString('base64');
  }
  return { form: 'folder', body: { files }, left, fileCount: keep.length };
}

// ---- Talking to a server -------------------------------------------------------------
// A plain http request, so a redirect or a proxy's page is seen as it is and Node 18 prints no warning about fetch.
// body: an object (sent as JSON) or a string (sent as it is). -> {status, text, json}
function httpRequest(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname.replace(/^\//, ''), base.endsWith('/') ? base : base + '/');
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, agent: false, headers }, res => {
      const chunks = [];
      let got = 0;
      res.on('data', c => { got += c.length; if (got > MAX_ANSWER) req.destroy(new Error('the answer is too large')); else chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

function normaliseServer(text) {
  let s = String(text).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Bad(`--server ${clean(text)} is not an address (try http://192.168.1.10:12801)`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Bad(`--server needs an http or https address, not ${clean(u.protocol)}`);
  return s.replace(/\/+$/, '');
}
// The address without the password, for printing.
function redact(base) {
  try { const u = new URL(base); if (u.password) u.password = '***'; return u.href.replace(/\/$/, ''); } catch { return clean(base); }
}

// One check request. -> {theme, warnings} for an accepted theme, {problems} for anything else.
async function askCheck(base, body, what) {
  let r;
  try { r = await httpRequest(base, 'POST', '/api/themes/check', body); }
  catch (e) {
    const code = e && (e.code || e.message);
    if (/^(EPIPE|ECONNRESET)$/.test(code)) return { problems: [`the server closed the connection while ${what} was being sent (${code}); it may be larger than the server accepts`] };
    if (code === 'timed out') return { problems: [`${redact(base)} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`] };
    return { problems: [`cannot reach ${redact(base)} (${clean(code)})`] };
  }
  const j = r.json;
  if (r.status === 401) return { problems: [`${redact(base)} asks for a password (HTTP 401). Put it in the address: http://shadow:PASSWORD@host:port`] };
  if ((r.status === 404 || r.status === 405) && !(j && Array.isArray(j.problems))) return { problems: ['This server cannot check themes; it needs a newer ShadowPKG.'] };
  if (r.status === 200 && j && j.ok === true) {
    if (!j.theme || typeof j.theme !== 'object') return { problems: ['The server sent back something that is not a theme.'] };
    return { theme: j.theme, warnings: Array.isArray(j.warnings) ? j.warnings.map(String) : [] };
  }
  if (j && Array.isArray(j.problems) && j.problems.length) return { problems: j.problems.map(String) };
  return { problems: [(j && j.error) ? String(j.error) : `the server did not accept it (HTTP ${r.status})`] };
}

// The page turns a dropped file into an object before it posts it, and an object cannot have a key twice, so a
// file that has one gets through a drop with its last value. The server refuses such a file when it is put in
// its themes folder by hand. The same text is posted as it is, to see whether the server minds.
async function askStrict(base, text) {
  let r;
  try { r = await httpRequest(base, 'POST', '/api/themes/check', `{"theme":${text}}`); } catch { return ''; }
  const first = r.status === 400 && r.json && Array.isArray(r.json.problems) ? String(r.json.problems[0]) : '';
  const m = /^The request (has the key .*more than once|is nested too deeply|is not valid JSON)$/.exec(first);
  return m ? m[1] : '';
}

// ---- The scratch server -------------------------------------------------------------
// Free when nothing answers on it and it can be bound. Both are asked: on Windows a server that listens on every
// address does not stop a bind to 127.0.0.1 alone, and the more specific one would then take its local traffic.
function isFree(port) {
  return new Promise(resolve => {
    const c = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const end = ok => { if (done) return; done = true; c.destroy(); resolve(ok); };
    c.setTimeout(500, () => end(false));
    c.once('connect', () => end(false));
    c.once('error', () => {
      done = true;
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
    });
  });
}
// The free ports of the range, starting at a random one so that two checks run together do not queue for the
// same port, then a random free port from the system as the last resort.
async function pickPorts(range = SCRATCH_PORTS) {
  const all = [];
  for (let p = range[0]; p <= range[1]; p++) all.push(p);
  const start = Math.floor(Math.random() * all.length);
  const out = [];
  for (let i = 0; i < all.length; i++) { const p = all[(start + i) % all.length]; if (await isFree(p)) out.push(p); }
  await new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve());
    s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => { const p = s.address().port; s.close(() => { out.push(p); resolve(); }); });
  });
  return out;
}

function removeDir(dir) {
  if (!dir || !path.basename(dir).startsWith(TMP_PREFIX)) return '';
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); return ''; }
  catch (e) { return `could not remove ${dir} (${e.code || e.message})`; }
}

// A run that was cut off without a chance to clean up (the machine went down, the whole process tree was killed) leaves
// its folder behind. Each folder names its owner in owner.pid, so the next run can tell a folder that is in use from one
// that is not, and removes those whose owner is gone, as long as they are not brand new.
function sweepStale() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(TMP_PREFIX)); } catch { return; }
  for (const n of names) {
    const dir = path.join(os.tmpdir(), n);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < 30000) continue;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8'), 10); } catch {}
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      if (!alive) removeDir(dir);
    } catch {}
  }
}

class Scratch {
  constructor(portRange, fixedPort = 0) { this.dir = null; this.child = null; this.port = 0; this.url = ''; this.log = ''; this.portRange = portRange; this.fixedPort = fixedPort; }

  async start() {
    sweepStale();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    fs.writeFileSync(path.join(this.dir, 'owner.pid'), String(process.pid));
    for (const d of ['cfg', 'lib', 'extra']) fs.mkdirSync(path.join(this.dir, d));
    const ports = this.fixedPort ? [this.fixedPort] : await pickPorts(this.portRange);
    let last = 'no free port';
    for (const port of ports) {
      const r = await this.tryStart(port);
      if (r.ready) return;
      if (r.busy) { if (this.fixedPort) throw new Error(`could not start the scratch server: port ${port} (from --port) is already in use; give another port, or leave --port out`); last = `port ${port} was taken`; continue; }
      throw new Error(`could not start the scratch server: ${r.error}`);
    }
    throw new Error(`could not start the scratch server: ${last}`);
  }

  tryStart(port) {
    return new Promise(resolve => {
      // A fresh environment for the server: only what this run says, and loopback only, so it is never on the network.
      const env = { ...process.env };
      for (const k of SERVER_ENV) delete env[k];
      Object.assign(env, {
        ROOT: path.join(this.dir, 'lib'), ROOT_LABEL: 'Check', SOURCES_DIR: path.join(this.dir, 'extra'), PORT: String(port),
        CONFIG_DIR: path.join(this.dir, 'cfg'), PS5_HOST: '127.0.0.1:9', FOLLOW_MOVES: '0', BIND_ADDRESS: '127.0.0.1', LOW_SPACE_GB: '0',
      });
      // On Windows a child that is not detached is killed at once when this process dies, without a chance to remove its
      // folder; a detached one sees the pipe close, stops the way docker stop does, and removes the folder.
      let child;
      try { child = cp.spawn(process.execPath, [__filename, '--run-server', SERVER_JS, this.dir], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'win32' }); }
      catch (e) { return resolve({ error: `node could not be started (${e.message})` }); }
      this.child = child; this.port = port; this.url = `http://127.0.0.1:${port}`; this.log = '';
      const t0 = Date.now();
      const line = new RegExp(`127\\.0\\.0\\.1:${port}, libraries`);
      let settled = false, poll = null;
      const done = v => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); resolve(v); };
      const onData = d => { this.log = (this.log + d).slice(-6000); if (line.test(this.log)) done({ ready: true }); };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', e => done({ error: `node could not be started (${e.message})` }));
      child.on('exit', code => {
        if (this.child === child) this.child = null;
        done(/EADDRINUSE/.test(this.log) ? { busy: true } : { error: `it stopped at once (exit ${code}): ${clean(this.log.trim().split('\n').slice(-3).join(' | '))}` });
      });
      const timer = setTimeout(() => done({ error: `it did not answer within ${START_TIMEOUT_MS / 1000} s` }), START_TIMEOUT_MS);
      // If the startup line ever changes, an answer to /healthz from a process that has stayed up is enough.
      poll = setInterval(() => {
        if (Date.now() - t0 < 600) return;
        httpRequest(this.url, 'GET', '/healthz').then(r => { if (r.status === 200 && child.exitCode === null) done({ ready: true }); }, () => {});
      }, 100);
    });
  }

  // Stops the server and removes its folder. Safe to call more than once. -> a note when something was left behind.
  async stop() {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null && c.signalCode === null) {
      const gone = new Promise(r => c.once('exit', r));
      try { c.stdin.destroy(); } catch {}
      try { c.kill(); } catch {}
      await Promise.race([gone, sleep(2000)]);
      if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(1000)]); }
    }
    const note = removeDir(this.dir);
    if (!note) this.dir = null;
    return note;
  }

  // The last resort, from an 'exit' listener, where only synchronous work runs.
  stopSync() {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch {} }
    if (!removeDir(this.dir)) this.dir = null;
  }
}

// Runs inside the scratch process: loads the real server.js, and ends when the check that started it is gone,
// whatever way it went (Ctrl-C, a kill, a crash), so a server is never left running. The pipe from the parent
// closes when the parent does. The server then stops the way it does for a docker stop, and its folder goes.
function runServerChild(serverJs, tmp) {
  process.on('exit', () => { if (tmp && path.dirname(path.resolve(tmp)) === path.resolve(os.tmpdir())) removeDir(tmp); });
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    if (!process.emit('SIGTERM')) process.exit(0);
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.stdin.on('end', quit); process.stdin.on('close', quit); process.stdin.on('error', quit);
  process.stdin.resume();
  require(serverJs);
}

// Signals and 'exit': stop the scratch server and remove its folder whatever ends the run. -> a function that lets go.
function guard(scratch) {
  const codes = { SIGINT: 130, SIGBREAK: 131, SIGHUP: 129, SIGTERM: 143 };
  const handlers = [];
  let ending = false;
  for (const sig of Object.keys(codes)) {
    const h = () => {
      if (ending) return;
      ending = true;
      process.stderr.write('interrupted: stopping the scratch server and removing its folder\n');
      const exit = () => process.exit(codes[sig]);
      setTimeout(exit, 5000).unref();
      scratch.stop().then(exit, exit);
    };
    try { process.on(sig, h); handlers.push([sig, h]); } catch {}
  }
  const onExit = () => scratch.stopSync();
  process.on('exit', onExit);
  return () => { for (const [sig, h] of handlers) process.removeListener(sig, h); process.removeListener('exit', onExit); };
}

// ---- What the engine says about an accepted theme -------------------------------------
// Every pair is judged twice: with the theme's explicit tokens (what the page will show), and from the palette alone.
// A pair that fails with the tokens and passes without them fails because of them, however the two are connected
// (a see-through outline button is drawn over the page colour, so an overridden --bg reaches it too). A pair that
// also fails from the palette alone, with nothing of its own overridden, is the derivation breaking its promise.
function analyse(theme, eng) {
  const own = new Set(Object.keys(theme.tokens && typeof theme.tokens === 'object' ? theme.tokens : {}));
  const given = { id: theme.id, base: theme.base, mode: theme.mode, palette: theme.palette };
  const out = eng.derive({ ...given, tokens: theme.tokens });
  const pure = own.size ? eng.derive({ ...given, tokens: {} }) : out;
  const pureBy = new Map(pure.report.map(r => [r.pair, r]));
  const report = out.report.map(r => {
    const p = pureBy.get(r.pair);
    const direct = [r.fg, r.bg].filter(t => own.has(t));
    const changed = !!p && p.ratio !== r.ratio;
    let overridden = direct;
    if (!direct.length && changed) { overridden = ['--bg', '--dlg-bg'].filter(t => own.has(t)); if (!overridden.length) overridden = [...own].slice(0, 3); }
    return {
      pair: r.pair, fg: r.fg, bg: r.bg, fgValue: out.tokens[r.fg], bgValue: out.tokens[r.bg], ratio: r.ratio, min: r.min, ok: !!r.ok,
      extra: !!r.extra, from: overridden.length ? 'override' : 'derived', overridden,
      // the palette alone fails it as well, and nothing of its own is overridden: not the theme's doing
      engineBug: !r.ok && !direct.length && !!p && !p.ok,
    };
  });
  const notes = [];
  // The ratio takes a see-through text colour as solid, so an override with alpha reads better than it is.
  const seen = new Set();
  for (const r of report) {
    if (!own.has(r.fg) || seen.has(r.fg)) continue;
    seen.add(r.fg);
    let c = null;
    try { c = eng.color(r.fgValue); } catch {}
    if (c && c[3] < 0.999) notes.push(`${r.fg} is see-through (alpha ${Math.round(c[3] * 100) / 100}); the readability ratio treats it as solid, so the real ratio is lower`);
  }
  // Values a theme's css sets on a token are applied by the page after the token block, and the engine never sees them.
  const set = new Set();
  const css = String(theme.css || '').replace(/"[^"]*"/g, '""');
  const known = new Set(out.names);
  for (const m of css.matchAll(/[{;]\s*(--[A-Za-z0-9_-]+)\s*:/g)) if (known.has(m[1])) set.add(m[1]);
  if (set.size) notes.push(`css sets ${[...set].join(', ')}: values set in css are not in the readability report; check them by eye, or put them in "tokens"`);
  const resolved = {};
  for (const n of out.names) resolved[n] = out.tokens[n];
  return { report, notes, resolved, overrides: [...own] };
}

// ---- Output --------------------------------------------------------------------------
function summary(theme) {
  return {
    id: theme.id, name: theme.name, author: theme.author || '', description: theme.description || '', version: theme.version || '',
    base: theme.base, mode: theme.mode, form: theme.form, bytes: theme.bytes, palette: theme.palette || null,
    hasFonts: !!theme.hasFonts, hasCss: !!theme.hasCss, hasTokens: !!theme.hasTokens, editable: !!theme.editable,
  };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
// Rows of cells as aligned lines; right: the columns (by index) that are right-aligned, as numbers are.
const table = (rows, right = []) => {
  const w = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
  return rows.map(r => r.map((v, c) => (c === r.length - 1 ? String(v) : right.includes(c) ? String(v).padStart(w[c]) + '  ' : String(v).padEnd(w[c] + 2))).join('').trimEnd());
};

function renderText(res, ctx) {
  const L = [];
  L.push(`theme: ${clean(ctx.label)}${ctx.form ? ` (${ctx.form})` : ''}`);
  if (ctx.server) L.push(`checked by: ${ctx.server}`);
  const t = res.theme;
  if (t) {
    L.push('', `ACCEPTED: ${clean(t.name)}`);
    const rows = [['id', clean(t.id)], ['name', clean(t.name)], ['base', clean(t.base)], ['mode', clean(t.mode)], ['form', clean(t.form)], ['bytes', String(t.bytes)]];
    if (t.author) rows.push(['author', clean(t.author)]);
    if (t.version) rows.push(['version', clean(t.version)]);
    if (t.description) rows.push(['description', clean(t.description)]);
    const uses = [];
    if (t.palette) uses.push(`palette (${Object.keys(t.palette).length} colours)`);
    if (t.hasTokens) uses.push(`tokens (${ctx.overrides.length})`);
    if (t.hasCss) uses.push('css');
    if (t.hasFonts) uses.push('fonts');
    rows.push(['uses', uses.join(', ') || 'nothing']);
    L.push(...table(rows).map(l => '  ' + l));
  }
  if (res.problems.length) {
    const n = `${res.problems.length} problem${res.problems.length === 1 ? '' : 's'}`;
    L.push('', t ? `problems (${n}):` : ctx.checked ? `REJECTED: ${n}` : `NOT CHECKED: ${n}`);
    for (const p of res.problems) L.push(`  - ${clean(p)}`);
  }
  if (res.warnings.length) { L.push('', 'warnings:'); for (const w of res.warnings) L.push(`  - ${clean(w)}`); }
  if (res.report) {
    const bad = res.report.filter(r => !r.ok);
    L.push('', `readability: ${res.report.length} pairs, ${bad.length ? bad.length + ' below their minimum' : 'all at or above their minimum'}`);
    const rows = [['pair', 'ratio', 'min', 'result', 'from']];
    for (const r of res.report) rows.push([r.pair, r.ratio.toFixed(2), String(r.min), r.ok ? 'PASS' : 'FAIL', r.overridden.length ? `override (${r.overridden.join(', ')})` : 'derived']);
    L.push(...table(rows, [1, 2]).map(l => '  ' + l));
    for (const r of bad) L.push(`  FAIL ${clean(r.pair)}: ${r.fg} ${cut(clean(r.fgValue), 40)} on ${r.bg} ${cut(clean(r.bgValue), 60)} is ${r.ratio.toFixed(2)}:1, needs ${r.min}`);
    if (ctx.opts.verbose) {
      L.push('', 'resolved tokens (what the theme ends up with):');
      const rs = [['token', 'from', 'value']];
      for (const [k, v] of Object.entries(ctx.resolved)) rs.push([k, ctx.overrides.includes(k) ? 'override' : 'derived', cut(clean(v), 72)]);
      L.push(...table(rs).map(l => '  ' + l));
    }
  }
  L.push('', `exit ${res.exit}: ${ctx.reason}`);
  return L.join('\n') + '\n';
}

// ---- The run -------------------------------------------------------------------------
// hooks (for tests): afterStart(scratch) runs once the scratch server answers, before the theme is posted.
// -> {out, err, code}. Only signals end the process from in here; the caller prints and exits.
async function run(argv, hooks = {}) {
  const opts = parseArgs(argv);
  if (opts.help) return { out: USAGE, err: '', code: 0 };
  const res = { ok: false, problems: [], warnings: [], theme: null, report: null, exit: 1 };
  const ctx = { opts, label: opts.target || '', form: '', server: '', checked: false, reason: '', overrides: [] };
  const scratch = new Scratch(hooks.portRange, opts.port);
  if (opts.error) res.problems.push(opts.error);
  else {
    const release = guard(scratch);
    try { await check(opts, res, ctx, scratch, hooks); }
    catch (e) { res.ok = false; res.theme = null; res.report = null; res.problems.push(e && e.message ? e.message : String(e)); ctx.reason = 'the check could not be done'; }
    finally {
      const note = await scratch.stop();
      if (note) res.warnings.push(note);
      release();
    }
  }
  if (!ctx.reason) ctx.reason = opts.error ? 'the command line is not right (see --help)' : 'the theme was not accepted';
  if (opts.json) return { out: JSON.stringify({ ok: res.ok, problems: res.problems, warnings: res.warnings, theme: res.theme, report: res.report, exit: res.exit }, null, 2) + '\n', err: '', code: res.exit };
  if (opts.error) return { out: '', err: `check.js: ${res.problems[0]}\n\n${USAGE}`, code: 1 };
  return { out: renderText(res, ctx), err: '', code: res.exit };
}

async function check(opts, res, ctx, scratch, hooks) {
  const eng = loadEngine();
  if (eng.limitsNote) res.warnings.push(eng.limitsNote);
  const inp = readInput(opts.target, eng);
  if (inp.problems) { res.problems.push(...inp.problems); ctx.reason = 'the input could not be read as a theme'; return; }
  ctx.form = inp.form === 'folder'
    ? `folder theme, ${inp.fileCount} file${inp.fileCount === 1 ? '' : 's'}${inp.viaManifest ? `, read from the folder around theme.json` : ''}`
    : 'single file';
  if (inp.left.length) res.warnings.push(`left out of the folder (not part of a theme): ${inp.left.slice(0, 6).map(clean).join(', ')}${inp.left.length > 6 ? ` and ${inp.left.length - 6} more` : ''}`);

  let base;
  if (opts.server) { base = normaliseServer(opts.server); ctx.server = redact(base); }
  else {
    await scratch.start();
    base = scratch.url;
    ctx.server = `a scratch server.js on 127.0.0.1:${scratch.port} (stopped afterwards)`;
    if (hooks.afterStart) await hooks.afterStart(scratch);
  }
  ctx.checked = true;
  const got = await askCheck(base, inp.body, 'the theme');
  if (got.problems) { res.problems.push(...got.problems); ctx.reason = 'the server did not accept the theme'; return; }
  if (inp.form === 'file') {
    const why = await askStrict(base, inp.text);
    if (why) {
      res.problems.push(`the file ${why}. Dropping it on the page works (the last value is kept), but the server does not use a file like this from its themes folder`);
      ctx.reason = 'the theme was not accepted as a file in the themes folder';
      return;
    }
  }
  res.warnings.push(...got.warnings);
  res.theme = summary(got.theme);

  const an = analyse(got.theme, eng);
  res.report = an.report;
  res.warnings.push(...an.notes);
  ctx.overrides = an.overrides;
  res.theme.overrides = an.overrides;
  ctx.resolved = an.resolved;
  if (opts.verbose) res.theme.resolved = an.resolved;

  const fails = an.report.filter(r => !r.ok);
  const fromPalette = fails.filter(r => r.engineBug);
  const fromOverride = fails.filter(r => !r.engineBug);
  if (fromPalette.length) {
    res.ok = false; res.exit = 1;
    const names = fromPalette.map(r => r.pair).join(', ');
    res.problems.push(`engine bug: ${fromPalette.length} pair${fromPalette.length === 1 ? '' : 's'} worked out from the palette fail${fromPalette.length === 1 ? 's' : ''} (${names}). The derivation promises these, so this is a fault in the theme engine, not in the theme`);
    ctx.reason = 'a pair derived from the palette is below its minimum (an engine bug)';
    return;
  }
  res.ok = true;
  if (fromOverride.length) {
    for (const r of fromOverride) res.warnings.push(`readability: ${r.pair} is ${r.ratio.toFixed(2)}:1, needs ${r.min} (explicit override of ${r.overridden.join(', ')})`);
    if (opts.allowLow) { res.exit = 0; ctx.reason = `valid; ${fromOverride.length} pair${fromOverride.length === 1 ? '' : 's'} below the minimum come from explicit overrides (allowed by --allow-low-contrast)`; }
    else { res.exit = 2; ctx.reason = `valid, but explicit overrides leave ${fromOverride.length} pair${fromOverride.length === 1 ? '' : 's'} below the minimum (--allow-low-contrast accepts this)`; }
    return;
  }
  res.exit = 0;
  ctx.reason = 'valid, and every readability pair passes';
}

function cli(argv) {
  run(argv).then(r => {
    if (r.err) process.stderr.write(r.err);
    const fin = () => process.exit(r.code);
    setTimeout(fin, 5000).unref();
    if (r.out) process.stdout.write(r.out, fin); else fin();
  }, e => { process.stderr.write(`check.js: ${e && e.stack || e}\n`); process.exit(1); });
  process.stdout.on('error', () => {});
}

if (require.main === module) {
  // --run-server <server.js> <folder> is how a scratch server is started (see Scratch); it is not for people
  const a = process.argv;
  if (a[2] === '--run-server' && a.length === 5 && path.isAbsolute(a[3]) && path.isAbsolute(a[4])) runServerChild(a[3], a[4]);
  else cli(a.slice(2));
} else {
  module.exports = { run, parseArgs, loadEngine, readInput, pickPorts, isFree, Scratch, askCheck, analyse, REPO };
}
