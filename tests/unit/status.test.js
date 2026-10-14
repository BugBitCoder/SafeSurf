/**
 * Live status-pill copy.
 *
 * The function lives inside the content script's IIFE, which cannot be
 * imported (MV3 content scripts are classic scripts). Rather than leave the
 * only thing the user actually sees while typing untested, extract the source
 * and exercise it directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = readFileSync(join(REPO, 'extension/content/content.js'), 'utf8');

/** Pull `describeScanStatus` out of the IIFE and evaluate it standalone. */
const describeScanStatus = (() => {
  const start = SOURCE.indexOf('function describeScanStatus');
  if (start === -1) throw new Error('describeScanStatus not found in content.js');

  // Skip past the parameter list first — the signature is `(scan = {})`, and
  // the `{` of that default value is not the function body.
  const parenOpen = SOURCE.indexOf('(', start);
  let depth = 0;
  let i = parenOpen;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '(') depth++;
    else if (SOURCE[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }

  // Now walk the body's braces.
  const bodyStart = SOURCE.indexOf('{', i);
  depth = 0;
  for (i = bodyStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }

  return new Function(`${SOURCE.slice(start, i)}; return describeScanStatus;`)();
})();

test('pending state reads as busy', () => {
  const s = describeScanStatus({ pending: true });
  assert.equal(s.tone, 'busy');
  assert.match(s.text, /scanning/i);
});

test('an injection outranks everything else', () => {
  const s = describeScanStatus({
    byCategory: { aadhaar: 1 },
    injection: { is_injection: true },
  });
  assert.equal(s.tone, 'danger');
  assert.match(s.text, /injection/i);
  assert.doesNotMatch(s.text, /AADHAAR/, 'injection must not be buried under PII copy');
});

test('PII shows what will be redacted', () => {
  const s = describeScanStatus({ byCategory: { aadhaar: 1, pan: 1, email: 2 } });
  assert.equal(s.tone, 'warn');
  assert.match(s.text, /3 values will be redacted/);
  assert.match(s.text, /AADHAAR/);
  assert.match(s.text, /PAN/);
  assert.match(s.text, /EMAIL/);
});

test('a single value is not pluralised', () => {
  assert.match(describeScanStatus({ byCategory: { aadhaar: 1 } }).text, /1 value will be redacted/);
});

test('more than three categories are summarised, not dumped', () => {
  const s = describeScanStatus({
    byCategory: { aadhaar: 1, pan: 1, card: 1, iban: 1, email: 1 },
  });
  assert.match(s.text, /\+2$/, 'overflow should collapse to a count');
  assert.doesNotMatch(s.text, /IBAN/);
});

test('a clean prompt still produces a visible confirmation', () => {
  // The whole point: silence is indistinguishable from a dead extension.
  const s = describeScanStatus({ byCategory: {} });
  assert.equal(s.tone, 'ok');
  assert.match(s.text, /armed/);
});

test('free-text-looking text gets a distinct message from structured-clean', () => {
  const clean = describeScanStatus({ byCategory: {}, personal: false });
  const personal = describeScanStatus({ byCategory: {}, personal: true });
  assert.notEqual(clean.text, personal.text);
  assert.match(personal.text, /nothing structured detected/);
});

test('always returns something renderable, for any input', () => {
  for (const input of [{}, { byCategory: null }, { injection: null }, { byCategory: {} }, null, undefined]) {
    const s = describeScanStatus(input);
    assert.ok(s, `should always return a status, got null for ${JSON.stringify(input)}`);
    assert.ok(['ok', 'warn', 'danger', 'busy'].includes(s.tone));
    assert.equal(typeof s.text, 'string');
    assert.ok(s.text.length > 0);
  }
});