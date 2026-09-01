/**
 * PDF → plain text.
 *
 * Never throws: a corrupt file, an encrypted file or a scanned page all come
 * back as `{ ok: false, reason }` with a message worth showing a user, so an
 * unreadable upload is a 400 rather than a crashed request.
 */

import { createRequire } from 'node:module';

/* Type-only, so it is erased at compile time and pulls nothing in at runtime —
   the whole point of the comment on `loadPdfParse` below. */
import type { PDFParse } from 'pdf-parse';

import { logger } from '../lib/logger.js';

export type PdfTextResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * `pdf-parse` is loaded on demand rather than imported at the top of this file,
 * and that is load-bearing rather than a micro-optimization.
 *
 * Its pdfjs build runs `const SCALE_MATRIX = new DOMMatrix()` at module scope.
 * `DOMMatrix` is a browser global; in Node it arrives from the optional
 * `@napi-rs/canvas` native binding, and pdfjs only *warns* when that binding is
 * missing before dereferencing the global anyway. So the import throws
 * `ReferenceError: DOMMatrix is not defined` — and because a static `import` is
 * evaluated before any code in this file, that ReferenceError propagated out of
 * the route graph and killed the API process at boot. The deploy went green (the
 * build only typechecks) and then every request failed, which reads like a
 * frontend outage and is nowhere near its cause.
 *
 * The binding goes missing on any host whose platform is not in the lockfile:
 * npm records only the `@napi-rs/canvas-*` binaries for the platform the lock was
 * generated on, so a lockfile written on Windows leaves Linux with none.
 *
 * Two things follow, and both matter:
 *   - the import is dynamic, so `installBrowserGlobals()` below can run first;
 *   - a failure to load is caught and reported as an unreadable upload instead of
 *     an unhandled throw, so the worst case is "resume parsing is down", never
 *     "the API is down".
 */
type PdfParseConstructor = typeof PDFParse;

/**
 * Stand-ins for the browser globals pdfjs polyfills from `@napi-rs/canvas`.
 *
 * These are inert on purpose. They exist so the module can finish evaluating;
 * they are not a canvas implementation. That is safe here because the only pdfjs
 * entry point this file uses is `getText()`, which never touches them — they are
 * read by the *rendering* paths (`getImage()`, `getScreenshot()`), which this
 * codebase does not call. Anything that starts rendering PDFs server-side needs
 * the real native binding, not these.
 */
class InertDOMMatrix {
  // The identity matrix, which is what `new DOMMatrix()` produces.
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
}
class InertImageData {}
class InertPath2D {}

type CanvasGlobals = Partial<Record<'DOMMatrix' | 'ImageData' | 'Path2D', unknown>>;

/**
 * The real classes when the native binding did install, so a working host keeps
 * working exactly as before. `createRequire` mirrors how pdfjs itself resolves
 * the package — this is the same lookup, just with a fallback that does not throw.
 */
function loadCanvasGlobals(): CanvasGlobals {
  try {
    return createRequire(import.meta.url)('@napi-rs/canvas') as CanvasGlobals;
  } catch {
    return {};
  }
}

/**
 * Defines the globals pdfjs needs before it is imported. Only fills gaps: pdfjs
 * skips its own polyfill when a global is already set, and a real browser-like
 * global that some other module installed must win over the placeholders above.
 */
function installBrowserGlobals(): void {
  const globals = globalThis as unknown as CanvasGlobals;

  if (globals.DOMMatrix && globals.ImageData && globals.Path2D) return;

  const canvas = loadCanvasGlobals();

  globals.DOMMatrix ??= canvas.DOMMatrix ?? InertDOMMatrix;
  globals.ImageData ??= canvas.ImageData ?? InertImageData;
  globals.Path2D ??= canvas.Path2D ?? InertPath2D;
}

/** Memoized so the globals are installed and the module resolved only once. */
let pdfParseConstructor: Promise<PdfParseConstructor> | null = null;

function loadPdfParse(): Promise<PdfParseConstructor> {
  pdfParseConstructor ??= (async () => {
    installBrowserGlobals();
    const pdfParse = await import('pdf-parse');
    return pdfParse.PDFParse;
  })();

  return pdfParseConstructor;
}

