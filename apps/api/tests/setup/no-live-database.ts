/**
 * Makes it impossible for the test suite to reach the configured MongoDB.
 *
 * This is not a style rule. `tests/telegram-jobs-visibility.test.ts` used to call
 * `connectDatabase()` — which reads `MONGODB_URI`, and in this repo that is the
 * production cluster — and then `JobModel.deleteMany({})` in `beforeEach`. Every
 * `npm test` emptied the live `jobs` collection. The GitHub source re-syncs from a
 * README so those rows came back; the Telegram history is never re-read, so those
 * postings were gone for good.
 *
 * Rewriting that file fixes today's suite. This makes tomorrow's safe too:
 * `mongoose.connect` throws here, so a test that reaches for the shared connection
 * fails loudly on its first line instead of quietly operating on real data. Route
 * tests mock at the model boundary (see `tests/helpers/mongo-filter.ts`), which
 * needs no connection at all.
 *
 * Only `mongoose.connect` is blocked — the global singleton that every model in
 * `src/models` binds to, and the only one `MONGODB_URI` feeds. A test that
 * genuinely needs a database can still stand up an ephemeral instance
 * (`mongodb-memory-server`) and open it with `mongoose.createConnection`, which
 * takes its URI explicitly and cannot inherit the deployed one by accident.
 */

import mongoose from 'mongoose';
import { beforeAll } from 'vitest';

const REFUSAL = [
  'A test tried to open the shared MongoDB connection (mongoose.connect).',
  '',
  'Tests must not connect to MONGODB_URI: it points at the deployed cluster, and a',
  'suite that can connect is a suite that can delete production data — which has',
  'already happened in this repo.',
  '',
  'Mock at the model boundary instead — vi.spyOn(JobModel, ...) with',
  'tests/helpers/mongo-filter.ts — or start an ephemeral instance and open it with',
  'mongoose.createConnection, passing that instance’s URI explicitly.',
].join('\n');

beforeAll(() => {
  /* Assigned rather than spied: `vi.spyOn` is undone by `restoreMocks`, which this
     suite has enabled globally, and a guard that switches itself off between files
     is no guard. */
  mongoose.connect = (): never => {
    throw new Error(REFUSAL);
  };
});
