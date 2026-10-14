/**
 * Deterministic PII detection — the model-free protection layer.
 *
 * Runs BEFORE any model call, on every prompt, every time. This is the
 * component that makes the whole product safe even if `gemma4:e4b` complies
 * instead of redacting: a checksum-validated identifier never reaches the
 * model in the first place.
 *
 * Pure ESM. Zero dependencies. Imported by the extension AND the landing page.
 */

import { verhoeffValid, luhnValid, ibanValid, looksLikeSecret } from './pii-checksums.js';

/**
 * Detector definitions.
 *
 * `pattern` matches the CANDIDATE. `validate` is the gate that decides
 * whether the candidate is real. A detector with no `validate` must have a
 * pattern specific enough to stand alone.
 *
 * Order matters: the first matching, passing detector wins a span. More
 * specific formats run before looser ones (card before bare digit run,
 * IBAN before PAN, secret prefixes before generic entropy).
 */
const DETECTORS = [
  {
    id: 'aadhaar',
    label: 'Aadhaar ID',
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: (m) => verhoeffValid(m.replace(/\D/g, '')),
  },
  {
    id: 'pan',
    label: 'PAN card',
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    validate: () => true,
  },
  {
    id: 'iban',
    label: 'IBAN',
    // Spaced form is the printed form; ibanValid() strips separators before mod-97.
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g,
    validate: (m) => ibanValid(m),
  },
  {
    id: 'card',
    label: 'Payment card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m.replace(/\D/g, '')),
  },
  {
    id: 'aws_access_key',
    label: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    validate: () => true,
  },
  {
    id: 'aws_secret',
    label: 'AWS secret access key',
    pattern: /\b[A-Za-z0-9/+=]{40}\b/g,
    validate: () => true,
  },
  {
    id: 'github_token',
    label: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    validate: () => true,
  },
  {
    id: 'slack_token',
    label: 'Slack token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
    validate: () => true,
  },
  {
    id: 'jwt',
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    validate: () => true,
  },
  {
    id: 'private_key',
    label: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    validate: () => true,
  },
  {
    id: 'email',
    label: 'Email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    validate: () => true,
  },
  {
    id: 'phone_in',
    label: 'Phone number (IN)',
    pattern: /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
    validate: () => true,
  },
  {
    id: 'us_ssn',
    label: 'US SSN',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: () => true,
  },
];

/** Categories that would be catastrophic to send to a third-party LLM. */
export const HIGH_SEVERITY = new Set([
  'aadhaar', 'pan', 'card', 'iban', 'private_key',
  'aws_access_key', 'aws_secret', 'github_token', 'slack_token', 'jwt',
]);

/**
 * Scan text for formatted identifiers.
 *
 * @param {string} text
 * @returns {Array<{category:string,label:string,original:string,replacement:string,span:[number,number],severity:string}>}
 */
