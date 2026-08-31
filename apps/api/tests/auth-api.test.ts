import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  hashPassword,
  readBearerToken,
  signAuthToken,
  verifyAuthToken,
  verifyPassword,
} from '../src/lib/auth.js';
import { UserModel } from '../src/models/user.model.js';

const app = createApp();

type FindOneMock = ReturnType<typeof UserModel.findOne>;
type FindByIdMock = ReturnType<typeof UserModel.findById>;

const adminId = new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d001');

/** `UserModel.findOne(...).lean()` / `findById(...).lean()` */
function mockLeanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) };
}

describe('password hashing', () => {
  it('1. round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery');

    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('2. rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');

    expect(await verifyPassword('Correct horse battery', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('3. salts each hash, so the same password stores differently', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
    expect(await verifyPassword('same', second)).toBe(true);
  });

  it('4. fails closed on a malformed stored value', async () => {
    for (const stored of ['', 'plaintext', 'scrypt$abc', 'bcrypt$aa$bb', 'scrypt$zz$zz']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });
});

describe('bearer tokens', () => {
  it('5. verifies a token it just issued', () => {
    const { token, expiresAt } = signAuthToken({ userId: adminId.toString(), role: 'ADMIN' });
    const payload = verifyAuthToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe(adminId.toString());
    expect(payload?.role).toBe('ADMIN');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('6. rejects a tampered payload', () => {
    const { token } = signAuthToken({ userId: adminId.toString(), role: 'USER' });
    const [, signature] = token.split('.');

    const forged = Buffer.from(
      JSON.stringify({ sub: adminId.toString(), role: 'ADMIN', exp: 4_000_000_000 }),
      'utf8',
    ).toString('base64url');

    // The escalated role is signed with the original signature — must not verify.
    expect(verifyAuthToken(`${forged}.${signature ?? ''}`)).toBeNull();
  });

  it('7. rejects garbage and structurally invalid tokens', () => {
    for (const token of ['', 'garbage', 'a.b.c', 'onlyonepart', '.', 'eyJhIjoxfQ.']) {
      expect(verifyAuthToken(token)).toBeNull();
    }
  });

  it('8. rejects an expired token', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const { token } = signAuthToken({ userId: adminId.toString(), role: 'ADMIN' }, issuedAt);

    // A year later, well past any allowed TTL.
    expect(verifyAuthToken(token, new Date('2027-01-01T00:00:00.000Z'))).toBeNull();
    expect(verifyAuthToken(token, issuedAt)).not.toBeNull();
  });

  it('9. reads a bearer header case-insensitively and ignores other schemes', () => {
    expect(readBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(readBearerToken('bearer   abc.def')).toBe('abc.def');
    expect(readBearerToken('Basic abc.def')).toBeNull();
    expect(readBearerToken('abc.def')).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('10. issues a token for valid credentials', async () => {
    const passwordHash = await hashPassword('admin-password');
    vi.spyOn(UserModel, 'findOne').mockReturnValue(
      mockLeanQuery({
        _id: adminId,
        email: 'admin@local',
        passwordHash,
        role: 'ADMIN',
      }) as unknown as FindOneMock,
    );

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'Admin@Local', password: 'admin-password' });

    expect(response.status).toBe(200);
    expect(response.body.data.user).toEqual({
      id: adminId.toString(),
      email: 'admin@local',
      role: 'ADMIN',
    });
    expect(verifyAuthToken(response.body.data.token)?.role).toBe('ADMIN');
    // The response describes the account, never its stored hash.
    expect(JSON.stringify(response.body)).not.toContain('scrypt$');
  });

  it('11. rejects a wrong password with 401', async () => {
    const passwordHash = await hashPassword('admin-password');
    vi.spyOn(UserModel, 'findOne').mockReturnValue(
      mockLeanQuery({
        _id: adminId,
        email: 'admin@local',
        passwordHash,
        role: 'ADMIN',
      }) as unknown as FindOneMock,
    );

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@local', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.body.data).toBeUndefined();
  });

  it('12. gives an unknown email the same answer as a wrong password', async () => {
    vi.spyOn(UserModel, 'findOne').mockReturnValue(mockLeanQuery(null) as unknown as FindOneMock);

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@local', password: 'whatever' });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid email or password.');
  });

  it('13. rejects a malformed body with 400', async () => {
    const response = await request(app).post('/api/auth/login').send({ email: 'admin@local' });

    expect(response.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('14. describes the caller behind a valid token', async () => {
    vi.spyOn(UserModel, 'findById').mockReturnValue(
      mockLeanQuery({
        _id: adminId,
        email: 'admin@local',
        role: 'ADMIN',
      }) as unknown as FindByIdMock,
    );

    const { token } = signAuthToken({ userId: adminId.toString(), role: 'ADMIN' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: adminId.toString(),
      email: 'admin@local',
      role: 'ADMIN',
    });
  });

  it('15. returns 401 without a token', async () => {
    const response = await request(app).get('/api/auth/me');

    expect(response.status).toBe(401);
  });

  it('16. returns 401 once the account is gone, even with a valid token', async () => {
    vi.spyOn(UserModel, 'findById').mockReturnValue(mockLeanQuery(null) as unknown as FindByIdMock);

    const { token } = signAuthToken({ userId: adminId.toString(), role: 'ADMIN' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('17. reports the stored role, not the role claimed by the token', async () => {
    // Demoted in the database while an ADMIN token is still in circulation.
    vi.spyOn(UserModel, 'findById').mockReturnValue(
      mockLeanQuery({
        _id: adminId,
        email: 'admin@local',
        role: 'USER',
      }) as unknown as FindByIdMock,
    );

    const { token } = signAuthToken({ userId: adminId.toString(), role: 'ADMIN' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe('USER');
  });
});
