/**
 * Load an unpacked extension into Chrome by driving the CDP **pipe**.
 *
 * Why this exists: Chrome 156 removed `--load-extension`, and the
 * `Extensions.loadUnpacked` CDP command is only exposed when Chrome is
 * started with `--enable-unsafe-extension-debugging` AND is attached over
 * the debug pipe (fds 3/4), not the TCP port.
 *
 *   node scripts/load-extension.js <ext-dir>
 *
 * Leaves Chrome running so the extension stays loaded for manual testing.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = process.argv[2];
const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!EXT) {
  console.error('usage: node scripts/load-extension.js <ext-dir>');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'ss-profile-'));

// fd 3 = browser→client (read), fd 4 = client→browser (write)
const child = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-pipe',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });

child.stderr.on('data', (d) => {
  const s = String(d);
  if (/extension|manifest|error/i.test(s) && !/updater|crashpad|crash/i.test(s)) process.stderr.write(s);
});

const readPipe = child.stdio[3];
const writePipe = child.stdio[4];

let buffer = Buffer.alloc(0);
const pending = new Map();
let nextId = 0;

readPipe.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const nul = buffer.indexOf(0);
    if (nul === -1) break;
    const line = buffer.subarray(0, nul).toString();
    buffer = buffer.subarray(nul + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  writePipe.write(`${JSON.stringify(payload)}\0`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 15_000);
  });
}

await new Promise((r) => setTimeout(r, 2500)); // let Chrome finish booting

const att = await send('Target.attachToBrowserTarget', { flatten: true });
const sid = att.result?.sessionId;
if (!sid) {
  console.error('could not attach:', JSON.stringify(att));
  child.kill();
  process.exit(1);
}

const enabled = await send('Extensions.enable', {}, sid);
if (enabled.error) {
  console.error('Extensions.enable unavailable:', JSON.stringify(enabled.error));
  console.error('profile:', profile);
  child.kill();
  process.exit(1);
}

const loaded = await send('Extensions.loadUnpacked', { path: EXT }, sid);
if (loaded.error) {
  console.error('Extensions.loadUnpacked failed:', JSON.stringify(loaded.error));
  child.kill();
  process.exit(1);
}

console.log('✓ extension loaded');
console.log(JSON.stringify(loaded.result, null, 2));
console.log(`\nChrome is running (pid ${child.pid}), profile: ${profile}`);
console.log('Drive it at any point with chrome-devtools, or open Chrome manually.');

// Hand the pipe to the parent so a supervising process can keep using CDP.
if (process.send) process.send({ ok: true, pid: child.pid, profile, loaded: loaded.result });