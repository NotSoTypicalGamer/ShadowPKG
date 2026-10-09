#!/usr/bin/env node
'use strict';
// Shows a ShadowPKG theme the way a person would see it, and checks that its text can be read.
//
//   node tools/themes/preview.js <theme .json file or theme folder> --out <folder> [--phone] [--browser <path>]
//   node tools/themes/preview.js --builtin ps1 --out <folder>          (a built-in look, for a baseline)
//
// What it does, all in temporary folders that are removed when it ends:
//   1. starts this checkout's server.js on a free port with a scratch library of made-up packages (PS4 and PS5, a game with
//      updates and DLC, a game dump, an archive, other files), a history with one entry of every kind, and two consoles;
//   2. installs the theme on that server through POST /api/themes, exactly as the page would, and points the page at it;
//   3. opens the page in a headless Chrome or Edge, driven over the DevTools protocol, and takes PNGs of each view: the list,
//      two rows selected with the tray, a game dump, History with every Details open, Activity, the Themes picker, Setup, the
//      theme maker and the dialog a dropped theme file opens; a long view is taken a screen at a time. At 1000x800, and with
//      --phone again at 375x760 (scale 2);
//   4. for each PNG, reads every piece of text on the screen and measures its contrast against what is really drawn behind it:
//      the page is captured a second time with its text made invisible and the pixels under each word are sampled, so
//      gradients and images count, and text inside a faded element is measured as it is drawn. Text below 4.5:1 (3:1 when it is
//      large, or is a lone mark such as a tick or an arrow) is listed with a selector and the colours.
//
// It writes the PNGs and a preview.json (the same findings, for scripts) into --out, prints where each PNG is with one line
// on what to look at in it, and ends with a FINDINGS summary: every piece of text below its ratio, each marked page-own (the page
// itself produces it; every theme shows it), base-look (a colour the base look hard-codes) or NEW (this theme causes it), then a
// one-line VERDICT that says which. Read that last line first.
//
// Exit codes: 0 all text passes; 1 some text is below its ratio; 2 it could not run, or could not take every view (a bad theme,
// no browser, a server or browser problem, a page that no longer answers to this script). Needs Node 22 or newer (the built-in WebSocket) and any Chrome, Edge or Chromium. No npm packages.
//
// What the contrast check leaves out: glows and text-shadows (text that has one and fails is listed apart, and not counted), a
// page-wide layer above the content such as the PS1 scanlines, text that scrolls out of every screen it takes, and what the
// browser draws itself (scrollbars, focus rings). Disabled controls are skipped, as WCAG skips them. The worst 8% of the points
// under a long word are set aside, so a star in a background picture does not condemn it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const net = require('net');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(REPO, 'server.js');
const BUILTINS = ['ps1', 'ps1v2', 'midnight', 'purple', 'nes', 'snes', 'dreamcast', 'wii', 'itsmemario', 'yoshisisland', 'oled', 'nathan', 'win95', 'spookemon'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const START = Date.now();

// ---- Findings that belong to the page, not to a theme --------------------------------------------------
// The built-in looks fail the contrast measure in a few places too. This list (measured by running this script on all fourteen
// built-ins, and on light and dark custom themes) is what docs/THEMES-FOR-AGENTS.md calls "findings the page itself produces".
// The summary at the end of a run sorts each finding into: page-own (any theme shows it: the page fades the element itself),
// base-look (a colour hard-coded by the base look, shown by the built-in look of that base) or NEW (caused by this theme).
// `re` is tested against the finding's selector, `text` (optional) against the words in it.
const PAGE_OWN = [
  { re: /\.row\.plain\.dim\b.*\.chip/, what: 'the "hidden" chip on a dimmed row (the page fades it to 0.6)' },
  { re: /\.row\.plain\.dim\b/, what: 'the name of a dimmed (hidden) row' },
  { re: /footer\.credits/, what: 'the footer credits and their links (faded to 0.8)' },
  { re: /#banners\b.*\.banner\b.*button/, what: 'the Details button in the warning banner (faded to 0.85)' },
  { re: /\.check\.lv-warn\b.*\.detail/, what: 'the detail text of a warning in Setup (faded to 0.85)' },
  { re: /\.snooze\b/, text: /Hide for a day|Hidden for a day/, what: 'the "Hide for a day" button in Setup' },
  { re: /\.row\.arc\b.*\.chip/, what: 'the "zip archive" chip (faded to 0.92)' },
  { re: /^main > details > summary/, what: 'the "Install from a URL instead" line (muted text on the tinted page)' },
];
// Colours a base look draws for itself, whatever the palette says. `bases` are the looks whose built-in theme shows the finding.
const BASE_LOOK = [
  { bases: ['ps1', 'ps1v2', 'dreamcast', 'itsmemario'], re: /details\.buildopts\b/, what: 'the build-options summary on the dump card' },
  { bases: ['ps1', 'ps1v2', 'dreamcast', 'itsmemario'], re: /\.check\.lv-good\b.*\.mark/, what: 'the tick of a good check in Setup' },
  { bases: ['ps1', 'dreamcast', 'itsmemario'], re: /#deleteBtn/, what: 'the Delete button in the tray' },
  { bases: ['dreamcast', 'itsmemario', 'win95'], re: /nav#crumbs/, what: 'the breadcrumb and its Up button' },
  { bases: ['ps1v2', 'snes'], re: /#(themeMake|send|diagIssue)\b/, what: 'a header or dialog button drawn by the pixel-face looks' },
  { bases: ['snes'], re: /\.theme-opt\b.*\.tcheck/, what: 'the tick in the Themes picker' },
];
// Text on a selected row: --sel-muted is derived at 3.2:1 and the measure asks 4.5:1, so this is the finding a theme most often has, and can fix.
const SEL_ROW = /\.row(\.member)?\.sel\b/;
function classify(f, base) {
  const words = (f.texts || []).join(' ');
  for (const p of PAGE_OWN) if (p.re.test(f.selector) && (!p.text || p.text.test(words))) return { kind: 'page-own', what: p.what };
  for (const b of BASE_LOOK) if (b.bases.includes(base) && b.re.test(f.selector)) return { kind: 'base-look', what: b.what };
  return { kind: 'NEW', what: '', hint: SEL_ROW.test(f.selector) ? 'text on a selected row: raise --sel-muted (quiet text) or --sel-text to 4.5:1 or more on --sel (guide, step 7)' : '' };
}
// -> {kinds, counts, verdict}: what the last lines of a run say about the findings.
function summarise(failures, base, builtin) {
  const kinds = failures.map(g => classify(g, base));
  const counts = { total: failures.length, pageOwn: 0, baseLook: 0, new: 0 };
  for (const k of kinds) { if (k.kind === 'page-own') counts.pageOwn++; else if (k.kind === 'base-look') counts.baseLook++; else counts.new++; }
  const rule = 'Exit codes: 0 all text passes, 1 some text is below its ratio (judge by this VERDICT, not by the code), 2 could not run.';
  const own = counts.pageOwn + ' page-own' + (counts.baseLook ? ', ' + counts.baseLook + ' from the ' + base + ' base look' : '');
  const plural = n => (n === 1 ? '' : 's');
  let verdict;
  if (!counts.total) verdict = 'VERDICT: no findings: every piece of text checked passes. Exit code is 0. ' + rule;
  else if (builtin) verdict = 'VERDICT: baseline for the built-in ' + builtin + ' look, not a theme: ' + counts.total + ' finding' + plural(counts.total) + ' (' + own + ', ' + counts.new + ' other). A theme on this base is expected to show the same page-own ones. The exit code is 1 for these. ' + rule;
  else if (!counts.new) verdict = 'VERDICT: only page-own findings (' + own + '): none comes from this theme, nothing to fix. The exit code is 1 here, and that is expected. ' + rule;
  else verdict = 'VERDICT: ' + counts.new + ' NEW finding' + plural(counts.new) + ' caused by this theme (also ' + own + ', which need no fix): fix the NEW ones (a token override, css that sets its own colour, the base look or a picture behind the text), then run again. The exit code is 1. ' + rule;
  return { kinds, counts, verdict };
}


class Fail extends Error {}                    // an expected problem: printed plainly, exit code 2

const USAGE = `Usage: node tools/themes/preview.js <theme file or folder> --out <folder> [options]
       node tools/themes/preview.js --builtin <id> --out <folder> [options]

  <theme>            a theme .json file, or a folder holding theme.json (and theme.css, assets/)
  --builtin <id>     use a built-in look instead: ${BUILTINS.join(', ')}
  --out <folder>     where the PNGs and preview.json go (created if missing; required)
  --phone            also take every screen at 375x760, scale 2
  --browser <path>   Chrome, Edge or Chromium to use (else $CHROME, then the usual places)
  --pages <n>        most screens of any one long view (default: 3, History 5; a phone gets half as many again)
  --only <a,b,...>   only these views: main, selected, dump, history, activity, themes, setup, maker, install
  --port <n>         port for the scratch server (default: a free one; the ports used are printed near the top)
  --debug-port <n>   port for the browser's debugging connection (default: a free one; the browser listens on 127.0.0.1 only)
  --verbose          say what it is doing
  --keep-temp        leave the scratch folders in place (their path is printed)
  --keep-bg          also save each text-hidden capture as <name>.bg.png: what the contrast is measured against

Exit code 0: every piece of text passes. 1: some text is below 4.5:1 (3:1 large): read the VERDICT on the last line, because a theme that has only
the page's own findings exits 1 too. 2: it could not run, or could not take every view.`;

// ---- Arguments --------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { theme: null, builtin: null, out: null, phone: false, browser: null, pages: 0, only: null, port: 0, debugPort: 0, verbose: false, keep: false, keepBg: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], inline = null;
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    if (eq) { a = eq[1]; inline = eq[2]; }
    const val = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length || (argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) throw new Fail(`${a} needs a value`);
      return argv[++i];
    };
    const num = (min, max) => { const v = val(), n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Fail(`${a} needs a whole number from ${min} to ${max}, not "${v}"`); return n; };
    switch (a) {
      case '--out': o.out = val(); break;
      case '--builtin': o.builtin = val(); break;
      case '--phone': o.phone = true; break;
      case '--browser': o.browser = val(); break;
      case '--pages': o.pages = num(1, 8); break;
      case '--only': o.only = val().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--port': o.port = num(1, 65535); break;
      case '--debug-port': o.debugPort = num(1, 65535); break;
      case '--verbose': o.verbose = true; break;
      case '--keep-temp': o.keep = true; break;
      case '--keep-bg': o.keepBg = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) throw new Fail(`unknown option ${a}\n\n${USAGE}`);
        if (o.theme) throw new Fail(`one theme at a time: got both "${o.theme}" and "${a}"`);
        o.theme = a;
    }
  }
  if (o.help) return o;
  if (!o.theme && !o.builtin) throw new Fail(`give a theme file or folder, or --builtin <id>\n\n${USAGE}`);
  if (o.theme && o.builtin) throw new Fail('give a theme path or --builtin, not both');
  if (o.builtin && !BUILTINS.includes(o.builtin)) throw new Fail(`--builtin ${o.builtin}: not a built-in look. They are ${BUILTINS.join(', ')}`);
  if (!o.out) throw new Fail(`--out <folder> is required\n\n${USAGE}`);
  return o;
}

let VERBOSE = false;
const say = (...a) => { if (VERBOSE) process.stderr.write(`[${((Date.now() - START) / 1000).toFixed(1)}s] ${a.join(' ')}\n`); };

// ---- Cleanup: runs on success, on failure and on Ctrl-C ---------------------------------------------
const cleanups = [];                           // async, run last-in first-out
const children = new Set();                    // every process started here
let tempRoot = null, keepTemp = false, cleaning = null;

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  } catch {}
}
function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {}
}
// A run that was killed outright cannot clean up after itself; the next one removes what it left (a run lasts a few minutes at most).
function sweepStale() {
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!/^shadowpkg-preview-[A-Za-z0-9]{6}$/.test(n)) continue;
      const p = path.join(os.tmpdir(), n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 15 * 60000) removeDir(p); } catch {}
    }
  } catch {}
}
function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch {} }
    for (const c of children) killTree(c);
    if (tempRoot && !keepTemp) removeDir(tempRoot);
  })();
  return cleaning;
}
// Last resort, when the process is going down without having awaited cleanup (an uncaught error, a second Ctrl-C).
process.on('exit', () => {
  for (const c of children) killTree(c);
  if (tempRoot && !keepTemp) removeDir(tempRoot);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { process.stderr.write(`\npreview: stopped (${sig}); cleaning up\n`); cleanup().finally(() => process.exit(130)); }); } catch {}
}

