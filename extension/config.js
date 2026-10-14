/**
 * Single source of configuration truth.
 *
 * The model id appears HERE AND NOWHERE ELSE. `tests/unit/config.test.js`
 * greps the tree to enforce that, so a teammate cannot accidentally pin
 * `gemma4` (which resolves to `:latest` and is not a promise) in a new file.
 */

/** Ollama endpoint. Must stay in lockstep with background/egress-guard.js. */
export const OLLAMA_ORIGIN = 'http://localhost:11434';

/** Pinned tag. NEVER write bare `gemma4` — it resolves to `:latest`. */
export const MODEL = 'gemma4:e4b';

/**
 * gemma4:e4b has thinking ON by default and supports it as a boolean only.
 * Sending `"think": "high"` would be silently ignored and leave thinking on.
 */
export const THINKING = false;

/** Model stays resident for 30m so the first user action is not a model load. */
export const KEEP_ALIVE = '30m';

/**
 * Deliberately overrides Gemma's documented 1.0. A security tool must give
 * the same answer twice.
 */
export const TEMPERATURE = 0.1;

/**
 * Hard cap on generation. Chrome terminates a service worker whose fetch
 * response takes more than 30s to arrive, so this is a correctness constraint
 * and not just a UX preference. Callers may lower it, never raise it past
 * the service-worker floor without switching to streaming.
 */
export const TIMEOUT_MS = 30_000;

/** Context budget per call site. */
export const CTX = {
  rephrase: 4096,
  injection: 16384,
  ocrClassify: 8192,
  visionClassify: 4096,
};

/**
 * Grace period for the PREFLIGHT chat call issued at worker startup so the
 * model is resident before the user's first action.
 */
export const PREFLIGHT_ENABLED = true;

export const STORAGE_KEYS = {
  settings: 'safesurf:settings',
  redactionMap: 'safesurf:redaction-map',
  signals: 'safesurf:signals',
  injectionFindings: 'safesurf:injection-findings',
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  interception: true,
  rephrase: true,
  injectionScan: true,
  clipboardGuard: true,
  threatScore: true,
  showOverlay: true,
  /** Fail loud: block the send and require acknowledgement. */
  blockOnTimeout: true,
};

export const MESSAGE_TYPES = {
  analysePrompt: 'ANALYSE_PROMPT',
  injectionScan: 'INJECTION_SCAN',
  health: 'HEALTH',
  getThreatScore: 'GET_THREAT_SCORE',
  redactOnly: 'REDACT_ONLY',
  unredact: 'UNREDACT',
  settingsGet: 'SETTINGS_GET',
  settingsSet: 'SETTINGS_SET',
  recordDwell: 'RECORD_DWELL',
};