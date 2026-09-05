/**
 * Telegram Jobs Apply URL Verification Migration
 *
 * This script handles existing Telegram jobs that were saved before the
 * applyUrlVerified requirement was enforced for public visibility.
 *
 * What it does:
 * 1. Identifies Telegram jobs without verified apply URLs
 * 2. For jobs with invalid/unverified URLs: sets applyUrl to null
 * 3. Enqueues unverified jobs to the apply-discovery queue for re-discovery
 * 4. Preserves jobs that already have verified URLs
 *
 * Safe to run multiple times - idempotent operations only.
 */

import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { connectDatabase } from '../config/database.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import { enqueueDiscoveryJob } from '../apply-discovery/queue.js';

interface JobToProcess {
  _id: mongoose.Types.ObjectId;
  company: string | null;
  role: string | null;
  location: string | null;
  employmentType: string | null;
  batch: string | null;
  applyUrl: string | null;
  applyUrlVerified: boolean | null;
  applyUrlStatus: string | null;
  sourceUrl: string | null;
  source: string;
  postedAt: Date;
}

async function main() {
  logger.info('Starting Telegram jobs apply URL verification migration...');

  if (!env.APPLY_DISCOVERY_ENABLED) {
    logger.warn('APPLY_DISCOVERY_ENABLED is false - discovery queue will not be used');
  }

  await connectDatabase();

  // Find all Telegram jobs that don't have verified apply URLs
  const telegramJobs = await JobModel.find({
    source: 'telegram',
    $or: [
      { applyUrlVerified: { $ne: true } },
      { applyUrlVerified: null },
      { applyUrlVerified: { $exists: false } },
    ],
  })
    .select({
      _id: 1,
      company: 1,
      role: 1,
      location: 1,
      employmentType: 1,
      batch: 1,
      applyUrl: 1,
      applyUrlVerified: 1,
      applyUrlStatus: 1,
      sourceUrl: 1,
      source: 1,
      postedAt: 1,
    })
    .lean<JobToProcess[]>();

  logger.info(`Found ${telegramJobs.length} Telegram jobs without verified apply URLs`);

  if (telegramJobs.length === 0) {
    logger.info('No jobs to process. Migration complete.');
    await mongoose.disconnect();
    return;
  }

  let cleaned = 0;
  let enqueued = 0;
  let alreadyQueued = 0;
  let failed = 0;

  // Process in batches to avoid overwhelming the discovery queue
  const BATCH_SIZE = 50;
  const BATCH_DELAY_MS = 2000; // 2 seconds between batches

  for (let i = 0; i < telegramJobs.length; i += BATCH_SIZE) {
    const batch = telegramJobs.slice(i, i + BATCH_SIZE);
    logger.info(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(telegramJobs.length / BATCH_SIZE)}`);

    for (const job of batch) {
      const jobRef = `[${job._id.toString()}] ${job.company ?? 'Unknown'} - ${job.role ?? 'Unknown'}`;

      try {
        // Check if this job has an invalid/unverified apply URL that should be cleaned
        const shouldCleanUrl =
          job.applyUrl !== null &&
          job.applyUrlVerified !== true &&
          (job.applyUrlStatus === 'needs_review' ||
            job.applyUrlStatus === 'broken' ||
            job.applyUrlStatus === null);

        if (shouldCleanUrl) {
          // Clear the invalid apply URL
          await JobModel.updateOne(
            { _id: job._id },
            {
              $set: {
                applyUrl: null,
                applyUrlStatus: 'pending',
                applyUrlVerified: false,
              },
            },
          );
          cleaned++;
          logger.debug(`${jobRef} → cleared invalid apply URL`);
        }

        // Enqueue for discovery if enabled
        if (env.APPLY_DISCOVERY_ENABLED) {
          try {
            const result = await enqueueDiscoveryJob({
              jobId: job._id.toString(),
              company: job.company,
              role: job.role,
              location: job.location,
              employmentType: job.employmentType,
              batch: job.batch,
              sourceUrl: job.sourceUrl,
              initialApplyUrl: shouldCleanUrl ? null : job.applyUrl,
              initialCandidates: null,
            });

            if (result.outcome === 'duplicate' || result.outcome === 'updated') {
              alreadyQueued++;
              logger.debug(`${jobRef} → already in discovery queue`);
            } else {
              enqueued++;
              logger.debug(`${jobRef} → enqueued for discovery`);
            }
          } catch (error: unknown) {
            // Duplicate queue entry is fine - job is already being processed
            if (error instanceof Error && error.message.includes('duplicate')) {
              alreadyQueued++;
              logger.debug(`${jobRef} → already in discovery queue`);
            } else {
              throw error;
            }
          }
        }
      } catch (error: unknown) {
        failed++;
        logger.error(
          `${jobRef} → failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Delay between batches to avoid overwhelming external APIs
    if (i + BATCH_SIZE < telegramJobs.length) {
      logger.info(`Waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  logger.info('Migration complete!');
  logger.info(`Summary:
  - Total Telegram jobs processed: ${telegramJobs.length}
  - Invalid URLs cleaned: ${cleaned}
  - Jobs enqueued for discovery: ${enqueued}
  - Jobs already in queue: ${alreadyQueued}
  - Failures: ${failed}
  `);

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  logger.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
