/**
 * DOM-independent half of the injection scanner.
 *
 * The content script collects page text (visible AND hidden) and hands the
 * raw strings here. This module does the cheap deterministic triage —
 * pattern matching, deobfuscation, normalisation — before anything is sent
 * to the model. Keeps obvious payloads off the wire and cuts ctx cost.
 *
 * Pure ESM. No DOM access lives here; see extension/content/content.js.
 */

export const INJECTION_CATEGORIES = {
  instruction_override: 'Attempts to override prior instructions',
  role_impersonation: 'Impersonates a system/developer message',
  exfiltration: 'Tries to move data to another destination',
  covert_channel: 'Hidden or encoded instruction delivery',
  tool_coercion: 'Tries to trigger tool or action execution',
  markdown_exfil: 'Markdown/image link that leaks conversation content',
};

const LEETSPEAK = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Reverse common leetspeak substitutions, preserving length. */
export function deleet(text) {
  return [...text].map((ch) => LEETSPEAK[ch.toLowerCase()] ?? ch).join('');
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', sol: '/',
};

/** Decode numeric and a handful of named HTML entities. */
export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Code point ranges that carry no glyph but survive copy/paste and JSON
 * transport: the classic way to break a keyword up so a naive scanner misses
 * it while the model reassembles it.
 *
 * Built from explicit hex ranges rather than literal invisible characters.
 * A literal character class is unreviewable in a diff and silently rots when
 * an editor or linter strips it — which had already happened once here,
 * quietly dropping U+200B..U+200E, the four most commonly used of the set.
 */
const INVISIBLE_RANGES = [
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embedding / override
  [0x2060, 0x2064], // word joiner + invisible math operators
  [0x2066, 0x206f], // bidi isolates + deprecated format characters
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
];

const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;

