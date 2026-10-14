/**
 * Service worker — the single egress point.
 *
 * INVARIANT: no feature module calls `fetch` directly. Everything routes
 * through background/ollama-client.js, which routes through
 * background/egress-guard.js, which refuses any origin but localhost:11434.
 * `tests/unit/egress-guard.test.js` enforces this by scanning the tree.
 *
 * LIFETIME NOTE: an MV3 worker is terminated after ~30s of inactivity and
 * loses all module state. Treat every handler as if it just booted: read
 * from chrome.storage at the top, register listeners synchronously at the
 * top level, never register them inside an await.
 */

import {
  OLLAMA_ORIGIN, MODEL, MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_SETTINGS, PREFLIGHT_ENABLED,
} from '../config.js';
import { chat, health, preflight } from './ollama-client.js';
import { scanAndRedact } from '../shared/pii-deterministic.js';
import { RedactionMap, unredact, mergeFindings } from '../shared/redaction-map.js';
import { rephrase } from '../lib/rephrase.js';
import { scan as injectionScan, triage } from '../lib/injection-scan.js';
import { inspectClipboard } from '../lib/clipboard-guard.js';
import * as threat from '../lib/threat-accumulator.js';

// ---------------------------------------------------------------------------
// Settings + reversible map, both in chrome.storage
// ---------------------------------------------------------------------------

async function getSettings() {
  const bag = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(bag[STORAGE_KEYS.settings] ?? {}) };
}

/**
 * The redaction map lives in chrome.storage.session: it survives worker
 * termination but is memory-resident, so plaintext PII never reaches disk,
 * and it is cleared when the browser closes. That is the right trade for a
 * product whose entire claim is that secrets do not leave the device.
 */
async function getMap() {
  const bag = await chrome.storage.session.get(STORAGE_KEYS.redactionMap);
  return RedactionMap.fromJSON(bag[STORAGE_KEYS.redactionMap] ?? []);
}

async function saveMap(map) {
  map.prune();
  await chrome.storage.session.set({ [STORAGE_KEYS.redactionMap]: map.toJSON() });
}

// ---------------------------------------------------------------------------
// Prompt analysis — the main path
// ---------------------------------------------------------------------------

/**
 * Full analysis of a prompt the user is about to send.
 *
 * `passive: true` runs the deterministic layers ONLY — no model call at all.
 * That is what makes live-as-you-type feedback viable: it costs single-digit
 * milliseconds, so it can run on every typing pause without being felt.
 * The model-assisted work (rephrase, injection confirmation) still happens on
 * the actual submit.
 *
 * Order is the security property, not an implementation detail:
 *   1. deterministic PII (model-free, checksum-gated)
 *   2. deterministic injection triage (model-free)
 *   3. model rephrase, ONLY on what survived step 1
 *
 * The model never sees a checksum-valid identifier, so the product stays
 * safe even if gemma4:e4b decides to comply instead of redacting.
 */
