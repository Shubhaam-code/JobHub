/**
 * Builds the two hero cutouts the landing page renders, from `public/boy.png` and
 * `public/girl.png`.
 *
 * Why this exists rather than pointing <Image> straight at the sources: both were
 * exported flattened onto an opaque black matte (PNG colour type 2 — no alpha
 * channel at all), and each one is a coloured organic blob sitting inside a black
 * rectangle. Dropped onto this page's #fafaf9 background they would render as two
 * black boxes.
 *
 * `logo-assets.mjs` solves the same problem for the wordmark by un-premultiplying
 * against the matte (alpha = max channel). That cannot be used here: these are
 * photographs, and their subjects contain genuinely dark pixels — the girl's navy
 * plaid shirt peaks around 60/255, the boy's glasses and pupils lower still. Taking
 * alpha from brightness would leave her shirt 23% opaque and his glasses see-through.
 *
 * So the matte is separated by *connectivity* instead of by brightness: flood fill
 * inward from the canvas edge through near-black pixels, and only what that fill
 * reaches is background. Dark pixels inside the blob are never reached, so they keep
 * full opacity.
 *
 * That leaves the blob's own anti-aliased rim, which is blob-colour blended toward
 * black and would read as a dirty outline. Rather than trying to recover coverage
 * per-pixel, the mask is eroded past the rim and then feathered: a distance
 * transform gives each pixel its distance to the nearest background pixel, and alpha
 * ramps from 0 at ERODE_PX - FEATHER_PX/2 to 1 at ERODE_PX + FEATHER_PX/2. Every
 * pixel that ends up even partly opaque therefore sits far enough inside the true
 * edge to carry the blob's real colour, and the visible boundary is a clean 2px
 * ramp. On artwork ~900px across, giving up 3px of rim is invisible.
 *
 * Sources are read only. Re-run after replacing either one:
 *   node scripts/hero-assets.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sharp from 'sharp';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_ROOT, 'public');

/**
 * How bright a pixel may be and still count as matte during the flood fill.
 *
 * The matte itself is exactly #000000, but both exports left a faint glow ramping
 * out of the blob across a few hundred pixels of it. Anything at or under this is
 * treated as background so that glow is discarded rather than kept as a grey halo;
 * the blobs' own edges are fully saturated, so nothing real is near it.
 */
const MATTE_MAX = 24;

/** How far inside the flood-fill boundary the fully-opaque region starts. */
const ERODE_PX = 3;

/** Width of the alpha ramp straddling that boundary. */
const FEATHER_PX = 2;

/** Transparent pixels kept around the trimmed cutout, so nothing clips its edge. */
const MARGIN = 1;

const DIAGONAL = Math.SQRT2;

/** Decodes to a flat RGB buffer plus its dimensions. */
async function readRgb(file) {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  const data = await image.removeAlpha().raw().toBuffer();
  return { width, height, data };
}

/**
 * The matte, as a flag per pixel: near-black *and* reachable from the canvas edge.
 *
 * An explicit stack rather than recursion — these are ~1.3M-pixel images and the
 * fill visits most of them.
 */
function floodMatte({ width, height, data }) {
  const matte = new Uint8Array(width * height);
  const stack = [];

  const isDark = (p) => {
    const i = p * 3;
    return Math.max(data[i], data[i + 1], data[i + 2]) <= MATTE_MAX;
  };

  const push = (p) => {
    if (matte[p] || !isDark(p)) return;
    matte[p] = 1;
    stack.push(p);
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (stack.length) {
    const p = stack.pop();
    const x = p % width;

    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < width * (height - 1)) push(p + width);
  }

  return matte;
}

/**
 * Distance from every pixel to the nearest matte pixel, by two-pass chamfer.
 *
 * Approximate — a chamfer metric, not exact Euclidean — which is more than enough
 * over the ~4px band the alpha ramp actually reads. Outside the canvas counts as
 * matte, so a blob running off an edge is cut there rather than left hard.
 */
function distanceToMatte(width, height, matte) {
  const dist = new Float32Array(width * height);

  for (let i = 0; i < dist.length; i += 1) dist[i] = matte[i] ? 0 : Infinity;

  const relax = (p, from, weight) => {
    const candidate = dist[from] + weight;
    if (candidate < dist[p]) dist[p] = candidate;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (dist[p] === 0) continue;

      // Outside the canvas is matte, so an edge pixel is already at the boundary.
      if (y === 0 || x === 0 || x === width - 1) dist[p] = Math.min(dist[p], 1);

      if (y > 0) {
        relax(p, p - width, 1);
        if (x > 0) relax(p, p - width - 1, DIAGONAL);
        if (x < width - 1) relax(p, p - width + 1, DIAGONAL);
      }
      if (x > 0) relax(p, p - 1, 1);
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const p = y * width + x;
      if (dist[p] === 0) continue;

      if (y === height - 1) dist[p] = Math.min(dist[p], 1);

      if (y < height - 1) {
        relax(p, p + width, 1);
        if (x < width - 1) relax(p, p + width + 1, DIAGONAL);
        if (x > 0) relax(p, p + width - 1, DIAGONAL);
      }
      if (x < width - 1) relax(p, p + 1, 1);
    }
  }

  return dist;
}

/** The source colours, with the eroded-and-feathered mask as their alpha channel. */
function cutout({ width, height, data }, dist) {
  const out = Buffer.alloc(width * height * 4);

  for (let p = 0; p < width * height; p += 1) {
    const coverage = (dist[p] - ERODE_PX) / FEATHER_PX + 0.5;
    if (coverage <= 0) continue;

    const src = p * 3;
    const dst = p * 4;

    out[dst] = data[src];
    out[dst + 1] = data[src + 1];
    out[dst + 2] = data[src + 2];
    out[dst + 3] = coverage >= 1 ? 255 : Math.round(coverage * 255);
  }

  return out;
}

/**
 * The tightest box containing every pixel with any coverage, grown by `MARGIN`.
 *
 * Trimming here rather than in CSS is what makes the rendered geometry predictable:
 * the file's aspect ratio becomes the blob's aspect ratio, so a width in the layout
 * determines the height without a second measurement.
 */
function contentBox(width, height, rgba) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
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

async function build(source, target) {
  const image = await readRgb(path.join(PUBLIC_DIR, source));
  const { width, height } = image;

  const matte = floodMatte(image);
  const rgba = cutout(image, distanceToMatte(width, height, matte));
  const box = contentBox(width, height, rgba);
  const file = path.join(PUBLIC_DIR, target);

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract(box)
    .png({ compressionLevel: 9 })
    .toFile(file);

  return { file, width: box.width, height: box.height };
}

const written = [
  await build('girl.png', 'hero-girl.png'),
  await build('boy.png', 'hero-boy.png'),
];

for (const { file, width, height } of written) {
  console.log(`${path.relative(WEB_ROOT, file).replace(/\\/g, '/')}  ${width}x${height}`);
}
