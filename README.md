# SafeSurf

**You get the AI's help. The AI never gets your secrets.**

A Chrome extension that rewrites your prompts before they reach ChatGPT, Gemini or
Copilot. Gemma 4 runs on your own machine through Ollama. No account, no server, no
request we could hand over if we wanted to.

---

## The idea in one paragraph

When you paste a prompt into a third-party AI, you are sending your Aadhaar number,
your PAN, your employer's name and your medical history to someone else's data
centre — and their training pipeline. Existing "privacy" modes are a toggle in the
vendor's dashboard, which is a promise, not a mechanism. SafeSurf replaces the
promise with a mechanism: the identifier is replaced **on your machine, before the
request exists**, and the extension physically cannot talk to any server but
`localhost`.

## Three properties worth arguing about

**1. The safety does not depend on the model cooperating.**
Every checksum-validated identifier — Aadhaar (Verhoeff), payment cards (Luhn),
IBAN (mod-97), AWS keys, GitHub tokens, JWTs, PEM blocks — is replaced by
arithmetic, before any model runs. If `gemma4:e4b` decides to helpfully comply
instead of redacting, it never had the value to comply with. The model only sees
free-text PII (names, employers, diagnoses) that no regex can catch.

**2. The privacy claim is a test, not a slogan.**
`background/egress-guard.js` is the only network primitive in the service worker,
and it refuses any origin but `http://localhost:11434`.
`tests/unit/egress-guard.test.js` walks the source tree and fails on any
non-local `http(s)://` literal, any unpinned `gemma4` reference, and any
host permission outside loopback. If someone adds a remote fetch, the build breaks.

**3. It fails loud.**
If Ollama times out or is not running, the prompt is **blocked** and you are shown
the unverified text. It is never silently forwarded. A security tool that fails open
is not a security tool.

## Measured results

| Claim | Number | How to reproduce |
|---|---|---|
| Golden-set pass rate | **26 / 26** | `npm run test:golden` |
| PII leak rate after SafeSurf | **0 %** (from 100 % of `expect` cases) | `npm run test:golden` |
| Unit suite | **60 / 60** | `npm test` |
| Integration pipeline (real `gemma4:e4b`) | **33 / 33** | `npm run test:integration` |
| Deterministic coverage with Ollama stopped | **unchanged** | `npm run test:golden` |

The leak-rate framing is the point: the deterministic layer is the protection, and
it needs no model, no network, and no GPU. The model is an *enhancement*, never a
dependency.

Integration coverage, measured against the real model rather than asserted:

- a clean prompt produces **zero model calls** and passes through byte-identical
- Aadhaar / PAN / card / email never appear in the rewritten text
- the rewrite keeps the original intent (`"leave policy"` survives)
- the reversible map round-trips through `storage.session` back to plaintext
- an injection in an HTML comment is flagged **with the payload quoted back**
- the same payload base64-encoded is still caught
- benign prose about AI is not flagged

## Install

Requires **macOS or Linux**, **Ollama ≥ 0.35**, and **Chrome 116+**.

```bash
# 1. model
ollama pull gemma4:e4b

# 2. environment (launchd env vars + block cloud routing)
./scripts/setup-env.sh
#    …then QUIT and REOPEN the Ollama app — env vars only reach new processes

# 3. extension
#    chrome://extensions → Developer mode → Load unpacked → select  extension/

# 4. prove it works
npm run verify
```

Chrome only for now. Firefox MV3 does not support `background.service_worker` at
all — it is locked off by design — so it needs a separate manifest and a different
clipboard path. That is a deliberate deferral, not an oversight.

## Layout

