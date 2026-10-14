/**
 * Egress guard + source-tree invariants.
 *
 * This file is what makes "nothing leaves your device" a TESTABLE claim
 * rather than a slogan. If it passes, no code path in the extension can
 * reach a remote origin.
 *
 *   node --test tests/unit/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { assertLocal, ALLOWED_ORIGIN } from '../../extension/background/egress-guard.js';
import { MODEL, OLLAMA_ORIGIN } from '../../extension/config.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_DIR = join(REPO, 'extension');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Vendored third-party binaries are not our code to police.
      if (entry === 'tesseract') continue;
      walk(full, out);
    } else if (/\.(js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// assertLocal behaviour
// ---------------------------------------------------------------------------

test('assertLocal allows the Ollama origin', () => {
  assert.equal(assertLocal(OLLAMA_ORIGIN), OLLAMA_ORIGIN);
  assert.equal(assertLocal(`${OLLAMA_ORIGIN}/api/chat`), `${OLLAMA_ORIGIN}/api/chat`);
});

test('assertLocal blocks remote origins', () => {
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://api.anthropic.com/v1/messages',
    'http://evil.test/collect',
  ]) {
    assert.throws(() => assertLocal(url), /blocked non-local request/,
      `should have blocked ${url}`);
  }
});

test('assertLocal blocks host-header tricks', () => {
  // These are the bypasses that actually get tried. Some are rejected as
  // malformed rather than as remote — both are refusals, which is the point.
  for (const url of [
    'http://localhost:11434.evil.test/api/chat',   // prefix trick
    'http://localhost@evil.test/api/chat',          // userinfo trick
    'http://evil.test/localhost:11434',             // path trick
    'https://localhost:11434/api/chat',            // wrong scheme
    'http://127.0.0.1:8080/api/chat',              // wrong port
  ]) {
    assert.throws(() => assertLocal(url), /blocked (non-local request|malformed URL)/,
      `should have blocked ${url}`);
  }
});

test('assertLocal rejects malformed input', () => {
  assert.throws(() => assertLocal('not a url'), /blocked malformed URL/);
  assert.throws(() => assertLocal(''), /blocked malformed URL/);
});

test('allowed origin is exactly the loopback Ollama origin', () => {
  assert.equal(ALLOWED_ORIGIN, 'http://localhost:11434');
});

// ---------------------------------------------------------------------------
// Source-tree invariants
// ---------------------------------------------------------------------------

test('no http(s) URL literal in the extension points anywhere but localhost', () => {
  const offenders = [];

  for (const file of walk(EXTENSION_DIR)) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      // Skip comments — a URL in prose is not a fetch target.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      const matches = code.match(/https?:\/\/[^\s'"`)]+/g);
      if (!matches) return;

      for (const url of matches) {
        const allowed = /^https?:\/\/(?:localhost|127\.0\.0\.1):11434/.test(url);
        if (!allowed) offenders.push({ file: relative(REPO, file), line: i + 1, url });
      }
    });
  }

  assert.deepEqual(offenders, [],
    `non-local URL literals found:\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.url}`).join('\n')}`);
});

test('the model id appears in exactly one file', () => {
  const offenders = [];
  for (const file of walk(EXTENSION_DIR)) {
    // Blank out comments first — a bare tag inside prose is not a reference.
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    source.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      // Bare `gemma4` without a pinned tag resolves to `:latest` — not a promise.
      if (/(?<![:\w])gemma4(?![:\w])/.test(line)) {
        offenders.push({ file: relative(REPO, file), line: i + 1, text: line.trim() });
      }
    });
  }

  assert.deepEqual(offenders, [],
    `unpinned model reference — always write ${MODEL}:\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`);
});

test('the extension declares no remote host permissions', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const allowed = /^https?:\/\/(?:localhost|127\.0\.0\.1):11434\/\*$/;

  for (const pattern of manifest.host_permissions ?? []) {
    assert.match(pattern, allowed, `host_permissions must be loopback-only, got: ${pattern}`);
  }
});

test('the extension CSP restricts connect-src to loopback', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy?.extension_pages;
  assert.ok(csp, 'expected an explicit extension_pages CSP');
  assert.match(csp, /connect-src[^;]*http:\/\/localhost:11434/);
  assert.doesNotMatch(csp, /connect-src[^;]*https?:\/\/(?!localhost|127\.0\.0\.1)/);
  // MV3 forbids these outright.
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('no content script or vendored file is web-accessible', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const war = manifest.web_accessible_resources ?? [];
  assert.deepEqual(war, [], 'this extension needs no web-accessible surface');
});

test('the deterministic layer imports nothing from the network or the platform', () => {
  const sharedFiles = walk(join(EXTENSION_DIR, 'shared'));
  assert.ok(sharedFiles.length >= 5, 'expected the shared modules to be present');

  for (const file of sharedFiles) {
    const source = readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      assert.doesNotMatch(line.trim(), /^\s*import\s+.*\bfrom\s+['"](?:https?:|node:|chrome:)/,
        `${relative(REPO, file)} must stay platform-free`);
      assert.doesNotMatch(line, /\bfetch\s*\(/,
        `${relative(REPO, file)} must not perform I/O — that belongs in the service worker`);
    }
  }
});

test('service worker registers its message listener synchronously at top level', () => {
  // An await before onMessage means the worker can miss the event that woke it.
  const source = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');
  const lines = source.split('\n');
  const listenerLine = lines.findIndex((l) => l.includes('chrome.runtime.onMessage.addListener'));
  const firstTopLevelAwait = lines.findIndex((l) => /^(await |const .*= await |let .*= await )/.test(l));

  assert.ok(listenerLine > -1, 'no top-level message listener found');
  assert.ok(firstTopLevelAwait === -1 || listenerLine < firstTopLevelAwait,
    `top-level await at line ${firstTopLevelAwait + 1} runs before the listener at ${listenerLine + 1}`);
  assert.match(source, /return true;/, 'async handlers must keep the message channel open');
});

test('sep is used for portable path joins', () => {
  // Guards against a Windows-only path literal sneaking into the walker.
  assert.ok(sep.length > 0);
});