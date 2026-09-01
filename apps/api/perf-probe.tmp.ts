/* Temporary diagnostic: measures the /api/v1/jobs query cost. Delete after use. */
import mongoose from 'mongoose';

import { env } from './src/config/env.js';
import { activeJobClauses, JobModel } from './src/models/job.model.js';

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });

const coll = mongoose.connection.db!.collection('jobs');
console.log('indexes:', JSON.stringify(await coll.indexes()));
console.log('estimated docs:', await coll.estimatedDocumentCount());

const filter = { $and: activeJobClauses() };

const t0 = Date.now();
const docs = await JobModel.find(filter).sort({ postedAt: -1, _id: -1 }).limit(12).lean();
const t1 = Date.now();
const total = await JobModel.countDocuments(filter);
const t2 = Date.now();

console.log(`find(12): ${t1 - t0}ms -> ${docs.length} docs`);
console.log(`countDocuments: ${t2 - t1}ms -> total ${total}`);

const explain = (await JobModel.find(filter)
  .sort({ postedAt: -1, _id: -1 })
  .limit(12)
  .explain('executionStats')) as Record<string, any>;
const stats = explain.executionStats ?? explain[0]?.executionStats;
console.log(
  'find explain:',
  JSON.stringify({
    plan: explain.queryPlanner?.winningPlan,
    nReturned: stats?.nReturned,
    totalKeysExamined: stats?.totalKeysExamined,
    totalDocsExamined: stats?.totalDocsExamined,
    executionTimeMillis: stats?.executionTimeMillis,
  }),
);

const countExplain = (await coll
  .find(filter)
  .explain('executionStats')
  .catch(() => null)) as Record<string, any> | null;
if (countExplain) {
  const cs = countExplain.executionStats;
  console.log(
    'unsorted-scan explain:',
    JSON.stringify({
      totalKeysExamined: cs?.totalKeysExamined,
      totalDocsExamined: cs?.totalDocsExamined,
      executionTimeMillis: cs?.executionTimeMillis,
    }),
  );
}

// Average doc size — payload weight matters for the 12-card first paint.
const stats2 = (await mongoose.connection.db!.command({ collStats: 'jobs' })) as Record<
  string,
  any
>;
console.log('avgObjSize bytes:', stats2.avgObjSize, 'size:', stats2.size);

await mongoose.disconnect();
