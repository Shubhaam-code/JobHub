import { describe, expect, it } from 'vitest';

import {
  isApplyUrlCandidate,
  isChatUrl,
  isGroundedIn,
  isPromotionalValue,
  isSafeUrl,
} from '../src/telegram/text-safety.js';

describe('isSafeUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeUrl('http://example.com/apply')).toBe(true);
    expect(isSafeUrl('https://example.com/apply')).toBe(true);
  });

  it('rejects javascript:, data: and file: schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<h1>hi</h1>')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects garbage that is not a URL', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});

describe('isChatUrl', () => {
  it('flags Telegram channel and message links', () => {
    expect(isChatUrl('https://t.me/jobsvillaa')).toBe(true);
    expect(isChatUrl('https://t.me/jobsvillaa/25587')).toBe(true);
    expect(isChatUrl('https://telegram.me/internfreak')).toBe(true);
    expect(isChatUrl('https://telegram.dog/internfreak')).toBe(true);
    expect(isChatUrl('https://www.t.me/somechannel')).toBe(true);
  });

  it('flags WhatsApp links', () => {
    expect(isChatUrl('https://chat.whatsapp.com/ABC123')).toBe(true);
    expect(isChatUrl('https://wa.me/919999999999')).toBe(true);
  });

  it('does not flag real application hosts', () => {
    expect(isChatUrl('https://careers.google.com/jobs/123')).toBe(false);
    expect(isChatUrl('https://forms.gle/abc')).toBe(false);
  });
});

describe('isApplyUrlCandidate', () => {
  it('accepts only safe, non-chat http(s) URLs', () => {
    expect(isApplyUrlCandidate('https://careers.zohocorp.com/jobs/42')).toBe(true);
    expect(isApplyUrlCandidate('https://t.me/jobsvillaa/25587')).toBe(false);
    expect(isApplyUrlCandidate('javascript:alert(1)')).toBe(false);
  });
});

describe('isPromotionalValue', () => {
  it('flags handles, chat links and ad CTAs', () => {
    expect(isPromotionalValue('@internfreak')).toBe(true);
    expect(isPromotionalValue('t.me/jobsvillaa')).toBe(true);
    expect(isPromotionalValue('Join Now')).toBe(true);
    expect(isPromotionalValue('DM for promotion')).toBe(true);
    expect(isPromotionalValue('collab')).toBe(true);
    expect(isPromotionalValue('Subscribe')).toBe(true);
    expect(isPromotionalValue('WhatsApp')).toBe(true);
  });

  it('does not flag ordinary employer or role names', () => {
    expect(isPromotionalValue('Amazon')).toBe(false);
    expect(isPromotionalValue('Software Engineering Intern')).toBe(false);
  });
});

describe('isGroundedIn', () => {
  it('accepts values present in the post, ignoring case and punctuation', () => {
    const text = '**Amazon** is hiring for *Software  Engineering-Intern*';
    expect(isGroundedIn('Amazon', text)).toBe(true);
    expect(isGroundedIn('Software Engineering Intern', text)).toBe(true);
    expect(isGroundedIn('amazon', text)).toBe(true);
  });

  it('rejects values the post never contained', () => {
    const text = 'Amazon is hiring for Software Engineering Intern';
    expect(isGroundedIn('Microsoft', text)).toBe(false);
    expect(isGroundedIn('Bengaluru', text)).toBe(false);
    expect(isGroundedIn('', text)).toBe(false);
  });
});
