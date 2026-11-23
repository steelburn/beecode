// Generates a placeholder resources/icon.png (256x256) with no image dependencies:
// raw RGBA pixels -> PNG chunks (IHDR/IDAT/IEND) with zlib deflate and CRC32.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const px = Buffer.alloc(SIZE * SIZE * 4);

function setPixel(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

// Rounded-square background + amber hexagon body + three dark stripes (a bee).
const cx = SIZE / 2;
const cy = SIZE / 2;
const radius = SIZE * 0.40;

function hexDistance(x, y) {
  // Distance inside a pointy-top hexagon, normalised so 1.0 == edge.
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  return Math.max(dx * 0.866 + dy * 0.5, dy);
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    // transparent canvas
    setPixel(x, y, 0, 0, 0, 0);

    const rounded = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    if (rounded < SIZE * 0.47) {
      const shade = 18 + Math.round((y / SIZE) * 14);
      setPixel(x, y, shade, shade + 3, shade + 8, 255);
    }

    const d = hexDistance(x, y) / radius;
    if (d <= 1) {
      const edge = d > 0.92;
      if (edge) {
        setPixel(x, y, 90, 62, 8, 255);
        continue;
      }
      // stripes across the body
      const stripe = Math.floor((y - (cy - radius)) / (radius / 3.2));
      const isStripe = stripe === 1 || stripe === 3;
      if (isStripe) setPixel(x, y, 32, 24, 10, 255);
      else setPixel(x, y, 245, 179, 1, 255);
    }
  }
}

// dark eyes
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = x - cx;
    const dy = y - cy;
    const eye1 = Math.hypot(dx + radius * 0.33, dy + radius * 0.42);
    const eye2 = Math.hypot(dx - radius * 0.33, dy + radius * 0.42);
    if (eye1 < radius * 0.11 || eye2 < radius * 0.11) setPixel(x, y, 20, 16, 8, 255);
  }
}

// --- PNG encoding -----------------------------------------------------------
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(root, 'resources', 'icon.png');
// The shipped icon is real artwork rendered from its 2048px source, so this generator
// would clobber it: only overwrite an existing icon when asked explicitly.
if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`[icon] ${out} already exists — pass --force to replace it with the placeholder`);
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[icon] wrote ${out} (${png.length} bytes)`);
