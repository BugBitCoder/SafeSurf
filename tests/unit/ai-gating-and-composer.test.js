import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = readFileSync(join(REPO, 'extension/content/content.js'), 'utf8');

/** Helper to extract a function from content.js and evaluate it with a custom environment */
function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`${name} not found in content.js`);

  const parenOpen = SOURCE.indexOf('(', start);
  let depth = 0;
  let i = parenOpen;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '(') depth++;
    else if (SOURCE[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }

  const bodyStart = SOURCE.indexOf('{', i);
  depth = 0;
  for (i = bodyStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }

  return SOURCE.slice(start, i);
}

// Extract AI_DOMAINS and functions
const aiDomainsMatch = SOURCE.match(/const AI_DOMAINS = \[[^\]]*\];/);
if (!aiDomainsMatch) throw new Error('AI_DOMAINS not found in content.js');

const fnSource = `
  ${aiDomainsMatch[0]}
  ${extractFunction('isSupportedAiPage')}
  ${extractFunction('isComposerElement')}
  ${extractFunction('isSubmitIntent')}
  return { isSupportedAiPage, isComposerElement, isSubmitIntent };
`;

test('isSupportedAiPage allows AI model pages', () => {
  const createEnv = (hostname, href = `https://${hostname}/`, protocol = 'https:') => {
    return new Function('location', `
      ${fnSource}
    `)({ hostname, href, protocol });
  };

  const aiHosts = [
    'chatgpt.com',
    'www.chatgpt.com',
    'chat.openai.com',
    'gemini.google.com',
    'claude.ai',
    'copilot.microsoft.com',
    'perplexity.ai',
    'www.perplexity.ai',
    'chat.deepseek.com',
    'chat.mistral.ai',
    'poe.com',
    'grok.com',
  ];

  for (const host of aiHosts) {
    const { isSupportedAiPage } = createEnv(host);
    assert.equal(isSupportedAiPage(), true, `Expected ${host} to be allowed as an AI page`);
  }

  // x.com/i/grok and huggingface.co/chat
  const grokEnv = createEnv('x.com', 'https://x.com/i/grok');
  assert.equal(grokEnv.isSupportedAiPage(), true, 'Expected x.com/i/grok to be allowed');

  const hfEnv = createEnv('huggingface.co', 'https://huggingface.co/chat');
  assert.equal(hfEnv.isSupportedAiPage(), true, 'Expected huggingface.co/chat to be allowed');

  // Local testing / test harness
  const localhostEnv = createEnv('localhost', 'http://localhost:3000/');
  assert.equal(localhostEnv.isSupportedAiPage(), true, 'Expected localhost to be allowed');

  const ipEnv = createEnv('127.0.0.1', 'http://127.0.0.1:8080/');
  assert.equal(ipEnv.isSupportedAiPage(), true, 'Expected 127.0.0.1 to be allowed');

  const fileEnv = createEnv('', 'file:///path/to/harness.html', 'file:');
  assert.equal(fileEnv.isSupportedAiPage(), true, 'Expected file:// harness to be allowed');
});

test('isSupportedAiPage rejects regular browsing websites', () => {
  const createEnv = (hostname) => {
    return new Function('location', `
      ${fnSource}
    `)({ hostname, href: `https://${hostname}/`, protocol: 'https:' });
  };

  const nonAiHosts = [
    'google.com',
    'www.google.com',
    'youtube.com',
    'github.com',
    'amazon.com',
    'reddit.com',
    'wikipedia.org',
    'news.ycombinator.com',
    'twitter.com',
    'linkedin.com',
  ];

  for (const host of nonAiHosts) {
    const { isSupportedAiPage } = createEnv(host);
    assert.equal(isSupportedAiPage(), false, `Expected ${host} to be blocked from running SafeSurf`);
  }
});

test('isComposerElement recognises AI composers including Gemini and ChatGPT', () => {
  const { isComposerElement } = new Function('location', `
    ${fnSource}
  `)({ hostname: 'gemini.google.com', href: 'https://gemini.google.com/', protocol: 'https:' });

  // Gemini Quill editor (contenteditable div inside rich-textarea without role="textbox")
  const geminiEl = {
    isContentEditable: true,
    tagName: 'DIV',
    id: '',
    name: '',
    className: 'ql-editor ql-blank',
    getAttribute: () => null,
    closest: (sel) => (sel === 'rich-textarea' ? {} : null),
  };
  assert.equal(isComposerElement(geminiEl), true, 'Gemini rich-textarea editor must be recognised as composer');

  // ChatGPT ProseMirror
  const chatGptEl = {
    isContentEditable: true,
    tagName: 'DIV',
    id: 'prompt-textarea',
    name: '',
    className: 'ProseMirror',
    getAttribute: (attr) => (attr === 'role' ? 'textbox' : null),
    closest: (sel) => (sel === '.ProseMirror' ? {} : null),
  };
  assert.equal(isComposerElement(chatGptEl), true, 'ChatGPT ProseMirror must be recognised as composer');

  // Plain textarea on AI page
  const textareaEl = {
    isContentEditable: false,
    tagName: 'TEXTAREA',
    id: 'prompt',
    name: 'prompt',
    className: '',
    getAttribute: () => null,
    closest: () => null,
  };
  assert.equal(isComposerElement(textareaEl), true, 'Textarea on AI page must be recognised as composer');
});

test('isSubmitIntent correctly differentiates Enter vs typing', () => {
  const { isSubmitIntent } = new Function('location', `
    ${fnSource}
  `)({ hostname: 'chatgpt.com', href: 'https://chatgpt.com/', protocol: 'https:' });

  assert.equal(isSubmitIntent({ type: 'keydown', key: 'Enter', shiftKey: false, altKey: false }), true);
  assert.equal(isSubmitIntent({ type: 'keydown', key: 'Enter', shiftKey: true }), false, 'Shift+Enter is newline');
  assert.equal(isSubmitIntent({ type: 'keydown', key: 'a' }), false, 'Regular keystroke is not submit');
  assert.equal(isSubmitIntent({ type: 'keydown', key: 'Enter', isComposing: true }), false, 'IME composing is not submit');
  assert.equal(isSubmitIntent({ type: 'submit' }), true, 'Form submit is submit');
  assert.equal(isSubmitIntent({ type: 'click' }), true, 'Send button click is submit');
});
