import { describe, expect, it } from 'vitest';

import { sanitizeParsedResume } from '../src/resume/resume-parser.js';

const RESUME_TEXT = [
  'Aarav Sharma — Bengaluru, India',
  'SKILLS: Java, Spring Boot, MongoDB, REST APIs, Git',
  'EXPERIENCE: Backend Developer Intern, 6 months',
  'EDUCATION: B.Tech, expected graduation 2026',
  'OBJECTIVE: Seeking a backend developer internship in Bengaluru.',
].join('\n');

describe('sanitizeParsedResume', () => {
  it('keeps skills that are actually in the resume', () => {
    const result = sanitizeParsedResume(
      { skills: ['Java', 'Spring Boot', 'MongoDB'] },
      RESUME_TEXT,
    );

    expect(result.skills).toEqual(['Java', 'Spring Boot', 'MongoDB']);
  });

  it('drops a hallucinated skill the resume never mentions', () => {
    const result = sanitizeParsedResume(
      { skills: ['Java', 'Kubernetes', 'Kafka', 'Spring Boot'] },
      RESUME_TEXT,
    );

    expect(result.skills).toEqual(['Java', 'Spring Boot']);
    expect(result.skills).not.toContain('Kubernetes');
    expect(result.skills).not.toContain('Kafka');
  });

  it('canonicalizes skill spellings', () => {
    const result = sanitizeParsedResume({ skills: ['spring boot', 'mongodb'] }, RESUME_TEXT);

    expect(result.skills).toEqual(['Spring Boot', 'MongoDB']);
  });

  it('de-duplicates skills that differ only in spelling', () => {
    const result = sanitizeParsedResume(
      { skills: ['Spring Boot', 'spring boot', 'SPRING BOOT'] },
      RESUME_TEXT,
    );

    expect(result.skills).toEqual(['Spring Boot']);
  });

  it('keeps grounded roles and locations', () => {
    const result = sanitizeParsedResume(
      { preferredRoles: ['Backend Developer'], preferredLocations: ['Bengaluru'] },
      RESUME_TEXT,
    );

    expect(result.preferredRoles).toEqual(['Backend Developer']);
    expect(result.preferredLocations).toEqual(['Bengaluru']);
  });

  it('drops a location the resume does not name', () => {
    const result = sanitizeParsedResume({ preferredLocations: ['Hyderabad'] }, RESUME_TEXT);

    expect(result.preferredLocations).toEqual([]);
  });

  it('accepts job types from the closed set without requiring the word', () => {
    const result = sanitizeParsedResume({ preferredJobTypes: ['internship'] }, RESUME_TEXT);

    expect(result.preferredJobTypes).toEqual(['internship']);
  });

  it('normalizes and rejects job types', () => {
    const result = sanitizeParsedResume(
      { preferredJobTypes: ['Intern', 'Full Time', 'whatever'] },
      RESUME_TEXT,
    );

    expect(result.preferredJobTypes).toEqual(['internship', 'full-time']);
  });

  it('treats -1 experience as unknown rather than negative', () => {
    expect(sanitizeParsedResume({ experienceYears: -1 }, RESUME_TEXT).experienceYears).toBeNull();
  });

  it('keeps a zero-year fresher as 0, not null', () => {
    expect(sanitizeParsedResume({ experienceYears: 0 }, RESUME_TEXT).experienceYears).toBe(0);
  });

  it('rounds experience to the nearest half year', () => {
    expect(sanitizeParsedResume({ experienceYears: 0.4 }, RESUME_TEXT).experienceYears).toBe(0.5);
  });

  it('rejects an implausible experience figure', () => {
    expect(sanitizeParsedResume({ experienceYears: 99 }, RESUME_TEXT).experienceYears).toBeNull();
  });

  it('keeps a graduation year that appears in the resume', () => {
    expect(sanitizeParsedResume({ graduationYear: '2026' }, RESUME_TEXT).graduationYear).toBe('2026');
  });

  it('drops an invented graduation year', () => {
    expect(sanitizeParsedResume({ graduationYear: '2031' }, RESUME_TEXT).graduationYear).toBeNull();
  });

  it('drops a graduation year that is not a year', () => {
    expect(sanitizeParsedResume({ graduationYear: 'next year' }, RESUME_TEXT).graduationYear).toBeNull();
  });

  it('turns stringified absences into nulls and empty lists', () => {
    const result = sanitizeParsedResume(
      {
        skills: ['N/A', 'none'],
        preferredRoles: ['not specified'],
        graduationYear: 'unknown',
      },
      RESUME_TEXT,
    );

    expect(result.skills).toEqual([]);
    expect(result.preferredRoles).toEqual([]);
    expect(result.graduationYear).toBeNull();
  });

  it('returns an empty profile rather than failing when the model returns nothing', () => {
    expect(sanitizeParsedResume(null, RESUME_TEXT)).toEqual({
      skills: [],
      preferredRoles: [],
      preferredLocations: [],
      preferredJobTypes: [],
      experienceYears: null,
      graduationYear: null,
    });
  });

  it('does not fail the whole profile over one bad field', () => {
    const result = sanitizeParsedResume(
      {
        skills: ['Java'],
        preferredRoles: 'not an array',
        preferredLocations: null,
        experienceYears: 'garbage',
        graduationYear: 12,
      },
      RESUME_TEXT,
    );

    // The good field survives; the rest degrade to empty rather than erroring.
    expect(result.skills).toEqual(['Java']);
    expect(result.preferredRoles).toEqual([]);
    expect(result.preferredLocations).toEqual([]);
    expect(result.experienceYears).toBeNull();
    expect(result.graduationYear).toBeNull();
  });

  it('drops an over-long value rather than storing a paragraph', () => {
    const result = sanitizeParsedResume({ skills: ['Java '.repeat(30)] }, RESUME_TEXT);

    expect(result.skills).toEqual([]);
  });
});
