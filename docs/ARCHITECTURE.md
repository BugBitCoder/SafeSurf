# SafeSurf — Architecture

## The invariant

**All model calls originate in the service worker. Content scripts never call
Ollama directly.**

This is not a style preference. A content script's `fetch()` runs on behalf of the
*page* origin, so Chrome sends `Origin: https://chatgpt.com` and Ollama rejects it.
Only an extension context can produce `Origin: chrome-extension://<id>`, which is
the origin we allow-list via `OLLAMA_ORIGINS`. Routing everything through the
service worker also means there is exactly one place where "no network egress" is
enforced as code.

```
page (isolated world)
  │  chrome.runtime.sendMessage
  ▼
service worker ──► egress-guard ──► ollama-client ──► localhost:11434
  │                    (refuses             (streams, to
  │                     anything             survive the 30 s
  │                     else)               worker-kill rule)
  │
  ├─► shared/pii-deterministic      model-free, always runs first
  ├─► lib/rephrase                  model, sees only what survived
  ├─► lib/injection-scan            triage, then model confirmation
  ├─► lib/threat-accumulator        arithmetic, session state
  └─► lib/vision-redact             OCR first, model classifies text
```

## Module contracts

| Module | Model? | Network? | Notes |
|---|---|---|---|
| `shared/pii-checksums` | no | no | Verhoeff `p[i % 8]`, not `(i+1)%8` |
| `shared/pii-deterministic` | no | no | must stay platform-free; unit-tested for it |
| `shared/redaction-map` | no | no | caller owns persistence |
| `shared/injection-text` | no | no | 4 deobfuscation passes |
| `shared/threat-score` | no | no | pure arithmetic |
| `background/egress-guard` | no | **yes** | the only `fetch` wrapper |
| `background/ollama-client` | yes | yes | streaming is mandatory |
| `background/service-worker` | – | – | no top-level `await` before listeners |
| `lib/rephrase` | yes | – | falls back to template on lost intent |
| `lib/injection-scan` | yes | – | degrades to triage when model is down |
| `lib/vision-redact` | yes | – | OCR-first; warns if OCR missing |
| `lib/clipboard-guard` | no | – | needs offscreen document for read |

## Prompt analysis order

The order **is** the security property:

1. **Deterministic PII** (`scanAndRedact`) — model-free, checksum-gated.
2. **Deterministic injection triage** — model-free, deobfuscated.
3. **Model rephrase** — sees only what survived step 1.

If the model complies instead of redacting, the identifier never reached it. If the
model is down, steps 1 and 2 still ran and the prompt is blocked rather than
forwarded.

## Failure behaviour

| Failure | Behaviour | Rationale |
|---|---|---|
| Ollama unreachable | Block, show unverified text | fail loud, never open |
| Model timeout (30 s) | Block, explicit acknowledgement required | a degraded rewrite is a leak the user did not choose |
| `intent_preserved: false` | Template fallback, `degraded: true` | a lost intent is worse than a leak the user chose |
| Injection scan fails | Report the deterministic verdict | never downgrade to "safe" |
| OCR unavailable | Vision warning, no blackout | degrade visibly, not silently |

## Browser constraints that shaped the code

| Constraint | Consequence |
|---|---|
| Worker killed if a `fetch` response takes >30 s | `stream: true` everywhere |
| Worker terminated after ~30 s idle | state in `chrome.storage.session`, not module scope |
| `navigator.clipboard` absent in service workers | `chrome.offscreen` + `execCommand('paste')` |
| Content scripts are not ES modules | `content.js` is import-free; no web-accessible surface |
| React 18+ ignores direct `.value` writes | native prototype setter + synthetic `input` event |
| `host_permissions` do not bypass server CORS | `OLLAMA_ORIGINS` is mandatory |
| MV3 forbids remotely hosted code | tesseract assets are vendored |
| Firefox has no `background.service_worker` | Chrome-only build |

## Vision redaction

```
image ──► tesseract.js ──► text + word-level pixel boxes
                            │
                            ├─ deterministic: any checksum-valid ID is redacted
                            │                  with no model call at all
                            ▼
                       gemma4:e4b  (TEXT input only)
                            │
                            ▼
                    labels + coordinates ──► canvas blackout
```

**On the visual token budget:** Ollama exposes no parameter for it. `mlxrunner`
auto-selects from 70/140/280/560/1120 based on image dimensions, and unknown keys
inside `options` are *silently dropped* — so an invented parameter name would fail
without an error. We do not attempt to set it. It only affects the residual
vision-only path (faces, signatures, QR codes), which asks a coarse question that
degrades gracefully at any budget.

## Testing strategy

- **Golden set** (`tests/golden/`) — 26 cases, no model, no network. Every detector
  has ≥1 positive and ≥1 near-miss negative, because checksum gates are exactly
  where false positives hide.
- **Unit suite** (`tests/unit/`) — 51 tests including source-tree invariants that
  make the privacy claim enforceable.
- **Manual** — the six-beat script in `docs/DEMO_SCRIPT.md`.

Regression discipline: if you change a detector, `npm run test:golden` must still
report 26/26 and 0 % leak rate. That number goes in the writeup; do not let it drift.