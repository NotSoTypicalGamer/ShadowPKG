'use strict';
// check-html.js — static guards over index.html that `node --check server.js`
// cannot see. Two classes of bug that have already shipped silently:
//
//   1. a duplicate top-level `let`/`const` in the one inline <script> is a
//      SyntaxError ("Identifier 'X' has already been declared") — e.g. the
//      second `let payloadPick` that collided with the setup-panel picker's.
//      The whole script is parsed, so every other syntax slip is caught too.
//
//   2. a duplicate `id=` in the markup: getElementById returns the first match,
//      so a second element with the same id is silently addressed instead of the
//      one you meant — e.g. the console-picker `<dialog id="payloadDlg">` that
//      collided with the existing payload picker and opened the wrong dialog.
//
// Run locally: node tools/check-html.js   (also wired into CI.)

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let bad = false;

// 1. Every inline <script> must parse.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) {
  console.error('check-html: no inline <script> found in index.html');
  bad = true;
} else {
  scripts.forEach((src, i) => {
    try { new Function(src); }
    catch (e) { console.error(`check-html: inline <script> #${i + 1} does not parse — ${e.message}`); bad = true; }
  });
}

// 2. No two elements may share an id. The markup is scanned with <script> blocks
//    and HTML comments stripped first, so `x.id = 'foo'` in JS and `id=` inside a
//    comment don't false-positive. The negative lookbehind keeps data-id,
//    grid-id and the like out; both quote styles are matched.
const markup = html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');
const seen = new Map();
for (const m of markup.matchAll(/(?<![\w-])id\s*=\s*["']([^"']+)["']/g)) {
  const id = m[1];
  if (seen.has(id)) {
    console.error(`check-html: duplicate id="${id}" (first at offset ${seen.get(id)}, again at ${m.index})`);
    bad = true;
  } else {
    seen.set(id, m.index);
  }
}

if (bad) {
  console.error('check-html: index.html failed — see above');
  process.exit(1);
}
console.log(`check-html: OK — ${scripts.length} inline script(s) parse, no duplicate ids (${seen.size} total)`);
