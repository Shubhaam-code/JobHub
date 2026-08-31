/**
 * Profile bearer tokens.
 *
 * The API has no user accounts yet, so a candidate profile is owned by whoever
 * holds its token. That makes two properties essential, and both live here:
 * the token is unguessable (256 bits of CSPRNG output), and only its SHA-256 is
 * ever persisted, so a leaked database cannot be replayed against the API.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes hex-encoded. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function createProfileToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function hashProfileToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Pulls a well-formed token out of an `Authorization: Bearer …` header.
 * Returns null for a missing, malformed or wrong-shaped value, so a caller
 * never runs a database lookup on arbitrary input.
 */
export function readBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1]?.toLowerCase();

  return token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}
