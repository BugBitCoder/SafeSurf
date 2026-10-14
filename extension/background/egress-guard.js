/**
 * Egress guard — makes the thesis testable rather than merely claimed.
 *
 * Every network call in the service worker goes through `localFetch`.
 * There is no second code path to Ollama. If a teammate adds a `fetch` that
 * bypasses this, `tests/unit/egress-guard.test.js` fails.
 */

import { OLLAMA_ORIGIN } from '../config.js';

/** The only origin this extension is ever permitted to talk to. */
export const ALLOWED_ORIGIN = OLLAMA_ORIGIN;

/**
 * Throw unless `url` resolves to the local Ollama origin.
 * @param {string} url
 * @returns {string} the same url, for chaining
 */
export function assertLocal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SafeSurf: blocked malformed URL ${url}`);
  }
  if (parsed.origin !== ALLOWED_ORIGIN) {
    throw new Error(`SafeSurf: blocked non-local request to ${parsed.origin}`);
  }
  return url;
}

/**
 * `fetch`, narrowed to localhost. This is the ONLY network primitive the
 * service worker is allowed to use.
 *
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<Response>}
 */
export async function localFetch(url, init = {}) {
  assertLocal(url);
  const { timeoutMs, ...rest } = init;
  if (timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('SafeSurf: request timed out')), timeoutMs);
    try {
      return await fetch(url, { ...rest, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  return fetch(url, rest);
}