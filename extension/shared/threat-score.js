/**
 * Threat score — mostly arithmetic.
 *
 * The model contributes at most a small semantic component; everything here
 * is deterministic so the number is reproducible and explainable. The whole
 * point is that we hand the user a BREAKDOWN, not an opaque score — an
 * unactionable number is worse than no number.
 *
 * Pure ESM. Persistence and signal collection live in the extension.
 */

/** Weights sum to 1.0 so the final score is a clean 0-100. */
export const WEIGHTS = {
  sensitive_dwell: 0.25,
  cross_site_hopping: 0.25,
  repeat_credential_shaped: 0.30,
  injection_seen: 0.20,
};

/** Domains where a dwell time or a typed credential is genuinely concerning. */
export const SENSITIVE_TLDS = [
  'bank', 'banking', 'finance', 'pay', 'payments', 'wallet', 'trading',
  'health', 'medical', 'clinic', 'hospital', 'pharmacy', 'insurance',
  'gov', 'gov.in', 'gov.uk', 'nic.in', 'tax', 'irs.gov',
  'edu', 'ac.in', 'university',
];

const COMPILED = SENSITIVE_TLDS.map((tld) => new RegExp(`(^|\\.)${tld.replace(/\./g, '\\.')}$`, 'i'));

/** Is this hostname in a sensitive category? */
export function isSensitiveHost(hostname) {
  if (!hostname) return false;
  return COMPILED.some((re) => re.test(hostname));
}

function normalise(signal, lo, hi) {
  if (hi === lo) return 0;
  return Math.min(1, Math.max(0, (signal - lo) / (hi - lo)));
}

/**
 * @typedef {Object} ThreatSignals
 * @property {number} [dwellSeconds]        time on a sensitive page
 * @property {string[]} [sensitiveHosts]    sensitive hosts visited this session
 * @property {string[]} [allHosts]           every host visited this session
 * @property {number} [credentialShapedPrompts] prompts containing credential-shaped strings
 * @property {number} [injectionHits]        injection findings this session
 */

/**
 * Compute a 0-100 threat score with a full, human-readable breakdown.
 *
 * @param {ThreatSignals} signals
 * @returns {{ score: number, band: 'low'|'elevated'|'high', breakdown: Array<{id:string,label:string,signal:number,weight:number,contribution:number,detail:string}> }}
 */
export function computeThreatScore(signals = {}) {
  const {
    dwellSeconds = 0,
    sensitiveHosts = [],
    allHosts = [],
    credentialShapedPrompts = 0,
    injectionHits = 0,
  } = signals;

  // 1. Long dwell on a sensitive page. 120s is the ceiling for a full point.
  const dwellNorm = isSensitiveHost(sensitiveHosts[0]) ? normalise(dwellSeconds, 0, 120) : 0;

  // 2. Sensitivity hopping: distinct sensitive hosts, plus cross-category drift.
  const distinctSensitive = new Set(sensitiveHosts).size;
  const categories = new Set(sensitiveHosts.map((h) => sensitiveCategory(h)).filter(Boolean));
  const hopNorm = Math.min(1, distinctSensitive / 4) * 0.6 + Math.min(1, categories.size / 3) * 0.4;

  // 3. Credential-shaped strings in prompts. 3 is enough to max out.
  const credentialNorm = normalise(credentialShapedPrompts, 0, 3);

  // 4. Injection attempts seen this session.
  const injectionNorm = normalise(injectionHits, 0, 2);

  const breakdown = [
    {
      id: 'sensitive_dwell',
      label: 'Time on sensitive pages',
      signal: Math.round(dwellSeconds),
      weight: WEIGHTS.sensitive_dwell,
      contribution: dwellNorm * WEIGHTS.sensitive_dwell * 100,
      detail: dwellNorm > 0
        ? `${Math.round(dwellSeconds)}s on ${sensitiveHosts[0] ?? 'a sensitive site'}`
        : 'no dwell on a sensitive site',
    },
    {
      id: 'cross_site_hopping',
      label: 'Cross-site sensitivity hopping',
      signal: distinctSensitive,
      weight: WEIGHTS.cross_site_hopping,
      contribution: hopNorm * WEIGHTS.cross_site_hopping * 100,
      detail: `${distinctSensitive} sensitive host(s), ${categories.size} categor(ies), ${allHosts.length} total host(s)`,
    },
    {
      id: 'repeat_credential_shaped',
      label: 'Credential-shaped strings typed',
      signal: credentialShapedPrompts,
      weight: WEIGHTS.repeat_credential_shaped,
      contribution: credentialNorm * WEIGHTS.repeat_credential_shaped * 100,
      detail: `${credentialShapedPrompts} prompt(s) contained credential-shaped text`,
    },
    {
      id: 'injection_seen',
      label: 'Prompt-injection attempts seen',
      signal: injectionHits,
      weight: WEIGHTS.injection_seen,
      contribution: injectionNorm * WEIGHTS.injection_seen * 100,
      detail: `${injectionHits} injection finding(s) this session`,
    },
  ];

  const score = Math.round(breakdown.reduce((sum, b) => sum + b.contribution, 0));
  const band = score >= 60 ? 'high' : score >= 30 ? 'elevated' : 'low';

  return { score: Math.min(100, score), band, breakdown };
}

/** Bucket a hostname into a sensitivity category, for hopping detection. */
export function sensitiveCategory(hostname) {
  if (!hostname) return null;
  if (/(^|\.)bank|banking|finance|pay|payments|wallet|trading/.test(hostname)) return 'finance';
  if (/(^|\.)health|medical|clinic|hospital|pharmacy|insurance/.test(hostname)) return 'health';
  if (/(^|\.)gov|nic\.|tax|irs/.test(hostname)) return 'government';
  if (/(^|\.)edu|ac\.|university/.test(hostname)) return 'education';
  return null;
}

/** Empty accumulator, so callers never guard against undefined. */
export function emptySignals() {
  return { dwellSeconds: 0, sensitiveHosts: [], allHosts: [], credentialShapedPrompts: 0, injectionHits: 0 };
}