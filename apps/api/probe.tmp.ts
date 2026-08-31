import { makePdf, SAMPLE_RESUME_LINES } from './tests/helpers/make-pdf.js';
import { extractPdfText } from './src/resume/pdf-text.js';
import { parseResume } from './src/resume/resume-parser.js';

const pdf = makePdf(SAMPLE_RESUME_LINES);
let t0 = Date.now();
const extracted = await extractPdfText(pdf);
console.log(`extractPdfText: ${Date.now() - t0}ms ->`, JSON.stringify(extracted).slice(0, 200));

const text: string = typeof extracted === 'string' ? extracted : (extracted as any).text;
t0 = Date.now();
try {
  const parsed = await parseResume(text);
  console.log(`parseResume: ${Date.now() - t0}ms`);
  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  console.log(`parseResume threw after ${Date.now() - t0}ms:`, (error as Error).message);
}
process.exit(0);
