/* Temporary verification harness — deleted after the run. */
import { makePdf, SAMPLE_RESUME_LINES } from './tests/helpers/make-pdf.ts';

const API = 'http://localhost:4000';

/** Every request gets a deadline so a stalled upstream shows up as a failure. */
async function req(label, url, init = {}, ms = 90_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.json();
    console.log(`[${label}] ${res.status} in ${Date.now() - t0}ms`);
    return { res, body };
  } catch (error) {
    console.log(`[${label}] FAILED after ${Date.now() - t0}ms: ${error.name} ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- 1. A resume with skills the job feed actually asks for ---------------- */
console.log('=== resume A (relevant skills) ===');
console.log(SAMPLE_RESUME_LINES.join('\n'));

const up = await req('POST /profile/resume (A)', `${API}/api/v1/profile/resume`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/pdf',
    'X-Resume-Filename': 'verify-resume.pdf',
    Accept: 'application/json',
  },
  body: makePdf(SAMPLE_RESUME_LINES),
});

if (!up.res.ok) {
  console.log(JSON.stringify(up.body, null, 2));
  process.exit(1);
}
console.log('parsed profile:', JSON.stringify(up.body.data, null, 2));
const token = up.body.token;
console.log('token issued:', typeof token === 'string' ? `${token.slice(0, 8)}… (${token.length} chars)` : token);

const rec = await req('GET /jobs/recommended (A)', `${API}/api/v1/jobs/recommended?limit=20`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
});
console.log('meta:', JSON.stringify(rec.body.meta));
console.log('returned:', rec.body.data.length);

const scores = rec.body.data.map((r) => r.matchScore);
console.log('scores in order:', scores.join(', '));
console.log('sorted high→low:', scores.every((s, i) => i === 0 || scores[i - 1] >= s));
console.log('all >= meta.minScore:', scores.every((s) => s >= rec.body.meta.minScore));
console.log('distinct score values:', new Set(scores).size);

console.log('\n=== top matches (score / role / reasons / gaps) ===');
for (const r of rec.body.data.slice(0, 5)) {
  console.log(`\n${r.matchScore}%  ${r.job.role ?? '(no role)'} @ ${r.job.company ?? '(no company)'}`);
  console.log(`   id: ${r.job.id}   location: ${r.job.location ?? '—'}`);
  console.log(`   matchedSkills: [${r.matchedSkills.join(', ')}]`);
  console.log(`   reasons: ${r.reasons.length === 0 ? '(none)' : r.reasons.join(' | ')}`);
  console.log(`   gaps: ${r.gaps.length === 0 ? '(none)' : r.gaps.join(', ')}`);
}

/* ---- 2. A resume whose skills no job asks for → expect zero matches ------- */
const IRRELEVANT_RESUME = [
  'Meera Iyer',
  'meera.iyer@example.com | Kochi, India',
  '',
  'EDUCATION',
  'B.Sc in Marine Biology, Cochin University',
  'Expected graduation: 2027',
  '',
  'SKILLS',
  'Coral reef surveying, Plankton identification, Scuba diving, Wet lab microscopy',
  '',
  'EXPERIENCE',
  'Field Research Assistant, Coastal Ecology Lab (4 months)',
  'Catalogued reef invertebrates and logged salinity readings.',
  '',
  'OBJECTIVE',
  'Seeking a marine ecology field research position in Kochi.',
];

console.log('\n\n=== resume B (no relevant skills) ===');
console.log(IRRELEVANT_RESUME.join('\n'));

const upB = await req('POST /profile/resume (B)', `${API}/api/v1/profile/resume`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/pdf',
    'X-Resume-Filename': 'verify-resume-b.pdf',
    Accept: 'application/json',
  },
  body: makePdf(IRRELEVANT_RESUME),
});
if (!upB.res.ok) {
  console.log(JSON.stringify(upB.body, null, 2));
} else {
  console.log('parsed profile B:', JSON.stringify(upB.body.data, null, 2));
  const recB = await req('GET /jobs/recommended (B)', `${API}/api/v1/jobs/recommended?limit=20`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${upB.body.token}` },
  });
  console.log('meta B:', JSON.stringify(recB.body.meta));
  console.log('returned B:', recB.body.data.length);
  console.log('scores B:', recB.body.data.map((r) => r.matchScore).join(', ') || '(none)');
}

/* Write A's token out so the browser check can install it in localStorage. */
const fs = await import('node:fs');
fs.writeFileSync('verify-token.tmp.txt', token, 'utf8');
console.log('\ntoken A written to apps/api/verify-token.tmp.txt');
