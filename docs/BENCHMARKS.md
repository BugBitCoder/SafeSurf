# Benchmarks

Fill these in from real runs. **Do not quote a number you have not measured** —
the whole writeup rests on these being real, and a single inflated figure
discredits the rest.

Record hardware in the header. Numbers from different Macs are not comparable.

---

## Machine

| | |
|---|---|
| **Date** | _fill in_ |
| **Machine** | _fill in_ |
| **Chip / RAM** | _fill in_ |
| **OS** | _fill in_ |
| **Ollama** | `0.35.1` _(0.40.4 recommended for MLX parity with teammates)_ |
| **Model** | `gemma4:e4b` — 7.5B, Q4_K_M, 131072 ctx |
| **Context** | `OLLAMA_CONTEXT_LENGTH=16384` |
| **Sampling** | `temperature 0.1`, `think: false`, `num_parallel 1` |

---

## 1. Deterministic layer

Reproduce: `npm run test:golden`

| Metric | Value |
|---|---|
| Golden cases | **26 / 26** |
| PII leak rate (before SafeSurf) | 100 % of `expect` cases |
| PII leak rate (after SafeSurf) | **0 %** |
| Runtime | _fill in (ms)_ |
| Requires a model? | **No** |
| Requires a network? | **No** |

Per-category:

| Category | Check | Positives | Near-miss negatives | Caught |
|---|---|---|---|---|
| Aadhaar | Verhoeff | _n_ | _n_ | _n/n_ |
| PAN | structural | _n_ | _n_ | _n/n_ |
| Card | Luhn | _n_ | _n_ | _n/n_ |
| IBAN | mod-97 + country length | _n_ | _n_ | _n/n_ |
| Email | regex | _n_ | _n_ | _n/n_ |
| Phone (IN) | regex | _n_ | _n_ | _n/n_ |
| AWS key | prefix | _n_ | _n_ | _n/n_ |
| GitHub token | prefix | _n_ | _n_ | _n/n_ |
| JWT | structure | _n_ | _n_ | _n/n_ |
| SSN | format | _n_ | _n_ | _n/n_ |
| High-entropy | Shannon > 4.0 | _n_ | _n_ | _n/n_ |

> **PAN is the honest weak spot.** It has no checksum, so `[A-Z]{5}[0-9]{4}[A-Z]`
> will match real PANs *and* any string shaped like one. Report its false-positive
> rate rather than hiding it.

---

## 2. Unit suite

Reproduce: `npm test`

| Metric | Value |
|---|---|
| Tests | **51 / 51** |
| Includes source-tree egress invariants | Yes |
| Runtime | ~_s_ |

---

## 3. Model latency

Reproduce: `npm run bench:model` (add once Phase 3 is stable), or time it manually.

| Operation | ctx | Median | p95 | Notes |
|---|---|---|---|---|
| Rephrase (short prompt) | 4096 | _ms_ | _ms_ | |
| Rephrase (long prompt) | 4096 | _ms_ | _ms_ | |
| Injection scan (typical page) | 16384 | _ms_ | _ms_ | |
| Injection scan (large page) | 16384 | _ms_ | _ms_ | |
| OCR fragment classification | 8192 | _ms_ | _ms_ | per word |

Reference point measured during development: a single structured-output rephrase
completed in **~6.0 s** at `num_ctx 2048` on an Apple Silicon Mac under Ollama
0.35.1 (19 tokens generated, 81 prompt tokens).

**The 30-second ceiling is real.** Chrome terminates a service worker whose
`fetch()` response takes more than 30 s. This is why the client streams — with
`stream:true` the headers arrive in milliseconds. If a page-level injection scan
genuinely needs more than 30 s of generation, that is a context-budget problem to
solve with `budgetText()`, not a reason to raise the timeout.

---

## 4. Model-free vs model-assisted

This is the argument that justifies the architecture. Measure both.

| Case | Deterministic only | Deterministic + e4b | Semantic residual |
|---|---|---|---|
| Formatted IDs (Aadhaar/PAN/card/IBAN) | caught | not sent to model | none |
| Credentials, keys, JWTs | caught | not sent to model | none |
| Names, employers, addresses | missed | caught | **the model's only job** |
| Diagnoses, medical terms | missed | caught | **the model's only job** |
| Prompt injection (pattern) | caught | confirmed + quoted | semantic variants |

> The honest claim: *the model is not protecting you from identifiers. Arithmetic
> is. The model handles what arithmetic cannot.*

---

## 5. Vision redaction

Requires `npm run vendor:tesseract`.

| Metric | Value |
|---|---|
| OCR (tesseract.js, 1 MP document) | _ms_ |
| Fragment classification | _ms per word_ |
| Total for a typical ID card | _s_ |
| Redaction precision / recall | _n_ / _n_ |

> Note the visual token budget is **not** settable through Ollama — `mlxrunner`
> auto-selects from 70/140/280/560/1120 by image dimensions, and unknown `options`
> keys are silently dropped. Since Gemma only receives extracted *text* in the OCR
> path, this does not affect the result. It matters only for the residual
> vision-only path.

---

## 6. Reproducing everything

```bash
npm run test:golden     # deterministic layer, no model needed
npm test                # unit suite, no model needed
npm run verify          # environment + both suites

# The strongest possible demo of the thesis:
ollama stop
npm run test:golden     # still 26/26, still 0% — the model was never needed
ollama serve
```

That last block is worth performing live. It is harder to argue with than any
screenshot.