async function analysePrompt({ text, pageChunks = [], doInjectionScan = true, passive = false }) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { blocked: false, reason: 'disabled', text, redacted: text, rewritten: text, findings: [], passive };
  }

  // 1 — deterministic
  const { redacted: deterministicText, findings, byCategory, personal } = scanAndRedact(text);
  const map = await getMap();
  if (!passive) {
    // Only persist plaintext to the session map when the user actually sends.
    // A passive scan runs on every typing pause and must not accumulate
    // half-typed secrets.
    findings.forEach((f) => map.set(f.replacement, f.original, f.category));
    await saveMap(map);
  }

  // 2 — deterministic injection triage on the page
  let injection = null;
  if (doInjectionScan && settings.injectionScan && pageChunks.length) {
    const quick = triage(pageChunks);
    if (quick.suspicious) {
      // Escalating to the model costs seconds. Defer that to the real submit.
      injection = passive ? null : await injectionScan(pageChunks);
      if (!injection) {
        injection = {
          is_injection: true,
          confidence: quick.score,
          instructions: quick.hits.map((h) => ({
            payload: h.excerpt, category: h.category, target: h.origin ?? '', hidden: h.hidden, source: 'deterministic',
          })),
          summary: 'Detected while typing — full confirmation runs on send.',
          deterministic: quick,
          modelRan: false,
        };
      }
    } else {
      // Report an explicit clean verdict rather than null, so the caller can
      // tell "scanned, found nothing" apart from "not scanned".
      injection = {
        is_injection: false,
        confidence: quick.score,
        instructions: [],
        summary: '',
        deterministic: quick,
        modelRan: false,
      };
    }
    if (injection?.is_injection && !passive) await threat.recordInjectionFinding(injection.instructions.length);
  }

  // 3 — model rephrase, on the already-redacted text, and ONLY when there is
  // a reason to believe free-text PII is present. Skipping the round trip for
  // obviously-clean prompts is what makes a clean prompt pass through
  // instantly; a ~6s model call on every keystroke would be unusable.
  const needsModel = !passive && settings.rephrase && (findings.length > 0 || personal);
  let rewritten = deterministicText;
  let degraded = false;
  let degradedReason;

  if (needsModel) {
    try {
      const result = await rephrase(deterministicText, map);
      rewritten = result.rewritten;
      degraded = result.degraded;
      degradedReason = result.reason;
      // Route through mergeFindings rather than writing directly — the model
      // output is untrusted and must never overwrite a deterministic entry.
      mergeFindings(map, result.found);
      await saveMap(map);
    } catch (err) {
      degraded = true;
      degradedReason = err.code ?? err.message;
    }
  }

  const highSeverity = findings.filter((f) => f.severity === 'high');
  if (highSeverity.length && !passive) await threat.recordCredentialShapedPrompt(highSeverity.length);

  const blocking = highSeverity.length > 0 || Boolean(injection?.is_injection);

  return {
    blocked: blocking,
    // Fail LOUD. A degraded rewrite is never silently sent.
    degraded,
    degradedReason,
    original: text,
    redacted: deterministicText,
    rewritten,
    findings,
    byCategory,
    injection,
    personal,
    passive,
    modelRan: needsModel && !degraded,
  };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const handlers = {
  [MESSAGE_TYPES.analysePrompt]: (msg) => analysePrompt(msg),

  [MESSAGE_TYPES.redactOnly]: async ({ text }) => {
    const { redacted, findings, byCategory } = scanAndRedact(text);
    return { redacted, findings, byCategory };
  },

  [MESSAGE_TYPES.injectionScan]: async ({ chunks }) => injectionScan(chunks ?? []),

  [MESSAGE_TYPES.health]: async () => ({
    ...(await health()),
    origin: OLLAMA_ORIGIN,
    model: MODEL,
    version: chrome.runtime.getManifest().version,
  }),

  [MESSAGE_TYPES.getThreatScore]: async () => threat.getScore(),

  [MESSAGE_TYPES.unredact]: async ({ text }) => {
    const map = await getMap();
    return { restored: unredact(text, map) };
  },

  [MESSAGE_TYPES.settingsGet]: async () => getSettings(),

  [MESSAGE_TYPES.settingsSet]: async (patch) => {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    return next;
  },

  [MESSAGE_TYPES.recordDwell]: async ({ hostname, seconds }) => {
    await threat.recordDwell(hostname, seconds);
    return threat.getScore();
  },

  INSPECT_CLIPBOARD: async ({ text }) => inspectClipboard(text),

  OFFSCREEN_READ_CLIPBOARD: async () => ({ text: null }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];

  // Offscreen documents answer for themselves so the content script's
  // clipboard relay resolves with the real text.
  if (message?.type === 'OFFSCREEN_READ_CLIPBOARD') return false;

  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
    return false;
  }

  Promise.resolve(handler(message, sender))
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code ?? null }));

  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Tab host tracking (threat score) + startup
// ---------------------------------------------------------------------------

chrome.tabs?.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => {
    if (tab?.url) {
      try { threat.recordVisit(new URL(tab.url).hostname); } catch { /* not a real URL */ }
    }
  }).catch(() => {});
});

chrome.tabs?.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  try { threat.recordVisit(new URL(tab.url).hostname); } catch { /* not a real URL */ }
});

chrome.runtime.onInstalled.addListener(async () => {
  await threat.reset();
  await getSettings();
  if (PREFLIGHT_ENABLED) await preflight();
});

chrome.runtime.onStartup.addListener(async () => {
  await threat.reset();
  if (PREFLIGHT_ENABLED) await preflight();
});

// A worker revived by an event also wants the model resident.
chrome.runtime.onMessage.addListener(() => {
  if (PREFLIGHT_ENABLED) preflight();
  return false;
});

export { chat, analysePrompt, getSettings };