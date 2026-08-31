import { describe, expect, it } from 'vitest';

import { extractPdfText } from '../src/resume/pdf-text.js';
import { makePdf, SAMPLE_RESUME_LINES } from './helpers/make-pdf.js';

describe('extractPdfText', () => {
  it('reads the text back out of a real PDF', async () => {
    const result = await extractPdfText(makePdf(SAMPLE_RESUME_LINES));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain('Spring Boot');
    expect(result.text).toContain('Bengaluru');
    expect(result.text).toContain('2026');
  });

  it('rejects a file that is not a PDF without throwing', async () => {
    const result = await extractPdfText(Buffer.from('PK a zip file', 'latin1'));

    expect(result).toEqual({
      ok: false,
      reason: 'That file is not a PDF. Please upload your resume as a PDF.',
    });
  });

  it('rejects an empty upload', async () => {
    const result = await extractPdfText(Buffer.alloc(0));

    expect(result).toEqual({ ok: false, reason: 'The uploaded file is empty.' });
  });

  it('reports a readable error for a corrupt PDF rather than crashing', async () => {
    const result = await extractPdfText(makePdf([], { corrupt: true }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either branch is a useful message; what matters is that it did not throw.
    expect(result.reason).toMatch(/could not be read|No readable text/);
  });

  it('treats a text-free PDF as unparseable instead of returning an empty profile', async () => {
    const result = await extractPdfText(makePdf(['hi']));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('No readable text found');
  });
});