const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join('')}]`,
  'g',
);

/** Remove zero-width and bidi-control characters used to hide instructions. */
export function stripInvisible(text) {
  return text.replace(INVISIBLE, '');
}

/**
 * Attempt base64 decode. Returns the decoded UTF-8 string only when the
 * result is mostly printable — otherwise binary noise is not an injection.
 */
export function tryBase64(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const binary = atob(compact);
    if (binary.length < 8) return null;
    let printable = 0;
    for (let i = 0; i < binary.length; i++) {
      const code = binary.charCodeAt(i);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
    }
    if (printable / binary.length < 0.85) return null;
    return binary;
  } catch {
    return null;
  }
}

/** Every deobfuscated view of a string, cheapest-first. */
export function variants(text) {
  const out = [{ source: 'raw', text }];
  const pushed = new Set([text]);

  const decoded = decodeEntities(text);
  if (decoded !== text && !pushed.has(decoded)) { out.push({ source: 'entities', text: decoded }); pushed.add(decoded); }

  const stripped = stripInvisible(decoded);
  if (stripped !== decoded && !pushed.has(stripped)) { out.push({ source: 'invisible-stripped', text: stripped }); pushed.add(stripped); }

  const leet = deleet(stripped);
  if (leet !== stripped && !pushed.has(leet)) { out.push({ source: 'leetspeak', text: leet }); pushed.add(leet); }

  const b64 = tryBase64(stripped);
  if (b64 && !pushed.has(b64)) { out.push({ source: 'base64', text: b64 }); pushed.add(b64); }

  return out;
}

const PATTERNS = [
  {
    id: 'instruction_override',
    weight: 0.9,
    regex: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,60}\b(all\s+)?(previous|prior|earlier|above|preceding|your)\b[^.\n]{0,30}\b(instruction|instructions|prompt|prompts|rule|rules|direction|directions|guideline|guidelines)\b/i,
  },
  {
    id: 'instruction_override',
    weight: 0.8,
    regex: /\b(new|updated|revised)\s+(system|instruction)s?\s*:/i,
  },
  {
    id: 'role_impersonation',
    weight: 0.85,
    regex: /<\s*(system|assistant|developer)\s*>|\[\s*(system|assistant|developer|inst)\s*\]|###\s*(system|instruction)/i,
  },
  {
    id: 'role_impersonation',
    weight: 0.75,
    regex: /\byou\s+are\s+(now\s+)?(a\s+)?(dan|developer|admin|administrator|root|system)\b/i,
  },
  {
    id: 'exfiltration',
    weight: 0.95,
    regex: /\b(send|post|email|mail|upload|transmit|forward|exfiltrate|leak|beacon|report)\b[^.\n]{0,40}\b(to\s+)?(https?:\/\/|www\.|webhook|attacker|my\s+server|our\s+server|this\s+endpoint|an?\s+(external|remote)\s+(url|server|address))\b/i,
  },
  {
    id: 'exfiltration',
    weight: 0.9,
    regex: /!\[[^\]]*\]\(\s*(?:javascript:|data:text\/html)/i,
  },
  {
    id: 'exfiltration',
    weight: 0.7,
    regex: /\b(secret|api[_ -]?key|token|password|credential)s?\b[^.\n]{0,30}\b(to|into|with)\b/i,
  },
  {
    id: 'tool_coercion',
    weight: 0.8,
    regex: /\b(call|invoke|execute|run|trigger)\b[^.\n]{0,30}\b(tool|function|command|shell|terminal|api)\b/i,
  },
  {
    id: 'tool_coercion',
    weight: 0.75,
    regex: /\b(curl|wget)\b\s+[^\s]*\s*(-d|--data|-X\s+POST|-F)\b/i,
  },
  {
    id: 'markdown_exfil',
    weight: 0.7,
    regex: /!\[[^\]]*\]\(\s*(https?:\/\/|data:)[^)]*\?[^)]*(prompt|message|context|history|conversation|data)=/i,
  },
  {
    id: 'covert_channel',
    weight: 0.85,
    regex: /\b(do\s+not|don't|never)\b[^.\n]{0,40}\b(tell|inform|mention|reveal|show|display|log)\b[^.\n]{0,30}\b(the\s+)?(user|human|operator)\b/i,
  },
  {
    id: 'covert_channel',
    weight: 0.6,
    regex: /\b(hidden|secretly|silently|quietly|without\s+(the\s+user('s)?\s+(knowledge|consent)))\b/i,
  },
];

/**
 * Deterministic triage of a text blob.
 *
 * @param {string} text
 * @param {{ origin?: string }} [options] where the text came from, for reporting
 * @returns {{
 *   suspicious: boolean,
 *   score: number,
 *   hits: Array<{category:string,weight:number,excerpt:string,via:string,origin?:string}>
 * }}
 */
export function scanTextForInjection(text, options = {}) {
  const hits = [];
  const seen = new Set();

  for (const variant of variants(String(text ?? ''))) {
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(variant.text);
      if (!match) continue;

      const key = `${pattern.id}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        category: pattern.id,
        weight: pattern.weight,
        excerpt: match[0].slice(0, 200),
        via: variant.source,
        origin: options.origin,
      });
    }
  }

  // A single high-confidence pattern firing is already conclusive on its own.
  // Averaging them is wrong: "Ignore all previous instructions" is a textbook
  // payload, and one pattern match must be enough to surface it.
  const conclusive = hits.some((h) => h.weight >= 0.8);

  // Diminishing returns: many hits in one blob are not proportionally worse.
  const score = Math.min(1, hits.reduce((sum, h) => sum + h.weight, 0) / 2.5);

  return { suspicious: conclusive || score >= 0.5, score, hits };
}

/** Cap a page's collected text so a huge DOM cannot blow the context budget. */
export function budgetText(chunks, { maxChars = 60000 } = {}) {
  const out = [];
  let total = 0;
  for (const { text, origin, hidden } of chunks) {
    if (total >= maxChars) break;
    const remaining = maxChars - total;
    const slice = text.slice(0, remaining);
    total += slice.length;
    out.push({ text: slice, origin, hidden });
  }
  return out;
}