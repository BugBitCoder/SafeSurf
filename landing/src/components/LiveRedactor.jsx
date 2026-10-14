import { useCallback, useMemo, useState } from 'react';
import { scanAndRedact } from '@safesurf/pii-deterministic.js';

const SAMPLE = `Hi, I'm Priya Sharma. My Aadhaar is 9999 9999 0019 and my PAN is ABCPE1234F.
I work at Northwind Logistics in Bengaluru. My phone is +91 98765 43210 and
you can reach me at priya.sharma@northwind.example.com.

Can you summarise the leave policy and tell me who I should talk to about my
pending reimbursement of ₹48,200 from last quarter?`;

const EMPTY = `Explain the difference between a mutex and a semaphore, and when
I would reach for each in a Go service. No code examples needed.`;

export default function LiveRedactor() {
  const [text, setText] = useState(SAMPLE);
  const [showOriginal, setShowOriginal] = useState(false);

  // The real pipeline, running in this tab. Nothing is transmitted — there is
  // no network call anywhere in this component.
  const { redacted, findings, byCategory } = useMemo(() => scanAndRedact(text), [text]);

  const onDrop = useCallback(() => {
    setText(EMPTY);
    setShowOriginal(true);
  }, []);

  const onReset = useCallback(() => {
    setText(SAMPLE);
    setShowOriginal(false);
  }, []);

  const sent = text.replace(redacted, '').length;

  return (
    <section className="redactor" aria-labelledby="redactor-heading">
      <div className="redactor-head">
        <div>
          <h3 id="redactor-heading">This is not a mockup</h3>
          <p>
            The panel below imports <code>extension/shared/pii-deterministic.js</code> — the
            identical module the extension loads. The same Verhoeff, Luhn and mod-97 checks
            run here in your browser. No network request is made.
          </p>
        </div>
        <div className="redactor-actions">
          <button type="button" onClick={onDrop}>Safe prompt</button>
          <button type="button" onClick={onReset}>Load PII sample</button>
        </div>
      </div>

      <label className="input-label" htmlFor="redactor-input">Your prompt</label>
      <textarea
        id="redactor-input"
        className="editor"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        rows={6}
      />

      <div className={`out ${findings.length ? 'out--blocked' : 'out--clean'}`}>
        <div className="out-head">
          <span className="out-dot" aria-hidden="true" />
          {findings.length
            ? `${findings.length} value${findings.length === 1 ? '' : 's'} removed on this device`
            : 'Nothing matched — this prompt would pass through untouched'}
        </div>

        <pre className="out-body">{showOriginal ? text : redacted}</pre>

        {showOriginal && (
          <button type="button" className="reveal" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? 'Show what the AI receives' : 'Show my original text'}
          </button>
        )}
      </div>

      {findings.length > 0 && (
        <ul className="chips" aria-label="Redaction categories">
          {Object.entries(byCategory).map(([category, count]) => (
            <li key={category} className={['aadhaar', 'pan', 'card', 'iban', 'secret'].includes(category) ? 'chip chip--high' : 'chip'}>
              {category.replace(/_/g, ' ')} <b>{count}</b>
            </li>
          ))}
        </ul>
      )}

      <p className="redactor-foot">
        {sent} characters stripped · {redacted.length} characters would leave your device
      </p>
    </section>
  );
}