/**
 * Loads the parser ahead of the first upload, and reports whether it worked.
 *
 * pdfjs is a very large module — several seconds to evaluate — and making it lazy
 * moved that cost from process start to whoever uploaded first. Warming it at
 * boot puts the cost back where nobody is waiting on it.
 *
 * It also restores the one good property the static import had: a host where the
 * parser cannot load says so at startup instead of staying quiet until a user
 * tries to upload a resume. Resolves either way — this is a diagnostic, and the
 * API serves jobs perfectly well without a working PDF parser.
 */
export async function warmPdfParser(): Promise<boolean> {
  try {
    await loadPdfParse();
    return true;
  } catch (error: unknown) {
    logger.warn(
      '[resume] PDF parser failed to load — resume uploads will be rejected with a ' +
        '"temporarily unavailable" message. Everything else is unaffected.',
      error,
    );
    return false;
  }
}

/** Every PDF starts with this signature; anything else is not a PDF. */
const PDF_MAGIC = '%PDF-';

/**
 * Below this much text the file is almost certainly a scan or an image export —
 * there is nothing for the parser to read, and saying so beats returning an
 * empty profile.
 */
const MIN_USABLE_CHARS = 80;

/**
 * Resumes are 1–3 pages. The cap keeps a padded PDF from turning into a huge
 * prompt; the classifying detail is always near the top.
 */
const MAX_TEXT_CHARS = 12_000;

/**
 * Zero-width and formatting characters (ZWSP, ZWJ, word joiner, BOM). PDF text
 * is full of them and they are worth deleting rather than spacing out: a
 * zero-width space inside "Java" must not survive into a skill comparison.
 *
 * Matched by Unicode category so no invisible literal has to appear in this
 * file, where it could not be reviewed or diffed.
 */
const FORMAT_CHARS_RE = /\p{Cf}/gu;

/**
 * Any whitespace except a newline: tab, plain space, non-breaking space, the
 * en/em space family, ideographic space. Collapsed to a single plain space so
 * "Spring Boot" is one comparable string regardless of which space a PDF used.
 */
const HORIZONTAL_SPACE_RE = /[^\S\n]+/gu;

/** Collapses the ragged whitespace PDF text extraction produces. */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(FORMAT_CHARS_RE, '')
    .replace(HORIZONTAL_SPACE_RE, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdfText(data: Buffer): Promise<PdfTextResult> {
  if (data.length === 0) {
    return { ok: false, reason: 'The uploaded file is empty.' };
  }

  if (data.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
    return { ok: false, reason: 'That file is not a PDF. Please upload your resume as a PDF.' };
  }

  let Parser: PdfParseConstructor;

  try {
    Parser = await loadPdfParse();
  } catch (error: unknown) {
    /* A broken deployment, not a bad upload — so it is logged at error level and
       the caller still gets a 400 it can render. The alternative used to be this
       throw escaping at import time and stopping the whole API. */
    logger.error(
      '[resume] PDF parser unavailable — resume uploads cannot be read on this host. ' +
        'The @napi-rs/canvas native binding is most likely missing for this platform.',
      error,
    );
    return {
      ok: false,
      reason:
        'Resume reading is temporarily unavailable. Please fill in your profile manually for now.',
    };
  }

  const parser = new Parser({ data: new Uint8Array(data) });

  try {
    const result = await parser.getText();
    const text = tidy(result.text ?? '');

    if (text.length < MIN_USABLE_CHARS) {
      return {
        ok: false,
        reason:
          'No readable text found in that PDF. Scanned or image-only resumes cannot be parsed — please upload a text-based PDF.',
      };
    }

    return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
  } catch (error: unknown) {
    // The provider's message names internal structures; log it, do not ship it.
    logger.warn(
      `[resume] PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ok: false,
      reason: 'That PDF could not be read. It may be corrupted or password-protected.',
    };
  } finally {
    await parser.destroy().catch(() => {
      // Cleanup only — a failure here must not mask the extraction result.
    });
  }
}
