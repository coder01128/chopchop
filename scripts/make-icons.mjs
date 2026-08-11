#!/usr/bin/env node
/**
 * Generates the dashboard's PWA icons.
 *
 *   node scripts/make-icons.mjs
 *
 * The icons are committed, so this does not run in the build. It exists so
 * they are reproducible: a binary nobody can regenerate is a binary nobody can
 * change, and the next person wanting a different mark should not have to open
 * an image editor and guess at the colours.
 *
 * The palette is the neutral default from `packages/shared/src/theme.css`.
 * This is the *dashboard's* icon — Brad's product, one shared host, every
 * seller — so it is deliberately not branded per tenant. A tenant colour here
 * would be the same bug as a component that knows the word `meat`.
 *
 * Antialiasing is a signed distance field per pixel rather than supersampling:
 * fewer moving parts, and exact edges at every size.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'dashboard', 'public', 'icons');

const ACCENT = [0xc9, 0xa2, 0x27]; // --accent
const INK = [0x12, 0x12, 0x0f]; // --accent-ink

/**
 * The mark: a tick. The dashboard is an order queue, and the whole job is
 * moving an order one step forward. Drawn in unit space so it scales exactly.
 */
const TICK = [
  [0.3, 0.54],
  [0.44, 0.68],
  [0.72, 0.33],
];

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Signed distance to a rounded box centred on (0.5, 0.5), in unit space. */
function distanceToRoundedBox(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function coverage(distance, feather) {
  return Math.max(0, Math.min(1, 0.5 - distance / feather));
}

function blend(base, over, alpha) {
  return [
    Math.round(base[0] * (1 - alpha) + over[0] * alpha),
    Math.round(base[1] * (1 - alpha) + over[1] * alpha),
    Math.round(base[2] * (1 - alpha) + over[2] * alpha),
  ];
}

/**
 * @param size      pixels square
 * @param cornerRadius  in unit space; 0 is a full bleed square
 * @param tickWidth stroke width in unit space
 * @param tickScale shrinks the tick towards the centre, for the maskable safe zone
 */
function renderIcon(size, { cornerRadius, tickWidth, tickScale }) {
  const feather = 1 / size;
  const pixels = Buffer.alloc(size * size * 4);

  const tick = TICK.map(([x, y]) => [0.5 + (x - 0.5) * tickScale, 0.5 + (y - 0.5) * tickScale]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;

      const plateAlpha =
        cornerRadius > 0 ? coverage(distanceToRoundedBox(px, py, 0.5, cornerRadius), feather) : 1;

      let tickDistance = Infinity;
      for (let i = 0; i < tick.length - 1; i += 1) {
        tickDistance = Math.min(tickDistance, distanceToSegment(px, py, tick[i], tick[i + 1]));
      }
      const tickAlpha = coverage(tickDistance - (tickWidth * tickScale) / 2, feather);

      const colour = blend(ACCENT, INK, tickAlpha);
      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = Math.round(plateAlpha * 255);
    }
  }

  return pixels;
}

// --- PNG container -------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function toPng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline, filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Output --------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const written = [];

function write(name, size, options) {
  const path = join(OUT, name);
  writeFileSync(path, toPng(size, renderIcon(size, options)));
  written.push(`${name} (${size}×${size})`);
}

// `purpose: any` — a rounded plate, because the launcher shows it as drawn.
write('icon-192.png', 192, { cornerRadius: 0.18, tickWidth: 0.12, tickScale: 1 });
write('icon-512.png', 512, { cornerRadius: 0.18, tickWidth: 0.12, tickScale: 1 });

// `purpose: maskable` — full bleed, and the mark pulled inside the safe zone.
// Android crops this to whatever shape the launcher uses, and anything outside
// the middle 80% can be cut off.
write('icon-maskable-512.png', 512, { cornerRadius: 0, tickWidth: 0.12, tickScale: 0.66 });

// iOS applies its own mask and does not composite transparency, so this one is
// a full square.
write('apple-touch-icon.png', 180, { cornerRadius: 0, tickWidth: 0.12, tickScale: 0.78 });

console.log(`Wrote ${written.length} icons to apps/dashboard/public/icons:`);
for (const line of written) console.log(`  ${line}`);
