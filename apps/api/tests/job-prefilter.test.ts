import { describe, expect, it } from 'vitest';

import { prefilterMessage } from '../src/telegram/job-prefilter.js';

describe('prefilterMessage — lets genuine posts through', () => {
  const jobPosts = [
    'Amazon is hiring Software Engineering Intern for 2027 batch',
    'Google Off Campus Drive 2027',
    'Zoho | Software Developer | Chennai | Apply now',
    'Accenture Off Campus Drive for freshers',
    'WALK-IN INTERVIEW TOMORROW',
    'New opening: Data Analyst, Remote, 4.5 LPA',
    'Registration link below, last date 5 Sep',
    'SDE-1 vacancy at Flipkart',
    'Batch: 2025, 2026 | Stipend: 25k/month',
    'Deloitte Careers — Analyst profile',
  ];

  for (const post of jobPosts) {
    it(`sends: ${post.slice(0, 42)}`, () => {
      expect(prefilterMessage(post).send).toBe(true);
    });
  }

  it('sends a job post even when it carries promotional lines', () => {
    const text = [
      'Join our Telegram channel @somechannel for more updates!',
      'Amazon is hiring SDE Interns — apply now',
      'Share with friends 🔥',
    ].join('\n');

    expect(prefilterMessage(text).send).toBe(true);
  });
});

describe('prefilterMessage — skips obvious noise', () => {
  it('skips empty text', () => {
    expect(prefilterMessage('')).toEqual({ send: false, reason: 'no text' });
    expect(prefilterMessage('   \n  ')).toEqual({ send: false, reason: 'no text' });
  });

  it('skips very short text with no job signal', () => {
    expect(prefilterMessage('👍').send).toBe(false);
    expect(prefilterMessage('Hi').send).toBe(false);
  });

  it('skips pure channel promotion and greetings', () => {
    const noise = [
      'Join our channel for daily updates 🚀',
      'DM me for collab and promotion enquiries',
      'Good morning everyone, have a great day ahead!',
      'Subscribe to https://t.me/somechannel now',
      'Follow us on WhatsApp for instant alerts',
    ];

    for (const text of noise) {
      const result = prefilterMessage(text);
      expect(result.send, text).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});
