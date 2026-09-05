import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { syncGithubJobs } from '../github/sync.js';

async function main(): Promise<void> {
  logger.info(`[github-sync] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);
  if (!(await connectDatabase())) throw new Error('MongoDB connection failed.');

  try {
    await syncGithubJobs();
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  logger.error(`[github-sync] Fatal error -> ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
