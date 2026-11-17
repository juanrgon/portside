#!/usr/bin/env node
// Draws the extension icons: a window with a sidebar on its left edge.
// Run `node script/make-icons.mjs` after changing the drawing.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

// Is (x, y) inside a rounded rectangle? All values are 0..1 of the icon size.
function inRound(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function colorAt(x, y) {
  if (!inRound(x, y, 0.04, 0.04, 0.96, 0.96, 0.24)) return [0, 0, 0, 0];
  if (inRound(x, y, 0.17, 0.2, 0.42, 0.8, 0.07)) return [255, 255, 255, 255];
  if (inRound(x, y, 0.48, 0.2, 0.83, 0.8, 0.07)) return [178, 160, 232, 255];
  const t = (x + y) / 2;
  return [Math.round(92 - 30 * t), Math.round(66 - 22 * t), Math.round(170 - 30 * t), 255];
}

function png(size) {
  const samples = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const [r, g, b, a] = colorAt((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size);
          sum[0] += r * a;
          sum[1] += g * a;
          sum[2] += b * a;
          sum[3] += a;
        }
      }
      const at = py * (size * 4 + 1) + 1 + px * 4;
      const alpha = sum[3] / (samples * samples);
      raw[at] = sum[3] ? Math.round(sum[0] / sum[3]) : 0;
      raw[at + 1] = sum[3] ? Math.round(sum[1] / sum[3]) : 0;
      raw[at + 2] = sum[3] ? Math.round(sum[2] / sum[3]) : 0;
      raw[at + 3] = Math.round(alpha);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = new URL("../extension/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon${size}.png`, dir), png(size));
console.log("icons written");
