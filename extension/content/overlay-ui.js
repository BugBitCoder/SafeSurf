/**
 * Overlay UI — renders into the page from the content script's isolated world.
 *
 * Declared BEFORE content.js in manifest.content_scripts so `SafeSurfOverlay`
 * exists on first use. Classic script, no imports: MV3 content scripts are
 * not ES modules, and we keep zero web-accessible surface for this reason.
 */

/* global SafeSurfOverlay */
(() => {
  const HOST_ID = 'safesurf-overlay-root';

  const CSS = `
    .ss-root {
      all: initial;
      position: fixed; inset: 0; z-index: 2147483647;
      font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    .ss-backdrop {
      position: absolute; inset: 0; background: rgba(8,10,14,.72);
      backdrop-filter: blur(3px);
      animation: ss-fade .14s ease-out;
    }
    @keyframes ss-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes ss-rise { from { opacity:0; transform: translateY(10px) scale(.985) } to { opacity:1; transform:none } }

    .ss-panel {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      width: min(680px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
      overflow: auto; background: #0f1626; color: #e8f1ff;
      border: 1px solid #22304a; border-radius: 14px;
      box-shadow: 0 24px 70px rgba(0,0,0,.6);
      animation: ss-rise .18s cubic-bezier(.2,.8,.3,1);
      font-size: 14px; line-height: 1.5;
    }
    .ss-head { padding: 18px 20px 14px; border-bottom: 1px solid #22304a; }
    .ss-title { display:flex; align-items:center; gap:10px; font-size:16px; font-weight:650; letter-spacing:-.01em; }
    .ss-dot { width:9px; height:9px; border-radius:50%; flex:none; }
    .ss-dot.high { background:#ff6b6b; box-shadow:0 0 12px #ff6b6b; }
    .ss-dot.medium { background:#ffb03b; box-shadow:0 0 12px #ffb03b; }
    .ss-dot.ok { background:#3ddc84; box-shadow:0 0 12px #3ddc84; }
    .ss-sub { margin-top:6px; color:#8fa6c8; font-size:13px; }

    .ss-body { padding: 16px 20px; display:grid; gap:14px; }
    .ss-section-title { font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:#6d84a8; margin-bottom:7px; font-weight:600; }

    .ss-diff { display:grid; gap:8px; }
    .ss-block { padding:10px 12px; border-radius:9px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12.5px; white-space:pre-wrap; word-break:break-word; border:1px solid #22304a; }
    .ss-block.original { background:#1a1020; border-color:#3d2447; color:#f0d9f7; }
    .ss-block.safe { background:#08251a; border-color:#1f5c3d; color:#c8f5dd; }

    .ss-tokens { display:flex; flex-wrap:wrap; gap:6px; }
    .ss-chip { font-size:11px; padding:3px 8px; border-radius:99px; background:#16233c; border:1px solid #2b3e5e; color:#9db4d8; font-family:ui-monospace,monospace; }
    .ss-chip.high { background:#2a1220; border-color:#6b2740; color:#ffb4c4; }

    .ss-alert { padding:11px 13px; border-radius:9px; font-size:13px; }
    .ss-alert.warn { background:#2e2408; border:1px solid #6b5220; color:#ffe2b0; }
    .ss-alert.danger { background:#2a1017; border:1px solid #6b2740; color:#ffc2cf; }
    .ss-alert code { font-family:ui-monospace,monospace; font-size:12px; background:rgba(0,0,0,.3); padding:1px 5px; border-radius:4px; display:inline-block; margin:2px 0; }

    .ss-foot { display:flex; gap:9px; padding: 14px 20px 18px; border-top:1px solid #22304a; flex-wrap: wrap; }
    .ss-btn { font:inherit; font-size:13px; font-weight:560; padding:8px 15px; border-radius:8px; cursor:pointer; border:1px solid #2b3e5e; background:#16233c; color:#dbe8ff; transition: background .12s ease, border-color .12s ease; }
    .ss-btn:hover { background:#1d2f4d; }
    .ss-btn.primary { background:#1f5c3d; border-color:#2d8a58; color:#eafff4; }
    .ss-btn.primary:hover { background:#26744b; }
    .ss-btn.danger { background:#3a1520; border-color:#6b2740; color:#ffc2cf; }
    .ss-spacer { flex:1; }

    .ss-score { display:grid; gap:9px; }
    .ss-meter { height:7px; border-radius:99px; background:#1a2438; overflow:hidden; }
    .ss-meter > i { display:block; height:100%; border-radius:99px; transition: width .4s cubic-bezier(.2,.8,.3,1); }
    .ss-bar { display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:5px; }
    .ss-breakdown { display:grid; gap:7px; margin-top:4px; }
    .ss-bd-row { display:grid; grid-template-columns:1fr auto; gap:4px 12px; font-size:12.5px; }
    .ss-bd-row span:last-child { color:#8fa6c8; font-variant-numeric:tabular-nums; }
    .ss-bd-detail { grid-column:1/-1; color:#6d84a8; font-size:11.5px; }

    .ss-img-wrap { display:grid; gap:9px; }
    .ss-img-wrap img { max-width:100%; border-radius:9px; border:1px solid #22304a; display:block; }
  `;

  function ensureRoot() {
    let root = document.getElementById(HOST_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = HOST_ID;
    root.className = 'ss-root';
    document.documentElement.appendChild(root);
    return root;
  }

  function mount(html) {
    const root = ensureRoot();
    root.innerHTML = `<div class="ss-backdrop"></div><div class="ss-panel">${html}</div>`;
    const backdrop = root.querySelector('.ss-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => api.close());
    return root;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const api = {
    /** Which findings deserve chip highlighting. */
    tokenChips(byCategory = {}) {
      return Object.entries(byCategory)
        .map(([k, v]) => `<span class="ss-chip ${['aadhaar', 'pan', 'card', 'iban', 'secret'].includes(k) ? 'high' : ''}">${esc(k.toUpperCase())} ×${v}</span>`)
        .join('');
    },

    /** The main interception dialog. */
    showPromptReview({ original, rewritten, byCategory, findings, injection, degraded, degradedReason, blocked }, callbacks = {}) {
      const highCount = (findings ?? []).filter((f) => f.severity === 'high').length;

      const banner = injection?.is_injection
        ? `<div class="ss-alert danger"><strong>Prompt injection detected on this page.</strong><br>${esc(injection.summary || 'The page contains instructions aimed at AI assistants.')}${injection.instructions?.length ? `<br><br>${injection.instructions.slice(0, 3).map((i) => `<code>${esc(i.payload)}</code>`).join('<br>')}` : ''}</div>`
        : '';

      const degradedBanner = degraded
        ? `<div class="ss-alert warn"><strong>Local model did not confirm a safe rewrite.</strong>${degradedReason ? ` (${esc(degradedReason)})` : ''}<br>The text below is deterministic redaction only. Review it before sending.</div>`
        : '';

      const html = `
        <div class="ss-head">
          <div class="ss-title"><i class="ss-dot ${highCount ? 'high' : 'ok'}"></i>
            ${blocked ? 'SafeSurf blocked this prompt' : 'SafeSurf review'}
          </div>
          <div class="ss-sub">${highCount} high-severity finding(s) · processed entirely on this device</div>
        </div>

        <div class="ss-body">
          ${banner}
          ${degradedBanner}

          <div>
            <div class="ss-section-title">What you typed</div>
            <div class="ss-block original">${esc(original)}</div>
          </div>

          <div>
            <div class="ss-section-title">What the AI will receive</div>
            <div class="ss-block safe">${esc(rewritten)}</div>
          </div>

          ${Object.keys(byCategory ?? {}).length ? `<div>
            <div class="ss-section-title">Redacted locally</div>
            <div class="ss-tokens">${api.tokenChips(byCategory)}</div>
          </div>` : ''}
        </div>

        <div class="ss-foot">
          <button class="ss-btn primary" data-act="send">Send redacted</button>
          <button class="ss-btn" data-act="original">Send original anyway</button>
          <span class="ss-spacer"></span>
          <button class="ss-btn" data-act="cancel">Cancel</button>
        </div>`;

      const root = mount(html);
      root.querySelector('[data-act="send"]').onclick = () => { api.close(); callbacks.onSend?.(rewritten); };
      root.querySelector('[data-act="original"]').onclick = () => { api.close(); callbacks.onSendOriginal?.(original); };
      root.querySelector('[data-act="cancel"]').onclick = () => { api.close(); callbacks.onCancel?.(); };
      return root;
    },

    showImageReview({ before, after, boxes, warnings, docType }, callbacks = {}) {
      const html = `
        <div class="ss-head">
          <div class="ss-title"><i class="ss-dot ${boxes?.length ? 'high' : 'ok'}"></i>Image redaction</div>
          <div class="ss-sub">${boxes?.length ?? 0} region(s) blacked out · OCR ran locally, model classified text only</div>
        </div>
        <div class="ss-body">
          ${(warnings ?? []).map((w) => `<div class="ss-alert warn">${esc(w)}</div>`).join('')}
          ${before ? `<div><div class="ss-section-title">Original</div><div class="ss-img-wrap"><img src="${before}" alt="original"></div></div>` : ''}
          ${after ? `<div><div class="ss-section-title">Safe to share</div><div class="ss-img-wrap"><img src="${after}" alt="redacted"></div></div>` : ''}
        </div>
        <div class="ss-foot">
          <span class="ss-spacer"></span>
          <button class="ss-btn primary" data-act="close">Close</button>
        </div>`;
      const root = mount(html);
      root.querySelector('[data-act="close"]').onclick = () => { api.close(); callbacks.onClose?.(); };
      return root;
    },

    showThreatScore({ score, band, breakdown }) {
      const colour = band === 'high' ? '#ff6b6b' : band === 'elevated' ? '#ffb03b' : '#3ddc84';
      const html = `
        <div class="ss-head">
          <div class="ss-title"><i class="ss-dot" style="background:${colour};box-shadow:0 0 12px ${colour}"></i>
            Threat score <span style="color:${colour}">${score}</span>/100</div>
          <div class="ss-sub">Band: ${esc(band)} · session signals only, nothing stored on disk</div>
        </div>
        <div class="ss-body">
          <div class="ss-score">
            <div class="ss-meter"><i style="width:${score}%;background:${colour}"></i></div>
            <div class="ss-breakdown">
              ${breakdown.map((b) => `<div class="ss-bd-row">
                <span>${esc(b.label)}</span><span>+${b.contribution.toFixed(1)}</span>
                <span class="ss-bd-detail">${esc(b.detail)}</span>
              </div>`).join('')}
            </div>
          </div>
        </div>
        <div class="ss-foot"><span class="ss-spacer"></span><button class="ss-btn primary" data-act="close">Close</button></div>`;
      const root = mount(html);
      root.querySelector('[data-act="close"]').onclick = () => api.close();
      return root;
    },

    showToast(message, tone = 'ok', ms = 4200) {
      const root = ensureRoot();
      let el = root.querySelector('.ss-toast');
      if (!el) {
        el = document.createElement('div');
        el.className = 'ss-toast';
        Object.assign(el.style, {
          all: 'initial', position: 'fixed', bottom: '20px', left: '50%',
          transform: 'translateX(-50%)', zIndex: '2147483647',
          padding: '10px 15px', borderRadius: '9px', font: '13px ui-sans-serif, system-ui, sans-serif',
          boxShadow: '0 10px 34px rgba(0,0,0,.45)', maxWidth: 'min(520px, calc(100vw - 32px))',
          transition: 'opacity .2s ease, transform .2s ease',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = message;
      el.style.background = tone === 'danger' ? '#2a1017' : tone === 'warn' ? '#2e2408' : '#08251a';
      el.style.color = tone === 'danger' ? '#ffc2cf' : tone === 'warn' ? '#ffe2b0' : '#c8f5dd';
      el.style.border = `1px solid ${tone === 'danger' ? '#6b2740' : tone === 'warn' ? '#6b5220' : '#1f5c3d'}`;
      el.style.opacity = '1';
      clearTimeout(el.__t);
      el.__t = setTimeout(() => { el.style.opacity = '0'; }, ms);
    },

    close() {
      const root = document.getElementById(HOST_ID);
      if (root) root.innerHTML = '';
    },

    CSS,
  };

  window.SafeSurfOverlay = api;
})();