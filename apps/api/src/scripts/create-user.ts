/**
 * Creates or updates an account.
 *
 *   npm run user:create --workspace @jia/api -- --email admin@local --password secret --role ADMIN
 *   npm run user:create --workspace @jia/api -- --email user@local  --password secret
 *
 * Flags:
 *   --email     required
 *   --password  required, at least 8 characters
 *   --role      USER (default) or ADMIN
 *
 * There is no signup endpoint — accounts exist only to gate `/admin`, so this
 * script and the ADMIN_EMAIL/ADMIN_PASSWORD seed are the only ways to make one.
 * Re-running for an existing email resets that account's password and role,
 * which is also how a forgotten admin password is recovered.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { USER_ROLES, UserModel, type UserRole } from '../models/user.model.js';

/** Reads `--flag value` or `--flag=value`. */
function readFlag(name: string): string | undefined {
  const flag = `--${name}`;

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === undefined) continue;

    if (arg === flag) return process.argv[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }

  return undefined;
}

const USAGE =
  'Usage: npm run user:create --workspace @jia/api -- ' +
  '--email <email> --password <password> [--role USER|ADMIN]';

async function main(): Promise<void> {
  const email = readFlag('email')?.trim().toLowerCase();
  const password = readFlag('password');
  const role = (readFlag('role') ?? 'USER').trim().toUpperCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`--email is required and must be a valid email address.\n${USAGE}`);
  }

  if (!password || password.length < 8) {
    throw new Error(`--password is required and must be at least 8 characters.\n${USAGE}`);
  }

  if (!(USER_ROLES as readonly string[]).includes(role)) {
    throw new Error(`--role must be one of: ${USER_ROLES.join(', ')}.\n${USAGE}`);
  }

  logger.info(`[user:create] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — an account cannot be created without it.');
  }

  const existing = await UserModel.findOne({ email }).lean<{ _id: unknown } | null>();

  await UserModel.updateOne(
    { email },
    { $set: { email, passwordHash: await hashPassword(password), role: role as UserRole } },
    { upsert: true },
  ).exec();

  console.log('');
  console.log(`${existing ? 'Updated' : 'Created'} account:`);
  console.log(`  email: ${email}`);
  console.log(`  role:  ${role}`);
  console.log('');
  console.log(
    `Sign in at http://localhost:${env.PORT}/api/auth/login, or at /admin in the web app.`,
  );

  await disconnectDatabase();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[user:create] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
