/**
 * Vision redaction — OCR first, model second.
 *
 * THE CENTRAL CONSTRAINT: Gemma 4 emits text, not bounding boxes. No model
 * size (e4b, 26B, 31B) can black out pixels through Ollama. This is an
 * interface limit, not a model-size limit — which is exactly why the plan
 * routes through OCR:
 *
 *     image ──► OCR (deterministic, gives text + pixel boxes)
 *            ──► Gemma classifies the TEXT ONLY (text input, no vision)
 *            ──► canvas blackout over the boxes
 *
 * The model never reads a blurry digit. OCR extracts it; Gemma classifies
 * it. This also removes e4b's small vision encoder (150M vs 550M) from the
 * critical path entirely.
 *
 * RESEARCH NOTE — visual token budget: Ollama exposes NO parameter for
 * Gemma 4's image token budget (70/140/280/560/1120). `mlxrunner` auto-selects
 * the smallest grid that still covers the source image. Unknown keys inside
 * `options` are silently dropped, so an invented parameter name would fail
 * invisibly. We therefore do not attempt to set it. It only affects the
 * residual vision-only path below, where the model is asked a coarse
 * question ("does this contain a face or signature?") that degrades
 * gracefully at any budget.
 */

import { CTX } from '../config.js';
import { chatJSON } from '../background/ollama-client.js';
import { scanDeterministic } from '../shared/pii-deterministic.js';

/**
 * tesseract.js cannot be imported as a bare specifier in an unbundled MV3
 * extension, and MV3 forbids remotely hosted code — the WASM core, worker,
 * and `eng.traineddata` must all be vendored under extension/assets/.
 * `npm run vendor:tesseract` populates that directory; see the README there.
 */
let tesseractPromise = null;

async function getTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import('../assets/tesseract/entry.js');
  }
  return tesseractPromise;
}

/** Classify an OCR'd fragment. Text in, label out. Never receives pixels. */
const FRAGMENT_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      enum: ['none', 'person_name', 'address', 'identifier', 'financial', 'contact', 'health', 'date_of_birth', 'signature', 'photo', 'qr_code'],
    },
    confidence: { type: 'number' },
  },
  required: ['label', 'confidence'],
};

async function classifyFragment(text, context) {
  if (!text?.trim()) return { label: 'none', confidence: 0 };

  try {
    const { data } = await chatJSON({
      system: `You label individual pieces of OCR text from identity documents for a redaction tool.

Return the single most specific label that applies. Use \`none\` for ordinary words, headings, and boilerplate that would be safe to leave visible. Confidence is 0-1.

Document context: ${context || 'unknown'}`,
      user: text.slice(0, 300),
      schema: FRAGMENT_SCHEMA,
      ctx: CTX.ocrClassify,
    });
    return { label: data.label ?? 'none', confidence: Number(data.confidence) || 0 };
  } catch {
    return { label: 'none', confidence: 0 };
  }
}

/** Labels that must be blacked out. Everything else stays legible. */
const REDACT_LABELS = new Set([
  'person_name', 'address', 'identifier', 'financial', 'contact', 'health', 'date_of_birth',
]);

/**
 * Full pipeline for one image.
 *
 * @param {string} imageDataUrl
 * @param {{ documentType?: string, onProgress?: (stage:string, pct:number) => void }} opts
 * @returns {Promise<{
 *   ok: boolean, ocrRan: boolean,
 *   boxes: Array<{x:number,y:number,w:number,h:number,text:string,label:string,source:string}>,
 *   redactedDataUrl: string|null,
 *   warnings: string[],
 * }>}
 */
