#!/usr/bin/env node
// check-bases.js — hold the built-in base looks to the same readability standard the
// runtime guard applies to custom themes: guardFixes() must have nothing left to change.
// Exit 0 when every base passes, 1 when any base still has a fixable text colour below
// its minimum. Focus rings and decorative icons are non-text and intentionally left
// alone, and a token used on surfaces no single colour can read on all of is structural
// (not a colour fix) — both match guardFixes() itself.
//
//   node tools/themes/check-bases.js            # check every built-in base
//   node tools/themes/check-bases.js nes win95  # check only the named bases
'use strict';

const fs = require('fs'), vm = require('vm'), path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'index.html');
const START = '// ==== theme engine (pure) ====';
const END = '// ==== end theme engine ====';

const html = fs.readFileSync(INDEX, 'utf8');
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b <= a) { console.error(`check-bases: engine markers not found in index.html`); process.exit(1); }

const sandbox = vm.createContext({});
try { vm.runInContext(html.slice(a, b), sandbox, { filename: 'index.html (theme engine)', timeout: 10000 }); }
catch (e) { console.error(`check-bases: the theme engine did not load: ${e && e.message}`); process.exit(1); }
const call = (expr, arg) => { sandbox.__arg = arg; return vm.runInContext(expr, sandbox, { timeout: 10000 }); };
if (call('typeof guardFixes') !== 'function') { console.error('check-bases: engine has no guardFixes()'); process.exit(1); }

// ---- Extract each built-in base's tokens from the CSS -------------------------
// The bases are the `[data-theme=X] { --token: value; ... }` blocks in <style>, plus the
// `:root, [data-theme=ps1]` block that carries ps1's full set and the one-line
// `[data-theme=ps1] { --panel-busy:... }` override. Later blocks merge over earlier ones.
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const tokensByBase = {};
const blockRe = /(:root,\s*\[data-theme=ps1\]|\[data-theme=[a-z0-9]+\])\s*\{([^}]*)\}/g;
let m;
while ((m = blockRe.exec(css))) {
  const sel = m[1], body = m[2];
  const name = (sel.match(/data-theme=([a-z0-9]+)/) || [])[1] || 'ps1';
  const tokens = tokensByBase[name] || (tokensByBase[name] = {});
  for (const t of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[t[1]] = t[2].trim();
}

const BUILTIN = ['ps1', 'ps1v2', 'midnight', 'purple', 'nes', 'snes', 'dreamcast', 'wii', 'itsmemario', 'yoshisisland', 'oled', 'nathan', 'win95', 'spookemon', 'minimal'];
const want = process.argv.slice(2).filter(s => BUILTIN.includes(s));
const bases = want.length ? want : BUILTIN;

let total = 0;
for (const base of bases) {
  const tokens = tokensByBase[base];
  if (!tokens) { console.error(`check-bases: no tokens found for base "${base}"`); process.exit(1); }
  // ItsMeMario! and Dreamcast draw their bottom bar as a light panel under a dark page,
  // so their tray text colours come from the panel (see trayInk in index.html).
  const trayInk = (base === 'dreamcast' || base === 'itsmemario') ? 'panel' : 'text';
  const fixes = JSON.parse(call('JSON.stringify(guardFixes(__arg.tokens, __arg.opts))', { tokens, opts: { trayInk } }));
  const names = Object.keys(fixes);
  if (names.length) {
    for (const tok of names) console.log(`FAIL ${base}: ${tok} still below its minimum — guardFixes wants ${fixes[tok]}`);
    total += names.length;
  } else {
    console.log(`ok   ${base}: nothing left for guardFixes to change`);
  }
}
console.log(total ? `\n${total} fixable token(s) still fail` : '\nall built-in bases pass the runtime readability standard');
process.exit(total ? 1 : 0);
