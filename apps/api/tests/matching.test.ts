import { describe, expect, it } from 'vitest';

import {
  containsTerm,
  MATCH_WEIGHTS,
  normalizeJobType,
  normalizeText,
  parseRequiredExperience,
  scoreJob,
  type MatchableJob,
} from '../src/recommendations/matching.js';
import { extractSkills, normalizeSkillList } from '../src/recommendations/skill-dictionary.js';

/** The candidate from the spec: a Java backend intern in Bengaluru. */
const CANDIDATE = {
  skills: ['Java', 'Spring Boot', 'MongoDB'],
  preferredRoles: ['Backend Developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0,
};

const BACKEND_INTERNSHIP: MatchableJob = {
  role: 'Backend Developer Intern',
  company: 'Acme Fintech',
  location: 'Bengaluru',
  employmentType: 'internship',
  cleanedText:
    'We are hiring a Backend Developer Intern in Bengaluru. You will work with Java and Spring Boot, ' +
    'building REST APIs on MongoDB. Freshers welcome.',
  originalText: 'raw post',
};

const IOS_JOB: MatchableJob = {
  role: 'iOS Developer',
  company: 'Cupertino Apps',
  location: 'New York',
  employmentType: 'full-time',
  cleanedText:
    'iOS Developer needed in New York. Strong Swift and Objective-C experience required, 3+ years.',
  originalText: 'raw post',
};

describe('normalizeText', () => {
  it('lowercases and collapses separators', () => {
    expect(normalizeText('  Spring   Boot / MongoDB  ')).toBe('spring boot mongodb');
    expect(normalizeText('Node.js')).toBe('node js');
  });

  it('keeps the characters that distinguish C++ and C#', () => {
    expect(normalizeText('C++')).toBe('c++');
    expect(normalizeText('C#')).toBe('c#');
  });
});

describe('containsTerm', () => {
  it('matches whole terms only', () => {
    expect(containsTerm('we use Java here', 'java')).toBe(true);
    expect(containsTerm('we use JavaScript here', 'java')).toBe(false);
    expect(containsTerm('CSS and HTML', 'c')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(containsTerm('JAVA developer', 'Java')).toBe(true);
  });
});

describe('extractSkills', () => {
  it('finds skills in job text regardless of spelling', () => {
    const found = extractSkills('Looking for node.js, NodeJS is fine, plus Next.js and TypeScript');

    expect(found).toContain('Node.js');
    expect(found).toContain('Next.js');
    expect(found).toContain('TypeScript');
  });

  it('does not report Java for a JavaScript post', () => {
    expect(extractSkills('JavaScript developer wanted')).not.toContain('Java');
  });

  it('prefers the longer skill when one contains another', () => {
    const found = extractSkills('Spring Boot microservices');

    expect(found).toContain('Spring Boot');
    expect(found).not.toContain('Spring');
  });

  it('finds nothing in a post with no technologies', () => {
    expect(extractSkills('Immediate joiner required, good communication skills')).toEqual([]);
  });
});

describe('normalizeSkillList', () => {
  it('canonicalizes spellings and drops duplicates', () => {
    expect(normalizeSkillList(['nodejs', 'Node.js', 'NODE JS'])).toEqual(['Node.js']);
  });

  it('keeps unrecognised skills as typed rather than losing them', () => {
    expect(normalizeSkillList(['Bhashini API'])).toEqual(['Bhashini API']);
  });
});

describe('normalizeJobType', () => {
  it('maps spellings onto canonical types', () => {
    expect(normalizeJobType('Intern')).toBe('internship');
    expect(normalizeJobType('Full Time')).toBe('full-time');
    expect(normalizeJobType('6 month internship')).toBe('internship');
  });

  it('returns null for something that is not a job type', () => {
    expect(normalizeJobType('Bengaluru')).toBeNull();
  });
});

describe('parseRequiredExperience', () => {
  it('reads the lower bound of a range', () => {
    expect(parseRequiredExperience('2-4 years of experience')).toBe(2);
    expect(parseRequiredExperience('3+ years required')).toBe(3);
  });

  it('treats fresher as zero', () => {
    expect(parseRequiredExperience('Freshers welcome')).toBe(0);
  });

  it('returns null when the post does not say', () => {
    expect(parseRequiredExperience('Backend developer in Bengaluru')).toBeNull();
  });
});

describe('scoreJob', () => {
  it('scores the spec example: 2 of 3 skills present', () => {
    // Candidate: Java, Spring Boot, MongoDB. Job: Java, Spring Boot, PostgreSQL.
    const result = scoreJob(
      { ...CANDIDATE, preferredRoles: [], preferredLocations: [], preferredJobTypes: [] },
      {
        role: null,
        location: null,
        employmentType: null,
        cleanedText: 'Required: Java, Spring Boot, PostgreSQL',
        originalText: 'Required: Java, Spring Boot, PostgreSQL',
      },
    );

    expect(result.matchedSkills.sort()).toEqual(['Java', 'Spring Boot']);
    expect(result.gaps).toEqual(['PostgreSQL']);
    expect(result.matchScore).toBe(67);
  });

  it('TEST 3: a matching Java backend internship in Bengaluru scores high', () => {
    const result = scoreJob(CANDIDATE, BACKEND_INTERNSHIP);

    expect(result.matchScore).toBeGreaterThanOrEqual(80);
    expect(result.matchedSkills).toContain('Java');
    expect(result.matchedSkills).toContain('Spring Boot');
    expect(result.matchedSkills).toContain('MongoDB');
  });

  it('TEST 3: explanations name every dimension that matched', () => {
    const result = scoreJob(CANDIDATE, BACKEND_INTERNSHIP);
    const joined = result.reasons.join('\n');

    expect(joined).toContain('your skills');
    expect(joined).toContain('Backend Developer matches your preferred role');
    expect(joined).toContain('Bengaluru matches your preferred location');
    expect(joined).toContain('Internship matches your preferred job type');
  });

  it('TEST 4: an iOS role in New York scores low for a Java candidate', () => {
    const result = scoreJob(CANDIDATE, IOS_JOB);

    expect(result.matchScore).toBeLessThan(50);
    expect(result.matchedSkills).toEqual([]);
  });

  it('TEST 5: changing the location preference changes the score', () => {
    const bengaluru = scoreJob(CANDIDATE, BACKEND_INTERNSHIP).matchScore;
    const remote = scoreJob(
      { ...CANDIDATE, preferredLocations: ['Remote'] },
      BACKEND_INTERNSHIP,
    ).matchScore;

    expect(remote).toBeLessThan(bengaluru);
  });

  it('treats work from home as remote', () => {
    const result = scoreJob(
      { ...CANDIDATE, preferredLocations: ['Remote'] },
      { ...BACKEND_INTERNSHIP, location: 'Work From Home' },
    );

    expect(result.reasons.join()).toContain('matches your preferred location');
  });

  it('treats Bangalore and Bengaluru as one city', () => {
    const result = scoreJob(CANDIDATE, { ...BACKEND_INTERNSHIP, location: 'Bangalore' });

    expect(result.reasons.join()).toContain('matches your preferred location');
  });

  it('does not match Backend Developer against iOS Developer on "Developer" alone', () => {
    const result = scoreJob(
      { skills: [], preferredRoles: ['Backend Developer'], preferredLocations: [], preferredJobTypes: [], experienceYears: null },
      IOS_JOB,
    );

    expect(result.matchScore).toBe(0);
  });

  it('scores an empty profile at zero so nothing can be recommended', () => {
    const result = scoreJob(
      { skills: [], preferredRoles: [], preferredLocations: [], preferredJobTypes: [], experienceYears: null },
      BACKEND_INTERNSHIP,
    );

    expect(result.matchScore).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('redistributes weight rather than penalising a job for fields it lacks', () => {
    // Skills-only comparison: all skills present should reach 100, not 50.
    const result = scoreJob(
      { ...CANDIDATE, preferredRoles: [], preferredLocations: [], preferredJobTypes: [], experienceYears: null },
      {
        role: null,
        location: null,
        employmentType: null,
        cleanedText: 'Java, Spring Boot and MongoDB',
        originalText: 'Java, Spring Boot and MongoDB',
      },
    );

    expect(result.matchScore).toBe(100);
  });

  it('reads cleanedText in preference to the raw post', () => {
    const result = scoreJob(CANDIDATE, {
      role: null,
      location: null,
      employmentType: null,
      cleanedText: 'Java role',
      originalText: 'Join our channel! Swift iOS developer',
    });

    expect(result.matchedSkills).toEqual(['Java']);
  });

  it('falls back to originalText when cleanedText is absent', () => {
    const result = scoreJob(CANDIDATE, {
      role: null,
      location: null,
      employmentType: null,
      cleanedText: null,
      originalText: 'Java and Spring Boot role',
    });

    expect(result.matchedSkills).toContain('Java');
  });

  it('caps gaps so an explanation stays readable', () => {
    const result = scoreJob(CANDIDATE, {
      role: null,
      location: null,
      employmentType: null,
      cleanedText: 'Java, Docker, Kubernetes, AWS, Terraform, Redis, Kafka, GraphQL',
      originalText: '',
    });

    expect(result.gaps.length).toBeLessThanOrEqual(5);
  });

  it('keeps the weights summing to 100 so they read as percentages', () => {
    const total = Object.values(MATCH_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBe(100);
  });
});
