/**
 * Public surface of the shared layer.
 *
 * Everything re-exported here must be pure ESM with zero dependencies and
 * zero platform APIs — the extension loads these directly as unbundled
 * modules, the landing page bundles them through the `@safesurf` alias, and
 * the test suite imports them under bare Node.
 */

export {
  verhoeffValid,
  luhnValid,
  ibanValid,
  shannonEntropy,
  looksLikeSecret,
} from './pii-checksums.js';

export {
  scanDeterministic,
  redact,
  scanAndRedact,
  looksPersonal,
  HIGH_SEVERITY,
} from './pii-deterministic.js';

export {
  RedactionMap,
  unredact,
  tokensIn,
  mergeFindings,
  isToken,
} from './redaction-map.js';

export {
  scanTextForInjection,
  variants,
  deleet,
  decodeEntities,
  stripInvisible,
  tryBase64,
  budgetText,
  INJECTION_CATEGORIES,
} from './injection-text.js';

export {
  computeThreatScore,
  isSensitiveHost,
  sensitiveCategory,
  emptySignals,
  WEIGHTS,
  SENSITIVE_TLDS,
} from './threat-score.js';

export const SHARED_VERSION = '0.1.0';