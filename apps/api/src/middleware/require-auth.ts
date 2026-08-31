import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import { readBearerToken, verifyAuthToken } from '../lib/auth.js';
import { forbidden, unauthorized } from '../lib/http-error.js';
import { UserModel, type UserRole } from '../models/user.model.js';

/** The caller, once authenticated. Never carries the password hash. */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

/** A request that has passed `requireAuth`, so the user is present. */
export type AuthenticatedRequest = Request & { authUser: AuthUser };

/**
 * Resolves the caller from their bearer token, or throws 401.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the token body. That costs one indexed lookup and buys immediate
 * revocation: deleting an account or demoting an admin takes effect at once,
 * instead of when their token happens to expire.
 */
async function authenticate(req: Request): Promise<AuthUser> {
  const token = readBearerToken(req.get('authorization'));
  if (token === null) throw unauthorized('Missing or malformed bearer token.');

  const payload = verifyAuthToken(token);
  // One message for every failure mode — expired, tampered, or signed with a
  // rotated secret — so nothing about the key is inferable from the response.
  if (payload === null || !mongoose.isValidObjectId(payload.sub)) {
    throw unauthorized('Invalid or expired token.');
  }

  const user = await UserModel.findById(payload.sub).lean<{
    _id: mongoose.Types.ObjectId;
    email: string;
    role: UserRole;
  } | null>();

  if (user === null) throw unauthorized('Invalid or expired token.');

  return { id: user._id.toString(), email: user.email, role: user.role };
}

/** Requires any authenticated account. 401 otherwise. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    (req as AuthenticatedRequest).authUser = await authenticate(req);
    next();
  } catch (error: unknown) {
    next(error);
  }
}

/**
 * Requires an authenticated ADMIN. 401 when unauthenticated, 403 when the
 * account exists but is not an admin.
 *
 * This is the whole admin boundary: `adminRouter` mounts it before any route, so
 * protection cannot be forgotten on a new endpoint, and it does not depend on
 * the frontend hiding anything.
 */
export async function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await authenticate(req);

    if (user.role !== 'ADMIN') throw forbidden('Administrator access required.');

    (req as AuthenticatedRequest).authUser = user;
    next();
  } catch (error: unknown) {
    next(error);
  }
}
