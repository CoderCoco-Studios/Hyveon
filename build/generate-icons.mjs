/**
 * Rasterises the Hyveon icon artwork into every asset the packagers and the web
 * client need. Run it with `npm run icons:generate` after editing icon.svg or
 * icon-small.svg; the outputs are committed so a plain `npm run desktop:package`
 * never has to rasterise anything.
 *
 * Produces:
 *   build/icon.png                              1024×1024, used by the Linux AppImage
 *   build/icon.ico                              7 sizes, used by NSIS + Windows Explorer
 *   build/icon.icns                             full macOS set, used by the DMG
 *   app/packages/web/public/favicon.svg         browser tab (vector)
 *   app/packages/web/public/favicon-32.png      browser tab (raster fallback)
 *   app/packages/web/public/apple-touch-icon.png  iOS/macOS bookmark tile
 *
 * Sizes at or below 32px are rendered from icon-small.svg: the seven-cell
 * honeycomb of the master needs ~48px before it reads as anything but a smudge.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import png2icons from 'png2icons';
import sharp from 'sharp';

const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BUILD_DIR, '..');
const WEB_PUBLIC = join(REPO_ROOT, 'app', 'packages', 'web', 'public');

const MASTER = join(BUILD_DIR, 'icon.svg');
const SMALL = join(BUILD_DIR, 'icon-small.svg');

/** Below this edge length the small-size variant is used instead of the master. */
const SMALL_VARIANT_MAX = 32;

/** Every size embedded in build/icon.ico, smallest first. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Renders one of the two source SVGs to a square PNG buffer.
 *
 * @param {number} size Edge length in pixels.
 * @returns {Promise<Buffer>} PNG-encoded image data.
 */
const renderPng = (size) =>
  sharp(size <= SMALL_VARIANT_MAX ? SMALL : MASTER)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * Renders one of the two source SVGs to raw straight-alpha RGBA pixels.
 *
 * @param {number} size Edge length in pixels.
 * @returns {Promise<Buffer>} `size * size * 4` bytes, top-down, RGBA order.
 */
const renderRgba = (size) =>
  sharp(size <= SMALL_VARIANT_MAX ? SMALL : MASTER)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer();

/**
 * Encodes RGBA pixels as the DIB payload of an ICO entry: a BITMAPINFOHEADER, a
 * bottom-up 32-bit BGRA colour block, and the 1-bit AND mask that the format
 * still requires even when the alpha channel already carries transparency.
 *
 * NSIS and older shell components only reliably decode DIB entries, so every
 * size except 256×256 is stored this way rather than as embedded PNG.
 *
 * @param {Buffer} rgba Top-down RGBA pixels.
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} The ICO entry payload.
 */
const encodeDib = (rgba, size) => {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — colour block plus AND mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    // DIB rows run bottom-up, so the last source row is written first.
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      colour[dst + x * 4] = rgba[src + x * 4 + 2]; // B
      colour[dst + x * 4 + 1] = rgba[src + x * 4 + 1]; // G
      colour[dst + x * 4 + 2] = rgba[src + x * 4]; // R
      colour[dst + x * 4 + 3] = rgba[src + x * 4 + 3]; // A
    }
  }

  // AND mask: 1 bit per pixel, rows padded to 4 bytes. All zeroes means "draw
  // every pixel" and lets the alpha channel do the masking.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  header.writeUInt32LE(colour.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, colour, mask]);
};

/**
 * Assembles a multi-size .ico from per-size payloads.
 *
 * @param {Array<{ size: number, payload: Buffer }>} entries Images to embed.
 * @returns {Buffer} A complete ICO file.
 */
const buildIco = (entries) => {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const table = entries.map(({ size, payload }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 encodes 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size — 0 for true colour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(payload.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += payload.length;
    return entry;
  });

  return Buffer.concat([dir, ...table, ...entries.map((e) => e.payload)]);
};

mkdirSync(WEB_PUBLIC, { recursive: true });

// ── Linux / electron-builder base image ─────────────────────────────────────
const master1024 = await renderPng(1024);
writeFileSync(join(BUILD_DIR, 'icon.png'), master1024);

// ── Windows ─────────────────────────────────────────────────────────────────
const icoEntries = [];
for (const size of ICO_SIZES) {
  // 256×256 stays PNG-compressed: it is the one size the format expects to be
  // PNG, and a DIB at that size would triple the file for no benefit.
  const payload = size === 256 ? await renderPng(size) : encodeDib(await renderRgba(size), size);
  icoEntries.push({ size, payload });
}
writeFileSync(join(BUILD_DIR, 'icon.ico'), buildIco(icoEntries));

// ── macOS ───────────────────────────────────────────────────────────────────
const icns = png2icons.createICNS(master1024, png2icons.BILINEAR, 0);
if (!icns) throw new Error('png2icons failed to produce an ICNS from build/icon.png');
writeFileSync(join(BUILD_DIR, 'icon.icns'), icns);

// ── Web client ──────────────────────────────────────────────────────────────
writeFileSync(join(WEB_PUBLIC, 'favicon.svg'), readFileSync(SMALL));
writeFileSync(join(WEB_PUBLIC, 'favicon-32.png'), await renderPng(32));
writeFileSync(join(WEB_PUBLIC, 'apple-touch-icon.png'), await renderPng(180));

console.log(`icons: wrote build/icon.png, build/icon.ico (${ICO_SIZES.join('/')}), build/icon.icns`);
console.log('icons: wrote favicon.svg, favicon-32.png, apple-touch-icon.png to app/packages/web/public');
