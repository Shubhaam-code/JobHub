import { describe, expect, it } from 'vitest';

import { extractApplyUrl, normalizeMessage } from '../src/telegram/normalize.js';

/** A realistic post: job data, one real apply link, three promotion lines. */
const AMAZON_POST = [
  '🔥 Amazon Off Campus Drive 2027',
  'Role: SDE Intern',
  'Location: Bengaluru',
  '',
  'Apply Link: https://amazon.jobs/en/jobs/2894732/sde-intern?src=tg',
  '',
  '✅ Join Our Official WhatsApp Channel - https://chat.whatsapp.com/K9xQ2mLpZ',
  'Join Our WhatsApp Channel 👉 https://whatsapp.com/channel/0029Va',
  '@jobsvillaa',
].join('\n');

describe('normalizeMessage — promotion is removed from what users read', () => {
  const result = normalizeMessage(AMAZON_POST);

  it('keeps the job content', () => {
    expect(result.cleanedText).toContain('Amazon Off Campus Drive 2027');
    expect(result.cleanedText).toContain('Role: SDE Intern');
    expect(result.cleanedText).toContain('Location: Bengaluru');
  });

  it('leaves no WhatsApp or Telegram promotion behind', () => {
    expect(result.cleanedText.toLowerCase()).not.toContain('whatsapp');
    expect(result.cleanedText.toLowerCase()).not.toContain('join our');
    expect(result.cleanedText).not.toContain('@jobsvillaa');
  });

  it('records the stripped promotional links for auditing', () => {
    expect(result.removedUrls).toContain('https://chat.whatsapp.com/K9xQ2mLpZ');
    expect(result.removedUrls).toContain('https://whatsapp.com/channel/0029Va');
    expect(result.removedLines).toBeGreaterThan(0);
  });

  it('invents nothing: every word of the cleaned text came from the post', () => {
    for (const token of result.cleanedText.split(/\s+/).filter(Boolean)) {
      expect(AMAZON_POST).toContain(token);
    }
  });

  it('never throws on empty or blank input', () => {
    expect(normalizeMessage('')).toEqual({
      cleanedText: '',
      applyUrl: null,
      removedUrls: [],
      removedLines: 0,
    });
    expect(normalizeMessage('   \n\n  ').cleanedText).toBe('');
  });

  it('drops decorative divider lines', () => {
    const normalized = normalizeMessage(['Infosys is hiring', '-----', 'Batch: 2026'].join('\n'));
    expect(normalized.cleanedText).toBe('Infosys is hiring\nBatch: 2026');
    expect(normalized.removedLines).toBe(1);
  });

  it('drops a subscribe line whose only link is a social page', () => {
    const normalized = normalizeMessage('Subscribe to our YouTube channel https://youtube.com/@jobs');
    expect(normalized.cleanedText).toBe('');
    expect(normalized.applyUrl).toBeNull();
    expect(normalized.removedUrls).toEqual(['https://youtube.com/@jobs']);
  });
});

describe('normalizeMessage — the apply URL survives, byte for byte', () => {
  it('extracts the application link exactly as published, query string included', () => {
    const result = normalizeMessage(AMAZON_POST);
    expect(result.applyUrl).toBe('https://amazon.jobs/en/jobs/2894732/sde-intern?src=tg');
    // The invariant the whole pipeline rests on: the stored URL is a substring of
    // the raw post, so nothing rewrote, shortened or reconstructed it.
    expect(AMAZON_POST).toContain(result.applyUrl!);
  });

  it('sanitizes a promo line rather than dropping it when it carries a real link', () => {
    const result = normalizeMessage('Join our WhatsApp channel for updates 👉 https://forms.gle/AbCdEf123');
    expect(result.applyUrl).toBe('https://forms.gle/AbCdEf123');
    expect(result.cleanedText).toContain('https://forms.gle/AbCdEf123');
    expect(result.cleanedText.toLowerCase()).not.toContain('whatsapp');
  });

  it('accepts a lone unlabelled link — losing a real apply URL is the worse failure', () => {
    const result = normalizeMessage(
      ['Amazon is hiring SDE interns for the 2027 batch', 'https://amazon.jobs/en/jobs/123'].join('\n'),
    );
    expect(result.applyUrl).toBe('https://amazon.jobs/en/jobs/123');
  });

  it('returns null when the post only links to chat channels', () => {
    const result = normalizeMessage(
      ['Join our channel https://t.me/jobsvillaa', 'DM me for collab'].join('\n'),
    );
    expect(result.applyUrl).toBeNull();
  });

  it('never returns a Telegram or WhatsApp link as the apply URL', () => {
    const posts = [
      'Apply here: https://t.me/jobsvillaa/4821',
      'Apply link 👉 https://chat.whatsapp.com/K9xQ2mLpZ',
      'Registration: https://wa.me/919876543210',
    ];
    for (const post of posts) {
      expect(normalizeMessage(post).applyUrl).toBeNull();
    }
  });
});

