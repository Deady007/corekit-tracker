// Generates PWA icons (icon-192/512, apple-touch-icon) with zero dependencies:
// raw RGB pixels → minimal PNG encoder (zlib + hand-rolled CRC32).
// Design: black field, orange "T" monogram with rounded terminals, white
// tick-in-circle badge — smooth/rounded, not blocky (the richer gradient +
// soft-shadow version lives in public/logo.svg; this raw RGB encoder has no
// alpha channel so shadows/gradients aren't practical at favicon sizes).
const { deflateSync } = require("node:zlib");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, draw) {
  const px = Buffer.alloc(size * size * 3);
  // NOTE: coordinates are rounded to integers before use — Buffer/typed-array
  // writes to a fractional index are silently dropped (no error, no pixel).
  const fill = (x, y, w, h, [r, g, b]) => {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let yy = Math.max(0, y0); yy < Math.min(size, y1); yy++)
      for (let xx = Math.max(0, x0); xx < Math.min(size, x1); xx++) {
        const i = (yy * size + xx) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
      }
  };
  const circle = (cx, cy, r, [rr, g, b]) => {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    for (let yy = Math.max(0, cy - r); yy < Math.min(size, cy + r + 1); yy++)
      for (let xx = Math.max(0, cx - r); xx < Math.min(size, cx + r + 1); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        const i = (yy * size + xx) * 3; px[i] = rr; px[i + 1] = g; px[i + 2] = b;
      }
  };
  // rounded rect = cross of two overlapping fills + 4 corner circles
  const roundedRect = (x, y, w, h, r, color) => {
    fill(x + r, y, w - 2 * r, h, color);
    fill(x, y + r, w, h - 2 * r, color);
    circle(x + r, y + r, r, color);
    circle(x + w - r, y + r, r, color);
    circle(x + r, y + h - r, r, color);
    circle(x + w - r, y + h - r, r, color);
  };
  // thick smooth line: overlapping circles along each segment (no blocky steps)
  const strokeLine = (x0, y0, x1, y1, width, color) => {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (width / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color);
    }
  };
  draw(fill, circle, roundedRect, strokeLine, size);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const INK = [26, 26, 26], ORANGE = [255, 122, 0], WHITE = [255, 255, 255];

const draw = (f, c, rr, stroke, S) => {
  const u = S / 64; // 64-unit design grid
  f(0, 0, S, S, INK);                                          // ink field
  // T monogram — rounded terminals, not square-cut
  rr(15 * u, 17.5 * u, 34 * u, 7 * u, 3.5 * u, ORANGE);         // top bar
  rr(28.5 * u, 17.5 * u, 7 * u, 29 * u, 3.5 * u, ORANGE);       // stem
  // task-complete badge, bottom-right — smooth circular checkmark
  c(47 * u, 47 * u, 8 * u, WHITE);
  stroke(44 * u, 47.5 * u, 46.5 * u, 50 * u, 1.7 * u, ORANGE);  // check: short leg
  stroke(46.5 * u, 50 * u, 51 * u, 43.5 * u, 1.7 * u, ORANGE);  // check: long leg
};

const out = join(__dirname, "..", "public");
writeFileSync(join(out, "icon-512.png"), png(512, draw));
writeFileSync(join(out, "icon-192.png"), png(192, draw));
writeFileSync(join(out, "apple-touch-icon.png"), png(180, draw));
console.log("icons written to public/");
