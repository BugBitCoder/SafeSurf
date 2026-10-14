import Pipeline from './components/Pipeline.jsx';
import LiveRedactor from './components/LiveRedactor.jsx';
import InjectionDemo from './components/InjectionDemo.jsx';
import Features from './components/Features.jsx';

const STEPS = [
  { n: 1, title: 'Install Ollama', body: 'brew install ollama, then ollama pull gemma4:e4b' },
  { n: 2, title: 'Allow the extension origin', body: 'scripts/setup-env.sh sets OLLAMA_ORIGINS and restarts the app' },
  { n: 3, title: 'Load unpacked', body: 'chrome://extensions → Developer mode → Load unpacked → extension/' },
  { n: 4, title: 'Verify', body: 'node tests/golden/run.js — 26 cases, no model needed' },
];

/**
 * The brand mark, drawn from the same geometry as scripts/make-icons.js so the
 * nav, the tab and the toolbar icon are one mark rather than three guesses.
 */
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="safesurf-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a9cfb2" />
          <stop offset="1" stopColor="#3f6b50" />
        </linearGradient>
      </defs>
      <rect x="7.68" y="7.68" width="112.64" height="112.64" rx="30.72" fill="url(#safesurf-mark)" />
      <path d="M36.48 32H91.52Q91.52 66.56 64 101.12Q36.48 66.56 36.48 32Z" fill="#0a0b0d" />
      <path d="M56.064 56.32L64 79.36L71.936 56.32A7.936 7.936 0 0 0 56.064 56.32Z" fill="#c3ddc9" />
    </svg>
  );
}

export default function App() {
  return (
    <>
      <header className="hero">
        <nav className="nav">
          <span className="brand">
            <Logo />
            SafeSurf
          </span>
          <a className="nav-cta" href="#install">Install</a>
        </nav>

        <div className="hero-body">
          <h1>
            You get the AI&rsquo;s help.
            <br />
            <em>The AI never gets your secrets.</em>
          </h1>
          <p className="lede">
            A browser extension that rewrites your prompts before they reach ChatGPT, Gemini or
            Copilot. Gemma&nbsp;4 runs on your own machine through Ollama. There is no account, no
            server, and no request we could hand over if we wanted to.
          </p>
          <div className="hero-actions">
            <a className="btn btn--primary" href="#install">Get started</a>
            <a className="btn" href="#try">Try it below</a>
          </div>
          <ul className="hero-facts">
            <li><b>0%</b> PII leak rate across the golden set</li>
            <li><b>6.6&nbsp;GB</b> model, on disk, on your machine</li>
            <li><b>1</b> permitted network origin</li>
          </ul>
        </div>
      </header>

      <main>
        <Pipeline />

        <section className="try" id="try" aria-labelledby="try-heading">
          <h2 id="try-heading">Try the redaction</h2>
          <LiveRedactor />
        </section>

        <InjectionDemo />
        <Features />

        <section className="install" id="install" aria-labelledby="install-heading">
          <h2 id="install-heading">Four steps</h2>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.n}>
                <span className="step-n">{step.n}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p><code>{step.body}</code></p>
                </div>
              </li>
            ))}
          </ol>
          <p className="install-note">
            Chrome only, for now. Firefox MV3 does not support{' '}
            <code>background.service_worker</code> at all, so it needs a separate manifest and a
            different clipboard path.
          </p>
        </section>
      </main>

      <footer className="footer">
        <p>
          Built for Hack Day. Apache 2.0. Runs entirely offline — this page has no analytics,
          no CDN and no remote fonts.
        </p>
      </footer>
    </>
  );
}