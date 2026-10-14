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
      border: 1px solid #22304a; border-radius: 18px;
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
    .ss-block { padding:10px 12px; border-radius:12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12.5px; white-space:pre-wrap; word-break:break-word; border:1px solid #22304a; }
    .ss-block.original { background:#1a1020; border-color:#3d2447; color:#f0d9f7; }
    .ss-block.safe { background:#08251a; border-color:#1f5c3d; color:#c8f5dd; }

    .ss-tokens { display:flex; flex-wrap:wrap; gap:6px; }
    .ss-chip { font-size:11px; padding:3px 8px; border-radius:99px; background:#16233c; border:1px solid #2b3e5e; color:#9db4d8; font-family:ui-monospace,monospace; }
    .ss-chip.high { background:#2a1220; border-color:#6b2740; color:#ffb4c4; }

    .ss-alert { padding:11px 13px; border-radius:12px; font-size:13px; }
    .ss-alert.warn { background:#2e2408; border:1px solid #6b5220; color:#ffe2b0; }
    .ss-alert.danger { background:#2a1017; border:1px solid #6b2740; color:#ffc2cf; }
    .ss-alert code { font-family:ui-monospace,monospace; font-size:12px; background:rgba(0,0,0,.3); padding:1px 5px; border-radius:6px; display:inline-block; margin:2px 0; }

    .ss-foot { display:flex; gap:9px; padding: 14px 20px 18px; border-top:1px solid #22304a; flex-wrap: wrap; }
    .ss-btn { font:inherit; font-size:13px; font-weight:560; padding:8px 15px; border-radius:10px; cursor:pointer; border:1px solid #2b3e5e; background:#16233c; color:#dbe8ff; transition: background .12s ease, border-color .12s ease; }
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
    .ss-img-wrap img { max-width:100%; border-radius:12px; border:1px solid #22304a; display:block; }
  `;

  let styleInjected = false;

  function ensureRoot() {
    let root = document.getElementById(HOST_ID);
    if (root) return root;

    root = document.createElement('div');
    root.id = HOST_ID;
    root.className = 'ss-root';

    // Inject our own stylesheet.
    //
    // content_scripts[].css (overlay.css) only styles the HOST element — it
    // cannot reach into a subtree Chrome did not create, and shipping every
    // .ss-* rule there would leak them into the page's own cascade. Keeping
    // the rules in JS and scoping them to this root is both correct and the
    // reason the panel is self-contained.
    if (!styleInjected) {
      const style = document.createElement('style');
      style.id = 'safesurf-overlay-style';
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
      styleInjected = true;
    }

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
    isOpen() {
      const root = document.getElementById(HOST_ID);
      return Boolean(root && root.innerHTML.trim().length > 0);
    },

    /** Which findings deserve chip highlighting. */
    tokenChips(byCategory = {}) {
      return Object.entries(byCategory)
        .map(([k, v]) => `<span class="ss-chip ${['aadhaar', 'pan', 'card', 'iban', 'secret'].includes(k) ? 'high' : ''}">${esc(k.toUpperCase())} ×${v}</span>`)
        .join('');
    },

    /** The main interception dialog. */
    showPromptReview({ original, rewritten, byCategory, findings, injection, degraded, degradedReason, blocked, upgrading, isTypingPause }, callbacks = {}) {
      const highCount = (findings ?? []).filter((f) => f.severity === 'high').length;

      const banner = injection?.is_injection
        ? `<div class="ss-alert danger"><strong>Prompt injection detected on this page.</strong><br>${esc(injection.summary || 'The page contains instructions aimed at AI assistants.')}${injection.instructions?.length ? `<br><br>${injection.instructions.slice(0, 3).map((i) => `<code>${esc(i.payload)}</code>`).join('<br>')}` : ''}</div>`
        : '';

      const degradedBanner = degraded
        ? `<div class="ss-alert warn"><strong>Local model did not confirm a safe rewrite.</strong>${degradedReason ? ` (${esc(degradedReason)})` : ''}<br>The text below is deterministic redaction only. Review it before sending.</div>`
        : '';

      // Shown when the panel was painted from the live typing scan and the
      // model-assisted rewrite has not landed yet. Blocking "Send redacted"
      // here matters — otherwise the user sends the deterministic-only text
      // believing free-text PII was handled.
      const upgradingBanner = upgrading
        ? `<div class="ss-alert warn ss-upgrade"><strong>Refining locally…</strong> the local model is still rewriting free-text details. Hold on a moment for the strongest redaction.</div>`
        : '';

      const subTitle = isTypingPause
        ? 'Detected after typing stopped · Sensitive information will not be sent to the web'
        : `${highCount} high-severity finding(s) · processed entirely on this device`;

      const titleText = isTypingPause
        ? 'SafeSurf detected sensitive information'
        : (blocked ? 'SafeSurf blocked this prompt' : 'SafeSurf review');

      const html = `
        <div class="ss-head">
          <div class="ss-title"><i class="ss-dot ${highCount ? 'high' : 'ok'}"></i>
            ${titleText}
          </div>
          <div class="ss-sub">${subTitle}</div>
        </div>

        <div class="ss-body">
          ${banner}
          ${degradedBanner}
          ${upgradingBanner}

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
          <button class="ss-btn primary" data-act="apply">Replace with redacted</button>
          ${upgrading ? '' : '<button class="ss-btn" data-act="send">Send redacted</button>'}
          <button class="ss-btn" data-act="original">Keep original</button>
          <span class="ss-spacer"></span>
          <button class="ss-btn" data-act="cancel">Dismiss</button>
        </div>`;

      const root = mount(html);
      const applyBtn = root.querySelector('[data-act="apply"]');
      if (applyBtn) applyBtn.onclick = () => { api.close(); callbacks.onApply?.(rewritten); };
      const sendBtn = root.querySelector('[data-act="send"]');
      if (sendBtn) sendBtn.onclick = () => { api.close(); callbacks.onSend?.(rewritten); };
      root.querySelector('[data-act="original"]').onclick = () => { api.close(); callbacks.onSendOriginal?.(original); };
      root.querySelector('[data-act="cancel"]').onclick = () => { api.close(); callbacks.onCancel?.(); };

      const onEscape = (e) => {
        if (e.key === 'Escape') {
          window.removeEventListener('keydown', onEscape, true);
          api.close();
          callbacks.onCancel?.();
        }
      };
      window.addEventListener('keydown', onEscape, true);

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
      // Look the existing toast up document-wide. It is appended to
      // <html>, not inside the overlay root, so a root-scoped query always
      // missed and every call stacked another element on the page forever.
      let el = document.querySelector('.ss-toast');
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

    /**
     * Live status pill, anchored next to the composer.
     *
     * This is the whole point of passive scanning: the user learns what will be
     * redacted the moment they stop typing, not after they have already
     * pressed Enter and committed.
     *
     * @param {{text:string, tone:'ok'|'warn'|'danger'|'busy', detail?:string}|null} state
     * @param {DOMRect} [anchor] composer rect, for placement
     * @param {(() => void)|null} [onClick] optional click callback to open full review
     */
    showStatus(state, anchor, onClick) {
      let el = document.getElementById(HOST_ID + '-status');
      if (!state) {
        el?.remove();
        return null;
      }

      if (!el) {
        el = document.createElement('div');
        el.id = HOST_ID + '-status';
        el.className = 'ss-status';
        document.documentElement.appendChild(el);
      }

      const colour = {
        ok: '#3ddc84', warn: '#ffb03b', danger: '#ff6b6a', busy: '#7fb0ff',
      }[state.tone] ?? '#7fb0ff';

      const isInteractive = typeof onClick === 'function';

      // Position ABOVE the composer, floating nicely and always visible
      let bottomPx = 90;
      let leftPx = 24;

      if (anchor && anchor.width > 0 && anchor.height > 0) {
        // Place 10px above the top edge of the composer
        const distFromBottom = window.innerHeight - anchor.top + 10;
        bottomPx = Math.max(20, Math.min(window.innerHeight - 60, distFromBottom));
        leftPx = Math.max(16, Math.min(window.innerWidth - 320, anchor.left));
      } else {
        bottomPx = 90;
        leftPx = 24;
      }

      const actionText = isInteractive && (state.tone === 'warn' || state.tone === 'danger')
        ? `<span style="margin-left:6px;padding:2px 8px;border-radius:6px;background:${colour}25;border:1px solid ${colour}60;font-size:11px;font-weight:600;color:${colour};">Review & Redact</span>`
        : '';

      const html = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colour};box-shadow:0 0 10px ${colour};flex-shrink:0;"></span><span style="font-weight:500;">${esc(state.text)}</span>${actionText}`;

      const css = [
        'all: initial', 'position: fixed', 'z-index: 2147483647',
        `border: 1px solid ${colour}55`, `background: #0f1626f2`,
        `box-shadow: 0 8px 30px rgba(0,0,0,.6)`,
        'border-radius: 99px', 'padding: 8px 16px',
        'font: 13px ui-sans-serif, -apple-system, system-ui, sans-serif',
        'color: #e8f1ff', 'display: flex', 'align-items: center', 'gap: 9px',
        isInteractive ? 'pointer-events: auto; cursor: pointer;' : 'pointer-events: none;',
        'transition: opacity .16s ease, bottom .16s ease',
        `left: ${Math.round(leftPx)}px`,
        `bottom: ${Math.round(bottomPx)}px`,
      ].join(';');

      // Idempotent by construction. This element is a child of <html>, which
      // the content script's SPA watcher observes with subtree:true — so an
      // unconditional write here can re-trigger that watcher forever and lock
      // the page. Repainting only when something actually changed makes the
      // whole class of re-entrancy bug impossible.
      const sig = `${html}|${css}|${isInteractive}`;
      if (el.__ssSig === sig) return el;
      el.__ssSig = sig;

      el.style.cssText = css;
      el.innerHTML = html;

      el.onclick = isInteractive ? (e) => { e.stopPropagation(); onClick(); } : null;

      return el;
    },

    hideStatus() {
      document.getElementById(HOST_ID + '-status')?.remove();
    },

    close() {
      const root = document.getElementById(HOST_ID);
      if (root) root.innerHTML = '';
      // The toast lives outside the root, so it needs clearing separately.
      const toast = document.querySelector('.ss-toast');
      if (toast) { clearTimeout(toast.__t); toast.remove(); }
    },

    CSS,
  };

  window.SafeSurfOverlay = api;
})();