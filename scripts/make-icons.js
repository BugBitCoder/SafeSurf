#!/usr/bin/env node
/**
 * Generate the extension icons.
 *
 *   node scripts/make-icons.js
 *
 * Pure Node (zlib + a hand-rolled PNG encoder) so the repo needs no image
 * dependency. Output is deterministic: same input, same bytes.
 *
 * The manifest references these icons, and a manifest pointing at a missing
 * file makes Chrome refuse to load the extension at all — which is a
 * confusing way to find out you forgot a PNG.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, 'extension/icons');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** @param {{width:number,height:number,rgba:Buffer}} img */
function encodePNG({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/** Signed distance to a rounded rect, for cheap anti-aliasing. */
function roundedRectSDF(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Shield: flat shoulders that hold full width for the first third, then a
 * parabolic taper to a point at the bottom centre. A plain triangle reads as
 * a funnel, not a shield.
 *
 * @returns boolean true when (px,py) is inside the shield body
 */
function insideShield(px, py, size) {
  const top = size * 0.25;
  const bottom = size * 0.79;
  const halfW = size * 0.215;

  if (py < top || py > bottom) return false;
  const k = (py - top) / (bottom - top);
  const hw = halfW * (1 - k * k);
  return Math.abs(px - size / 2) <= hw;
}

/** Keyhole punched out of the shield: a circle with a slot down to a point. */
function insideKeyhole(px, py, size) {
  const cx = size / 2;
  const cy = size * 0.44;
  const r = size * 0.062;

  if (Math.hypot(px - cx, py - cy) <= r) return true;

  const slotTop = cy;
  const slotBottom = size * 0.62;
  if (py < slotTop || py > slotBottom) return false;
  const t = (py - slotTop) / (slotBottom - slotTop);
  const half = r * (1 - t);
  return Math.abs(px - cx) <= half;
}

const lerp = (a, b, t) => a + (b - a) * t;

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const half = size * 0.44;
  const radius = size * 0.24;
  // One pixel of feather at this scale keeps the edge smooth after downscaling.
  const feather = 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Background plate: rounded square, diagonal green gradient.
      const plateD = roundedRectSDF(px, py, c, c, half, half, radius);
      const plateA = Math.min(1, Math.max(0, 0.5 - plateD / feather));
      if (plateA <= 0) continue;

      const t = (px + py) / (size * 2);
      let r = lerp(0x3d, 0x18, t);
      let g = lerp(0xdc, 0x5c, t);
      let b = lerp(0x84, 0x3d, t);

      // Shield glyph in near-black, with the keyhole cut back out to green so
      // it reads as a lock rather than a blob.
      if (insideShield(px, py, size)) {
        if (insideKeyhole(px, py, size)) {
          r = 0x9f; g = 0xf7; b = 0xcf; // a lighter green reads better than the plate
        } else {
          r = 0x06; g = 0x0d; b = 0x0a;
        }
      }

      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(plateA * 255);
    }
  }

  return encodePNG({ width: size, height: size, rgba });
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

for (const size of [16, 48, 128]) {
  const file = resolve(OUT, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`  wrote extension/icons/icon-${size}.png`);
}

console.log('\nDone. Manifest icons now resolve.\n');