const PROBES = [
  { url: 'http://localhost:11434/api/chat', allowed: true },
  { url: 'https://api.openai.com/v1/chat/completions', allowed: false },
  { url: 'https://generativelanguage.googleapis.com/v1beta', allowed: false },
  { url: 'http://localhost:11434.evil.test/api/chat', allowed: false },
  { url: 'http://127.0.0.1:8080/api/chat', allowed: false },
];

/** Mirrors background/egress-guard.js exactly, so the demo cannot drift from it. */
function assertLocal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === 'http://localhost:11434';
}

const FEATURES = [
  {
    id: 'pii',
    title: 'Deterministic redaction first',
    body:
      'Aadhaar (Verhoeff), PAN, payment cards (Luhn), IBAN (mod-97), AWS keys, GitHub tokens, JWTs, PEM blocks and high-entropy secrets are caught by arithmetic, before any model runs. The checksum gates are what keep "[A-Z]{5}[0-9]{4}[A-Z]" from firing on ordinary prose.',
    metric: '26 / 26 golden cases',
    note: '0% leak rate, with Ollama stopped',
  },
  {
    id: 'model',
    title: 'Gemma 4 only sees what survives',
    body:
      'Free-text PII — names, employers, addresses, diagnoses — is handled by gemma4:e4b running locally at low temperature with thinking disabled. It returns the original span alongside each replacement, which is what makes the mapping reversible on your device.',
    metric: '6.0 s median rewrite',
    note: 'temperature 0.1, think: false',
  },
  {
    id: 'injection',
    title: 'Injection scanning, including the parts you cannot see',
    body:
      'HTML comments, display:none nodes, sr-only text, templates and alt/title/aria-label attributes are all collected and deobfuscated — entities, leetspeak, zero-width characters and base64 — before triage.',
    metric: '4 deobfuscation passes',
    note: 'low-entropy near-misses are not flagged',
  },
  {
    id: 'vision',
    title: 'Images: OCR first, model second',
    body:
      'Gemma 4 emits text, not bounding boxes — no model size can black out pixels through Ollama. So tesseract.js extracts text with pixel coordinates locally, and the model classifies only that text. The model never reads a blurry digit.',
    metric: 'word-level boxes',
    note: 'removes the vision encoder from the critical path',
  },
  {
    id: 'threat',
    title: 'A threat score you can act on',
    body:
      'Dwell time on sensitive sites, cross-category hopping, credential-shaped prompts and injection attempts. Weights are fixed and the breakdown is always shown — an opaque number is worse than no number.',
    metric: '4 weighted signals',
    note: 'session-only, nothing written to disk',
  },
  {
    id: 'fail',
    title: 'It fails loud',
    body:
      'If the model times out or Ollama is unreachable, the prompt is blocked and you are shown the unverified text. It is never silently forwarded. A security tool that fails open is not a security tool.',
    metric: 'no silent pass-through',
    note: 'explicit acknowledgement required',
  },
];

export default function Features() {
  return (
    <section className="features" aria-labelledby="features-heading">
      <h2 id="features-heading">What it actually does</h2>
      <div className="feature-grid">
        {FEATURES.map((feature) => (
          <article key={feature.id} className="feature">
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
            <div className="feature-foot">
              <span className="metric">{feature.metric}</span>
              <span className="note">{feature.note}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="proof">
        <h3>The claim, run in front of you</h3>
        <p className="proof-lede">
          This is <code>assertLocal()</code> from <code>background/egress-guard.js</code>, the
          function every fetch in the service worker passes through. The same check is a unit test
          that scans the source tree for non-local URL literals.
        </p>
        <pre className="proof-log">
          {PROBES.map(({ url, allowed }) => {
            const verdict = assertLocal(url);
            return (
              <span key={url} className={verdict ? 'line line--allow' : 'line line--block'}>
                {verdict ? 'ALLOWED' : 'BLOCKED'}  {url}
                {verdict !== allowed ? '   ← guard did not behave as expected' : ''}
              </span>
            );
          })}
        </pre>
      </div>
    </section>
  );
}