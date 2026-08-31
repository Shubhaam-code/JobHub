/**
 * PDF → plain text.
 *
 * Never throws: a corrupt file, an encrypted file or a scanned page all come
 * back as `{ ok: false, reason }` with a message worth showing a user, so an
 * unreadable upload is a 400 rather than a crashed request.
 */

import { PDFParse } from 'pdf-parse';

import { logger } from '../lib/logger.js';

export type PdfTextResult = { ok: true; text: string } | { ok: false; reason: string };

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

  const parser = new PDFParse({ data: new Uint8Array(data) });

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
