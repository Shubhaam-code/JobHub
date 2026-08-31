/**
 * Temporary verification seed — removed after the run.
 *
 * Gemini's free-tier daily quota is exhausted, so `POST /profile/resume` cannot
 * run the LLM step today. The recommendation route scores the *stored* profile,
 * so seeding the exact fields the parser writes exercises the identical
 * post-parse path: requireProfile -> scoreJob -> min-score cutoff -> sort.
 */
import mongoose from 'mongoose';

import { env } from './src/config/env.js';
import { createProfileToken, hashProfileToken } from './src/lib/profile-token.js';
import { CandidateProfileModel } from './src/models/candidate-profile.model.js';
import { normalizeSkillList } from './src/recommendations/skill-dictionary.js';

await mongoose.connect(env.MONGODB_URI);

/* Field-for-field what the parser would extract from the Aarav Sharma resume
   in tests/helpers/make-pdf.ts. */
const A = {
  skills: normalizeSkillList(['Java', 'Spring Boot', 'MongoDB', 'REST APIs', 'Git', 'SQL']),
  preferredRoles: ['backend developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0.5,
  graduationYear: '2026',
};

/* A resume from a field this job board does not cover at all. */
const B = {
  skills: normalizeSkillList([
    'Coral reef surveying',
    'Plankton identification',
    'Scuba diving',
    'Wet lab microscopy',
  ]),
  preferredRoles: ['marine ecology field researcher'],
  preferredLocations: ['Kochi'],
  preferredJobTypes: [],
  experienceYears: 0.3,
  graduationYear: '2027',
};

const out: Record<string, string> = {};
for (const [label, fields] of [['A', A], ['B', B]] as const) {
  const token = createProfileToken();
  await CandidateProfileModel.create({
    ...fields,
    tokenHash: hashProfileToken(token),
    resumeFileName: `verify-${label}.pdf`,
    resumeParsedAt: new Date(),
    manualFields: [],
  });
  out[label] = token;
  console.log(`profile ${label} skills after normalizeSkillList:`, JSON.stringify(fields.skills));
}

await mongoose.disconnect();
const fs = await import('node:fs');
fs.writeFileSync('verify-token.tmp.txt', JSON.stringify(out), 'utf8');
console.log('tokens written to verify-token.tmp.txt');
process.exit(0);
