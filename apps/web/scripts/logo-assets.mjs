/**
 * Builds the logo assets the app renders, from the two source files in `public/`.
 *
 * Why this exists rather than pointing <Image> straight at the sources: both were
 * exported flattened onto an opaque black matte, and `public/image.png` carries
 * the "JobHub" wordmark in #070707 on #000000 — a 1.0:1 contrast ratio, invisible
 * to the eye on any background. Dropping either file into this light-themed
 * header would render a black rectangle with no readable wordmark.
 *
 * Both problems are recoverable because the matte is *exactly* #000000 while
 * every real pixel is above it, so the matte can be separated from the artwork:
 *
 *   - background (max channel == 0)  ->  alpha 0
 *   - the wordmark (grey, peaks at 7/255)  ->  re-inked to --color-foreground,
 *     with its 1..7 anti-alias ramp becoming the alpha ramp
 *   - the icon squares  ->  un-premultiplied from the black matte
 *     (alpha = max channel, colour = c * 255 / max), which is the standard
 *     inverse of "composite over black" and restores clean gradient edges
 *
 * Sources are read only. Re-run after replacing either one:
 *   node scripts/logo-assets.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sharp from 'sharp';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_ROOT, 'public');
const APP_DIR = path.join(WEB_ROOT, 'src', 'app');

/** `--color-foreground`. The wordmark is site ink, so it tracks the type colour. */
const INK = [0x1c, 0x19, 0x17];

/**
 * Where the wordmark starts in `image.png`. The icon artwork ends at x=449 and
 * the glyphs begin around x=460, so anything at or past this column is type and
 * gets re-inked; anything before it is artwork and gets un-matted.
 */
const WORDMARK_X = 455;

/** The wordmark's own peak value. Its glyph bodies sit at 7/255, not 255. */
const WORDMARK_PEAK = 7;

/** Breathing room kept around the trimmed artwork, in source pixels. */
const MARGIN = 8;

const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));

/** Decodes to a flat RGBA buffer plus its dimensions. */
async function readRgba(file) {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  const data = await image.ensureAlpha().raw().toBuffer();
  return { width, height, data };
}

/**
 * The tightest box containing every pixel `keep` accepts, grown by `MARGIN` and
 * clipped to the canvas. Trimming here rather than in CSS is what makes the
 * rendered height predictable: the file's edges become the mark's edges.
 */
function contentBox(width, height, keep) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!keep(x, y)) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  if (x1 < 0) throw new Error('no content found — is the source file blank?');

  x0 = Math.max(0, x0 - MARGIN);
  y0 = Math.max(0, y0 - MARGIN);
  x1 = Math.min(width - 1, x1 + MARGIN);
  y1 = Math.min(height - 1, y1 + MARGIN);

  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Lifts `image.png` off its black matte: transparent background, re-inked
 * wordmark, un-premultiplied icon. Returns the un-cropped RGBA canvas.
 */
function unmatte({ width, height, data }) {
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);

      // The matte. Exactly black, so it never collides with real artwork.
      if (max === 0) continue;

      if (x >= WORDMARK_X) {
        // Type. Its value carries coverage, not colour.
        out[i] = INK[0];
        out[i + 1] = INK[1];
        out[i + 2] = INK[2];
        out[i + 3] = clamp255((max * 255) / WORDMARK_PEAK);
        continue;
      }

      // Artwork composited over black: recover the original colour and coverage.
      out[i] = clamp255((r * 255) / max);
      out[i + 1] = clamp255((g * 255) / max);
      out[i + 2] = clamp255((b * 255) / max);
      out[i + 3] = max;
    }
  }

  return out;
}

async function writePng(rgba, width, height, box, file) {
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract(box)
    .png({ compressionLevel: 9 })
    .toFile(file);

  return { file, width: box.width, height: box.height };
}

async function buildFromLockup() {
  const source = await readRgba(path.join(PUBLIC_DIR, 'image.png'));
  const { width, height } = source;
  const rgba = unmatte(source);

  const alphaAt = (x, y) => rgba[(y * width + x) * 4 + 3];

  /* The full lockup — icon plus wordmark — for the navbars and every other
     light surface. Anything with real coverage counts as content; the faint
     glow the export left around the icon does not. */
  const lockup = await writePng(
    rgba,
    width,
    height,
    contentBox(width, height, (x, y) => alphaAt(x, y) > 8),
    path.join(PUBLIC_DIR, 'logo-lockup.png'),
  );

  /* The icon on its own, for the one dark surface in the product: the admin
     sidebar, where a #1c1917 wordmark would be invisible. */
  const mark = await writePng(
    rgba,
    width,
    height,
    contentBox(width, height, (x, y) => x < WORDMARK_X && alphaAt(x, y) > 8),
    path.join(PUBLIC_DIR, 'logo-mark.png'),
  );

  return [lockup, mark];
}

/**
 * The tab icon, from the square icon-only source.
 *
 * Its black matte is kept on purpose here: a favicon is composited against
 * browser chrome this code cannot see, and a solid dark tile stays legible in
 * both light and dark chrome. Padded to a square so no browser stretches it.
 */
async function buildIcons() {
  const file = path.join(PUBLIC_DIR, 'logo.jpeg');
  const { width, height, data } = await readRgba(file);

  // JPEG noise means the matte is near-black, not exactly black, so the artwork
  // is found by saturation instead of by "brighter than zero".
  const box = contentBox(width, height, (x, y) => {
    const i = (y * width + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    return Math.max(r, g, b) - Math.min(r, g, b) > 30;
  });

  const written = [];
  for (const [name, size] of [
    ['icon.png', 512],
    ['apple-icon.png', 180],
  ]) {
    // Artwork at 78% of the tile: enough inset that the squares do not touch a
    // rounded mask, which is what iOS applies to `apple-icon`.
    const inset = Math.round(size * 0.78);
    const target = path.join(APP_DIR, name);

    await sharp(file)
      .extract(box)
      .resize(inset, inset, { fit: 'contain', background: '#000000' })
      .extend({
        top: Math.floor((size - inset) / 2),
        bottom: Math.ceil((size - inset) / 2),
        left: Math.floor((size - inset) / 2),
        right: Math.ceil((size - inset) / 2),
        background: '#000000',
      })
      .png({ compressionLevel: 9 })
      .toFile(target);

    written.push({ file: target, width: size, height: size });
  }

  return written;
}

const written = [...(await buildFromLockup()), ...(await buildIcons())];

for (const { file, width, height } of written) {
  console.log(`${path.relative(WEB_ROOT, file).replace(/\\/g, '/')}  ${width}x${height}`);
}