// ---- Finding things ---------------------------------------------------------------------------------
function findBrowser(explicit) {
  const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (explicit) {
    if (!exists(explicit)) throw new Fail(`--browser ${explicit}: no such file`);
    return explicit;
  }
  const list = [process.env.CHROME, process.env.CHROME_BIN];
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean)) {
      list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'chrome']) {
      for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) list.push(path.join(d, n));
    }
    list.push('/snap/bin/chromium', '/usr/bin/google-chrome', '/opt/google/chrome/chrome');
  }
  for (const p of list) if (p && exists(p)) return p;
  throw new Fail('no browser found. This needs Google Chrome, Microsoft Edge or Chromium (any recent version) to take the screenshots.\n'
    + '  Install one, or pass --browser <path to chrome or msedge>, or set the CHROME environment variable to its path.');
}

function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', e => { if (preferred) reject(new Fail(`port ${preferred} is not free (${e.code})`)); else reject(e); });
    s.listen(preferred || 0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- The theme to show ------------------------------------------------------------------------------
// The page's own way of making an id from a file or folder name (index.html, themeSlug), for a theme that has none.
const slug = s => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\.json$/i, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
const bomless = s => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// -> { label, form: 'file'|'folder', body } where body is what POST /api/themes takes
function loadTheme(p) {
  let st;
  try { st = fs.statSync(p); } catch { throw new Fail(`${p}: no such file or folder`); }
  if (st.isFile() && path.basename(p).toLowerCase() === 'theme.json') { p = path.dirname(p); st = fs.statSync(p); }   // the manifest of a folder theme
  if (st.isDirectory()) return loadFolder(p);
  if (!/\.json$/i.test(p)) throw new Fail(`${p}: a theme is a .json file, or a folder with a theme.json in it`);
  if (st.size > 1024 * 1024) throw new Fail(`${p} is ${(st.size / 1048576).toFixed(2)} MiB; a single-file theme is at most 1 MiB (use a folder for pictures and fonts)`);
  const text = bomless(fs.readFileSync(p, 'utf8'));
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Fail(`${p} is not valid JSON: ${e.message}`); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Fail(`${p} must hold one JSON object (the theme's manifest)`);
  if ((m.id === undefined || m.id === null || m.id === '') && slug(path.basename(p))) m.id = slug(path.basename(p));   // as the page does for a dropped file
  return { label: path.basename(p), form: 'file', body: { theme: m } };
}
function loadFolder(dir) {
  const files = {};
  let total = 0, count = 0;
  const add = (rel, buf, asText) => {
    total += buf.length; count++;
    if (total > 8 * 1048576 || count > 60) throw new Fail(`${dir} is too big to be a theme (a theme folder is at most 4 MiB and 24 files)`);
    files[rel] = asText ? bomless(buf.toString('utf8')) : buf.toString('base64');
  };
  if (!fs.existsSync(path.join(dir, 'theme.json'))) throw new Fail(`${dir} has no theme.json (a theme folder holds theme.json, an optional theme.css and an assets folder)`);
  add('theme.json', fs.readFileSync(path.join(dir, 'theme.json')), true);
  // a manifest with no id is given the folder's name, as the page does when a folder is dropped
  try {
    const m = JSON.parse(files['theme.json']), id = slug(path.basename(path.resolve(dir)));
    if (m && typeof m === 'object' && !Array.isArray(m) && (m.id === undefined || m.id === null || m.id === '') && id) { m.id = id; files['theme.json'] = JSON.stringify(m, null, 2); }
  } catch { /* not JSON: the server says so */ }
  if (fs.existsSync(path.join(dir, 'theme.css'))) add('theme.css', fs.readFileSync(path.join(dir, 'theme.css')), true);
  const ad = path.join(dir, 'assets');
  if (fs.existsSync(ad) && fs.statSync(ad).isDirectory()) {
    for (const n of fs.readdirSync(ad).sort()) {
      const f = path.join(ad, n);
      if (fs.statSync(f).isFile()) add('assets/' + n, fs.readFileSync(f), false);
    }
  }
  return { label: path.basename(path.resolve(dir)) + '/', form: 'folder', folder: path.basename(path.resolve(dir)), body: { files } };
}

// ---- The scratch library and config -----------------------------------------------------------------
const MIN = 60000, DAY = 86400000;
const cid = (tid, name) => `UP0001-${tid}_00-${name.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(16, '0').slice(0, 16)}`;

// Everything the server is started with. Sizes are small real files (sparse where the disk allows), so listings and the
// Activity feed are true to what the server sees; History carries its own, larger, numbers.
function seedScratch(lib, cfg) {
  const now = Date.now(), meta = {}, info = { pkgs: {} };
  const mkdir = d => fs.mkdirSync(d, { recursive: true });
  const stamp = (f, days) => { const t = new Date(Math.floor((now - days * DAY) / 1000) * 1000); fs.utimesSync(f, t, t); };
  const stub = (rel, mb, days, m) => {
    const f = path.join(lib, rel);
    mkdir(path.dirname(f));
    const head = Buffer.alloc(4096); head.writeUInt32BE(0x7f434e54, 0);
    fs.writeFileSync(f, head);
    fs.truncateSync(f, Math.round(mb * 1048576));
    stamp(f, days);
    const st = fs.statSync(f);
    if (m) meta['games\n' + rel] = { k: st.size + '|' + st.mtimeMs, meta: m };
    info.pkgs[rel] = { size: st.size, mtime: st.mtime.getTime() };
    return f;
  };
  const small = (rel, text, days) => { const f = path.join(lib, rel); mkdir(path.dirname(f)); fs.writeFileSync(f, text); stamp(f, days); };
  const ps4 = (tid, title, kind, version, more) => ({ platform: 'PS4', titleId: tid, title, contentId: cid(tid, title.replace(/ - .*/, '') + kind), version, kind, ...more });
  const ps5 = (tid, title, kind, version, more) => ({ platform: 'PS5', titleId: tid, title, contentId: cid(tid, title.replace(/ - .*/, '') + kind), version, kind, ...more });

  // the list: two games that group (updates, DLC), plain ones with each kind of chip, an archive, other files
  stub('Neon Drift.pkg', 9, 60, ps4('CUSA12345', 'Neon Drift', 'game', '01.00', { firmware: '9.00' }));
  stub('Neon Drift Update 1.03.pkg', 3, 45, ps4('CUSA12345', 'Neon Drift', 'patch', '01.03', { firmware: '9.00' }));
  stub('Neon Drift Update 1.05.pkg', 4, 20, ps4('CUSA12345', 'Neon Drift', 'patch', '01.05', { firmware: '9.00' }));
  stub('Neon Drift Season Pass DLC.pkg', 6, 30, ps4('CUSA12345', 'Neon Drift - Season Pass', 'DLC', '01.00'));
  stub('Starfall Odyssey.pkg', 36, 12, ps5('PPSA04321', 'Starfall Odyssey', 'game', '01.002.000'));
  stub('Starfall Odyssey - Deluxe Pack.pkg', 5, 10, ps5('PPSA04321', 'Starfall Odyssey - Deluxe Pack', 'DLC', '01.000.000'));
  stub('Ember Trials.pkg', 48, 6, ps5('PPSA07777', 'Ember Trials', 'game', '01.000.000'));
  stub('Retro Racer.pkg', 7, 90, ps4('CUSA00999', 'Retro Racer', 'game', '01.00', { tentative: true }));
  stub('PKGi PS4.pkg', 2, 200, ps4('PKGI13337', 'PKGi PS4', 'game', '01.00', { firmware: '5.05' }));
  stub('mystery-release.pkg', 3, 3, null);
  stub('Nameless.pkg', 4, 5, { platform: 'PS5', titleId: 'PPSA09999', title: null, contentId: cid('PPSA09999', 'nameless'), version: '01.000.000', kind: 'game' });
  small('Bundle Pack.zip', 'PK'.repeat(2048), 8);
  small('readme.txt', 'Notes for this library.\n', 40);
  small('checksums.sfv', 'x\n'.repeat(300), 40);
  small('.hidden-note', 'not a package\n', 100);
  for (const d of ['PS4', 'PS5']) { mkdir(path.join(lib, d)); }
  stub('PS4/Old Racer.pkg', 5, 300, ps4('CUSA05555', 'Old Racer', 'game', '01.00'));
  stub('PS5/Sky Harbor.pkg', 12, 15, ps5('PPSA05555', 'Sky Harbor', 'game', '01.000.000'));

  // game dumps: one that passes the check (with a warning), one the kit would refuse, one being built now
  const dump = (rel, param, extra) => {
    const d = path.join(lib, rel);
    mkdir(path.join(d, 'sce_sys'));
    small(rel + '/sce_sys/param.json', JSON.stringify(param, null, 2), 30);
    small(rel + '/eboot.bin', 'ELF'.repeat(4000), 30);
    small(rel + '/sce_module/libc.prx', 'x'.repeat(3000), 30);
    small(rel + '/Media/intro.bik', 'x'.repeat(9000), 30);
    extra && extra(d);
  };
  const pparam = (cidv, tid, title, ver) => ({ contentId: cidv, titleId: tid, applicationCategoryType: 0, contentVersion: ver, localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: title } } });
  dump('Dumps/Mystery Quest', pparam('UP9000-PPSA12345_00-MYSTERYQUEST0000', 'PPSA12345', 'Mystery Quest', '01.02'), d => {
    fs.writeFileSync(path.join(d, 'sce_sys', 'keystone'), Buffer.alloc(96, 7));
    mkdir(path.join(d, 'sce_module', '.cache'));
    fs.writeFileSync(path.join(d, 'sce_module', '.cache', 'leftover.tmp'), 'x');
  });
  dump('Dumps/Broken Dump', pparam('not-a-content-id', 'PPSA22222', 'Broken Dump', '01.00'), d => {
    fs.writeFileSync(path.join(d, 'sce_sys', 'keystone'), Buffer.alloc(40, 7));
    stub('Dumps/Broken Dump/patch.pkg', 1, 20, null);
  });
  dump('Dumps/Orbital Siege', pparam('UP9000-PPSA33333_00-ORBITALSIEGE0000', 'PPSA33333', 'Orbital Siege', '01.00'), d => {
    fs.writeFileSync(path.join(d, 'sce_sys', 'keystone'), Buffer.alloc(96, 7));
  });
  small('Dumps/notes.txt', 'dump notes\n', 20);

  // the details cache, the way the server writes it
  fs.writeFileSync(path.join(cfg, 'packages.json'), JSON.stringify({ schema: 3, packages: meta }));

  // consoles: a PS5 (answers nothing) and a PS4 whose installer app is closed
  fs.writeFileSync(path.join(cfg, 'profiles.json'), JSON.stringify({ profiles: [
    { id: 'a1b2c3d4', name: 'Living room PS5', host: '127.0.0.1:9' },
    { id: 'e5f6a7b8', name: 'Office PS4', host: '127.0.0.2:12800', installer: 'rpi' },
  ] }));

  // History: one entry of every kind (a send, a failed one, one the console never asked for, downloads, extractions, builds)
  const T = now - 50 * MIN;
  const pk = (rel, extra) => { const m = (meta['games\n' + rel] || {}).meta || {}; return { src: 'games', dir: path.dirname(rel) === '.' ? '' : path.dirname(rel).replace(/\\/g, '/'), path: rel, name: path.basename(rel), meta: { title: m.title || path.basename(rel, '.pkg'), platform: m.platform || 'PS5', kind: m.kind || 'game', contentId: m.contentId || cid('PPSA01000', 'x') }, ...extra }; };
  const H = [
    { type: 'send', status: 'done', ps5: 'Living room PS5', profile: 'a1b2c3d4', ...pk('Starfall Odyssey.pkg'), size: 41e9, message: null, queuedAt: T, startedAt: T + 130000, endedAt: T + 134000, outcome: 'done', outcomeAt: T + 135000 + 14 * MIN + 2000, dlStartedAt: T + 140000, dlEndedAt: T + 140000 + 14 * MIN + 2000, at: now - 1 * MIN },
    { type: 'send', status: 'failed', ps5: 'Living room PS5', profile: 'a1b2c3d4', ...pk('Ember Trials.pkg'), size: 48e9, message: 'Could not reach PS5 at 192.168.1.50:2121: connect ETIMEDOUT', queuedAt: T, startedAt: T + 1000, endedAt: T + 16000, at: now - 2 * MIN },
    { type: 'send', status: 'done', ps5: 'Living room PS5', profile: 'a1b2c3d4', ...pk('Retro Racer.pkg'), size: 7e9, message: null, queuedAt: T, startedAt: T + 2000, endedAt: T + 3000, outcome: 'never', outcomeAt: T + 190000, at: now - 3 * MIN },
    { type: 'download', status: 'done', ps5: 'Living room PS5', ...pk('Neon Drift Season Pass DLC.pkg'), size: 5.2e9, startedAt: T + 10 * MIN, endedAt: T + 10 * MIN + 4 * MIN + 12000, abortsTotal: 1, at: now - 4 * MIN },
    { type: 'download', status: 'aborted', ps5: 'Office PS4', ...pk('Neon Drift Update 1.05.pkg'), size: 5.2e9, received: 2.1e9, startedAt: T + 20 * MIN, endedAt: T + 26 * MIN, abortsTotal: 5, at: now - 5 * MIN },
    { type: 'extract', status: 'done', ...pk('Bundle Pack.zip', { meta: null }), size: 12e9, message: 'extracted 3 packages in 190s with 7z', queuedAt: T, startedAt: T + 40000, endedAt: T + 40000 + 190000, tool: '7z', mode: 'all', count: 3, at: now - 6 * MIN },
    { type: 'extract', status: 'failed', ...pk('Broken Bundle.rar', { meta: null }), size: 4e9, message: 'none of the installed tools can decompress this archive', queuedAt: T, startedAt: T + 1000, endedAt: T + 9000, mode: 'packages', at: now - 7 * MIN },
    { type: 'build', status: 'done', ...pk('Dumps/UP9000-PPSA12345_00-MYSTERYQUEST0000.pkg', { meta: { title: 'Mystery Quest', platform: 'PS5', kind: 'game', contentId: 'UP9000-PPSA12345_00-MYSTERYQUEST0000' } }), size: 1.2e9, dumpBytes: 2e9, files: 812, message: 'built from a game dump', queuedAt: T - 5 * MIN, startedAt: T, endedAt: T + 610000,
      stats: { seconds: 610, cores: 8, avgCores: 6.5, peakMemGB: 9.1, memLimitGB: 16, readMBs: 120, writeMBs: 80, ioWaitPct: 4, limit: 'CPU: nearly every core was busy' },
      phases: [{ name: 'starting', seconds: 2 }, { name: 'fetching', seconds: 60 }, { name: 'preparing', seconds: 20 }, { name: 'packing', seconds: 510 }, { name: 'copying', seconds: 18 }], at: now - 8 * MIN },
    { type: 'build', status: 'failed', ...pk('Dumps/UP9000-PPSA22222_00-BROKENDUMP000000.pkg', { meta: { title: 'Broken Dump', platform: 'PS5', kind: 'game', contentId: 'UP9000-PPSA22222_00-BROKENDUMP000000' } }), dumpBytes: 9e9, message: 'the kit stopped with exit code 1', queuedAt: T, startedAt: T + 20000, endedAt: T + 20000 + 21 * MIN,
      phases: [{ name: 'starting', seconds: 2 }, { name: 'preparing', seconds: 30 }, { name: 'packing', seconds: 1228 }], at: now - 9 * MIN },
    { type: 'send', status: 'done', ps5: 'Living room PS5', ...pk('PS5/Sky Harbor.pkg'), size: 12e9, message: null, endedAt: T + 5 * MIN, outcome: 'done', at: now - 11 * MIN },
    { type: 'send', status: 'failed', ps5: 'Living room PS5', src: null, dir: null, path: null, name: 'http://192.168.1.10/x.pkg', meta: null, size: null, message: 'refused', endedAt: T + 6 * MIN, at: now - 13 * MIN },
  ].map((h, i) => ({ id: 'h' + String(i).padStart(11, '0'), ...h }));
  fs.writeFileSync(path.join(cfg, 'history.json'), JSON.stringify({ history: H }));

  // Activity: a paused download and a finished one, picked up when the server starts (a live one is opened later), and a build under way
  const tr = (ip, rel, frac, lastAgo, aborts, recorded) => {
    const p = info.pkgs[rel];
    return { key: `${ip}|games|${rel}`, id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'), ip, srcId: 'games', rel, size: p.size, mtime: p.mtime, firstAt: now - lastAgo - 9 * MIN, lastAt: now - lastAgo,
      recorded, abortsTotal: aborts, noted: false, stuckNoted: 0, stopped: false, intervals: [[0, Math.round(p.size * frac)]] };
  };
  fs.writeFileSync(path.join(cfg, 'transfers.json'), JSON.stringify({ schema: 1, transfers: [
    tr('127.0.0.2', 'Starfall Odyssey.pkg', 0.62, 4 * MIN, 4, true),
    tr('127.0.0.1', 'Neon Drift Season Pass DLC.pkg', 1, 2 * MIN, 1, true),
  ] }));
  const jobId = 'a1b2c3d4e5f6', jobRel = 'Dumps/.shadowpkg-build/' + jobId;
  mkdir(path.join(lib, jobRel));
  fs.writeFileSync(path.join(cfg, 'builds.json'), JSON.stringify({ builds: [{ id: jobId, src: 'games', jobRel, dumpRel: 'Dumps/Orbital Siege', outputDirRel: 'Dumps', contentId: 'UP9000-PPSA33333_00-ORBITALSIEGE0000', title: 'Orbital Siege', createdAt: now - 9 * MIN, recorded: false, dumpBytes: 3e9 }] }));
  // a builder heartbeat and the job's progress; refreshed while the run lasts, or the server calls them stale
  info.heartbeat = () => {
    const iso = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(lib, '.shadowpkg-builder.json'), JSON.stringify({ updated: iso, kind: 'container', host: 'preview', ready: true, busy: { title: 'Orbital Siege' }, version: 1, problems: [], checks: [
        { id: 'kit', label: 'Repack kit', ok: true, detail: 'found', fix: '' }, { id: 'disk', label: 'Free disk space', ok: true, detail: '412 GB free', fix: '' },
        { id: 'net', label: 'Reaching the library share', ok: false, detail: 'slow: 4 MB/s', fix: 'Check the network cable or Wi-Fi between the builder and the server.' }] }));
      fs.writeFileSync(path.join(lib, jobRel, 'state.json'), JSON.stringify({ state: 'running', message: 'packing', updated: iso, startedAt: new Date(now - 6 * MIN).toISOString(), percent: 41, written: 1.2e9 }));
    } catch {}
  };
  info.heartbeat();
  info.liveFile = 'Ember Trials.pkg';
  return info;
}

