/** Options / popup page. Loaded as an ES module (extension context). */

import { MODEL, OLLAMA_ORIGIN, MESSAGE_TYPES, DEFAULT_SETTINGS } from '../config.js';
import { health } from '../background/ollama-client.js';
import { getScore } from '../lib/threat-accumulator.js';
import { assertLocal } from '../background/egress-guard.js';

const $ = (sel) => document.querySelector(sel);

const TOGGLES = [
  ['enabled', 'SafeSurf active', 'Master switch. Off means no interception and no model calls.'],
  ['interception', 'Intercept prompts', 'Review prompts before they are sent to a third-party AI.'],
  ['rephrase', 'Model rephrasing', 'Let the local model rewrite free-text PII (names, addresses, employer). Off still leaves the deterministic layer working.'],
  ['injectionScan', 'Injection scanning', 'Read hidden page content and flag prompt-injection attempts.'],
  ['clipboardGuard', 'Clipboard guard', 'Warn when pasted text looks like a credential.'],
  ['threatScore', 'Threat score', 'Accumulate session signals and show the breakdown.'],
  ['showOverlay', 'Show overlay', 'Render the review panel instead of silently passing prompts through.'],
  ['blockOnTimeout', 'Block on model timeout', 'Fail loud. A degraded rewrite is never sent without your say-so.'],
];

async function renderHealth() {
  const el = $('#health');
  const result = await health();

  el.className = `health ${result.ok ? 'ok' : 'bad'}`;
  el.textContent = result.ok ? 'local model ready' : 'local model unavailable';

  $('#healthDetail').innerHTML = [
    ['Origin', OLLAMA_ORIGIN],
    ['Model', MODEL],
    ['Reachable', result.ok ? 'yes' : 'no'],
    ['Installed', result.ok ? (result.installed ? 'yes' : `no — run: ollama pull ${MODEL}`) : '—'],
    ...(result.reason ? [['Reason', result.reason]] : []),
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${String(v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</dd></div>`).join('');
}

async function renderToggles() {
  const current = { ...DEFAULT_SETTINGS, ...((await chrome.storage.local.get('safesurf:settings'))['safesurf:settings'] ?? {}) };

  $('#toggles').innerHTML = TOGGLES.map(([key, label, help]) => `
    <label class="toggle">
      <input type="checkbox" data-key="${key}" ${current[key] ? 'checked' : ''}>
      <span class="body">
        <span class="label">${label}</span>
        <span class="help">${help}</span>
      </span>
    </label>`).join('');

  $('#toggles').addEventListener('change', async (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.settingsSet, [key]: e.target.checked });
  });
}

async function renderScore() {
  const { score, band, breakdown } = await getScore();
  const colour = band === 'high' ? '#ff6b6b' : band === 'elevated' ? '#ffb03b' : '#3ddc84';

  $('#score').innerHTML = `
    <div class="big"><span style="color:${colour}">${score}</span><small>/100 · ${band}</small></div>
    <div class="meter"><i style="width:${score}%;background:${colour}"></i></div>
    <ul class="bd">
      ${breakdown.map((b) => `<li><span>${b.label}</span><b>+${b.contribution.toFixed(1)}</b><em>${b.detail}</em></li>`).join('')}
    </ul>`;
}

function renderEgress() {
  // Live proof, not a claim: ask the guard directly.
  const probes = [OLLAMA_ORIGIN, 'https://api.openai.com/v1/chat/completions', 'http://evil.test/collect'];
  const lines = probes.map((url) => {
    try {
      assertLocal(url);
      return `ALLOWED  ${url}`;
    } catch (err) {
      return `BLOCKED  ${url}\n         ↳ ${err.message}`;
    }
  });
  $('#egress').textContent = lines.join('\n');
}

$('#refreshScore').addEventListener('click', renderScore);

renderHealth();
renderToggles();
renderScore();
renderEgress();