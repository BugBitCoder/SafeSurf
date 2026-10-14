# tesseract assets (vendored)

This directory is **empty in git** and populated by:

```bash
npm run vendor:tesseract
```

## Why these files are vendored at all

MV3 forbids remotely hosted code. tesseract.js normally fetches its WASM core,
its worker script, and `eng.traineddata` from a CDN the first time you call
`recognize()`. An extension that does that:

1. violates the Chrome Web Store policy,
2. breaks entirely when offline, and
3. would be a visible outbound request in the network tab during a demo of a
   product whose entire pitch is that nothing leaves your machine.

So the assets ship inside the extension package and every path is local.

## What lands here

| File | Approx. size | Purpose |
|---|---|---|
| `tesseract.min.js` | 60 KB | main library |
| `worker.min.js` | 50 KB | OCR worker |
| `tesseract-core-simd.wasm.js` | 4 MB | SIMD WASM core |
| `tesseract-core.wasm.js` | 4 MB | fallback WASM core |
| `eng.traineddata.gz` | 4 MB | English language model |
| `entry.js` | generated | local-path wrapper the extension imports |

`entry.js` exists because `lib/vision-redact.js` cannot `import 'tesseract.js'`
by bare specifier in an unbundled MV3 extension.

## Phase 5 dependency

Phase 5 (vision redaction) degrades gracefully without these. `redactImage()`
catches the import failure and falls back to a coarse model-level vision check
that warns the user instead of redacting. **The rest of the product does not
depend on this directory at all.**

## Team sync

Because these are gitignored, every teammate must run `npm run vendor:tesseract`
once. Add it to your onboarding checklist, or drop the un-ignored copies into
git if bandwidth is not a concern.