// Generates PWA icons (icon-192/512, apple-touch-icon) with zero dependencies:
// raw RGB pixels → minimal PNG encoder (zlib + hand-rolled CRC32).
// Design: brutalist block mark — ink field, yellow plate, blocky CK glyphs.
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
  const fill = (x, y, w, h, [r, g, b]) => {
    for (let yy = Math.max(0, y); yy < Math.min(size, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(size, x + w); xx++) {
        const i = (yy * size + xx) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
      }
  };
  draw(fill, size);
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

const INK = [20, 20, 20], YELLOW = [255, 217, 0], PAPER = [242, 239, 232];

const draw = (f, S) => {
  const u = S / 64; // 64-unit design grid
  f(0, 0, S, S, INK);                                   // ink field
  f(6 * u, 6 * u, 48 * u, 48 * u, YELLOW);              // yellow plate (offset = shadow feel)
  f(6 * u, 6 * u, 48 * u, 3 * u, INK);                  // plate border top
  f(6 * u, 51 * u, 48 * u, 3 * u, INK);                 // bottom
  f(6 * u, 6 * u, 3 * u, 48 * u, INK);                  // left
  f(51 * u, 6 * u, 3 * u, 48 * u, INK);                 // right
  // C
  f(14 * u, 18 * u, 6 * u, 24 * u, INK);
  f(14 * u, 18 * u, 14 * u, 6 * u, INK);
  f(14 * u, 36 * u, 14 * u, 6 * u, INK);
  // K
  f(32 * u, 18 * u, 6 * u, 24 * u, INK);
  for (let i = 0; i < 4; i++) {                         // stepped arms
    f((38 + i * 2) * u, (27 - i * 3) * u, 4 * u, 4 * u, INK);   // upper
    f((38 + i * 2) * u, (30 + i * 3) * u, 4 * u, 4 * u, INK);   // lower
  }
  // paper tick, bottom-right — the "tracker" dot
  f(44 * u, 44 * u, 5 * u, 5 * u, PAPER);
};

const out = join(__dirname, "..", "public");
writeFileSync(join(out, "icon-512.png"), png(512, draw));
writeFileSync(join(out, "icon-192.png"), png(192, draw));
writeFileSync(join(out, "apple-touch-icon.png"), png(180, draw));
console.log("icons written to public/");
