/**
 * Offscreen document — clipboard access only.
 *
 * Answers a direct message from the service worker with the clipboard
 * contents. Never persists what it reads.
 */

const scratch = document.getElementById('scratch');

async function readClipboard() {
  scratch.focus();
  // The call must be synchronous within the gesture chain or Chrome refuses.
  const ok = document.execCommand('paste');
  const text = ok ? scratch.value : null;
  scratch.value = '';
  return text;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_READ_CLIPBOARD') return false;

  readClipboard()
    .then((text) => sendResponse({ ok: true, text }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});