export async function redactImage(imageDataUrl, opts = {}) {
  const { documentType = 'unknown document', onProgress } = opts;
  const warnings = [];

  if (!imageDataUrl) return { ok: false, ocrRan: false, boxes: [], redactedDataUrl: null, warnings: ['No image supplied'] };

  onProgress?.('ocr', 0);

  let words = [];
  try {
    const { default: Tesseract } = await getTesseract();
    const result = await Tesseract.recognize(imageDataUrl, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.('ocr', Math.round(m.progress * 100));
      },
    });
    // tesseract.js v6 word-level bboxes are the whole point — we need pixels.
    words = result?.data?.words ?? [];
  } catch (err) {
    warnings.push(`OCR unavailable (${err.message}). Falling back to a model-level warning only.`);
    return fallbackVisionCheck(imageDataUrl, warnings, onProgress);
  }

  if (!words.length) {
    return { ok: true, ocrRan: true, boxes: [], redactedDataUrl: imageDataUrl, warnings: ['No text found in image'] };
  }

  // Deterministic first: any OCR'd fragment that is itself a checksum-valid
  // identifier is already a high-confidence redaction with no model call.
  const text = words.map((w) => w.text).join(' ');
  const deterministic = scanDeterministic(text);
  const deterministicValues = new Set(deterministic.map((f) => f.original.replace(/\D/g, '')));

  onProgress?.('classify', 0);
  const boxes = [];

  for (const [i, word] of words.entries()) {
    const stripped = word.text.replace(/\D/g, '');
    const isKnownIdentifier = stripped.length >= 4 && deterministicValues.has(stripped);

    if (isKnownIdentifier) {
      boxes.push({ ...geometry(word), text: word.text, label: 'identifier', source: 'deterministic' });
    } else {
      const { label, confidence } = await classifyFragment(word.text, documentType);
      if (REDACT_LABELS.has(label) && confidence >= 0.5) {
        boxes.push({ ...geometry(word), text: word.text, label, source: 'model' });
      }
    }
    onProgress?.('classify', Math.round(((i + 1) / words.length) * 100));
  }

  onProgress?.('draw', 100);
  const redactedDataUrl = boxes.length ? drawBlackouts(imageDataUrl, boxes) : imageDataUrl;

  return { ok: true, ocrRan: true, boxes, redactedDataUrl, warnings };
}

function geometry(word) {
  const { bbox } = word;
  return { x: bbox.x0, y: bbox.y0, w: bbox.x1 - bbox.x0, h: bbox.y1 - bbox.y0 };
}

/** Paint opaque boxes over a data-URL image. Runs in an OffscreenCanvas. */
function drawBlackouts(imageDataUrl, boxes) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(img.width, img.height)
        : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = '#000';
      for (const b of boxes) ctx.fillRect(b.x, b.y, b.w, b.h);
      canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png');
    };
    img.onerror = () => resolve(imageDataUrl);
    img.src = imageDataUrl;
  });
}

/**
 * Residual vision-only path: things OCR cannot express at all — a face photo,
 * a signature, a QR encoding an ID.
 *
 * Coarse question, coarse budget. Degrades gracefully at any visual token
 * count, which is why the un-settable budget is not a blocker here.
 */
const VISION_SCHEMA = {
  type: 'object',
  properties: {
    contains: {
      type: 'array',
      items: { type: 'string', enum: ['face_photo', 'signature', 'qr_code', 'barcode', 'none'] },
    },
    looks_like_identity_document: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['contains', 'looks_like_identity_document', 'confidence'],
};

async function fallbackVisionCheck(imageDataUrl, warnings, onProgress) {
  onProgress?.('vision', 0);
  try {
    const base64 = imageDataUrl.split(',')[1] ?? '';
    const { data } = await chatJSON({
      system: `You inspect images that were going to be shared with a third-party AI. Report which non-text sensitive elements are present: a face photograph, a signature, a QR or barcode. Return \`none\` for an empty list.`,
      user: 'Inspect this image.',
      schema: VISION_SCHEMA,
      ctx: CTX.visionClassify,
      images: [base64],
    });
    onProgress?.('vision', 100);

    const contains = Array.isArray(data.contains) ? data.contains.filter((c) => c !== 'none') : [];
    if (contains.length) warnings.push(`Image appears to contain: ${contains.join(', ')}. Redact manually before sharing.`);
    return {
      ok: true, ocrRan: false, boxes: [], redactedDataUrl: null, warnings,
      vision: data,
    };
  } catch (err) {
    warnings.push(`Vision check failed (${err.message}). Treat this image as potentially sensitive.`);
    return { ok: false, ocrRan: false, boxes: [], redactedDataUrl: null, warnings };
  }
}