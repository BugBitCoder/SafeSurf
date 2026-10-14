/**
 * Clipboard guard.
 *
 * TWO PLATFORM FACTS DRIVE THE DESIGN:
 *
 * 1. `navigator.clipboard` is NOT exposed to MV3 service workers
 *    (crbug 1160302), and offscreen documents cannot use it either because
 *    the Clipboard API requires document focus (crbug 1404835). The only
 *    working path is `document.execCommand('paste')` inside an offscreen
 *    document with `chrome.offscreen.Reason.CLIPBOARD`.
 *
 * 2. Clipboard access must follow a genuine user gesture. We never poll.
 *
 * Warn, never block.
 */

import { looksLikeSecret, luhnValid } from '../shared/pii-checksums.js';

/** Base64 payloads are ambiguous; require the decoded text to look like a credential. */
const CREDENTIAL_PATTERNS = [
  { id: 'aws_access_key', label: 'AWS access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: 'github_token', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'slack_token', label: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/ },
  { id: 'private_key', label: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'password_assignment', label: 'Password assignment', re: /\b(?:pass(?:word|wd)?|pwd|secret)\s*[:=]\s*\S{6,}/i },
  { id: 'card_number', label: 'Payment card number', re: /\b(?:\d[ -]?){12,18}\d\b/ },
  { id: 'credential_url', label: 'Credential in URL', re: /[?&](?:password|passwd|token|api[_-]?key|secret)=[^&\s]{6,}/i },
];

/**
 * Classify clipboard text. Model-free.
 *
 * @param {string} text
 * @returns {{ risky: boolean, findings: Array<{id:string,label:string,excerpt:string}> }}
 */
export function inspectClipboard(text) {
  if (!text) return { risky: false, findings: [] };

  const findings = [];
  const claimed = new Array(text.length).fill(false);

  for (const pattern of CREDENTIAL_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) { re.lastIndex += 1; continue; }

      let overlaps = false;
      for (let i = start; i < end; i++) if (claimed[i]) { overlaps = true; break; }
      if (overlaps) continue;

      // Gate the card pattern on Luhn, same as the deterministic layer.
      if (pattern.id === 'card_number' && !luhnValid(m[0].replace(/\D/g, ''))) continue;

      for (let i = start; i < end; i++) claimed[i] = true;
      findings.push({ id: pattern.id, label: pattern.label, excerpt: m[0].slice(0, 60) });
    }
  }

  // High-entropy tokens in untouched regions.
  const tokenRe = /[A-Za-z0-9_\-+/=]{16,}/g;
  let t;
  while ((t = tokenRe.exec(text)) !== null) {
    const start = t.index;
    const end = start + t[0].length;
    let overlaps = false;
    for (let i = start; i < end; i++) if (claimed[i]) { overlaps = true; break; }
    if (overlaps) continue;
    if (!looksLikeSecret(t[0])) continue;
    for (let i = start; i < end; i++) claimed[i] = true;
    findings.push({ id: 'high_entropy', label: 'High-entropy token', excerpt: t[0].slice(0, 40) });
  }

  return { risky: findings.length > 0, findings };
}

/** Create the offscreen document used to reach the clipboard. */
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (existing?.length) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: 'Read clipboard text on an explicit user gesture to warn about pasted secrets.',
  });
}

/**
 * Read the clipboard. MUST be invoked from a real user gesture in the
 * content script, which then relays to the service worker.
 * @returns {Promise<string|null>}
 */
export async function readClipboard() {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_READ_CLIPBOARD' });
  return res?.text ?? null;
}