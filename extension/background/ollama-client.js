/**
 * Ollama client — the single wrapper every feature module goes through.
 *
 * STREAMING IS MANDATORY, NOT A PREFERENCE.
 * Chrome terminates an MV3 service worker whose `fetch()` response takes more
 * than 30 seconds to arrive. A `stream:false` request against a 16K-context
 * injection scan reliably exceeds that and kills the worker mid-request.
 * With `stream:true` the response headers land immediately, which both
 * resets the inactivity timer and lets us show real progress.
 */

import {
  OLLAMA_ORIGIN, MODEL, THINKING, KEEP_ALIVE, TEMPERATURE, TIMEOUT_MS,
} from '../config.js';
import { localFetch } from './egress-guard.js';

/**
 * Raised when the model did not answer inside the budget. The service worker
 * turns this into a BLOCK, never a silent pass-through — failing open in a
 * security tool is worse than failing loud.
 */
export class OllamaTimeoutError extends Error {
  constructor(ms) {
    super(`SafeSurf: Ollama did not respond within ${ms}ms`);
    this.name = 'OllamaTimeoutError';
    this.code = 'OLLAMA_TIMEOUT';
    this.timeoutMs = ms;
  }
}

export class OllamaUnavailableError extends Error {
  constructor(cause) {
    super('SafeSurf: local Ollama is unreachable. Start it with `ollama serve`.');
    this.name = 'OllamaUnavailableError';
    this.code = 'OLLAMA_UNAVAILABLE';
    this.cause = cause;
  }
}

/** Is the local model reachable? Never throws. */
export async function health() {
  try {
    const res = await localFetch(`${OLLAMA_ORIGIN}/api/tags`, { timeoutMs: 3000 });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const { models = [] } = await res.json();
    const found = models.some((m) => m.name === MODEL);
    return { ok: true, model: MODEL, installed: found, reason: found ? null : `${MODEL} not pulled` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Load the model into memory without generating. Issued at worker startup so
 * the user's first real action is not a multi-second model load.
 */
export async function preflight() {
  try {
    await localFetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false, think: THINKING, keep_alive: KEEP_ALIVE, messages: [] }),
      timeoutMs: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume Ollama's NDJSON stream, accumulating `message.content`.
 *
 * @param {Response} res
 * @param {{ signal?: AbortSignal, onToken?: (chunk: string) => void }} opts
 */
async function consumeNDJSON(res, { signal, onToken } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let meta = {};

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // NDJSON: one complete JSON object per line, '\n'-terminated.
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // tolerate a truncated final line
        }

        if (frame.error) throw new Error(`SafeSurf: ollama error — ${frame.error}`);

        const delta = frame.message?.content ?? '';
        if (delta) {
          content += delta;
          onToken?.(delta);
        }
        if (frame.message?.thinking) thinking += frame.message.thinking;

        if (frame.done) {
          meta = {
            done_reason: frame.done_reason,
            total_duration: frame.total_duration,
            eval_count: frame.eval_count,
            prompt_eval_count: frame.prompt_eval_count,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (signal?.aborted) reader.cancel().catch(() => {});
  }

  return { content, thinking, meta };
}

/**
 * Chat with the local model.
 *
 * @param {{
 *   system?: string,
 *   user: string,
 *   images?: string[],
 *   schema?: object,
 *   ctx?: number,
 *   timeoutMs?: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   onToken?: (chunk: string) => void,
 * }} params
 * @returns {Promise<{ content: string, raw: any, meta: object }>}
 */
export async function chat({
  system,
  user,
  images = [],
  schema = null,
  ctx = 4096,
  timeoutMs = TIMEOUT_MS,
  temperature = TEMPERATURE,
  signal,
  onToken,
} = {}) {
  if (!user) throw new Error('SafeSurf: chat() requires `user`');

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  // The budget covers generation only. Headers arrive in ms because we stream.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new OllamaTimeoutError(timeoutMs));
  }, timeoutMs);

  const body = {
    model: MODEL,
    stream: true,
    think: THINKING,
    keep_alive: KEEP_ALIVE,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user, ...(images.length ? { images } : {}) },
    ],
    ...(schema ? { format: schema } : {}),
    options: { temperature, num_ctx: ctx },
  };

  let res;
  try {
    res = await localFetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new OllamaTimeoutError(timeoutMs);
    if (signal?.aborted) throw err;
    throw new OllamaUnavailableError(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SafeSurf: ollama ${res.status} ${detail.slice(0, 300)}`);
  }

  const { content, thinking, meta } = await consumeNDJSON(res, { signal, onToken });
  return { content, raw: { content, thinking }, meta };
}

/**
 * Chat constrained by a JSON Schema. Ollama accepts a full schema object in
 * `format` (since v0.5.0) — a bare array of enum values is rejected.
 * The schema is ALSO inlined in the prompt, which measurably improves
 * adherence on small models.
 */
export async function chatJSON({ schema, ...params }) {
  const inlined = `\n\nRespond with JSON matching this schema exactly:\n${JSON.stringify(schema)}`;
  const result = await chat({ ...params, user: `${params.user}${inlined}`, schema });

  let parsed;
  try {
    parsed = JSON.parse(result.content);
  } catch (err) {
    throw new Error(`SafeSurf: model returned invalid JSON — ${result.content.slice(0, 200)}`, { cause: err });
  }
  return { ...result, data: parsed };
}