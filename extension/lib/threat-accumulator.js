/**
 * Threat-score accumulator.
 *
 * Collects signals in `chrome.storage.session` (in-memory, cleared on browser
 * restart) and delegates the arithmetic to shared/threat-score.js.
 *
 * `chrome.storage.session` rather than module state because the MV3 service
 * worker is terminated after ~30s of inactivity — any in-memory accumulator
 * would reset between events.
 */

import { STORAGE_KEYS } from '../config.js';
import { computeThreatScore, emptySignals, sensitiveCategory } from '../shared/threat-score.js';

/** Longest session we track. Older sessions are dropped on read. */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

async function read() {
  const bag = await chrome.storage.session.get(STORAGE_KEYS.signals);
  const signals = bag[STORAGE_KEYS.signals];
  if (!signals?.startedAt) return emptySignals();
  if (Date.now() - signals.startedAt > SESSION_TTL_MS) return emptySignals();
  return { ...emptySignals(), ...signals, injectionHits: 0, credentialShapedPrompts: 0, ...signals };
}

async function write(signals) {
  await chrome.storage.session.set({ [STORAGE_KEYS.signals]: signals });
  return signals;
}

/** Reset for a brand-new session. */
export async function reset() {
  return write({ ...emptySignals(), startedAt: Date.now() });
}

async function ensure() {
  const signals = await read();
  return signals;
}

/** Note a host visit. Repeated visits to a sensitive host accumulate weight. */
export async function recordVisit(hostname) {
  const signals = await ensure();
  if (!hostname) return signals;

  if (!signals.allHosts.includes(hostname)) signals.allHosts.push(hostname);
  if (!signals.sensitiveHosts.includes(hostname)) signals.sensitiveHosts.push(hostname);

  // Bank → clinic → payroll in one session is the cross-category drift we care about.
  const cats = new Set(signals.sensitiveHosts.map(sensitiveCategory).filter(Boolean));
  signals.categoryDrift = cats.size;

  return write(signals);
}

/** Accumulate dwell time. Called on an interval from the content script. */
export async function recordDwell(hostname, seconds) {
  const signals = await ensure();
  if (sensitiveCategory(hostname)) {
    signals.dwellSeconds = (signals.dwellSeconds ?? 0) + seconds;
    signals.dwellHost = hostname;
  }
  return write(signals);
}

/** A prompt containing credential-shaped strings was blocked. */
export async function recordCredentialShapedPrompt(count = 1) {
  const signals = await ensure();
  signals.credentialShapedPrompts = (signals.credentialShapedPrompts ?? 0) + count;
  return write(signals);
}

/** An injection finding was surfaced to the user. */
export async function recordInjectionFinding(count = 1) {
  const signals = await ensure();
  signals.injectionHits = (signals.injectionHits ?? 0) + count;
  return write(signals);
}

/** Full score with the breakdown the user actually acts on. */
export async function getScore() {
  const signals = await ensure();
  return computeThreatScore({
    dwellSeconds: signals.dwellSeconds ?? 0,
    sensitiveHosts: signals.sensitiveHosts ?? [],
    allHosts: signals.allHosts ?? [],
    credentialShapedPrompts: signals.credentialShapedPrompts ?? 0,
    injectionHits: signals.injectionHits ?? 0,
  });
}