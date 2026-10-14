/**
 * Rephrasing — the one place output quality is user-visible.
 *
 * Runs AFTER the deterministic layer. The model only ever sees text that
 * has already had every checksum-validated identifier replaced, so the
 * thesis does not depend on the model cooperating.
 *
 * `original` comes back from the model, which is what lets us hold a
 * reversible map locally: the remote AI sees only `rewritten`, the user's
 * own device keeps the plaintext. That is the strongest argument in the
 * writeup, so it is a first-class feature rather than a side effect.
 */

import { CTX } from '../config.js';
import { chatJSON } from '../background/ollama-client.js';
import { RedactionMap, mergeFindings } from '../shared/redaction-map.js';

const SYSTEM = `You are SafeSurf's redaction engine. You rewrite a user's prompt so it can be sent to a third-party AI without leaking personal data.

Rules:
1. Replace personally identifying content with stable tokens of the form [CATEGORY_N], e.g. [AADHAAR_1], [PAN_1], [EMAIL_1], [NAME_1], [ADDRESS_1], [EMPLOYER_1], [DIAGNOSIS_1].
2. NEVER invent a replacement that was not in the original text. If a span is not PII, leave it exactly as it is.
3. Preserve the user's intent completely. A rewritten prompt must be answerable in exactly the same way as the original.
4. Never add commentary, apologies, or explanations to \`rewritten\`. It must read as a natural prompt a human would have typed.
5. Copy an 'original' span verbatim into your findings. Do not paraphrase it.
6. If the text contains no PII at all, return it unchanged with an empty \`found\` array.`;

const SCHEMA = {
  type: 'object',
  properties: {
    rewritten: { type: 'string' },
    found: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['aadhaar', 'pan', 'credentials', 'financial', 'health', 'contact', 'pii', 'none'],
          },
          original: { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['category', 'original', 'replacement'],
      },
    },
    intent_preserved: { type: 'boolean' },
  },
  required: ['rewritten', 'found', 'intent_preserved'],
};

/**
 * Deterministic fallback used when the model reports a lost intent or the
 * call fails. A degraded-but-safe prompt beats a leak the user did not
 * choose — and an intent-lost rewrite is worse than no rewrite at all.
 */
export function templateRewrite(text) {
  const generic = text.replace(/\b(?:I|my)\b/gi, 'the user').replace(/\s{2,}/g, ' ').trim();
  return {
    rewritten: generic || text,
    found: [],
    intent_preserved: true,
    degraded: true,
    reason: 'template-fallback',
  };
}

/**
 * Rephrase a prompt for safe transmission.
 *
 * @param {string} text  Already deterministically redacted by the caller.
 * @param {RedactionMap} map  Populated with any new token↔plaintext pairs.
 * @returns {Promise<{rewritten:string,found:Array,intent_preserved:boolean,degraded:boolean,reason?:string}>}
 */
export async function rephrase(text, map) {
  if (!text || !text.trim()) {
    return { rewritten: text, found: [], intent_preserved: true, degraded: false };
  }

  let data;
  try {
    ({ data } = await chatJSON({
      system: SYSTEM,
      user: text,
      schema: SCHEMA,
      ctx: CTX.rephrase,
    }));
  } catch (err) {
    // Model unavailable, timed out, or emitted invalid JSON.
    return { ...templateRewrite(text), reason: `model-error:${err.code ?? err.message}` };
  }

  if (data.intent_preserved === false) {
    return { ...templateRewrite(text), reason: 'intent-not-preserved' };
  }

  if (typeof data.rewritten !== 'string' || !data.rewritten.trim()) {
    return { ...templateRewrite(text), reason: 'empty-rewrite' };
  }

  const found = Array.isArray(data.found) ? data.found.filter((f) => f?.original && f?.replacement) : [];
  if (map instanceof RedactionMap) mergeFindings(map, found);

  return {
    rewritten: data.rewritten,
    found,
    intent_preserved: true,
    degraded: false,
  };
}