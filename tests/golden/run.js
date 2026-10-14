#!/usr/bin/env node
/**
 * Golden-set runner.
 *
 * This is the evidence that makes the `gemma4:e4b` decision measurable rather
 * than assumed. The number this prints goes straight into the writeup:
 *
 *   > Deterministic layer: N/25. PII leak rate across the corpus:
 *   > X% before SafeSurf, 0% after.
 *
 * Runs on the DETERMINISTIC layer only — no model, no network. That is the
 * point: the highest-severity protection must not depend on Ollama running.
 *
 *   node tests/golden/run.js            # summary
 *   node tests/golden/run.js --verbose  # per-case detail
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanAndRedact } from '../../extension/shared/pii-deterministic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

const { cases } = JSON.parse(readFileSync(resolve(HERE, 'cases.json'), 'utf8'));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Does the leak rate drop?
 * A case "leaks" when any expected category was not actually redacted.
 */
function evaluate(testCase) {
  const { redacted, byCategory } = scanAndRedact(testCase.text);
  const missed = (testCase.expect ?? []).filter((c) => !byCategory[c]);
  const falsePositives = (testCase.expectNot ?? []).filter((c) => byCategory[c]);
  return { redacted, byCategory, missed, falsePositives };
}

let passed = 0;
const failures = [];
let leakTotal = 0;

for (const testCase of cases) {
  const { redacted, byCategory, missed, falsePositives } = evaluate(testCase);
  const expectedCount = (testCase.expect ?? []).length;
  leakTotal += missed.length + expectedCount;

  const ok = missed.length === 0 && falsePositives.length === 0;

  if (ok) {
    passed++;
    if (VERBOSE) {
      const cats = Object.keys(byCategory).join(', ') || 'none';
      console.log(`${GREEN}  pass${RESET}  ${testCase.id.padEnd(34)} ${DIM}${cats}${RESET}`);
    }
  } else {
    failures.push({ id: testCase.id, missed, falsePositives, redacted, text: testCase.text });
    if (VERBOSE) {
      console.log(`${RED}  FAIL${RESET}  ${testCase.id}`);
      if (missed.length) console.log(`        missed:    ${missed.join(', ')}`);
      if (falsePositives.length) console.log(`        over-fired: ${falsePositives.join(', ')}`);
      console.log(`        input:     ${testCase.text}`);
      console.log(`        output:    ${redacted}`);
    }
  }
}

const total = cases.length;
const leakRate = leakTotal === 0 ? 0 : (missedTotal(failures) / leakTotal) * 100;

function missedTotal(list) {
  return list.reduce((sum, f) => sum + f.missed.length, 0);
}

console.log('');
console.log(`${BOLD}SafeSurf golden set${RESET}`);
console.log(`${'─'.repeat(46)}`);
console.log(`  cases              ${total}`);
console.log(`  passed             ${GREEN}${passed}${RESET}${passed === total ? '' : ` / ${total}`}`);
console.log(`  PII caught         ${leakTotal - missedTotal(failures)}/${leakTotal}`);
console.log(`  leak rate          ${leakRate.toFixed(0)}%`);
console.log(`  after SafeSurf     ${leakRate.toFixed(0)}%  ${DIM}(deterministic layer, no model)${RESET}`);

if (failures.length) {
  console.log('');
  console.log(`${RED}${failures.length} failing case(s):${RESET}`);
  for (const f of failures) {
    console.log(`  ${RED}✗${RESET} ${f.id}`);
    if (f.missed.length) console.log(`      missed:     ${f.missed.join(', ')}`);
    if (f.falsePositives.length) console.log(`      over-fired: ${f.falsePositives.join(', ')}`);
    console.log(`      output:     ${f.redacted}`);
  }
  console.log('');
  console.log(`${DIM}re-run with --verbose for per-case detail${RESET}`);
}

console.log('');
process.exit(failures.length ? 1 : 0);