// ---- Scratch server ---------------------------------------------------------------------------------
async function startServer(dir, port) {
  const env = { ...process.env };
  for (const k of ['ACCESS_PASSWORD', 'ACCESS_USER', 'ALLOWED_ORIGINS', 'ALLOW_ANY_FILE', 'DEFAULT_THEME', 'NOTIFY_URL', 'NOTIFY_FORMAT', 'NOTIFY_ON', 'SOURCES_DIR', 'LOW_SPACE_GB', 'LOG_RANGES', 'APP_NAME']) delete env[k];
  Object.assign(env, { ROOT: path.join(dir, 'lib'), ROOT_LABEL: 'Games', PORT: String(port), CONFIG_DIR: path.join(dir, 'cfg'), PS5_HOST: '127.0.0.1:9', FOLLOW_MOVES: '0', BIND_ADDRESS: '127.0.0.1', PUBLIC_BASE: `http://127.0.0.1:${port}` });
  const child = cp.spawn(process.execPath, [SERVER_JS], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  children.add(child);
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  const url = `http://127.0.0.1:${port}`;
  const t = Date.now();
  for (;;) {
    if (exited) throw new Fail(`the scratch server stopped at start-up (${exited.code !== null ? 'exit ' + exited.code : exited.sig}):\n${log.trim().split('\n').slice(-8).join('\n')}`);
    try { const r = await fetch(url + '/api/sources'); if (r.ok) break; } catch {}
    if (Date.now() - t > 20000) throw new Fail(`the scratch server did not answer within 20 s:\n${log.trim().split('\n').slice(-8).join('\n')}`);
    await sleep(100);
  }
  cleanups.push(async () => { killTree(child); });
  return { child, url, port, log: () => log };
}
async function api(server, method, p, body) {
  const r = await fetch(server.url + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

// A download that is under way: half the file fetched and read to the end, then the rest asked for and left hanging, the way a
// console does it (Range requests). The server counts what it has served, so Activity shows a real bar and a Stop button.
async function startLiveDownload(server, seeded) {
  const http = require('http');
  const rel = seeded.liveFile, size = seeded.pkgs[rel].size;
  const url = `${server.url}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const half = Math.floor(size * 0.5);
  await new Promise((resolve, reject) => {
    const r = http.get(url, { headers: { Range: `bytes=0-${half - 1}` }, agent: false }, res => { res.on('data', () => {}); res.on('end', resolve); res.on('error', reject); });
    r.on('error', reject);
  });
  const req = http.get(url, { headers: { Range: `bytes=${half}-` }, agent: false }, res => { res.pause(); });
  req.on('error', () => {});
  cleanups.push(async () => { try { req.destroy(); } catch {} });
}
// The server shows a speed and a time left for a few seconds after data moved: wait until that has died down, so the bar reads the
// same in every screenshot.
async function liveSettled(server, seeded) {
  const t = Date.now();
  while (Date.now() - t < 12000) {
    const j = await api(server, 'GET', '/api/downloads');
    const d = (j.j.downloads || []).find(x => x.path === seeded.liveFile);
    if (!d || d.status !== 'downloading' || !d.speed) return;
    await sleep(400);
  }
}

// ---- The browser, over the DevTools protocol --------------------------------------------------------
async function launchBrowser(exe, profileDir, wantPort) {
  const args = ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-search-engine-choice-screen', '--password-store=basic', '--use-mock-keychain',
    '--force-color-profile=srgb', '--proxy-server=127.0.0.1:9', '--disable-dev-shm-usage', '--remote-allow-origins=*', `--remote-debugging-port=${wantPort || 0}`, `--user-data-dir=${profileDir}`, 'about:blank'];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  const child = cp.spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  children.add(child);
  let err = '', exited = null;
  child.stderr.on('data', d => { err = (err + d).slice(-2000); });
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  child.on('error', e => { exited = { code: null, sig: e.message }; });
  let port = 0;
  const t = Date.now();
  while (!port) {
    if (exited) throw new Fail(`the browser (${exe}) exited at start-up (${exited.code !== null ? 'exit ' + exited.code : exited.sig}). ${err.trim().split('\n').slice(-3).join(' ')}`);
    if (Date.now() - t > 25000) throw new Fail(`the browser (${exe}) did not open its debugging port within 25 s`);
    if (wantPort) { try { if ((await fetch(`http://127.0.0.1:${wantPort}/json/version`)).ok) port = wantPort; } catch {} }
    else {
      try { const n = parseInt(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0], 10); if (n) { await fetch(`http://127.0.0.1:${n}/json/version`); port = n; } } catch {}
    }
    if (!port) await sleep(100);
  }
  let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = targets.find(x => x.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  cleanups.push(async () => {
    try { await Promise.race([cdp.send('Browser.close'), sleep(1500)]); } catch {}
    const t2 = Date.now();
    while (child.exitCode === null && child.signalCode === null && Date.now() - t2 < 2500) await sleep(50);
    killTree(child);
  });
  return { child, cdp, port };
}

function connectCdp(wsUrl) {
  if (typeof WebSocket === 'undefined') throw new Fail(`this Node (${process.version}) has no built-in WebSocket; use Node 22 or newer`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map(), handlers = new Map();
    const api = {
      send(method, params = {}, ms = 30000) {
        return new Promise((res, rej) => {
          const i = ++id;
          const timer = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out after ${ms / 1000} s`)); }, ms);
          pending.set(i, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); }, method });
          try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { pending.delete(i); clearTimeout(timer); rej(e); }
        });
      },
      on(method, fn) { (handlers.get(method) || handlers.set(method, []).get(method)).push(fn); },
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Fail('could not open the connection to the browser'));
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result); } }
      else if (m.method) for (const f of handlers.get(m.method) || []) f(m.params);
    };
    ws.onclose = () => { api.closed = true; for (const p of pending.values()) p.rej(new Error('the browser closed the connection')); pending.clear(); };
  });
}

// ---- PNG reading (8-bit RGB/RGBA, not interlaced: what Chrome writes) ---------------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8 || interlace || (ctype !== 2 && ctype !== 6)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype})`);
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], so = y * (stride + 1) + 1, doff = y * stride, poff = doff - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[doff + x - bpp] : 0, b = y ? out[poff + x] : 0, c = y && x >= bpp ? out[poff + x - bpp] : 0;
      let v = raw[so + x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[doff + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

// ---- Contrast ---------------------------------------------------------------------------------------
const LIN = Float64Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
const lum = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Each record is one run of text: its colour, its opacity, and the boxes (CSS px) it occupies on the screen. The worst
// contrast over pixels sampled inside those boxes decides it. `bg1` is the screen with its text invisible; `bg2`, when
// something is see-through, is the same with every opacity put to 1. A see-through text colour, or one inside an element
// with an opacity, is laid over what is under it first, so the ratio is between the two colours as they are drawn.
function judge(recs, bg1, bg2, scale) {
  const bad = [];
  let checked = 0;
  const at = (png, px, py) => (Math.min(png.h - 1, Math.max(0, py)) * png.w + Math.min(png.w - 1, Math.max(0, px))) * png.bpp;
  for (const r of recs) {
    const found = [];                                        // [ratio, bg, fg, at] for each sample
    const [tr, tg, tb, ta] = r.fg, op = r.op;
    const group = op < 0.98 && bg2;                          // the text and its background fade together, toward what is beneath
    for (const [x0, y0, x1, y1] of r.rects) {
      const cols = Math.min(28, Math.max(2, Math.ceil((x1 - x0) / 3))), rows = Math.min(6, Math.max(2, Math.ceil((y1 - y0) / 3)));
      for (let j = 0; j < rows; j++) {
        const py = Math.round((y0 + (y1 - y0) * (j + 0.5) / rows) * scale);
        for (let i = 0; i < cols; i++) {
          const px = Math.round((x0 + (x1 - x0) * (i + 0.5) / cols) * scale);
          const o1 = at(bg1, px, py), b = [bg1.data[o1], bg1.data[o1 + 1], bg1.data[o1 + 2]];
          const f = [0, 0, 0];
          if (group) {
            const o2 = at(bg2, px, py);
            for (let k = 0; k < 3; k++) {
              const own = bg2.data[o2 + k];                                       // the element's own background
              const under = Math.max(0, Math.min(255, (b[k] - op * own) / (1 - op)));   // what it fades into
              f[k] = op * (ta * [tr, tg, tb][k] + (1 - ta) * own) + (1 - op) * under;
            }
          } else for (let k = 0; k < 3; k++) f[k] = op * ta * [tr, tg, tb][k] + (1 - op * ta) * b[k];
          const fr = Math.round(f[0]), fg = Math.round(f[1]), fb = Math.round(f[2]);
          const l1 = lum(fr, fg, fb), l2 = lum(b[0], b[1], b[2]);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          found.push([ratio, b, [fr, fg, fb], [Math.round(px / scale), Math.round(py / scale)]]);
        }
      }
    }
    if (!found.length) continue;
    // A speck behind the text (a star in an image, a dither dot) does not make a word unreadable: the worst few percent of the
    // samples are set aside once there are enough of them to tell a speck from a real change of background.
    found.sort((a, b) => a[0] - b[0]);
    const [worst, worstBg, worstFg, worstAt] = found[found.length >= 13 ? Math.floor(found.length * 0.08) : 0];
    checked++;
    const need = r.large ? 3 : 4.5;
    if (worst < need - 0.005) bad.push({ selector: r.s, text: r.t, fg: hex(...worstFg), bg: hex(...worstBg), ratio: Math.round(worst * 100) / 100, need, large: r.large, shadow: r.shadow, fontPx: r.size, at: worstAt, box: r.rects[0].map(Math.round), opacity: op < 0.98 ? Math.round(op * 100) / 100 : undefined });
  }
  return { checked, bad };
}

// Runs inside the page. Lists every run of visible text in `scopeSel` (the whole page when null) that is on screen now.
/* eslint-disable no-undef */
function pageCollect(scopeSel, seenKey) {
  const scope = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!scope) return { error: 'nothing matches ' + scopeSel };
  const seen = window[seenKey] || (window[seenKey] = new WeakSet());
  const de = document.documentElement, vw = de.clientWidth, vh = de.clientHeight;
  const recs = [], skipped = { disabled: 0, covered: 0, gradientText: 0, repeated: 0, cut: 0, by: [] };
  const parse = s => {
    let m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(s);
    if (m) { const p = m[1].split(/[\s/]+/).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const selOf = el => {
    const parts = [];
    for (let e = el, n = 0; e && e.nodeType === 1 && e !== document.body && n < 4; e = e.parentElement, n++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + e.id); break; }
      const c = Array.from(e.classList).slice(0, 3);
      if (c.length) s += '.' + c.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const geoCache = new Map();
  const geo = el => {
    if (geoCache.has(el)) return geoCache.get(el);
    let op = 1, hidden = false, clip = [0, 0, vw, vh];
    for (let e = el; e && e !== de; e = e.parentElement) {
      const cs = getComputedStyle(e);
      op *= parseFloat(cs.opacity);
      if (cs.visibility === 'hidden' && e === el) hidden = true;
      if (e !== document.body && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
        const r = e.getBoundingClientRect(), l = r.left + e.clientLeft, t = r.top + e.clientTop;
        clip = [Math.max(clip[0], l), Math.max(clip[1], t), Math.min(clip[2], l + e.clientWidth), Math.min(clip[3], t + e.clientHeight)];
      }
    }
    const g = { op, hidden, clip };
    geoCache.set(el, g);
    return g;
  };
  const visibleRects = (raw, el, g) => {
    const out = [];
    let whole = true;
    for (const r of raw) {
      const c = [Math.max(r.left, g.clip[0]), Math.max(r.top, g.clip[1]), Math.min(r.right, g.clip[2]), Math.min(r.bottom, g.clip[3])];
      if (c[2] - c[0] < 2 || c[3] - c[1] < 2) { whole = false; continue; }
      if (Math.abs(c[0] - r.left) > 0.5 || Math.abs(c[1] - r.top) > 0.5 || Math.abs(c[2] - r.right) > 0.5 || Math.abs(c[3] - r.bottom) > 0.5) {
        whole = false;
        // a line that is mostly cut off by the edge of the screen or of a scrolled box is judged on the screen where it is whole
        if (c[3] - c[1] < 0.7 * r.height || c[2] - c[0] < 0.5 * r.width) { skipped.cut++; continue; }
      }
      // the middle and the four corners must show this text and not something laid over it (the tray, a menu)
      let under = null;
      for (const [x, y] of [[(c[0] + c[2]) / 2, (c[1] + c[3]) / 2], [c[0] + 1, c[1] + 1], [c[2] - 1, c[1] + 1], [c[0] + 1, c[3] - 1], [c[2] - 1, c[3] - 1]]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !reachable(el, hit)) { under = hit || false; break; }
      }
      if (under !== null) { skipped.covered++; whole = false; if (skipped.by.length < 6) skipped.by.push(selOf(el) + '  under  ' + (under ? selOf(under) : 'nothing')); continue; }
      out.push(c);
    }
    return { out, whole };
  };
  // The text is on top at that point: it is the element hit, or inside it, or in a parent (the text is not hit-testable, or its
  // box is smaller than the line it sits on), or the next word beside it. Something laid over it is another thing entirely.
  const reachable = (el, hit) => hit === el || el.contains(hit) || hit.contains(el) || hit.parentElement === el.parentElement;
  // Inside a closed <details> (beyond its <summary>) nothing is drawn, though the browser still knows where it would be.
  const folded = el => {
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
      if (!d.open) { const sm = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!sm || !sm.contains(el)) return true; }
    }
    return false;
  };
  const big = (size, bold) => size >= 24 || (size >= 18.66 && bold);
  const push = (el, text, fill, op, rects, note) => {
    const cs = getComputedStyle(el), size = parseFloat(cs.fontSize), bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const t = text.trim(), icon = t.length <= 3 && !/[\p{L}\p{N}]/u.test(t);      // a lone mark (a tick, a cross, an arrow) is an icon: 3:1
    recs.push({ s: selOf(el), t: text.trim().replace(/\s+/g, ' ').slice(0, 40) + (note || ''), fg: fill, op, rects, size: Math.round(size * 10) / 10, large: big(size, bold) || icon, shadow: cs.textShadow !== 'none' });
  };
  const range = document.createRange();
  const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    if (!/\S/.test(n.nodeValue)) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,template,noscript,option,textarea,select,svg,title,.aa')) continue;   // .aa: the sample letters in a readability report, drawn in the pair they report on
    if (seen.has(n)) { skipped.repeated++; continue; }
    if (folded(el)) continue;
    const g = geo(el);
    if (g.op < 0.02 || g.hidden) continue;
    const cs = getComputedStyle(el);
    if (el.closest(':disabled,[aria-disabled="true"]')) { skipped.disabled++; continue; }
    range.selectNodeContents(n);
    const raw = Array.from(range.getClientRects()).filter(r => r.width >= 1 && r.height >= 1);
    if (!raw.length) continue;
    const fill = parse(cs.webkitTextFillColor) || parse(cs.color);
    if (!fill) continue;
    if (fill[3] * g.op < 0.05) { if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') skipped.gradientText++; continue; }
    const v = visibleRects(raw, el, g);
    if (!v.out.length) continue;
    if (v.whole) seen.add(n);
    push(el, n.nodeValue, fill, g.op, v.out);
  }
  // text a control draws itself: the value or placeholder of a field, the chosen option of a menu
  for (const el of scope.querySelectorAll('input,textarea,select')) {
    const type = (el.type || '').toLowerCase();
    if (/^(hidden|checkbox|radio|color|file|range|button|submit|reset|image)$/.test(type)) continue;
    if (el.disabled) { skipped.disabled++; continue; }
    if (seen.has(el)) { skipped.repeated++; continue; }
    if (folded(el)) continue;
    const cs = getComputedStyle(el), g = geo(el);
    if (g.op < 0.02 || g.hidden) continue;
    let text = '', fill = null, note = '';
    if (el.tagName === 'SELECT') text = el.selectedOptions[0] ? el.selectedOptions[0].text : '';
    else if (el.value) text = el.value;
    else if (el.placeholder) { text = el.placeholder; fill = parse(getComputedStyle(el, '::placeholder').color); note = ' (placeholder)'; }
    if (!text.trim()) continue;
    fill = fill || parse(cs.webkitTextFillColor) || parse(cs.color);
    if (!fill) continue;
    const r = el.getBoundingClientRect(), pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const w = Math.min(r.width - pl - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth), text.length * parseFloat(cs.fontSize) * 0.55);
    const box = { left: r.left + pl, top: r.top + pt, right: r.left + pl + Math.max(4, w), bottom: r.bottom - pt };
    const v = visibleRects([box], el, g);
    if (!v.out.length) continue;
    if (v.whole) seen.add(el);
    push(el, text, fill, g.op, v.out, note);
  }
  return { recs, skipped, vw, vh };
}

// Runs inside the page. Whether what is on screen is wider than the screen (the page scrolls sideways) or than the dialog that
// holds it, and the first things that stick out. An element inside a box that scrolls or clips on purpose is not counted.
function pageOverflow(scopeSel) {
  const de = document.documentElement, scope = scopeSel ? document.querySelector(scopeSel) : null;
  const out = { page: scope ? 0 : de.scrollWidth - de.clientWidth, box: scope ? scope.scrollWidth - scope.clientWidth : 0, wide: [] };
  if (out.page <= 1 && out.box <= 1) return out;
  const root = scope || document.body, limit = scope ? scope.getBoundingClientRect().right - scope.clientLeft : de.clientWidth;
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + Array.from(e.classList).slice(0, 2).map(c => '.' + c).join('');
  const clipped = e => { for (let a = e.parentElement; a && a !== root; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
  for (const e of root.querySelectorAll('*')) {
    if (out.wide.length >= 3) break;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.right > limit + 1 && !e.closest('svg') && getComputedStyle(e).visibility !== 'hidden' && !clipped(e)) out.wide.push(`${name(e)} ends ${Math.round(r.right - limit)}px past the edge`);
  }
  return out;
}

// ---- The views --------------------------------------------------------------------------------------
// Each view: how to get the page into the state, what to scroll, which part to measure, and what to look at.
// `scroll` is what scrolls (the page, or a dialog: a dialog scrolls as a whole, header and all); `scope` is what is measured
// (null: the page); `pages` is the most screens taken of it (a phone gets half as many again); `anchor` (page views) is the
// element the first screen starts at.
const VIEWS = [
  { key: 'main', name: 'main', title: 'the library list', scroll: 'page', scope: null, pages: 3,
    hint: 'header buttons and logo, the bars for a download and a build, the toolbar toggles and chips, folder rows, groups with their "Game + newest update" chip, chips (game/DLC/version/PS5/unconfirmed/no title), the archive row, dim hidden rows, the footer' },
  { key: 'selected', name: 'selected', title: 'two rows selected, tray showing', scroll: 'page', scope: null, pages: 1, anchor: '#view .panel', anchorGap: 96,
    hint: 'the selected-row colour and the text on it, checkbox ticks, member rows under an open group, the bottom tray (count, Delete / Rename / Copy links / Send buttons)' },
  { key: 'dump', name: 'dump', title: 'a folder that is a game dump', scroll: 'page', scope: null, pages: 3, anchor: 'nav.crumbs', anchorGap: 12,
    hint: 'the path above the card (Up button, folder links), the dump card (title, chips), its check rows (ok and warning marks), the build buttons and options, the builder line, then the dump\'s own folders and files' },
  { key: 'history', name: 'history', title: 'History, every Details open', scroll: '#historyDlg', scope: '#historyDlg', pages: 5,
    hint: 'the Sent / Failed / Downloaded / Incomplete / Extracted / Built pills, the grey meta lines, the Details labels against their values, status words, buttons; all of it on the panel' },
  { key: 'activity', name: 'activity', title: 'the Activity dialog', scroll: '#dlDlg', scope: '#dlDlg', pages: 3,
    hint: 'a build and a download in progress (progress bars, Stop / Cancel buttons), a Paused and a Finished download, the restart note, the History / Clear / Done buttons' },
  { key: 'themes', name: 'themes', title: 'the Themes picker', scroll: '#themeDlg', scope: '#themeDlg', pages: 3,
    hint: 'this theme\'s row (its swatch, the ticked mark, Custom badge, Edit / Export / Delete) among the built-ins, then the add-your-own buttons and the server-default menu' },
  { key: 'setup', name: 'setup', title: 'Setup and network', scroll: '#diagDlg', scope: '#diagDlg', pages: 3,
    hint: 'the first-run help box, check rows with their good / warning / bad marks, the address field, the row of buttons at the bottom' },
  { key: 'maker', name: 'maker', title: 'the theme maker', scroll: '#themeMakeDlg', scope: '#themeMakeDlg', pages: 3,
    hint: 'form fields and colour pickers on the dialog background, the readability report (a failing row is drawn in the error colour), the Advanced section, the four save buttons' },
  // what dropping this theme's file on the page shows; only for a theme given as a file or folder
  { key: 'install', name: 'install', title: 'the Add a theme dialog (dropping this theme on the page)', scroll: '#themeAddDlg', scope: '#themeAddDlg', pages: 2, needsTheme: true,
    hint: 'the theme\'s name and badges, the six colour swatches, the readability table opened (a failing row is drawn in the error colour), warnings, the Try it / Install for every device / This browser only buttons' },
];

// ---- Main -------------------------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  VERBOSE = opts.verbose;
  keepTemp = opts.keep;
  if (typeof fetch !== 'function' || typeof WebSocket === 'undefined') throw new Fail(`Node 22 or newer is needed (this is ${process.version}): it has the built-in WebSocket this uses`);
  if (!fs.existsSync(SERVER_JS)) throw new Fail(`${SERVER_JS} not found: this script lives in tools/themes of a ShadowPKG checkout`);
  const only = opts.only ? new Set(opts.only) : null;
  if (only) for (const k of only) if (!VIEWS.some(v => v.key === k)) throw new Fail(`--only ${k}: not a view. They are ${VIEWS.map(v => v.key).join(', ')}`);

  // read the theme and find a browser before anything is started, so a mistake costs no time
  const theme = opts.theme ? loadTheme(opts.theme) : null;
  const browserExe = findBrowser(opts.browser);
  const out = path.resolve(opts.out);
  try { fs.mkdirSync(out, { recursive: true }); fs.accessSync(out, fs.constants.W_OK); } catch (e) { throw new Fail(`cannot write to --out ${opts.out}: ${e.message}`); }

  sweepStale();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowpkg-preview-'));
  const lib = path.join(tempRoot, 'lib'), cfg = path.join(tempRoot, 'cfg'), prof = path.join(tempRoot, 'browser');
  for (const d of [lib, cfg, prof]) fs.mkdirSync(d);
  say('scratch folders in', tempRoot);
  if (keepTemp) process.stderr.write(`preview: scratch folders kept in ${tempRoot}\n`);
  const watchdog = setTimeout(() => { process.stderr.write('preview: gave up after 5 minutes\n'); cleanup().finally(() => process.exit(2)); }, 5 * 60000);
  watchdog.unref();

  say('seeding the scratch library');
  const seeded = seedScratch(lib, cfg);
  const beat = setInterval(seeded.heartbeat, 15000); beat.unref();
  cleanups.push(async () => clearInterval(beat));

  // a port that was free a moment ago can be taken by another run starting at the same time: ask again
  let server = null, port = 0;
  for (let attempt = 0; !server; attempt++) {
    port = await freePort(opts.port);
    say('starting the server on', port);
    try { server = await startServer(tempRoot, port); }
    catch (e) { if (attempt >= 2 || opts.port || !/EADDRINUSE/.test(e.message)) throw e; }
  }

  // the theme goes in through the API, as the page's Install button does
  let themeId, themeInfo;
  if (theme) {
    const chk = await api(server, 'POST', '/api/themes/check', theme.body);
    if (chk.status === 404) throw new Fail(`this checkout's server.js has no theme API (POST /api/themes/check answered 404), so a theme cannot be installed to preview; --builtin still works`);
    if (chk.status !== 200 || !chk.j.ok) {
      const probs = Array.isArray(chk.j.problems) && chk.j.problems.length ? chk.j.problems : [chk.j.error || `HTTP ${chk.status}`];
      throw new Fail(`the server would not accept ${theme.label}:\n${probs.map(x => '  - ' + x).join('\n')}`);
    }
    const warnings = chk.j.warnings || [];
    const ins = await api(server, 'POST', '/api/themes', theme.body);
    if (ins.status !== 200 || !ins.j.ok) throw new Fail(`the server would not install ${theme.label}: ${(ins.j.problems || [ins.j.error || 'HTTP ' + ins.status]).join('; ')}`);
    themeId = ins.j.theme.id;
    themeInfo = { ...ins.j.theme, warnings };
    say('installed', themeId);
  } else themeId = opts.builtin;
  const isCustom = !BUILTINS.includes(themeId);

  await startLiveDownload(server, seeded);   // so Activity has a download in progress as well as a paused and a finished one
  const settling = liveSettled(server, seeded).catch(() => {});      // runs while the browser starts
  say('starting the browser', browserExe);
  const { cdp, port: debugPortUsed } = await launchBrowser(browserExe, prof, opts.debugPort);
  const problems = new Set();
  const noteProblem = t => { if (problems.size < 30) problems.add(t); };
  cdp.on('Runtime.exceptionThrown', p => noteProblem('script error: ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text || '').split('\n')[0]));
  cdp.on('Log.entryAdded', p => { if (p.entry.level === 'error') noteProblem(`${p.entry.text}${p.entry.url ? ' (' + p.entry.url.replace(/^https?:\/\/[^/]+/, '') + ')' : ''}`); });
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') noteProblem('console.error: ' + p.args.map(a => a.value !== undefined ? a.value : a.description || '').join(' ').slice(0, 200)); });
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.send(m);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page script failed: ' + ((r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value)) || r.exceptionDetails.text).split('\n').slice(0, 3).join(' '));
    return r.result.value;
  };
  const until = async (expr, ms = 15000) => {
    const t = Date.now();
    for (;;) {
      let v; try { v = await ev(expr); } catch {}
      if (v) return v;
      if (Date.now() - t > ms) return false;
      await sleep(80);
    }
  };
  // A wait the views depend on: when it runs out the picture is still taken, but the report says it may not show what it should.
  const stale = [], broken = [];
  const cdpGone = () => !!cdp.closed;
  let viewNow = '';
  const want = async (expr, ms) => { const ok = await until(expr, ms); if (!ok) stale.push(`${viewNow}: still waiting after ${ms / 1000} s for ${expr.replace(/\s+/g, ' ').slice(0, 90)}`); return ok; };
  const frames = () => ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const png = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');

  const mainUrl = `http://127.0.0.1:${port}/`;
  // Set before any of the page's own scripts run: no first-run dialog, this theme chosen, hidden files shown.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('shadowpkg.setupSeen','1');localStorage.setItem('shadowpkg.theme',${JSON.stringify(themeId)});localStorage.setItem('shadowpkg.hidden','1')}catch(e){}` });

  const sizes = [{ tag: '', label: 'desktop 1000x800', w: 1000, h: 800, dpr: 1, mobile: false }];
  if (opts.phone) sizes.push({ tag: '-phone', label: 'phone 375x760 @2x', w: 375, h: 760, dpr: 2, mobile: true });
  const shots = [];
  let liveReq = null;

  async function openPage(size) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: size.mobile });
    await cdp.send('Page.navigate', { url: mainUrl + '?' + Date.now() + '#/games' });
    if (!await until("document.readyState === 'complete' && typeof listing !== 'undefined' && listing && listing.pkgs && listing.pkgs.length > 0", 20000)) throw new Fail('the page did not show the library within 20 s');
    // the theme has to be on the page before anything is photographed
    const want = JSON.stringify(themeId);
    const applied = await until(isCustom
      ? `typeof painted !== 'undefined' && painted && painted.id === ${want} && !painted.degraded && document.documentElement.getAttribute('data-custom') === ${want}`
      : `document.documentElement.getAttribute('data-theme') === ${want} && !document.documentElement.hasAttribute('data-custom')`, 15000);
    if (!applied) {
      const state = await ev("({ theme: document.documentElement.getAttribute('data-theme'), custom: document.documentElement.getAttribute('data-custom'), painted: typeof painted !== 'undefined' && painted ? { id: painted.id, degraded: !!painted.degraded } : null, applied: typeof appliedTheme !== 'undefined' ? appliedTheme : null })").catch(() => ({}));
      throw new Fail(`the page did not switch to theme "${themeId}" within 15 s (page state: ${JSON.stringify(state)})`);
    }
    await ev('document.fonts.ready.then(() => true)');
    for (const f of await ev("[...document.fonts].filter(f => f.status === 'error').map(f => f.family)")) noteProblem(`the font "${f}" did not load`);
    await frames();
    await sleep(300);
  }
  // Every dialog shut (the maker through its own Cancel, so the theme it was previewing is put back), no trial running.
  const closeAll = () => ev(`(() => {
    const m = document.getElementById('mkClose');
    if (m && document.getElementById('themeMakeDlg').open) m.click();
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    window.scrollTo(0, 0);
    const t = document.getElementById('tryBar');
    if (t && !t.hidden) document.getElementById('tryUndo').click();
    return true; })()`);

  // How each view gets to its state.
  const enter = {
    async main() {
      await closeAll();
      await ev("selected.clear(); location.hash = '#/games'; true");
      await want("listing && listing.dir === '' && document.querySelectorAll('#view .row').length > 4", 8000);
      await ev('window.scrollTo(0, 0); true');
    },
    async selected() {
      await enter.main();
      await ev(`(() => {
        const g = document.querySelector('.row.grp'); if (g && !g.classList.contains('open')) g.click();
        return true; })()`);
      await want("document.querySelectorAll('.row.member').length > 0", 5000);
      await ev(`(() => {
        const pick = re => { const r = [...document.querySelectorAll('#view .row')].find(x => re.test(x.textContent) && x.querySelector('input[type=checkbox]') && !x.classList.contains('grp')); if (r) r.querySelector('input[type=checkbox]').click(); };
        pick(/Ember Trials/); pick(/Neon Drift\\.pkg/); return true; })()`);
      await want("document.getElementById('tray').classList.contains('show') && selected.size >= 2", 5000);
    },
    async dump() {
      await closeAll();
      await ev("selected.clear(); location.hash = '#/games/Dumps/Mystery%20Quest'; true");
      await want("listing && listing.dump && document.querySelector('.dumpcard')", 8000);
      seeded.heartbeat();
      await ev("(() => { const b = [...document.querySelectorAll('.dumpcard .dlacts button')].find(x => /Check this dump|Check again/.test(x.textContent)); if (b) b.click(); return true; })()");
      await want("(() => { const c = dumpChecks.get(currentSrc() + '|' + listing.dir); return c && c.state === 'done'; })()", 15000);
      await want("!!document.querySelector('.dumpcard .buildbox')", 8000);
      await sleep(400);
    },
    async history() {
      await closeAll();
      await ev("location.hash = '#/games'; openHistory(); true");
      await want("document.querySelectorAll('#historyList .dl').length >= 10", 8000);
      await ev("document.querySelectorAll('#historyList .hdetail').forEach(d => { d.open = true; }); true");
    },
    async activity() {
      await closeAll();
      await ev("location.hash = '#/games'; openActivity(); true");
      await want("document.querySelectorAll('#dlList .dl').length >= 4", 8000);
      await sleep(500);
    },
    async themes() {
      await closeAll();
      await ev("document.getElementById('themeBtn').click(); true");
      await want("document.getElementById('themeDlg').open && document.querySelectorAll('#themeList .theme-opt').length >= 11", 8000);
      if (isCustom) await want(`!!document.querySelector('[data-k="o:${themeId}"]')`, 6000);
      await sleep(400);
    },
    async setup() {
      await closeAll();
      await ev("location.hash = '#/games'; firstRun = true; openDiag(); true");
      await want("document.querySelectorAll('#diagChecks .check').length >= 3", 10000);
      await sleep(600);
    },
    async maker() {
      await closeAll();
      await ev("document.getElementById('themeBtn').click(); true");
      await want("document.getElementById('themeDlg').open && document.querySelectorAll('#themeList .theme-opt').length >= 11", 8000);
      // Edit opens this theme's own colours; a folder theme or a built-in gets the empty maker instead
      if (isCustom) await want(`!!document.querySelector('[data-k="e:${themeId}"]')`, 6000);
      const edit = isCustom && await ev(`(() => { const b = document.querySelector('[data-k="e:${themeId}"]'); return !!b && !b.disabled; })()`);
      await ev(edit ? `document.querySelector('[data-k="e:${themeId}"]').click(); true` : "document.getElementById('themeMake').click(); true");
      await want("document.getElementById('themeMakeDlg').open", 8000);
      await sleep(700);
      return edit ? 'Edit, showing this theme\'s own colours' : 'Make a theme, empty';
    },
    // The page's own drop handler, given the files as File objects, so the dialog is the one a person gets. It is already
    // installed here, so the server adds a warning that the id exists: that is part of the real thing too.
    async install() {
      await closeAll();
      await ev(`(async () => {
        const body = ${JSON.stringify(theme.body)}, items = [];
        const file = (p, v, text) => new File([text ? v : Uint8Array.from(atob(v), c => c.charCodeAt(0))], p.split('/').pop());
        const root = ${JSON.stringify(theme.folder || '')};       // a dropped folder's files arrive under its name
        if (body.theme) { const name = ${JSON.stringify(themeId + '.json')}; items.push({ path: name, file: new File([JSON.stringify(body.theme)], name) }); }
        else for (const [p, v] of Object.entries(body.files)) { items.push({ path: root + '/' + p, file: file(p, v, /\\.(json|css)$/i.test(p)) }); }
        await startAdd(items, root, ${JSON.stringify(theme.label)});
        const d = document.querySelector('#addBody details'); if (d) d.open = true;
        return true; })()`);
      await want("document.getElementById('themeAddDlg').open && !!document.querySelector('#addBody .sw6, #addBody .warn')", 8000);
      await sleep(300);
    },
  };

  // The scroll positions of the screens of a view: where the first one starts, then one step (85% of what is visible) at a time.
  async function scrollPlan(view, cap) {
    const dlg = view.scroll === 'page' ? null : view.scroll;
    const m = await ev(`(() => {
      const dlg = ${JSON.stringify(dlg)}, e = dlg ? document.querySelector(dlg) : document.scrollingElement;
      if (!e) return { max: 0, step: 100, first: 0 };
      const max = Math.max(0, e.scrollHeight - e.clientHeight), step = Math.round(e.clientHeight * 0.85);
      let first = 0;
      const anchor = ${JSON.stringify(view.anchor || null)}, row = ${JSON.stringify(view.key === 'themes' ? '#themeList [aria-checked="true"]' : null)};
      if (anchor && !dlg) { const a = document.querySelector(anchor); if (a) first = a.getBoundingClientRect().top + window.scrollY - ${view.anchorGap || 0}; }
      if (row) { const r = document.querySelector(row); if (r) first = e.scrollTop + r.getBoundingClientRect().top - e.getBoundingClientRect().top - 110; }
      return { max, step, first: Math.max(0, Math.min(max, Math.round(first))) };
    })()`);
    const at = [];
    for (let y = m.first; at.length < cap; y += Math.max(60, m.step)) {
      at.push(Math.min(m.max, y));
      if (y >= m.max) break;
    }
    return at.map(y => () => ev(`(() => { const dlg = ${JSON.stringify(dlg)}; if (dlg) document.querySelector(dlg).scrollTop = ${y}; else window.scrollTo(0, ${y}); return true; })()`));
  }

  // The page with its text made invisible (and, when asked, every opacity put to 1), to read what is drawn behind the text.
  // A layer that covers the whole page above its content (the PS1 scanlines are one) is left out too: it darkens the text as much
  // as what is behind it, and the theme has no say in it.
  const HIDE = `(() => {
    let s = document.getElementById('__pvHide');
    if (!s) { s = document.createElement('style'); s.id = '__pvHide'; document.head.appendChild(s); }
    const above = [];
    for (const [host, name] of [[document.documentElement, 'html'], [document.body, 'body']]) for (const p of ['::before', '::after']) {
      const c = getComputedStyle(host, p);
      if (c.content !== 'none' && c.content !== 'normal' && c.pointerEvents === 'none' && (c.position === 'fixed' || c.position === 'absolute') && (parseInt(c.zIndex, 10) || 0) > 0) above.push(name + p);
    }
    s.textContent = '*, *::before, *::after, ::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; -webkit-text-stroke: 0 !important; transition: none !important; animation: none !important }'
      + (above.length ? ' ' + above.join(', ') + ' { visibility: hidden !important }' : '');
    return true; })()`;
  const OPAQUE = `(() => { const s = document.getElementById('__pvHide'); if (s) s.textContent += ' *, *::before, *::after { opacity: 1 !important }'; return true; })()`;
  const UNHIDE = "(() => { const s = document.getElementById('__pvHide'); if (s) s.remove(); return true; })()";

  for (const size of sizes) {
    say('opening the page at', size.label);
    await openPage(size);
    await settling;
    for (const view of VIEWS) {
      if ((only && !only.has(view.key)) || (view.needsTheme && !theme)) continue;
      say('view', view.key, size.tag || 'desktop');
      viewNow = view.key + (size.tag || '');
      try {
        const note = await enter[view.key]();
        await frames();
        await sleep(250);
        const cap = Math.min(opts.pages || 99, Math.ceil((view.pages || 3) * (size.mobile ? 1.5 : 1)));
        const plan = await scrollPlan(view, cap);
        await ev('window.__pvSeen = new WeakSet(); true');
        for (let i = 0; i < plan.length; i++) {
          await plan[i]();
          await frames();
          await sleep(120);
          const name = `${String(VIEWS.indexOf(view) + 1).padStart(2, '0')}-${view.name}${i ? '-' + (i + 1) : ''}${size.tag}.png`;
          const file = path.join(out, name);
          // measure the screen as it is, then take it again with its text made invisible (twice when something on it is see-through)
          const col = await ev(`(${pageCollect.toString()})(${JSON.stringify(view.scope)}, '__pvSeen')`);
          if (col.error) throw new Error(`${view.key}: ${col.error}`);
          const wide = await ev(`(${pageOverflow.toString()})(${JSON.stringify(view.scope)})`);
          fs.writeFileSync(file, await png());
          await ev(HIDE); await frames();
          const bgRaw = await png();
          if (opts.keepBg) fs.writeFileSync(file.replace(/\.png$/, '.bg.png'), bgRaw);
          const bg1 = decodePng(bgRaw);
          let bg2 = null;
          if (col.recs.some(r => r.op < 0.98)) { await ev(OPAQUE); await frames(); bg2 = decodePng(await png()); }
          await ev(UNHIDE); await frames();
          const res = judge(col.recs, bg1, bg2, size.dpr);
          shots.push({ file, name, view: view.key, viewTitle: view.title, size: size.label, page: i + 1, of: plan.length, hint: view.hint + (note ? ` [opened: ${note}]` : ''), checked: res.checked, skipped: col.skipped, bad: res.bad, wide: wide.page > 1 || wide.box > 1 ? wide : null });
          say('  ', name, res.checked, 'texts,', res.bad.length, 'below the ratio', col.skipped.covered ? '(' + col.skipped.covered + ' covered: ' + col.skipped.by.join(' | ') + ')' : '');
        }
        await closeAll();
      } catch (e) {
        // one view that cannot be taken (the page changed under this script) does not cost the others; the run then says it is incomplete
        if (cdpGone()) throw new Fail(`the browser went away while taking ${viewNow}`);
        broken.push(`${viewNow}: ${e.message}`);
        say('  view failed:', e.message);
        try { await closeAll(); } catch {}
      }
    }
  }

  // ---- report
  // The same fault on many pieces of text (the nine letters of a title, a footer of six lines) is one line.
  const group = new Map();
  for (const s of shots) for (const b of s.bad) {
    const k = [s.size, b.selector, b.shadow].join('|');
    let g = group.get(k);
    if (!g) group.set(k, g = { screen: s.size, selector: b.selector, fg: b.fg, bg: b.bg, ratio: b.ratio, need: b.need, large: b.large, shadow: b.shadow, fontPx: b.fontPx, opacity: b.opacity, texts: [], shots: [], at: b.at });
    if (b.ratio < g.ratio) Object.assign(g, { fg: b.fg, bg: b.bg, ratio: b.ratio, at: b.at, opacity: b.opacity });   // the worst one is the one shown
    if (!g.texts.includes(b.text)) g.texts.push(b.text);
    if (!g.shots.includes(s.name)) g.shots.push(s.name);
  }
  const all = [...group.values()].sort((a, b) => a.ratio - b.ratio);
  const failures = all.filter(g => !g.shadow), review = all.filter(g => g.shadow);
  const describe = g => {
    const some = g.texts.slice(0, 4).map(t => `"${t}"`).join(', ') + (g.texts.length > 4 ? `, +${g.texts.length - 4} more` : '');
    return `  ${g.ratio.toFixed(2)}:1 (needs ${g.need})  ${g.fg} on ${g.bg}  ${g.selector}  ${some}${g.opacity ? `  [faded to ${g.opacity} opacity]` : ''}  in ${g.shots.slice(0, 3).join(', ')}${g.shots.length > 3 ? ', ...' : ''}`;
  };

  const lines = [];
  const head = theme ? `${themeInfo.name} (${themeId}), ${themeInfo.base} base look, ${themeInfo.mode}, ${theme.form === 'folder' ? 'folder' : 'single file'} theme, ${themeInfo.bytes} bytes` : `built-in look ${themeId}`;
  lines.push(`Theme preview: ${head}`);
  lines.push(`Browser: ${path.basename(browserExe)}; ${sizes.map(s => s.label).join(' and ')}; ${((Date.now() - START) / 1000).toFixed(1)} s`);
  lines.push(`Ports used: scratch server 127.0.0.1:${port}, browser debugging 127.0.0.1:${debugPortUsed} (both closed again; --port and --debug-port choose them)`);
  if (themeInfo && themeInfo.warnings && themeInfo.warnings.length) for (const w of themeInfo.warnings) lines.push(`server warning: ${w}`);
  lines.push('');
  lines.push('Screenshots:');
  for (const s of shots) {
    const skipped = [s.skipped.covered && `${s.skipped.covered} covered`, s.skipped.cut && `${s.skipped.cut} cut off`, s.skipped.disabled && `${s.skipped.disabled} disabled`].filter(Boolean).join(', ');
    const sh = s.bad.filter(b => b.shadow).length;
    lines.push(`  ${s.file}`);
    lines.push(s.page > 1 ? `      look at: ${s.viewTitle}, screen ${s.page} of ${s.of}: further down the same view` : `      look at: ${s.viewTitle}${s.of > 1 ? ` (screen 1 of ${s.of})` : ''}: ${s.hint}`);
    lines.push(`      contrast: ${s.bad.length ? `${s.bad.length - sh} below the ratio${sh ? `, ${sh} more with a text-shadow` : ''}` : 'ok'} (${s.checked} ${s.checked === 1 ? 'piece' : 'pieces'} of text checked${skipped ? `; skipped: ${skipped}` : ''})`);
  }
  lines.push('');
  if (review.length) {
    lines.push('');
    lines.push(`Below the ratio by its fill, but drawn with a text-shadow (not counted: an outline or glow may be what carries it, so look at the PNG): ${review.length}`);
    for (const g of review.slice(0, 20)) lines.push(describe(g));
  }
  const total = shots.reduce((n, s) => n + s.checked, 0);
  lines.push(`(${total} pieces of text measured across ${shots.length} screenshot${shots.length === 1 ? '' : 's'})`);
  // the same overflow on every screen of a view is one line
  const sideways = new Map();
  for (const s of shots) {
    if (!s.wide) continue;
    const text = [s.wide.page > 1 && `the page is ${s.wide.page}px wider than the screen`, s.wide.box > 1 && `the dialog's content is ${s.wide.box}px wider than the dialog`].filter(Boolean).join(', ') + (s.wide.wide.length ? `; ${s.wide.wide.join('; ')}` : '');
    const k = s.size + '|' + s.view + '|' + text;
    if (!sideways.has(k)) sideways.set(k, { text, names: [] });
    sideways.get(k).names.push(s.name);
  }
  if (sideways.size) {
    lines.push('');
    lines.push('Wider than the screen (not counted in the exit code; look at the PNG):');
    for (const { text, names } of sideways.values()) lines.push(`  ${names[0]}${names.length > 1 ? ` and ${names.length - 1} more of the same view` : ''}: ${text}`);
  }
  if (broken.length) { lines.push(''); lines.push('These views could not be taken, so this check is incomplete (the page may have changed since this script was written):'); for (const t of broken) lines.push('  ' + t); }
  if (stale.length) { lines.push(''); lines.push('A screen may not show what it should (the page did not get there in time):'); for (const t of stale) lines.push('  ' + t); }
  if (problems.size) { lines.push(''); lines.push('The browser reported:'); for (const p of problems) lines.push('  ' + p); }
  // the summary comes last, so that it is what a reader sees when the output is cut to its tail
  const sum = summarise(failures, themeInfo ? themeInfo.base : themeId, theme ? null : themeId);
  lines.push('');
  lines.push('FINDINGS');
  if (failures.length) {
    lines.push(`Text below its contrast ratio (4.5:1, or 3:1 for large text): ${failures.length} place${failures.length === 1 ? '' : 's'}`);
    failures.slice(0, 60).forEach((g, i) => { const k = sum.kinds[i]; lines.push(`[${k.kind}]${describe(g)}${k.what ? `  (${k.what.replace(/ \(.*\)$/, '')})` : ''}${k.hint ? `  -> ${k.hint}` : ''}`); });
    if (failures.length > 60) lines.push(`  ... and ${failures.length - 60} more (all of them are in preview.json)`);
  } else lines.push('Contrast: every piece of text checked is at or above its ratio (4.5:1, or 3:1 for large text).');
  lines.push(sum.verdict);
  console.log(lines.join('\n'));
  fs.writeFileSync(path.join(out, 'preview.json'), JSON.stringify({
    theme: themeId, custom: isCustom, base: themeInfo ? themeInfo.base : themeId, screens: sizes.map(s => s.label),
    shots: shots.map(s => ({ file: s.file, view: s.view, screen: s.page, of: s.of, size: s.size, hint: s.hint, textChecked: s.checked, skipped: s.skipped, below: s.bad, wider: s.wide })),
    failures: failures.map((g, i) => ({ ...g, kind: sum.kinds[i].kind })), verdict: { ...sum.counts, text: sum.verdict }, review, notReached: stale, notTaken: broken, browserProblems: [...problems],
  }, null, 2));
  return broken.length ? 2 : failures.length ? 1 : 0;
}

// A reader that stops reading (head, a closed pipe) is not an error worth a stack trace.
for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
// Leave once everything written to stdout and stderr has been handed on (a pipe can still hold the end of a long report).
const leave = code => Promise.all([process.stdout, process.stderr].map(s => new Promise(r => s.write('', r)))).then(() => process.exit(code));
const run = () => main().then(async code => { await cleanup(); await leave(code); }, async e => {
  await cleanup();
  if (e instanceof Fail) process.stderr.write(`preview: ${e.message}\n`);
  else process.stderr.write(`preview: unexpected error: ${e && e.stack || e}\n`);
  await leave(2);
});
if (require.main === module) run();
else module.exports = { PAGE_OWN, BASE_LOOK, classify, summarise, parseArgs, BUILTINS };
