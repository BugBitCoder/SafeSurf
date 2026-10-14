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

test('the content script never intercepts a typing event', () => {
  // Regression, and the cause of "SafeSurf won't let me finish typing".
  //
  // `beforeinput` fires on EVERY keystroke. The original listener ran the full
  // analysis on it and called preventDefault(), so after three characters the
  // user physically could not type.
  for (const file of CONTENT_SCRIPTS) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /addEventListener\(\s*['"]beforeinput['"]/,
      `${relative(REPO, file)} must not listen to beforeinput`);
    assert.doesNotMatch(source, /addEventListener\(\s*['"](?:keypress|keyup)['"]/,
      `${relative(REPO, file)} must not intercept non-submit key events`);
  }

  // Observing `input` is required for the live typing pill. What is forbidden
  // is consuming the event — a passive observer must never cancel it.
  const source = readFileSync(join(EXTENSION_DIR, 'content/content.js'), 'utf8');
  assert.match(source, /addEventListener\(\s*['"]input['"]\s*,\s*onInputObserved/,
    'the live typing scan needs an input observer');

  const body = source.slice(source.indexOf('function onInputObserved'));
  const observer = body.slice(0, body.indexOf('\n  }'));
  assert.doesNotMatch(observer, /preventDefault|stopImmediatePropagation|stopPropagation/,
    'onInputObserved must be purely observational');
});

test('the live pill cannot spin the SPA watcher into an infinite loop', () => {
  // Regression, and the cause of "nothing pops up when I type" — with the tab
  // frozen solid.
  //
  // The SPA watcher observes documentElement with subtree:true, and the status
  // pill is appended to documentElement. It called renderStatus() on EVERY
  // callback, so painting the pill re-triggered the watcher, which painted the
  // pill again, forever. The main thread never yielded to the compositor, so
  // the first paint never reached the screen. Verified in headless Chrome:
  // the page never finished loading.
  const content = readFileSync(join(EXTENSION_DIR, 'content/content.js'), 'utf8');

  assert.match(content, /function anchorSignature/, 'no way to tell whether the composer moved');
  assert.match(content, /new MutationObserver\(/, 'the SPA watcher is gone entirely');

  const watcher = content.slice(content.indexOf('new MutationObserver('));
  assert.match(watcher, /anchorSignature\(el\)\s*===\s*anchoredTo/,
    'the watcher must skip the repaint when the composer has not moved');
  assert.match(watcher, /renderStatus\(/,
    'the watcher should still re-anchor on a real move');

  // A re-anchor must repaint the same pill, not a stripped-down one.
  assert.match(content, /lastStatus\s*=\s*\{\s*res,\s*onClick\s*\}/,
    'the pill lost its click handler when re-anchored');

  // Defence in depth: the renderer itself must be idempotent, so that no
  // future caller can reintroduce the loop through a different path.
  const overlay = readFileSync(join(EXTENSION_DIR, 'content/overlay-ui.js'), 'utf8');
  assert.match(overlay, /__ssSig/,
    'showStatus repaints unconditionally; writing to the observed subtree must be a no-op when nothing changed');
});

test('submit interception is gated on Enter and a composer', () => {
  const source = readFileSync(join(EXTENSION_DIR, 'content/content.js'), 'utf8');

  // The gate must exist and must be consulted before any preventDefault.
  assert.match(source, /function isSubmitIntent/, 'missing isSubmitIntent predicate');
  assert.match(source, /function isComposerElement/, 'missing isComposerElement predicate');

  const gate = source.indexOf('if (!isSubmitIntent(event)) return;');
  const block = source.indexOf('submitEvent.preventDefault?.();');
  assert.ok(gate > -1, 'isSubmitIntent is never consulted');
  assert.ok(block > -1, 'preventDefault call site not found');
  assert.ok(gate < block, 'preventDefault must be gated behind isSubmitIntent');

  const composerGate = source.indexOf('!isComposerElement(el)');
  assert.ok(composerGate > -1 && composerGate < block,
    'preventDefault must also be gated behind isComposerElement');
});

test('the overlay injects its own stylesheet', () => {
  // Regression: the .ss-* rules lived in a CSS constant that nothing ever
  // injected, and overlay.css only styles the host element. The panel
  // rendered completely unstyled in production.
  const source = readFileSync(join(EXTENSION_DIR, 'content/overlay-ui.js'), 'utf8');
  assert.match(source, /safesurf-overlay-style/, 'overlay stylesheet is never injected');
  assert.match(source, /style\.textContent\s*=\s*CSS/, 'CSS constant is never applied');
  assert.match(source, /createElement\(['"]style['"]\)/);
});

test('extension-context invalidation is reported as actionable', () => {
  // Regression: reloading the extension tears down the context that an
  // already-injected content script is bound to. The raw platform message
  // ("Extension context invalidated.") is not something a user can act on, and
  // it is the single most common thing they will hit during development.
  const source = readFileSync(join(EXTENSION_DIR, 'content/content.js'), 'utf8');

  assert.match(source, /function isContextInvalidated/);
  assert.match(source, /Extension context invalidated/);
  assert.match(source, /Receiving end does not exist/, 'must also catch the port-closed variant');
  assert.match(source, /Refresh this page/i, 'the user must be told how to recover');

  // The chrome.storage listener must be guarded, or an uncaught throw aborts
  // the rest of the boot sequence on every re-injection.
  assert.match(source, /try\s*\{[^}]*chrome\.storage\?\.onChanged\.addListener/s);
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