```
extension/
  manifest.json            MV3, Chrome-only
  config.js                the ONLY place the model id appears
  background/
    service-worker.js      message router + prompt analysis pipeline
    ollama-client.js       streaming wrapper (see note below)
    egress-guard.js        refuses any origin but localhost:11434
  content/
    content.js             capture-phase interception, hidden-DOM collection
    overlay-ui.js          the review panel
    overlay.css
  shared/                  PURE ESM — zero deps, no platform APIs
    pii-checksums.js       Verhoeff / Luhn / mod-97 / Shannon entropy
    pii-deterministic.js   the detector layer
    redaction-map.js       reversible token ↔ plaintext mapping
    injection-text.js      deobfuscation + pattern triage
    threat-score.js        weighted scoring arithmetic
  lib/
    rephrase.js            structured-output model rephrasing
    injection-scan.js      model-assisted verdict on top of triage
    vision-redact.js       OCR-first image redaction
    clipboard-guard.js     pasted-secret warning
    threat-accumulator.js  session signal collection
  options/                 settings popup, live egress proof
  offscreen.{html,js}      the only way to reach the clipboard in MV3

landing/                   Vite + React showcase
tests/
  golden/                  26 cases, no model required
  unit/                    60 tests incl. egress invariants + a loadability sweep
  integration/             the real pipeline against a real gemma4:e4b
scripts/                   setup-env.sh, verify-env.js, vendor-tesseract.js
docs/                      ARCHITECTURE, BENCHMARKS, DEMO_SCRIPT
```

`extension/shared/` is imported by **both** the extension and the landing page, so
the interactive demo on the marketing site runs the real detection code rather than
a reimplementation. If the demo and the product ever disagreed, the demo would be
lying.

## Three things that are not obvious

**The Ollama client streams, and it has to.** Chrome kills an MV3 service worker
whose `fetch()` response takes more than 30 seconds to arrive. A `stream:false`
request for a 16K-context injection scan reliably exceeds that and kills the worker
mid-request. `stream:true` lands the response headers immediately, which resets the
timer. See `background/ollama-client.js`.

**The reversible map lives in `chrome.storage.session`, not memory.** The service
worker is terminated after ~30 s of inactivity and loses module scope.
`storage.session` survives that, is memory-resident so plaintext PII never touches
disk, and is cleared when the browser closes — which is exactly the lifetime we want
for a secret-recovery map.

**Vision redaction is OCR-first, and that is forced.** Gemma 4 emits text, not
bounding boxes; no model size can black out pixels through Ollama. So tesseract.js
extracts text with pixel coordinates locally and the model classifies *only the
extracted text*. It also means e4b's small vision encoder (150M vs 550M) is off the
critical path entirely.

## Commands

| Command | What it does |
|---|---|
| `npm test` | 60 unit tests, ~2 s, no model needed |
| `npm run test:golden` | 26 golden cases + leak rate |
| `npm run test:integration` | full pipeline against the real model (needs Ollama) |
| `npm run test:all` | all three |
| `npm run verify` | checks Ollama, model, `OLLAMA_ORIGINS`, GPU, and the suites |
| `npm run landing:dev` | showcase on :5173 |
| `npm run vendor:tesseract` | fetches OCR assets into the extension (~15 MB) |

## Status

Working end to end, verified against the real model: deterministic redaction,
model rephrasing, injection scanning (including base64 and hidden-DOM), threat
score, clipboard guard, and the overlay UI.

**Not yet verified: the extension loading in a real Chrome.** Chrome 156 removed
`--load-extension` and exposes `Extensions.loadUnpacked` only over the debug pipe,
so this could not be automated here. Load it by hand — `chrome://extensions` →
Developer mode → Load unpacked → `extension/` — and walk `docs/DEMO_SCRIPT.md`.
That is the one box left to tick.

Phase 5 (image redaction) needs `npm run vendor:tesseract` and is unverified
on-device; it degrades gracefully to a warning when OCR is absent.

See `docs/ARCHITECTURE.md` for the module contracts and `docs/DEMO_SCRIPT.md` for
the six-beat demo.

## License

Apache 2.0. Gemma 4 is Apache 2.0.