describe('extractApplyUrl', () => {
  it('prefers the labelled application link over another link in the post', () => {
    const post = [
      'Company: Acme Corp',
      'Website: https://acme.example.com/about',
      'Apply here: https://boards.greenhouse.io/acme/jobs/998877',
    ].join('\n');

    expect(extractApplyUrl(post)).toBe('https://boards.greenhouse.io/acme/jobs/998877');
  });

  it('reads a label sitting on the line above a bare URL', () => {
    const post = ['Acme Corp — Analyst', 'Registration link', 'https://forms.gle/XyZ987'].join('\n');
    expect(extractApplyUrl(post)).toBe('https://forms.gle/XyZ987');
  });

  it('trims trailing sentence punctuation so the href resolves', () => {
    expect(extractApplyUrl('Apply at https://careers.acme.com/openings.')).toBe(
      'https://careers.acme.com/openings',
    );
  });

  it('is stable: the same post always yields the same URL', () => {
    // Two equally-unlabelled links score the same, so the tie-break decides —
    // and it has to be deterministic, or a re-run could change a stored URL.
    const post = ['https://careers.one.example.com/a', 'https://careers.two.example.com/b'].join(
      '\n',
    );
    expect(extractApplyUrl(post)).toBe(extractApplyUrl(post));
    // Tie on score → the earlier link wins.
    expect(extractApplyUrl(post)).toBe('https://careers.one.example.com/a');
  });

  it('returns null for a post with no links at all', () => {
    expect(extractApplyUrl('Walk-in interview tomorrow at 10am, bring your resume')).toBeNull();
  });

  /**
   * Regression, from three stored jobs that ended up with the channel's Linktree
   * as their apply link.
   *
   * The digest shape is what makes it dangerous: the post's own article comes
   * first, a list of other articles follows, and the last line is a link-in-bio
   * page under an "Apply" label. A link wrapper hides its destination, so it can
   * only be rejected by host — otherwise the strongest label on the page belongs
   * to the one link that leads nowhere near a job.
   */
  it('never picks the channel link-in-bio page over the post’s own article', () => {
    const post = [
      'Yash Technologies Hiring Executive',
      'Apply link 👉 https://job4freshers.co.in/yash-technologies-executive/',
      '',
      'Subscribe: https://youtu.be/t80blkwVsv0',
      'Apply link for all jobs 👉 https://linktr.ee/job4freshers.co_in',
    ].join('\n');

    expect(extractApplyUrl(post)).toBe('https://job4freshers.co.in/yash-technologies-executive/');
  });

  it('picks an article over the link-in-bio page even when only the wrapper is labelled', () => {
    const post = [
      'AGS Health Walk-In for AR Caller',
      'https://job4freshers.co.in/ags-health-walk-in-drive/',
      'Apply link for all jobs 👉 https://linktr.ee/job4freshers.co_in',
    ].join('\n');

    expect(extractApplyUrl(post)).toBe('https://job4freshers.co.in/ags-health-walk-in-drive/');
  });

  it('returns null when every link in the post is promotion', () => {
    const post = [
      'If you are Placement/Internship Coordinator at your college, connect with me',
      'https://www.linkedin.com/in/krishan-kumar08',
    ].join('\n');

    expect(extractApplyUrl(post)).toBeNull();
  });
});
