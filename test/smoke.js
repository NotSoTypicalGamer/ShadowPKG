'use strict';
// smoke.js — boot server.js on a throwaway port with a throwaway config, fetch the
// page, and check it looks like ShadowPKG. The only real assertion: it comes up and
// serves the app. Run locally or in CI (see .github/workflows/ci.yml).
//
//   node test/smoke.js            # port 14801 by default
//   SMOKE_PORT=15500 node test/smoke.js

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = process.env.SMOKE_PORT || '14801';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spkg-smoke-'));
const ROOT = path.join(tmp, 'root');
const CONF = path.join(tmp, 'config');
const SOURCES = path.join(tmp, 'sources');
fs.mkdirSync(ROOT);
fs.mkdirSync(CONF);
fs.mkdirSync(SOURCES);

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT,
    ROOT,
    CONFIG_DIR: CONF,
    SOURCES_DIR: SOURCES,
    PS5_HOST: '127.0.0.1:9',
    FOLLOW_MOVES: '0',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
child.stderr.on('data', c => { stderr += c; });

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

async function poll(url, tries, ms) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await get(url); } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, ms));
  }
  throw last || new Error('server did not answer');
}

function cleanup() {
  try { child.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  try {
    const res = await poll(`http://127.0.0.1:${PORT}/`, 40, 250);
    if (res.status !== 200) throw new Error(`GET / returned ${res.status}, expected 200`);
    if (!/<html/i.test(res.data)) throw new Error('response is not HTML');
    if (!/ShadowPKG/.test(res.data)) throw new Error('page does not mention ShadowPKG');
    console.log(`smoke OK: GET / -> 200, ${res.data.length} bytes`);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('smoke FAIL:', e.message);
    if (stderr.trim()) console.error('server stderr:\n' + stderr.slice(0, 2000));
    cleanup();
    process.exit(1);
  }
})();
