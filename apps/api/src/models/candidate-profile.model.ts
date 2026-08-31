import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * One candidate's job preferences, derived from an uploaded resume and then
 * editable by hand.
 *
 * Identity is a bearer token minted on first upload: `tokenHash` is the SHA-256
 * of the token handed to the client, so a database dump cannot be replayed
 * against the API. It is unique, which is what gives each holder exactly one
 * profile.
 *
 * `userId` is the relation to `User` for once login exists — nullable and
 * sparse-unique, so today's token-only profiles coexist with account-owned ones
 * and each account still gets at most one profile. Nothing here duplicates
 * `User`: this model holds preferences only.
 *
 * The resume file itself is never stored, only the fields extracted from it.
 */
const candidateProfileSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      /**
       * Absent, not null, on a token-only profile. A sparse index skips a
       * missing field but still indexes an explicit `null`, so defaulting to
       * `null` would let exactly one anonymous profile exist and fail every
       * upload after it with a duplicate-key error on `userId_1`.
       */
      default: undefined,
      unique: true,
      sparse: true,
    },

    // ── Preference fields ─────────────────────────────────────────────────
    skills: { type: [String], default: [] },
    preferredRoles: { type: [String], default: [] },
    preferredLocations: { type: [String], default: [] },
    preferredJobTypes: { type: [String], default: [] },
    experienceYears: { type: Number, default: null },
    graduationYear: { type: String, default: null },

    // ── Resume provenance (no file, no URL — just what was parsed) ────────
    resumeFileName: { type: String, default: null },
    resumeParsedAt: { type: Date, default: null },

    /**
     * Fields the user has edited by hand. A later resume upload leaves these
     * alone, so re-uploading a resume never silently undoes a manual choice.
     */
    manualFields: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: 'candidate_profiles',
  },
);

/** The preference fields a user may edit, and the only keys `manualFields` holds. */
export const EDITABLE_PROFILE_FIELDS = [
  'skills',
  'preferredRoles',
  'preferredLocations',
  'preferredJobTypes',
  'experienceYears',
  'graduationYear',
] as const;

export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];

export type CandidateProfile = InferSchemaType<typeof candidateProfileSchema>;
export type CandidateProfileDocument = HydratedDocument<CandidateProfile>;

export const CandidateProfileModel = model<CandidateProfile>(
  'CandidateProfile',
  candidateProfileSchema,
);
