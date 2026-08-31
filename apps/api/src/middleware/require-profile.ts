import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../lib/http-error.js';
import { hashProfileToken, readBearerToken } from '../lib/profile-token.js';
import {
  CandidateProfileModel,
  type CandidateProfileDocument,
} from '../models/candidate-profile.model.js';

/** A request that has passed `requireProfile`, so the profile is present. */
export type ProfileRequest = Request & { candidateProfile: CandidateProfileDocument };

/**
 * Loads the caller's own profile from their bearer token.
 *
 * Every profile and recommendation route goes through this, and it is the only
 * place a profile is looked up: the lookup key is derived from the caller's
 * token and nothing else, so no request can name — or reach — another
 * candidate's profile.
 */
export async function requireProfile(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = readBearerToken(req.get('authorization'));

  if (token === null) {
    next(new HttpError(401, 'Missing or malformed profile token.'));
    return;
  }

  const profile = await CandidateProfileModel.findOne({ tokenHash: hashProfileToken(token) });

  if (profile === null) {
    next(new HttpError(401, 'Unknown profile token.'));
    return;
  }

  (req as ProfileRequest).candidateProfile = profile;
  next();
}
