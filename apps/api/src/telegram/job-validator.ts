/**
 * Deterministic validation of a classified job before persistence.
 *
 * The LLM is not the final authority: this is the gate every classified post
 * must pass, and it re-checks the safety rules independently of the model.
 *
 * Pure function — no I/O, no side effects.
 */

import type { ClassifiedJob } from './job-classifier.js';
import { isChatUrl, isSafeUrl } from './text-safety.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a classified job post.
 *
 * Rules:
 *  - isJob must be true.
 *  - company OR role must be present (enough to identify the opportunity).
 *  - Missing batch / applyUrl / location / employmentType do not disqualify.
 *  - applyUrl, when present, must be http(s) and must not be a Telegram or
 *    WhatsApp link.
 */
export function validateClassifiedJob(job: ClassifiedJob): ValidationResult {
  if (!job.isJob) {
    return { valid: false, reason: 'not a job' };
  }

  if (job.company === null && job.role === null) {
    return { valid: false, reason: 'neither company nor role could be extracted' };
  }

  if (job.applyUrl !== null) {
    if (!isSafeUrl(job.applyUrl)) {
      return { valid: false, reason: `unsafe applyUrl: ${job.applyUrl}` };
    }

    if (isChatUrl(job.applyUrl)) {
      return { valid: false, reason: 'applyUrl is a Telegram/WhatsApp link' };
    }
  }

  return { valid: true };
}
