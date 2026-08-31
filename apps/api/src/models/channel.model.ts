import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * A Telegram channel this instance ingests from.
 *
 * The registry is what makes the source list dynamic: it is seeded from
 * `TELEGRAM_CHANNELS` on boot and enriched with the numeric ID and title
 * Telegram itself reports, so enabling or pausing a channel is a data change,
 * not a code change.
 *
 * Which channels feed the product is internal information: this collection is
 * reachable only through `/api/admin/*`, never from a public route.
 */
const channelSchema = new Schema(
  {
    /** Numeric Telegram channel ID as a string; null until first resolved. */
    telegramId: { type: String, default: null },
    /** Username in Telegram's own casing, without "@". Display form. */
    username: { type: String, required: true, trim: true },
    /** Lowercased username — the stable lookup key. */
    usernameKey: { type: String, required: true, trim: true, lowercase: true },
    /** Channel title as Telegram reports it. */
    title: { type: String, default: null },
    /** Only active channels are ingested. Flipped by the admin dashboard. */
    isActive: { type: Boolean, default: true, required: true },
    /**
     * When an admin last paused this channel; null while active. Pausing only
     * stops future ingestion — no stored job or queued message is ever removed.
     */
    pausedAt: { type: Date, default: null },
    /** Highest message ID seen, for reporting and backfill diagnostics. */
    lastMessageId: { type: Number, default: null },
    /** Last time a message from this channel was ingested. */
    lastSyncedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'channels',
  },
);

channelSchema.index({ usernameKey: 1 }, { unique: true });
channelSchema.index({ isActive: 1, username: 1 });

export type Channel = InferSchemaType<typeof channelSchema>;
export type ChannelDocument = HydratedDocument<Channel>;

export const ChannelModel = model<Channel>('Channel', channelSchema);
