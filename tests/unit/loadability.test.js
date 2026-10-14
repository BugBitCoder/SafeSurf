/**
 * Loadability sweep.
 *
 * The unit suite imports the pure `shared/` modules and nothing else, which
 * left real modules — `lib/rephrase.js` among them — never parsed by any test.
 * A syntax error in one of those files is invisible until Chrome refuses to
 * load the extension, which is the worst possible moment to find out.
 *
 * Every extension module must at minimum parse as ESM.
 *
 *   node --test tests/unit/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_DIR = join(REPO, 'extension');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tesseract') continue; // vendored third-party code
      walk(full, out);
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const MODULES = walk(EXTENSION_DIR);

// Content scripts are classic scripts, not ES modules. Parse them as such.
const CONTENT_SCRIPTS = MODULES.filter((f) => f.includes('/content/'));
const ESM_MODULES = MODULES.filter((f) => !f.includes('/content/'));

test('every extension module parses as an ES module', async () => {
  const broken = [];

  for (const file of ESM_MODULES) {
    try {
      // Parse without executing: pull the source through the module compiler
      // via a data URL import that we immediately discard would still run
      // top-level code, so instead compile it as a Function-less check.
      const source = readFileSync(file, 'utf8');

      // eslint-disable-next-line no-new-func
      new Function(`return (async () => { ${stripImports(source)} })`);
    } catch (err) {
      broken.push({ file: relative(REPO, file), error: err.message });
    }
  }

  assert.deepEqual(broken, [],
    `these files failed to parse:\n${broken.map((b) => `  ${b.file}\n    ${b.error}`).join('\n')}`);
});

test('content scripts parse as classic scripts', () => {
  const broken = [];
  for (const file of CONTENT_SCRIPTS) {
    try {
      new Function(stripImports(readFileSync(file, 'utf8')));
    } catch (err) {
      broken.push({ file: relative(REPO, file), error: err.message });
    }
  }
  assert.deepEqual(broken, [],
    `these content scripts failed to parse:\n${broken.map((b) => `  ${b.file}\n    ${b.error}`).join('\n')}`);
});

test('the service worker and every lib module actually import cleanly', async () => {
  // The real check. Import each module with the chrome.* mock in place so the
  // module body can execute without throwing on a missing API.
  installChromeMock();
  installDomStub();
  globalThis.self ??= globalThis;

  const failures = [];
  for (const file of ESM_MODULES) {
    if (file.includes('/shared/') || file.endsWith('config.js')) continue; // already covered
    try {
      await import(`file://${file}`);
    } catch (err) {
      failures.push({ file: relative(REPO, file), error: err.message.split('\n')[0] });
    }
  }

  assert.deepEqual(failures, [],
    `these modules threw on import:\n${failures.map((f) => `  ${f.file}\n    ${f.error}`).join('\n')}`);
});

/**
 * Remove import/export statements so the remainder can be parsed standalone.
 *
 * `export { a, b } from './x.js'` is a re-export, not a declaration, and must
 * be stripped in full or the standalone parse fails on the `export` keyword.
 */
function stripImports(source) {
  return source
    .replace(/^\s*import\s[^;]*?;\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|class|async))/gm, '');
}

/**
 * Extension pages (options, offscreen) legitimately touch the DOM at module
 * scope. This stub is just enough for their top-level code to evaluate —
 * `querySelector` returns null, listeners are no-ops.
 */
function installDomStub() {
  if (globalThis.document) return;

  const element = () => new Proxy({}, {
    get(_, prop) {
      if (prop === 'value') return '';
      if (prop === 'style') return {};
      if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === 'addEventListener' || prop === 'onclick' || prop === 'focus' || prop === 'click') return () => {};
      if (prop === 'innerHTML' || prop === 'textContent' || prop === 'className') return '';
      if (prop === 'getAttribute') return () => null;
      if (prop === 'querySelector' || prop === 'querySelectorAll') return () => null;
      return undefined;
    },
    set() { return true; },
  });

  globalThis.document = {
    getElementById: () => element(),
    querySelector: () => element(),
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {},
  };
  globalThis.window = globalThis;
}

function installChromeMock() {
  if (globalThis.chrome) return;
  const area = () => {
    const data = new Map();
    return {
      get: async (k) => (k == null ? Object.fromEntries(data) : (data.has(k) ? { [k]: data.get(k) } : {})),
      set: async (o) => { for (const [k, v] of Object.entries(o)) data.set(k, v); },
      remove: async (k) => data.delete(k),
      clear: async () => data.clear(),
    };
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')),
      getURL: (p) => `chrome-extension://mock/${p}`,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getContexts: async () => [],
      sendMessage: async () => ({ ok: true }),
    },
    storage: { local: area(), session: area() },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} }, get: async () => null },
    offscreen: { Reason: { CLIPBOARD: 'CLIPBOARD' }, createDocument: async () => {} },
  };
}