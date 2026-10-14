/**
 * Content script — captures prompt text and page content before submission.
 *
 * Classic script, zero imports: MV3 content scripts are not ES modules, and
 * keeping it import-free means we expose nothing via web_accessible_resources.
 * All logic that needs the shared library or the model runs in the service
 * worker.
 *
 * CAPTURE STRATEGY
 * - Capture-phase listeners on window, so we run BEFORE the page's React
 *   handlers see the event.
 * - A MutationObserver on the composer container, because SPAs re-render and
 *   swap the node, which silently invalidates bound listeners.
 * - A generic adapter plus a tuned ChatGPT adapter (ProseMirror).
 */

(() => {
  if (window.__safesurfLoaded) return;
  window.__safesurfLoaded = true;

  const OVERLAY = () => window.SafeSurfOverlay;
  let enabled = true;
  let interception = true;
  let busy = false;

  // -------------------------------------------------------------------------
  // Composer adapters
  // -------------------------------------------------------------------------

  /**
   * ChatGPT's visible composer is a ProseMirror contenteditable div. The
   * <textarea name="prompt-textarea"> that shares its id is hidden and cleared
   * on submit — reading it gives you an empty string. Read the visible editor.
   */
  const ADAPTERS = [
    {
      id: 'chatgpt',
      match: () => location.hostname.endsWith('chatgpt.com') || location.hostname === 'chat.openai.com',
      find: () => document.querySelector('div.ProseMirror[contenteditable="true"][role="textbox"]')
        ?? document.querySelector('#prompt-textarea')
        ?? document.querySelector('textarea[data-testid="prompt-textarea"]'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => setReactValue(el, text),
    },
    {
      id: 'claude',
      match: () => location.hostname.endsWith('claude.ai'),
      find: () => document.querySelector('div[contenteditable="true"][role="textbox"]') ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => setReactValue(el, text),
    },
    {
      id: 'gemini',
      match: () => location.hostname.endsWith('gemini.google.com'),
      find: () => document.querySelector('rich-textarea div[contenteditable="true"]') ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => setReactValue(el, text),
    },
    {
      id: 'generic',
      match: () => true,
      find: () => document.querySelector('textarea:not([type="hidden"]):not([disabled])')
        ?? document.querySelector('[contenteditable="true"][role="textbox"]')
        ?? document.querySelector('[contenteditable="true"]'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => setReactValue(el, text),
    },
  ];

  function activeAdapter() {
    return ADAPTERS.find((a) => a.match()) ?? ADAPTERS[ADAPTERS.length - 1];
  }

  /**
   * Setting .value directly is silently ignored by React 18+ controlled
   * inputs because its value tracker sees no change. Go through the native
   * prototype setter, then fire the input event React listens for.
   */
  function setReactValue(el, text) {
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'INPUT' ? HTMLInputElement.prototype : null;

    if (proto) {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
    } else {
      el.innerText = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // Page content collection — visible AND hidden
  // -------------------------------------------------------------------------

  const HIDDEN_SELECTOR = [
    '[style*="display:none"]', '[style*="display: none"]',
    '[style*="visibility:hidden"]', '[style*="visibility: hidden"]',
    '[style*="opacity:0"]', '[style*="opacity: 0"]',
    '.sr-only', '.visually-hidden', '[hidden]', 'template',
    '[aria-hidden="true"]', '[tabindex="-1"][style*="clip"]',
  ].join(',');

  /** Walk comment nodes with a TreeWalker — querySelectorAll cannot see them. */
  function collectComments(root = document.body) {
    if (!root) return [];
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      // Skip the usual licence/build noise.
      if (text && text.length > 20 && !/^\s*(?:copyright|licen[cs]e|!)/i.test(text)) out.push(text.slice(0, 2000));
    }
    return out;
  }

  function collectPageChunks() {
    const chunks = [];

    const visible = document.body?.innerText ?? '';
    if (visible.trim()) chunks.push({ text: visible.slice(0, 30000), origin: 'visible-text', hidden: false });

    const comments = collectComments();
    if (comments.length) chunks.push({ text: comments.join('\n').slice(0, 8000), origin: 'html-comment', hidden: true });

    const hiddenEls = [...document.querySelectorAll(HIDDEN_SELECTOR)].slice(0, 120);
    const hiddenText = hiddenEls
      .map((el) => `${el.textContent ?? ''} ${el.getAttribute('alt') ?? ''}`.trim())
      .filter((t) => t.length > 3)
      .join('\n');
    if (hiddenText.trim()) chunks.push({ text: hiddenText.slice(0, 10000), origin: 'hidden-nodes', hidden: true });

    // Attribute-borne payloads: alt/title/placeholder/aria-label/data-* are
    // all fed to a model reading the page but never rendered visibly.
    const attrs = [];
    for (const el of document.querySelectorAll('[alt],[title],[placeholder],[aria-label],[data-prompt],[data-instruction]')) {
      for (const name of ['alt', 'title', 'placeholder', 'aria-label', 'data-prompt', 'data-instruction']) {
        const v = el.getAttribute?.(name);
        if (v && v.trim().length > 8) attrs.push(v.trim());
      }
    }
    if (attrs.length) chunks.push({ text: [...new Set(attrs)].join('\n').slice(0, 8000), origin: 'attributes', hidden: true });

    return chunks;
  }

  // -------------------------------------------------------------------------
  // Interception
  // -------------------------------------------------------------------------

  async function onSubmitCaptured(event) {
    if (!interception || busy) return;
    if (event.isTrusted === false) return;

    const adapter = activeAdapter();
    const el = adapter.find();
    if (!el) return;

    const text = adapter.read(el).trim();
    if (!text || text.length < 3) return;

    busy = true;
    const submitEvent = event;

    try {
      // Stop the page from sending while we decide.
      submitEvent.preventDefault?.();
      submitEvent.stopImmediatePropagation?.();

      OVERLAY().showToast('SafeSurf is analysing this prompt locally…', 'warn', 8000);

      const res = await chrome.runtime.sendMessage({
        type: 'ANALYSE_PROMPT',
        text,
        pageChunks: collectPageChunks(),
      });

      if (!res?.ok) {
        // FAIL LOUD. Never silently forward a prompt we could not inspect.
        OVERLAY().showPromptReview(
          { original: text, rewritten: text, byCategory: {}, findings: [], degraded: true, degradedReason: res?.error, blocked: true },
          {
            onSend: () => resubmit(adapter, el, text),
            onSendOriginal: () => resubmit(adapter, el, text),
            onCancel: () => {},
          },
        );
        return;
      }

      const clean = res.redacted ?? text;
      const rewritten = res.rewritten ?? clean;
      const needsReview = res.blocked || res.degraded || res.injection?.is_injection
        || Object.keys(res.byCategory ?? {}).length > 0;

      if (!needsReview) {
        resubmit(adapter, el, text); // untouched pass-through
        return;
      }

      OVERLAY().showPromptReview(
        {
          original: text, rewritten, byCategory: res.byCategory, findings: res.findings,
          injection: res.injection, degraded: res.degraded, degradedReason: res.degradedReason, blocked: res.blocked,
        },
        {
          onSend: () => resubmit(adapter, el, rewritten),
          onSendOriginal: () => resubmit(adapter, el, text),
          onCancel: () => {},
        },
      );
    } catch (err) {
      OVERLAY().showToast(`SafeSurf error: ${err.message}. Prompt not sent.`, 'danger');
    } finally {
      busy = false;
    }
  }

  /** Write the final text and dispatch a fresh, trusted-looking Enter. */
  function resubmit(adapter, el, text) {
    adapter.write(el, text);
    setTimeout(() => {
      el.focus?.();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.click?.();
    }, 60);
  }

  // -------------------------------------------------------------------------
  // Clipboard guard
  // -------------------------------------------------------------------------

  async function onPaste(event) {
    if (!enabled) return;
    const target = event.target;
    const isField = target?.matches?.('input,textarea,[contenteditable="true"]');
    if (!isField) return;

    let text = event.clipboardData?.getData('text/plain');
    if (!text) {
      // Async fallback, gated on the user gesture that produced this paste.
      try { text = await navigator.clipboard.readText(); } catch { return; }
    }
    if (!text) return;

    try {
      const res = await chrome.runtime.sendMessage({ type: 'INSPECT_CLIPBOARD', text });
      if (res?.ok && res.risky) {
        OVERLAY().showToast(
          `That looks like a secret — ${res.findings.map((f) => f.label).join(', ')}. It is still local; consider redacting before pasting into an AI.`,
          'danger', 6500,
        );
      }
    } catch { /* service worker asleep; clipboard guard is advisory */ }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async function loadSettings() {
    try {
      const s = await chrome.runtime.sendMessage({ type: 'SETTINGS_GET' });
      enabled = s?.enabled ?? true;
      interception = s?.interception ?? true;
    } catch { /* defaults are safe enough */ }
  }

  function attach() {
    window.addEventListener('keydown', onSubmitCaptured, true);
    window.addEventListener('beforeinput', onSubmitCaptured, true);
    window.addEventListener('paste', onPaste, true);
    document.addEventListener('submit', onSubmitCaptured, true);

    // SPAs replace the composer node; re-anchor a few times then settle.
    let observer;
    try {
      observer = new MutationObserver(() => {
        clearTimeout(observer.__t);
        observer.__t = setTimeout(() => {
          if (!window.__safesurfComposer) window.__safesurfComposer = activeAdapter().find();
        }, 400);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* non-fatal */ }
  }

  // Dwell time feeds the threat score.
  setInterval(() => {
    if (!enabled) return;
    chrome.runtime.sendMessage({
      type: 'RECORD_DWELL', hostname: location.hostname, seconds: 10,
    }).catch(() => {});
  }, 10_000);

  attach();
  loadSettings();

  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['safesurf:settings']) return;
    const s = changes['safesurf:settings'].newValue ?? {};
    enabled = s.enabled ?? true;
    interception = s.interception ?? true;
  });
})();