/**
 * Builds a real, minimal PDF in memory so resume tests do not need a binary
 * fixture checked into the repo.
 *
 * It is a hand-assembled PDF 1.4 with one Helvetica text object — enough for a
 * text extractor to read back every line it was given, which is all the resume
 * tests assert. Offsets in the xref table are computed from the actual byte
 * positions, so the file is structurally valid rather than merely parseable by a
 * lenient reader.
 */

/** Escapes the three characters that terminate or nest inside a PDF string. */
function escapePdfText(line: string): string {
  return line.replace(/([\\()])/g, '\\$1');
}

/**
 * Returns a valid single-page PDF whose text content is `lines`.
 *
 * Pass `corrupt: true` to get a file with an intact `%PDF-` header and garbage
 * body — the case that must surface a readable error instead of a crash.
 */
export function makePdf(lines: string[], options: { corrupt?: boolean } = {}): Buffer {
  if (options.corrupt === true) {
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('this is not a pdf body at all\n'.repeat(8), 'latin1'),
    ]);
  }

  const textOps = lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join('\n');
  const content = `BT\n/F1 12 Tf\n50 750 Td\n14 TL\n${textOps}\nET\n`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = header.length + body.length;
  const xrefRows = offsets
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('');

  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefRows}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + body + xref, 'latin1');
}

/** The resume used by the recommendation tests: a Java backend intern profile. */
export const SAMPLE_RESUME_LINES = [
  'Aarav Sharma',
  'aarav.sharma@example.com | Bengaluru, India',
  '',
  'EDUCATION',
  'B.Tech in Computer Science, RV College of Engineering',
  'Expected graduation: 2026',
  '',
  'SKILLS',
  'Java, Spring Boot, MongoDB, REST APIs, Git, SQL',
  '',
  'EXPERIENCE',
  'Backend Developer Intern, Fintech Startup (6 months)',
  'Built Spring Boot microservices backed by MongoDB.',
  'Wrote REST APIs consumed by the mobile client.',
  '',
  'OBJECTIVE',
  'Seeking a backend developer internship in Bengaluru.',
];
