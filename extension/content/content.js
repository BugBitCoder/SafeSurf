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
  // AI Domain Gating — SafeSurf only runs on AI model pages
  // -------------------------------------------------------------------------

  const AI_DOMAINS = [
    'chatgpt.com',
    'chat.openai.com',
    'gemini.google.com',
    'claude.ai',
    'copilot.microsoft.com',
    'perplexity.ai',
    'chat.deepseek.com',
    'deepseek.com',
    'chat.mistral.ai',
    'mistral.ai',
    'poe.com',
    'grok.com',
  ];

  function isSupportedAiPage() {
    if (typeof location === 'undefined') return true;
    const host = (location.hostname || '').toLowerCase();
    const href = (location.href || '').toLowerCase();
    const protocol = location.protocol || '';

    // Local development and test harness support
    if (!host || host === 'localhost' || host === '127.0.0.1' || protocol === 'file:') {
      return true;
    }

    if (AI_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) {
      return true;
    }

    if (host.endsWith('x.com') && href.includes('/i/grok')) {
      return true;
    }

    if (host.endsWith('huggingface.co') && href.includes('/chat')) {
      return true;
    }

    return false;
  }

  // Do not run on non-AI pages (Google search, Wikipedia, Reddit, etc.)
  if (!isSupportedAiPage()) return;

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
      match: () => typeof location !== 'undefined' && (location.hostname.endsWith('chatgpt.com') || location.hostname === 'chat.openai.com'),
      find: () => document.querySelector('div.ProseMirror[contenteditable="true"]')
        ?? document.querySelector('#prompt-textarea')
        ?? document.querySelector('textarea[data-testid="prompt-textarea"]')
        ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
    {
      id: 'claude',
      match: () => typeof location !== 'undefined' && location.hostname.endsWith('claude.ai'),
      find: () => document.querySelector('div[contenteditable="true"][role="textbox"]')
        ?? document.querySelector('div.ProseMirror[contenteditable="true"]')
        ?? document.querySelector('div[contenteditable="true"]')
        ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
    {
      id: 'gemini',
      match: () => typeof location !== 'undefined' && location.hostname.endsWith('gemini.google.com'),
      find: () => document.querySelector('rich-textarea div[contenteditable="true"]')
        ?? document.querySelector('div.ql-editor[contenteditable="true"]')
        ?? document.querySelector('div[contenteditable="true"]')
        ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
    {
      id: 'copilot',
      match: () => typeof location !== 'undefined' && location.hostname.endsWith('copilot.microsoft.com'),
      find: () => document.querySelector('textarea#searchbox') ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
    {
      id: 'perplexity',
      match: () => typeof location !== 'undefined' && location.hostname.endsWith('perplexity.ai'),
      find: () => document.querySelector('textarea[placeholder*="Ask"]') ?? document.querySelector('textarea'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
    {
      id: 'generic',
      match: () => true,
      find: () => document.querySelector('#prompt-textarea')
        ?? document.querySelector('textarea:not([type="hidden"]):not([disabled])')
        ?? document.querySelector('[contenteditable="true"][role="textbox"]')
        ?? document.querySelector('[contenteditable="true"]'),
      read: (el) => (el?.isContentEditable ? el.innerText : el?.value ?? ''),
      write: (el, text) => writeToElement(el, text),
    },
  ];

  function activeAdapter() {
    return ADAPTERS.find((a) => a.match()) ?? ADAPTERS[ADAPTERS.length - 1];
  }

  function writeToElement(el, text) {
    if (!el) return;
    try { el.focus(); } catch {}
    if (el.isContentEditable) {
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        if (document.execCommand('insertText', false, text)) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      } catch { /* fallback */ }
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      setReactValue(el, text);
    }
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

  /**
   * Does this event represent the user actually SUBMITTING, rather than just
   * typing?
   *
   * This is the single most important predicate in the content script. An
   * earlier version ran the whole analysis on every `keydown`, so after three
   * characters every keystroke hit preventDefault() and the user physically
   * could not finish typing their prompt.
   *
   * Rules:
   *  - `beforeinput` never means submit. It fires on every keystroke.
   *  - Only Enter submits, never Shift+Enter (that is a newline), and never
   *    while an IME composition is active.
   *  - Enter only means submit in something that looks like a chat composer.
   *    In a plain <textarea> on an ordinary page, Enter inserts a newline.
   */
  function isSubmitIntent(event) {
    if (event.type === 'submit' || event.type === 'click') return true;
    if (event.type !== 'keydown') return false;
    if (event.key !== 'Enter') return false;
    if (event.shiftKey || event.altKey) return false;
    // IME: Enter commits the candidate, it does not submit.
    if (event.isComposing || event.keyCode === 229) return false;
    return true;
  }

  const COMPOSER_HINT = /prompt|composer|message|chat|query|ask|input|askinput|userinput/i;

  /** Is this element a chat composer, where Enter should submit? */
  function isComposerElement(el) {
    if (!el) return false;

    // On supported AI pages, any element matched by an adapter or contenteditable/textarea is a composer
    if (isSupportedAiPage()) {
      if (el.isContentEditable || el.closest?.('[contenteditable="true"]') || el.closest?.('rich-textarea')) {
        return true;
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        return true;
      }
    }

    if (el.isContentEditable) {
      const role = el.getAttribute('role');
      if (role === 'textbox') return true;
    }

    const fingerprint = [el.id, el.name, el.className, el.getAttribute?.('data-testid')]
      .filter(Boolean).join(' ');
    if (COMPOSER_HINT.test(fingerprint)) return true;

    // A textarea inside a real form submits on Enter without needing to look
    // like a chat box.
    if (el.tagName === 'TEXTAREA' && el.closest?.('form')) return true;

    // A nearby send/submit button is a strong signal this is a composer.
    const form = el.closest?.('form');
    if (form?.querySelector('button[type="submit"], input[type="submit"]')) return true;

    return false;
  }

  // -------------------------------------------------------------------------
  // Live, passive analysis while the user types
  // -------------------------------------------------------------------------

  /**
   * The user's actual objection to the Enter-only design: by the time you
   * press Enter the prompt is already on the wire, so telling them afterwards
   * is worthless. So we analyse on every typing PAUSE and show a live pill.
   *
   * The passive scan runs the deterministic layers only — no model call — so
   * it costs single-digit milliseconds and is invisible.
   */
  const TYPING_PAUSE_MS = 900;
  let pauseTimer = null;
  let lastScan = { text: null, at: 0, result: null };
  let scanSeq = 0;
  let lastDismissedText = null;

  function schedulePassiveScan() {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(runPassiveScan, TYPING_PAUSE_MS);
  }

  function openPromptReview(result, adapter, el, text, isTypingPause = false) {
    const clean = result.redacted ?? text;
    const rewritten = result.rewritten ?? clean;

    OVERLAY().showPromptReview(
      {
        original: text,
        rewritten,
        byCategory: result.byCategory ?? {},
        findings: result.findings ?? [],
        injection: result.injection ?? null,
        degraded: result.degraded ?? false,
        degradedReason: result.degradedReason,
        blocked: result.blocked ?? true,
        upgrading: Boolean(result.upgrading),
        isTypingPause,
      },
      {
        onApply: (safeText) => {
          lastDismissedText = safeText;
          adapter.write(el, safeText);
          lastScan = { text: safeText, at: Date.now(), result: null };
          OVERLAY().hideStatus();
          OVERLAY().showToast('Redacted text applied to editor. Safe to send!', 'ok', 3500);
        },
        onSend: () => resubmit(adapter, el, rewritten),
        onSendOriginal: () => resubmit(adapter, el, text),
        onCancel: () => {
          lastDismissedText = text;
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Context health & safe messaging
  // -------------------------------------------------------------------------

  /**
   * Has the extension context been torn down under us?
   *
   * Happens on every extension reload or update: the old context is destroyed,
   * but content scripts already injected into open tabs keep running against it
   * and every chrome.* call throws. It is recoverable by refreshing the page,
   * and completely unhelpful if reported as a raw platform exception.
   */
  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidated(err) {
    if (!isContextValid()) return true;
    const msg = String(err?.message ?? '');
    return /Extension context invalidated|Receiving end does not exist|message port closed/i.test(msg);
  }

  async function safeSendMessage(payload) {
    if (!isContextValid()) return null;
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      if (isContextInvalidated(err)) return null;
      throw err;
    }
  }

  async function runPassiveScan() {
    if (!enabled || !interception || !isContextValid()) {
      if (!isContextValid()) OVERLAY().hideStatus();
      return;
    }

    const adapter = activeAdapter();
    const el = adapter.find();
    if (!el) return;

    const text = adapter.read(el).trim();
    if (!text || text.length < 3) { OVERLAY().hideStatus(); return; }

    // If text changed from what was dismissed, clear the dismissed record
    if (lastDismissedText && text !== lastDismissedText) {
      lastDismissedText = null;
    }

    // Already have a result for this exact text.
    if (lastScan.text === text && Date.now() - lastScan.at < 60_000) {
      const res = lastScan.result;
      const hasSens = Object.keys(res?.byCategory ?? {}).length > 0 || res?.injection?.is_injection;
      renderStatus(res, el, hasSens ? () => openPromptReview(res, adapter, el, text) : null);
      return;
    }

    const seq = ++scanSeq;
    renderStatus({ pending: true }, el);

    try {
      const res = await safeSendMessage({
        type: 'ANALYSE_PROMPT',
        text,
        pageChunks: collectPageChunks(),
        passive: true,
      });

      // A newer keystroke superseded this scan, or context was invalidated.
      if (seq !== scanSeq) return;
      if (!res?.ok) { OVERLAY().hideStatus(); return; }

      lastScan = { text, at: Date.now(), result: res };
      const hasSensitive = Object.keys(res.byCategory ?? {}).length > 0 || res.injection?.is_injection;

      renderStatus(res, el, hasSensitive ? () => openPromptReview(res, adapter, el, text) : null);

      // Proactively show the review modal when sensitive info is detected and typing has stopped!
      if (hasSensitive && !OVERLAY().isOpen() && lastDismissedText !== text) {
        openPromptReview(res, adapter, el, text, true);
      }
    } catch (err) {
      if (seq !== scanSeq) return;
      OVERLAY().hideStatus();
      if (isContextInvalidated(err)) {
        OVERLAY().showToast('SafeSurf was reloaded. Refresh this page (⌘⇧R) to re-arm it.', 'warn', 7000);
      }
    }
  }

  /**
   * Turn a passive scan into live status-pill copy.
   *
   * Pure and self-contained — the content script cannot `import` (MV3 content
   * scripts are classic scripts, which is exactly why this file has no
   * imports at all). tests/unit/status.test.js extracts and exercises it
   * directly rather than leaving it untested inside the IIFE.
   */
  function describeScanStatus(scan = {}) {
    // `?? {}` rather than a destructuring default: a default only fires for
    // `undefined`, so an explicit `null` from the service worker would reach
    // Object.keys() and throw inside the render path.
    const byCategory = scan?.byCategory ?? {};
    const injection = scan?.injection ?? null;
    const personal = scan?.personal ?? false;
    const pending = scan?.pending ?? false;

    if (pending) return { text: 'SafeSurf · scanning…', tone: 'busy' };

    if (injection?.is_injection) {
      return { text: 'SafeSurf · prompt injection on this page', tone: 'danger' };
    }

    const categories = Object.keys(byCategory);
    if (categories.length) {
      const shown = categories.slice(0, 3).map((c) => c.toUpperCase().replace(/_/g, ' '));
      const more = categories.length > 3 ? ` +${categories.length - 3}` : '';
      return {
        text: `SafeSurf · ${categories.length} value${categories.length === 1 ? '' : 's'} will be redacted — ${shown.join(', ')}${more}`,
        tone: 'warn',
      };
    }

    // Clean. Say so explicitly: silence is indistinguishable from a dead
    // extension, which is the most confusing failure mode a user can hit.
    return {
      text: personal
        ? 'SafeSurf · armed, nothing structured detected'
        : 'SafeSurf · armed, nothing to redact',
      tone: 'ok',
    };
  }

  /**
   * Identity + position of the composer the pill is currently anchored to.
   *
   * The pill lives under <html>, which is the same subtree the SPA watcher
   * observes. So the watcher must only re-render when the composer genuinely
   * moved or was replaced — see the observer in attach().
   */
  let anchoredTo = null;
  let lastStatus = null;

  function anchorSignature(el) {
    const r = el?.getBoundingClientRect?.();
    if (!el || !r) return 'none';
    // Whole pixels: sub-pixel jitter from layout must not count as a move, or
    // we are back to re-rendering on every mutation the pill itself causes.
    return `${el.tagName}#${el.id || ''}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
  }

  /** Turn a passive result into a pill. */
  function renderStatus(res, el, onClick = null) {
    anchoredTo = anchorSignature(el);

    if (!res) { lastStatus = null; OVERLAY().hideStatus(); return; }

    const desc = describeScanStatus({
      byCategory: res.byCategory,
      injection: res.injection,
      personal: res.personal,
      pending: res.pending,
    });
    if (!desc) { lastStatus = null; OVERLAY().hideStatus(); return; }

    // Remembered so a later re-anchor can repaint the identical pill, still
    // clickable — dropping onClick here silently loses "Review & Redact".
    lastStatus = { res, onClick };
    OVERLAY().showStatus(desc, el?.getBoundingClientRect?.(), onClick);
  }

  /** Never call preventDefault here. Observation only. */
  function onInputObserved() {
    if (!enabled || !interception) return;
    // Text changed, so any cached scan is stale for the submit.
    lastScan = { text: null, at: 0, result: null };
    schedulePassiveScan();
  }

  function clearPassive() {
    clearTimeout(pauseTimer);
    lastScan = { text: null, at: 0, result: null };
    OVERLAY().hideStatus();
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  async function onSubmitCaptured(event) {
    if (!interception || busy) return;
    if (event.isTrusted === false) return;
    if (!isSubmitIntent(event)) return;

    const adapter = activeAdapter();
    const el = adapter.find();
    if (!el) return;

    // Enter in a plain textarea on an ordinary page is a newline, not a
    // submit. Do not eat it.
    if (event.type === 'keydown' && !isComposerElement(el)) return;

    const text = adapter.read(el).trim();
    if (!text || text.length < 3) return;

    if (!isContextValid()) {
      OVERLAY().showToast(
        'SafeSurf was reloaded or updated. Refresh this page (⌘⇧R) to re-arm it, then send again. Prompt not sent.',
        'warn', 9000,
      );
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      return;
    }

    busy = true;
    const submitEvent = event;

    // Capture the live scan BEFORE clearing it. It is deterministic-only, so
    // it is enough to show the panel immediately; the model-assisted rewrite
    // arrives afterwards and upgrades it in place.
    const cached = lastScan.result && lastScan.text === text ? lastScan.result : null;
    clearPassive();

    try {
      // Stop the page from sending while we decide.
      submitEvent.preventDefault?.();
      submitEvent.stopImmediatePropagation?.();

      const paint = (result) => OVERLAY().showPromptReview(
        {
          original: text,
          rewritten: result.rewritten ?? text,
          byCategory: result.byCategory ?? {},
          findings: result.findings ?? [],
          injection: result.injection ?? null,
          degraded: result.degraded ?? false,
          degradedReason: result.degradedReason,
          blocked: result.blocked ?? true,
          upgrading: Boolean(result.upgrading),
          isTypingPause: false,
        },
        {
          onApply: (safeText) => {
            lastDismissedText = safeText;
            adapter.write(el, safeText);
            OVERLAY().hideStatus();
            OVERLAY().showToast('Redacted text applied to editor. Safe to send!', 'ok', 3500);
          },
          onSend: () => resubmit(adapter, el, result.rewritten ?? text),
          onSendOriginal: () => resubmit(adapter, el, text),
          onCancel: () => {
            lastDismissedText = text;
          },
        },
      );

      // Show what we already know, immediately. No spinner, no 6s wait.
      if (cached && (Object.keys(cached.byCategory ?? {}).length || cached.injection?.is_injection)) {
        paint({ ...cached, upgrading: true });
      } else {
        OVERLAY().showToast('SafeSurf is analysing this prompt locally…', 'warn', 8000);
      }

      const full = await safeSendMessage({
        type: 'ANALYSE_PROMPT',
        text,
        pageChunks: collectPageChunks(),
      });

      if (!full?.ok) {
        if (!isContextValid()) {
          OVERLAY().showToast(
            'SafeSurf was reloaded or updated. Refresh this page (⌘⇧R) to re-arm it, then send again. Prompt not sent.',
            'warn', 9000,
          );
          return;
        }
        // FAIL LOUD. Never silently forward a prompt we could not inspect.
        paint({
          rewritten: text, byCategory: {}, findings: [],
          degraded: true, degradedReason: full?.error, blocked: true,
        });
        return;
      }

      const clean = full.redacted ?? text;
      const rewritten = full.rewritten ?? clean;
      const needsReview = full.blocked || full.degraded || full.injection?.is_injection
        || Object.keys(full.byCategory ?? {}).length > 0;

      if (!needsReview) {
        OVERLAY().hideStatus();
        resubmit(adapter, el, text); // untouched pass-through
        return;
      }

      paint(full);
    } catch (err) {
      // The most common error by far during development: the extension was
      // reloaded, which kills the context this content script is bound to.
      // The tab must be refreshed to re-arm. Say so, instead of surfacing a
      // raw platform exception the user cannot act on.
      if (isContextInvalidated(err)) {
        OVERLAY().showToast(
          'SafeSurf was reloaded or updated. Refresh this page (⌘⇧R) to re-arm it, then send again. Prompt not sent.',
          'warn', 9000,
        );
      } else {
        OVERLAY().showToast(`SafeSurf error: ${err.message}. Prompt not sent.`, 'danger');
      }
    } finally {
      busy = false;
    }
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button.send-button',
      'rich-textarea + * button',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  /** Write the final text and dispatch a fresh, trusted-looking Enter. */
  function resubmit(adapter, el, text) {
    adapter.write(el, text);
    setTimeout(() => {
      el.focus?.();
      const sendBtn = findSendButton();
      if (sendBtn && typeof sendBtn.click === 'function') {
        sendBtn.click();
        return;
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.click?.();
    }, 60);
  }

  function onClickCaptured(event) {
    if (!interception || busy) return;
    if (event.isTrusted === false) return;
    const btn = event.target?.closest?.('button, [role="button"]');
    if (!btn) return;

    // Do not intercept SafeSurf UI buttons
    if (btn.closest('#safesurf-overlay-root') || btn.classList.contains('ss-btn')) return;

    const isSendBtn = btn.type === 'submit'
      || btn.getAttribute('data-testid') === 'send-button'
      || /send|submit/i.test(btn.getAttribute('aria-label') || '')
      || /send-button/i.test(btn.className || '')
      || btn.id === 'send-button';

    if (!isSendBtn) return;

    onSubmitCaptured(event);
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
      const res = await safeSendMessage({ type: 'INSPECT_CLIPBOARD', text });
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
    if (!isContextValid()) return;
    try {
      const s = await safeSendMessage({ type: 'SETTINGS_GET' });
      enabled = s?.enabled ?? true;
      interception = s?.interception ?? true;
    } catch (err) {
      // Defaults are safe enough, but if the context is dead the user needs to
      // know now rather than on their first submit.
      if (isContextInvalidated(err)) {
        OVERLAY().showToast(
          'SafeSurf is not connected to this page. Refresh (⌘⇧R) to arm it.',
          'warn', 7000,
        );
      }
    }
  }

  function attach() {
    // Deliberately NO `beforeinput` listener. It fires on every single
    // keystroke, and intercepting it made the page untypable.
    window.addEventListener('keydown', onSubmitCaptured, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('click', onClickCaptured, true);
    document.addEventListener('submit', onSubmitCaptured, true);

    // Passive observation. No preventDefault, ever — this is what drives the
    // live pill while the user is still typing.
    document.addEventListener('input', onInputObserved, true);

    // SPAs replace the composer node; re-anchor when it genuinely moves.
    let observer;
    try {
      observer = new MutationObserver(() => {
        const el = activeAdapter().find();
        if (!el) { clearPassive(); return; }
        window.__safesurfComposer = el;

        // Re-anchor ONLY on a real move. This observer watches documentElement
        // with subtree:true, and the status pill is appended to documentElement
        // — so repainting unconditionally writes to the subtree being observed,
        // the observer fires again, and the main thread spins at 100% forever.
        // That is what made the pill never appear: the tab froze on the first
        // paint. anchorSignature() is updated by renderStatus(), which makes
        // the second pass a no-op.
        if (!lastStatus) return;
        if (anchorSignature(el) === anchoredTo) return;
        renderStatus(lastStatus.res, el, lastStatus.onClick);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* non-fatal */ }
  }

  // Dwell time feeds the threat score.
  let dwellTimer = setInterval(() => {
    if (!enabled || !isContextValid()) {
      if (!isContextValid()) clearInterval(dwellTimer);
      return;
    }
    safeSendMessage({
      type: 'RECORD_DWELL', hostname: location.hostname, seconds: 10,
    }).catch(() => {});
  }, 10_000);

  attach();
  loadSettings();

  // Expose the two gating predicates. These decide whether a keystroke is
  // swallowed, so they are the highest-value thing to assert against — and
  // they are not reachable from a page's main world, only from devtools.
  window.SafeSurfContent = {
    isSubmitIntent,
    isComposerElement,
    activeAdapter,
    version: '0.1.0',
  };

  // Guarded: touching chrome.* after the extension has been reloaded throws,
// and an uncaught throw here would abort the rest of the boot sequence.
try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['safesurf:settings']) return;
      const s = changes['safesurf:settings'].newValue ?? {};
      enabled = s.enabled ?? true;
      interception = s.interception ?? true;
    });
  } catch { /* context invalidated; the submit-time message covers it */ }
})();