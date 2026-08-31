/**
 * Password hashing and bearer tokens for the admin boundary.
 *
 * Built entirely on `node:crypto` — no new dependency for a feature whose only
 * job is to gate one dashboard. Two rules shape everything here:
 *
 *  - A password is never stored or compared in plaintext. scrypt with a
 *    per-password salt, verified with `timingSafeEqual`.
 *  - A token is never trusted because of what it claims. The role inside a
 *    token is only a hint; `requireAdmin` re-reads the user from the database,
 *    so revoking an admin takes effect immediately rather than at expiry.
 */

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { env } from '../config/env.js';
import { USER_ROLES, UserModel, type UserRole } from '../models/user.model.js';
import { logger } from './logger.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const HASH_SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/* ── Passwords ─────────────────────────────────────────────────────────────── */

/**
 * Hashes a password as `scrypt$<saltHex>$<keyHex>`.
 *
 * The salt travels with the hash, so verification needs nothing but the stored
 * string, and two users with the same password get different digests.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, KEY_BYTES);

  return `${HASH_SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false rather than throwing for anything malformed, so a corrupt or
 * legacy value in the database fails closed instead of erroring the request.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [scheme, saltHex, keyHex] = parts;
  if (scheme !== HASH_SCHEME || !saltHex || !keyHex) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(keyHex)) return false;

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length === 0) return false;

  const derived = await scrypt(plain, Buffer.from(saltHex, 'hex'), expected.length);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ── Tokens ────────────────────────────────────────────────────────────────── */

export interface AuthTokenPayload {
  /** User id. */
  sub: string;
  role: UserRole;
  /** Expiry as a Unix timestamp in seconds. */
  exp: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', env.authSecret).update(encodedPayload).digest('base64url');
}

/**
 * Issues `<base64url(payload)>.<base64url(hmac)>`.
 *
 * The payload is readable by anyone holding the token — that is fine, it carries
 * no secret — but it cannot be edited without the signing key.
 */
export function signAuthToken(
  user: { userId: string; role: UserRole },
  now: Date = new Date(),
): IssuedToken {
  const expSeconds = Math.floor(now.getTime() / 1000) + env.AUTH_TOKEN_TTL_HOURS * 3600;

  const payload: AuthTokenPayload = { sub: user.userId, role: user.role, exp: expSeconds };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return {
    token: `${encoded}.${signPayload(encoded)}`,
    expiresAt: new Date(expSeconds * 1000),
  };
}

/**
 * Verifies signature and expiry, returning the payload or null.
 *
 * Signature is checked before the payload is parsed, so unsigned input never
 * reaches `JSON.parse`, and the comparison is constant-time.
 */
export function verifyAuthToken(token: string, now: Date = new Date()): AuthTokenPayload | null {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const actual = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(signPayload(encoded), 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const { sub, role, exp } = parsed as Record<string, unknown>;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof role !== 'string' || !(USER_ROLES as readonly string[]).includes(role)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;

  if (exp * 1000 <= now.getTime()) return null;

  return { sub, role: role as UserRole, exp };
}

/** Extracts the raw token from an `Authorization: Bearer …` header. */
export function readBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());

  return match?.[1] ?? null;
}

/* ── Bootstrap ─────────────────────────────────────────────────────────────── */

export type SeedResult = 'created' | 'promoted' | 'exists' | 'skipped';

/**
 * Creates the first admin from ADMIN_EMAIL/ADMIN_PASSWORD, if configured.
 *
 * Idempotent and non-destructive: an existing account keeps its password, so
 * leaving these variables in `.env` cannot silently reset a password that was
 * changed later. An existing non-admin account with that email is promoted,
 * which is the documented way to grant the role.
 */
export async function seedAdminUser(): Promise<SeedResult> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;

  if (!email || !password) return 'skipped';

  const existing = await UserModel.findOne({ email }).lean<{
    _id: unknown;
    role: UserRole;
  } | null>();

  if (existing) {
    if (existing.role === 'ADMIN') return 'exists';

    await UserModel.updateOne({ _id: existing._id }, { $set: { role: 'ADMIN' } }).exec();
    logger.warn(`[auth] Promoted existing account ${email} to ADMIN (from ADMIN_EMAIL).`);

    return 'promoted';
  }

  await UserModel.create({
    email,
    passwordHash: await hashPassword(password),
    role: 'ADMIN',
  });
  logger.info(`[auth] Seeded admin account ${email}.`);

  return 'created';
}
