/**
 * Login and identity.
 *
 * Accounts exist for one reason: to gate the admin dashboard. There is no
 * self-service signup — accounts are created by `npm run user:create` or seeded
 * from ADMIN_EMAIL/ADMIN_PASSWORD — so this router only issues and describes
 * tokens.
 */

import { randomBytes } from 'node:crypto';

import { Router, type Request, type Response } from 'express';
import type mongoose from 'mongoose';
import { z } from 'zod';

import { hashPassword, signAuthToken, verifyPassword } from '../lib/auth.js';
import { badRequest, unauthorized } from '../lib/http-error.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import { UserModel, type UserRole } from '../models/user.model.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/**
 * A throwaway hash, verified against when the email is unknown.
 *
 * Without it, a missing account would answer before scrypt ran and a wrong
 * password after — a timing difference that reveals which emails are
 * registered. Computed once, lazily, from random input it will never match.
 */
let decoyHash: Promise<string> | null = null;

function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString('hex'));

  return decoyHash;
}

/**
 * POST /api/auth/login
 * Exchanges email + password for a bearer token.
 */
authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest('Email and password are required.');
  }

  const email = parsed.data.email.toLowerCase();

  const user = await UserModel.findOne({ email }).lean<{
    _id: mongoose.Types.ObjectId;
    email: string;
    passwordHash: string;
    role: UserRole;
  } | null>();

  const passwordMatches = await verifyPassword(
    parsed.data.password,
    user?.passwordHash ?? (await getDecoyHash()),
  );

  // One message for both failure modes: an unknown email and a wrong password
  // are indistinguishable to the caller.
  if (user === null || !passwordMatches) {
    throw unauthorized('Invalid email or password.');
  }

  const { token, expiresAt } = signAuthToken({
    userId: user._id.toString(),
    role: user.role,
  });

  res.status(200).json({
    data: {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user._id.toString(), email: user.email, role: user.role },
    },
  });
});

/**
 * GET /api/auth/me
 * Describes the caller. The web client uses this to decide whether a stored
 * token still grants admin access, rather than trusting the token's own claim.
 */
authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const { authUser } = req as AuthenticatedRequest;

  res.status(200).json({ data: authUser });
});
