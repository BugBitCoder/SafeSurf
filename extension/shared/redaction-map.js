/**
 * Reversible redaction mapping.
 *
 * The core product argument: the remote AI only ever sees `rewritten`
 * (tokens like `[AADHAAR_1]`), while the plaintext↔token map never leaves
 * the user's device. Populate the composer with the original text and the
 * user can type a normal prompt to ChatGPT while ChatGPT remains ignorant
 * of every identifier in it.
 *
 * Pure ESM. The caller decides persistence — the extension stores this in
 * `chrome.storage.session` (in-memory, cleared on browser restart) so
 * plaintext PII never touches disk.
 */

const MAP_PREFIX = 'safesurf:redaction-map:';

/**
 * @typedef {Object} RedactionEntry
 * @property {string} token       e.g. "[AADHAAR_1]"
 * @property {string} original    the plaintext
 * @property {string} category
 * @property {number} createdAt
 */

/**
 * In-memory store. The extension wraps this with chrome.storage.session
 * persistence; the landing page uses it directly for the live demo.
 */
export class RedactionMap {
  constructor(entries = []) {
    /** @type {Map<string, RedactionEntry>} */
    this.entries = new Map();
    for (const e of entries) this.entries.set(e.token, e);
  }

  static fromJSON(json) {
    return new RedactionMap(Array.isArray(json) ? json : []);
  }

  /** Record a plaintext↔token pair. Idempotent on token. */
  set(token, original, category) {
    this.entries.set(token, { token, original, category, createdAt: Date.now() });
    return this;
  }

  /** Resolve a token back to plaintext. Returns null if unknown. */
  restore(token) {
    return this.entries.get(token)?.original ?? null;
  }

  has(token) {
    return this.entries.has(token);
  }

  get size() {
    return this.entries.size;
  }

  toJSON() {
    return [...this.entries.values()];
  }

  clear() {
    this.entries.clear();
  }

  /** Drop entries older than `ttlMs`. Keeps the store from growing forever. */
  prune(ttlMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.createdAt < cutoff) this.entries.delete(token);
    }
  }
}

/**
 * The redaction-token shape: [CATEGORY_N].
 *
 * Deliberately validates SHAPE, not vocabulary. The deterministic layer uses
 * a fixed set (AADHAAR, PAN, CARD…), but the model is instructed to invent
 * semantic ones of its own (NAME, ADDRESS, EMPLOYER, DIAGNOSIS…). Hardcoding a
 * category list here silently rejected every legitimate model finding, which
 * broke the reversible mapping for free-text PII without any error.
 */
const TOKEN_REGEX = /\[[A-Z][A-Z0-9_]*_\d+\]/g;

/** Is this string one of our redaction tokens? */
export function isToken(value) {
  return typeof value === 'string' && /^\[[A-Z][A-Z0-9_]*_\d+\]$/.test(value);
}

/**
 * Reverse `redact()` using a RedactionMap. Tokens with no mapping are left
 * untouched — that is the safe failure mode: we never invent a value.
 */
export function unredact(text, map) {
  return text.replace(TOKEN_REGEX, (token) => map.restore(token) ?? token);
}

/** Extract every token referenced by a piece of text. */
export function tokensIn(text) {
  return text.match(TOKEN_REGEX) ?? [];
}

/**
 * Fold a model's proposed replacements into an existing map.
 *
 * The model's output is UNTRUSTED. Two failure modes observed against the
 * real model, both of which would have poisoned the reversible map:
 *
 *   1. It echoes the example tokens from the system prompt
 *      ({original: '[AADHAAR_1]', replacement: '[AADHAAR_1]'}) as findings
 *      even when nothing was found.
 *   2. It occasionally returns the token as the original when the incoming
 *      text was already redacted upstream.
 *
 * So: reject anything that is not a genuine plaintext → token pair, and never
 * let the model overwrite an entry the deterministic layer already claimed.
 */
export function mergeFindings(map, findings) {
  for (const f of findings ?? []) {
    const original = typeof f?.original === 'string' ? f.original : '';
    const replacement = typeof f?.replacement === 'string' ? f.replacement : '';

    if (!original || !replacement) continue;
    // A token cannot be its own plaintext.
    if (original === replacement) continue;
    // The "original" is already a token — there is no plaintext to store.
    if (isToken(original)) continue;
    // The model must produce a token, not free text.
    if (!isToken(replacement)) continue;

    if (!map.has(replacement)) {
      map.set(replacement, original, f.category ?? 'unknown');
    }
  }
  return map;
}