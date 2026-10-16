'use strict';
// Quick check of the save-data routes that don't need a live console: list/delete
// backups and the input validation on backup/restore.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = '14899';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spkg-saves-'));
const CONF = path.join(tmp, 'config');
fs.mkdirSync(CONF);

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, ROOT: tmp, CONFIG_DIR: CONF, SOURCES_DIR: tmp, PS5_HOST: '127.0.0.1:9', FOLLOW_MOVES: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

(async () => {
  await sleep(1200);
  let out = [];
  let r = await req('GET', '/api/saves');
  out.push(['GET /api/saves empty', r.status, JSON.stringify(r.j)]);

  // Fake a backup: folder + meta + a file.
  const id = 'abcdef012345';
  const dir = path.join(CONF, 'saves', id);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'data.sav'), 'hello');
  fs.writeFileSync(path.join(dir, 'shadowpkg-save.json'), JSON.stringify({ id, consoleId: 'x', consoleName: 'T', uid: '1e025929', kind: 'savedata', titleId: 'CUSA12345', bytes: 5, files: 1, at: new Date().toISOString() }));

  r = await req('GET', '/api/saves');
  out.push(['GET /api/saves one', r.status, JSON.stringify(r.j)]);

  r = await req('POST', '/api/ftp/saves/backup?src=ftp:nope', { uid: 'BAD', kind: 'savedata', titleId: 'CUSA12345' });
  out.push(['backup bad uid -> 404 (no source)', r.status, JSON.stringify(r.j)]);

  r = await req('POST', '/api/ftp/saves/restore?src=ftp:nope', { id: 'doesnotexist' });
  out.push(['restore bad id -> 404', r.status, JSON.stringify(r.j)]);

  r = await req('DELETE', `/api/saves/${id}`);
  out.push(['DELETE backup', r.status, JSON.stringify(r.j)]);

  r = await req('GET', '/api/saves');
  out.push(['GET /api/saves after delete', r.status, JSON.stringify(r.j)]);

  for (const line of out) console.log(line.join('  |  '));
  child.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); child.kill(); process.exit(1); });
