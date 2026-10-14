#!/usr/bin/env node
/**
 * Verify the Phase 0 environment before building on top of it.
 *
 *   node scripts/verify-env.js
 *
 * Checks, in order of how badly they will hurt:
 *   1. Ollama is reachable
 *   2. the pinned model tag is actually pulled (not `:latest`)
 *   3. OLLAMA_ORIGINS allows the extension origin — without this every fetch 403s
 *   4. the deterministic and unit suites pass
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:11434';
const MODEL = 'gemma4:e4b';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

let failures = 0;
const ok = (label, detail = '') => console.log(`${G}  ✓${X} ${label}${detail ? `  ${D}${detail}${X}` : ''}`);
const warn = (label, detail) => { console.log(`${Y}  !${X} ${label}${detail ? `  ${D}${detail}${X}` : ''}`); };
const bad = (label, detail) => { failures++; console.log(`${R}  ✗${X} ${label}${detail ? `  ${detail}` : ''}`); };

console.log(`\n${B}SafeSurf environment${X}`);

// --- 1. server ------------------------------------------------------------
let tags = null;
try {
  const res = await fetch(`${ORIGIN}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (res.ok) tags = await res.json();
} catch { /* handled below */ }

if (!tags) {
  bad('Ollama is not reachable', `start it with \`ollama serve\`, expected ${ORIGIN}`);
} else {
  ok('Ollama reachable', ORIGIN);

  // --- 2. model -----------------------------------------------------------
  const model = tags.models?.find((m) => m.name === MODEL);
  if (model) {
    ok(`Model present: ${MODEL}`,
      `${(model.size / 1e9).toFixed(1)} GB · ${model.details?.quantization_level} · ctx ${model.details?.context_length}`);
    if (model.capabilities?.includes('vision')) ok('Model accepts images', 'needed for the residual vision path');
    if (model.capabilities?.includes('thinking')) warn('Model supports thinking', 'config.js must send `think: false`');
  } else {
    bad(`Model ${MODEL} is not pulled`, `run: ollama pull ${MODEL}`);
    const latest = tags.models?.find((m) => m.name.startsWith('gemma4:'));
    if (latest) warn(`${latest.name} exists but is unpinned`, 'never rely on :latest');
  }

  // --- 3. CORS origin ----------------------------------------------------
  // A browser cannot probe this for us; the extension is the only client that
  // sends Origin: chrome-extension://<id>. So check the config directly.
  try {
    const origins = execFileSync('launchctl', ['getenv', 'OLLAMA_ORIGINS'], { encoding: 'utf8' }).trim();
    if (/chrome-extension:\/\/\*/.test(origins) || /chrome-extension/.test(origins)) {
      ok('OLLAMA_ORIGINS allows the extension', origins);
    } else {
      bad('OLLAMA_ORIGINS does not allow chrome-extension://*',
        `currently: "${origins || '(unset)'}" — every fetch from the extension will 403`);
    }
  } catch {
    warn('Could not read OLLAMA_ORIGINS', 'not a macOS launchd environment, or unset');
  }

  // --- 4. GPU residency ---------------------------------------------------
  try {
    const ps = execFileSync('ollama', ['ps'], { encoding: 'utf8' }).trim().split('\n').slice(1)
      .filter((l) => l.trim().length);
    if (ps.length) {
      const gpu = ps.some((l) => /100% GPU/i.test(l));
      gpu ? ok('Model resident on GPU', ps[0].trim())
          : warn('Model is NOT fully on GPU', `${ps[0].trim()} — expect slow inference`);
    } else {
      warn('No model currently loaded', 'normal when idle; preflight loads it on first use');
    }
  } catch {
    warn('Could not run `ollama ps`');
  }

  // --- 5. cloud blocking --------------------------------------------------
  try {
    const serverJson = JSON.parse(
      await (await import('node:fs/promises')).readFile(`${process.env.HOME}/.ollama/server.json`, 'utf8'),
    );
    serverJson.disable_ollama_cloud
      ? ok('Cloud inference disabled', '~/.ollama/server.json')
      : warn('disable_ollama_cloud is not set', 'a `:cloud` variant could be pulled by accident');
  } catch {
    warn('~/.ollama/server.json missing', 'echo \'{"disable_ollama_cloud": true}\' > ~/.ollama/server.json');
  }
}

// --- 6. suites ------------------------------------------------------------
for (const [label, args] of [['unit suite', ['tests/unit/index.js']], ['golden set', ['tests/golden/run.js']]]) {
  try {
    execFileSync(process.execPath, args, { cwd: REPO, stdio: 'pipe' });
    ok(label, 'passing');
  } catch {
    bad(label, 'failing — run `npm run test:all`');
  }
}

console.log('');
if (failures) {
  console.log(`${R}${failures} problem(s) to fix before the demo.${X}\n`);
  process.exit(1);
}
console.log(`${G}Environment ready.${X}\n`);