export function scanDeterministic(text) {
  if (!text || typeof text !== 'string') return [];

  /** @type {Array<any>} */
  const found = [];
  const claimed = new Array(text.length).fill(false);
  const perCategoryCounters = new Map();
  // The same secret appearing twice must map to ONE token, otherwise the
  // rewritten prompt aliases one identity as [AADHAAR_1] and [AADHAAR_3],
  // which reads as two different people to the receiving model.
  const tokenByValue = new Map();

  /** Canonical form used for identity: strip the formatting, keep the value. */
  const canonical = (value, category) => {
    const stripped = value.replace(/[\s-]/g, '');
    return /\d/.test(stripped) && /^[0-9]+$/.test(stripped) ? `${category}:${stripped}` : `${category}:${value.toLowerCase()}`;
  };

  const tokenFor = (category, original) => {
    const key = canonical(original, category);
    const existing = tokenByValue.get(key);
    if (existing) return existing;

    const n = (perCategoryCounters.get(category) ?? 0) + 1;
    perCategoryCounters.set(category, n);
    const token = `[${category.toUpperCase()}_${n}]`;
    tokenByValue.set(key, token);
    return token;
  };

  for (const detector of DETECTORS) {
    // Fresh lastIndex per detector; the regexes are module-level literals
    // with /g so they retain state between calls.
    const regex = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match;

    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const original = match[0];

      // Zero-length matches would loop forever.
      if (original.length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      // Another, higher-priority detector already owns part of this span.
      let overlaps = false;
      for (let i = start; i < end; i++) {
        if (claimed[i]) { overlaps = true; break; }
      }
      if (overlaps) continue;

      if (detector.validate && !detector.validate(original)) continue;

      for (let i = start; i < end; i++) claimed[i] = true;

      found.push({
        category: detector.id,
        label: detector.label,
        original,
        replacement: tokenFor(detector.id, original),
        span: [start, end],
        severity: HIGH_SEVERITY.has(detector.id) ? 'high' : 'medium',
      });
    }
  }

  // Generic high-entropy sweep runs last, only over untouched regions.
  const entropyRegex = /[A-Za-z0-9_\-+/=]{16,}/g;
  let entropyMatch;
  while ((entropyMatch = entropyRegex.exec(text)) !== null) {
    const start = entropyMatch.index;
    const end = start + entropyMatch[0].length;
    let overlaps = false;
    for (let i = start; i < end; i++) {
      if (claimed[i]) { overlaps = true; break; }
    }
    if (overlaps) continue;
    if (!looksLikeSecret(entropyMatch[0])) continue;

    for (let i = start; i < end; i++) claimed[i] = true;
    found.push({
      category: 'secret',
      label: 'High-entropy token',
      original: entropyMatch[0],
      replacement: tokenFor('secret', entropyMatch[0]),
      span: [start, end],
      severity: 'high',
    });
  }

  found.sort((a, b) => a.span[0] - b.span[0]);
  return found;
}

/**
 * Apply findings to text, producing the sanitized string.
 * Replacements are applied right-to-left so earlier spans keep valid offsets.
 */
export function redact(text, findings) {
  let out = text;
  for (const f of [...findings].sort((a, b) => b.span[0] - a.span[0])) {
    out = out.slice(0, f.span[0]) + f.replacement + out.slice(f.span[1]);
  }
  return out;
}

/**
 * Cheap signal that a prompt contains free-text PII no checksum could catch —
 * names, employers, addresses, diagnoses.
 *
 * This exists for LATENCY, not for safety. Without it every keystroke batch
 * costs a ~6s round trip to the model, which destroys the single most
 * important demo beat: a clean prompt must pass through instantly, or the
 * product looks like it is blocking and stalling everything.
 *
 * Deliberately broad. A false positive costs one fast round trip; a false
 * negative only means free-text PII reaches the model, which is the exact
 * case the deterministic layer cannot help with anyway.
 */
const FREE_TEXT_HINTS = [
  /\b(?:my|our)\s+(?:name|email|phone|number|address|birthday|dob|wife|husband|son|daughter|father|mother|doctor|hospital|bank)\b/i,
  /\b(?:i|we)\s+(?:work|worked|live|lived|study|studied|graduated)\s+(?:at|for|in|from)\b/i,
  /\b(?:i|we)\s+(?:am|are)\s+(?:a|an)\s+[A-Z][a-z]+/,
  /\b(?:my|our)\s+(?:employer|company|manager|school|university|college|department|salary|ctc|designation)\b/i,
  /\b(?:diagnos(?:is|ed)|prescription|medication|symptoms?|patient|hospital|clinic|discharge summary)\b/i,
  /\b(?:my|our)\s+(?:bank|account|iban|passport|voter id|licence|license|aadhaar|pan|ssn|nin)\b/i,
  /\b\d{1,4}\s+[A-Za-z]+\s+(?:road|rd|street|st|avenue|ave|lane|nagar|apartments?|colony|block|sector)\b/i,
  /\b(?:dear|hi|hello)\s+[A-Z][a-z]+,?\s+(?:my|i)\b/i,
  /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

export function looksPersonal(text) {
  if (!text || typeof text !== 'string') return false;
  return FREE_TEXT_HINTS.some((re) => re.test(text));
}

/**
 * One-shot convenience: scan then redact.
 * @returns {{ redacted: string, findings: Array<any>, byCategory: Record<string, number>, personal: boolean }}
 */
export function scanAndRedact(text) {
  const findings = scanDeterministic(text);
  const byCategory = {};
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  return {
    redacted: redact(text, findings),
    findings,
    byCategory,
    personal: looksPersonal(text),
  };
}