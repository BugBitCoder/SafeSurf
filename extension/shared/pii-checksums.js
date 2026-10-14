/**
 * Deterministic checksum + entropy primitives.
 *
 * Pure ESM. Zero dependencies. No DOM, no extension APIs, no Node APIs.
 * Imported by BOTH the extension and the landing page, so this file must
 * stay environment-agnostic.
 *
 * Why checksums: a bare regex for `[A-Z]{5}[0-9]{4}[A-Z]` matches ordinary
 * prose constantly. The Verhoeff / Luhn / mod-97 gates are what make a
 * detector usable — they collapse false positives without a model.
 */

// ---------------------------------------------------------------------------
// Verhoeff (Aadhaar)
// ---------------------------------------------------------------------------

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Validate a digit string against the Verhoeff algorithm.
 * Aadhaar's trailing check digit is Verhoeff, not Luhn or mod-10.
 *
 * The permutation index is `i % 8` — NOT `(i + 1) % 8`, which is the
 * variant that appears in some pseudocode write-ups and produces a
 * different (also self-consistent) checksum. `i % 8` is the one UIDAI
 * numbers actually validate against; 999999990019 passes and
 * 999999990018 fails.
 */
export function verhoeffValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/** Compute the Verhoeff check digit that completes `digits`. */
export function verhoeffCheckDigit(digits) {
  if (!/^\d+$/.test(digits)) return null;
  for (let d = 0; d <= 9; d++) {
    if (verhoeffValid(digits + d)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Luhn (payment cards)
// ---------------------------------------------------------------------------

/** Validate a digit string against the Luhn algorithm. */
export function luhnValid(digits) {
  if (!/^\d+$/.test(digits) || digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// mod-97 (IBAN)
// ---------------------------------------------------------------------------

/**
 * Validate an IBAN. Rearranges to A=10..Z=35 and checks mod 97 === 1.
 * Also enforces real per-country length so we do not "verify" a 15-char
 * string that happens to satisfy mod-97.
 */
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
  NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
  SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};

export function ibanValid(compact) {
  const s = compact.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const country = s.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (!expected || s.length !== expected) return false;

  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    // Fold chunk-by-chunk to stay inside Number.MAX_SAFE_INTEGER.
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

/** Shannon entropy in bits per character. Empty string is 0. */
export function shannonEntropy(text) {
  if (!text.length) return 0;
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Heuristic: does this token look like a machine-generated secret?
 *
 * Deliberately conservative. English prose sits around 3.5-4.2 bits/char,
 * so the 4.0 floor plus a 16-char minimum plus a mixed character-class
 * requirement together keep this from eating normal words.
 */
export function looksLikeSecret(token, { minEntropy = 4.0, minLength = 16 } = {}) {
  if (token.length < minLength) return false;
  if (!/[a-z]/.test(token) && !/[A-Z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(token));
  if (classes.length < 2) return false;
  return shannonEntropy(token) > minEntropy;
}