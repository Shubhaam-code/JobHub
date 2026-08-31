import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { JobModel } from './src/models/job.model.js';

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
const total = await JobModel.countDocuments();
const rows = await JobModel.aggregate([
  { $group: { _id: '$telegramChannel', count: { $sum: 1 }, newest: { $max: '$postedAt' }, oldest: { $min: '$postedAt' } } },
  { $sort: { count: -1 } },
]);
console.log('TOTAL', total);
for (const r of rows) console.log(`${r._id}\t${r.count}\t${r.oldest?.toISOString?.()}\t${r.newest?.toISOString?.()}`);
console.log('CONFIGURED', env.telegramChannels.length, env.telegramChannels.join(','));
await mongoose.disconnect();
