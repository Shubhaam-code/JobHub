/**
 * Pushing a job that changed to every connected client.
 *
 * Two callers need this and neither has a `PublicJob` in hand: the GitHub sync
 * writes with `updateOne` and the apply-discovery worker does the same, so both
 * hold an id and nothing else. Rather than each re-reading and re-formatting the
 * document its own way, they share this — which is also what guarantees the
 * broadcast payload goes through the same `formatJob` redaction as an HTTP
 * response, including the guard that drops an aggregator URL from `applyUrl`.
 *
 * Never throws. A live update is a nicety: the client sees the change on its next
 * fetch regardless, so a failure here must not fail the write that triggered it.
 */

import { logger } from './logger.js';
import { broadcastUpdatedJob, getSocketServer, type JobFeed } from './socket.js';
import { GITHUB_SOURCE } from '../github/sync.js';
import { JobModel } from '../models/job.model.js';
import { formatJob, type MongoJobDoc } from '../routes/jobs.route.js';

/**
 * Which feed a stored job belongs to, from its own `source`.
 *
 * Derived rather than passed in: the apply-discovery worker updates jobs from both
 * feeds through this one function and holds only an id, so asking the document is
 * the only way the event can land on the right channel. It also means the rule
 * lives next to the `$nin` that enforces it in the route — one definition of "this
 * source has its own page", not two that can drift.
 */
function feedForSource(source: string | null | undefined): JobFeed {
  return source === GITHUB_SOURCE ? 'global-internships' : 'jobs';
}

/**
 * Reads one job and emits its feed's update event.
 *
 * Returns whether the event went out, which the callers log but do not act on.
 * Skipped without a database read when no Socket.IO server exists — the sync and
 * the backfill both also run as standalone CLIs, where there is nobody to notify.
 */
export async function broadcastJobUpdateById(id: unknown): Promise<boolean> {
  if (getSocketServer() === null) return false;

  try {
    const doc = await JobModel.findById(id).lean<MongoJobDoc | null>();
    if (doc === null) return false;

    broadcastUpdatedJob(formatJob(doc), feedForSource(doc.source));
    return true;
  } catch (error: unknown) {
    logger.debug(
      `[job-broadcast] live update skipped -> ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
