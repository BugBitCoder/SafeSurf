/** Checksum and entropy primitives. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  verhoeffValid, verhoeffCheckDigit, luhnValid, ibanValid, shannonEntropy, looksLikeSecret,
} from '../../extension/shared/pii-checksums.js';

test('verhoeff: accepts a real Aadhaar, rejects a broken check digit', () => {
  assert.equal(verhoeffValid('999999990019'), true);
  assert.equal(verhoeffValid('999999990018'), false);
  assert.equal(verhoeffValid('234567890124'), true);
});

test('verhoeff: computes the correct check digit', () => {
  assert.equal(verhoeffCheckDigit('99999999001'), 9);
  assert.equal(verhoeffCheckDigit('23456789012'), 4);
});

test('verhoeff: catches an adjacent transposition', () => {
  // The whole point of Verhoeff over a plain length check: it detects ALL
  // transpositions, so swapping any adjacent pair of a valid number breaks it.
  const valid = '234567890124'; // passes above
  assert.equal(verhoeffValid(valid), true);

  const chars = [...valid];
  [chars[0], chars[1]] = [chars[1], chars[0]];
  const transposed = chars.join('');
  assert.equal(transposed, '324567890124');
  assert.equal(verhoeffValid(transposed), false, 'transposition must be rejected');
});

test('verhoeff: rejects non-digits and empty input', () => {
  assert.equal(verhoeffValid(''), false);
  assert.equal(verhoeffValid('12345abc6789'), false);
  assert.equal(verhoeffValid(' 999999990019'), false);
});

test('luhn: accepts real card numbers, rejects near-misses', () => {
  assert.equal(luhnValid('4539578763621486'), true);
  assert.equal(luhnValid('378282246310005'), true);
  assert.equal(luhnValid('5105105105105100'), true);
  assert.equal(luhnValid('4539578763621487'), false);
});

test('luhn: rejects anything too short to be a card', () => {
  assert.equal(luhnValid('7992739871'), false);
  assert.equal(luhnValid(''), false);
});

test('iban: validates mod-97 and country length', () => {
  assert.equal(ibanValid('GB82WEST12345698765432'), true);
  assert.equal(ibanValid('GB82 WEST 1234 5698 7654 32'), true, 'spaced print form');
  assert.equal(ibanValid('DE89370400440532013000'), true);

  assert.equal(ibanValid('GB82WEST12345698765433'), false, 'bad mod-97');
  assert.equal(ibanValid('GB82WEST1234569876543'), false, 'wrong length for GB');
  assert.equal(ibanValid('ZZ82WEST12345698765432'), false, 'unknown country');
  assert.equal(ibanValid('not-an-iban'), false);
});

test('shannon: entropy rises with character variety', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaaaaaa'), 0);
  assert.ok(shannonEntropy('abcdefgh') > 2.9);
  assert.ok(shannonEntropy('aG9sZCdFRkxPUl9hdVRoVG9rZW4') > 4);
});

test('looksLikeSecret: fires on tokens, not on words', () => {
  assert.equal(looksLikeSecret('aG9sZCdFRkxPUl9hdVRoVG9rZW5f9x2Kq'), true);
  assert.equal(looksLikeSecret('internationalization'), false);
  assert.equal(looksLikeSecret('short'), false);
  assert.equal(looksLikeSecret('aaaaaaaaaaaaaaaa'), false, 'low entropy');
  assert.equal(looksLikeSecret('abcdefghijklmnopqrst'), false, 'no digits');
});