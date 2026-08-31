import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** The only two roles the system knows about. */
export const USER_ROLES = ['USER', 'ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Application account.
 *
 * `passwordHash` is a scrypt digest produced by `hashPassword` (lib/auth.ts) —
 * a plaintext password is never stored, and the hash is never serialized into
 * an API response.
 *
 * Role drives the admin boundary: only 'ADMIN' may reach /api/admin/*.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: USER_ROLES, default: 'USER' },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

export const UserModel = model<User>('User', userSchema);
