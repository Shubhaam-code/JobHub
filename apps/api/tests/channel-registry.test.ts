/**
 * The channel registry and its effect on ingestion.
 *
 * Two properties matter most here and are asserted directly: a paused channel is
 * dropped *before* anything is queued, and reconciling the configured list can
 * never re-enable a channel an admin switched off.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelModel } from '../src/models/channel.model.js';
import { enqueueMessage } from '../src/queue/ingest-queue.js';
import {
  ensureConfiguredChannels,
  invalidateChannelStatusCache,
  isChannelIngestionEnabled,
  mergeChannelNames,
  recordChannelActivity,
} from '../src/telegram/channel-registry.js';
import { ingestMessage } from '../src/telegram/ingestion.js';

vi.mock('../src/queue/ingest-queue.js', () => ({
  enqueueMessage: vi.fn(async () => ({ outcome: 'queued', queueJobId: 'queue-1' })),
}));

/** `ChannelModel.find(...).lean()` — the status map read. */
function mockStatuses(docs: { usernameKey: string; isActive: boolean }[]): void {
  vi.spyOn(ChannelModel, 'find').mockReturnValue({
    lean: vi.fn().mockResolvedValue(docs),
  } as unknown as ReturnType<typeof ChannelModel.find>);
}

function mockUpdateOne() {
  return vi.spyOn(ChannelModel, 'updateOne').mockReturnValue({
    exec: vi.fn().mockResolvedValue({ acknowledged: true }),
  } as unknown as ReturnType<typeof ChannelModel.updateOne>);
}

const message = {
  text: 'Company: Infobip\nRole: Solution Engineer Intern\nApply: https://example.com/apply',
  messageId: 5310,
  date: Math.floor(new Date('2026-08-31T09:00:00.000Z').getTime() / 1000),
  channelUsername: 'internfreak',
  channelId: '-1001234567890',
};

describe('isChannelIngestionEnabled', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it('1. reports a paused channel as disabled, case-insensitively', async () => {
    mockStatuses([{ usernameKey: 'internfreak', isActive: false }]);

    expect(await isChannelIngestionEnabled('internfreak')).toBe(false);
    expect(await isChannelIngestionEnabled('@InternFreak')).toBe(false);
  });

  it('2. fails open for an unknown channel', async () => {
    mockStatuses([]);

    expect(await isChannelIngestionEnabled('never_registered')).toBe(true);
  });

  it('3. fails open when the registry cannot be read', async () => {
    // A false "paused" would silently drop messages Telegram never re-delivers.
    vi.spyOn(ChannelModel, 'find').mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as unknown as ReturnType<typeof ChannelModel.find>);

    expect(await isChannelIngestionEnabled('internfreak')).toBe(true);
  });
});

describe('ingestMessage on a paused channel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(enqueueMessage).mockClear();
    invalidateChannelStatusCache();
  });

  it('4. skips the message without queuing it', async () => {
    mockStatuses([{ usernameKey: 'internfreak', isActive: false }]);

    const result = await ingestMessage(message);

    expect(result).toEqual({
      outcome: 'skipped',
      messageId: 5310,
      reason: 'channel paused',
    });
    // Nothing enters the pipeline: no queue row, so no LLM call later either.
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it('5. deletes nothing when a message is skipped', async () => {
    mockStatuses([{ usernameKey: 'internfreak', isActive: false }]);

    const deleteMany = vi.spyOn(ChannelModel, 'deleteMany');
    const updateOne = vi.spyOn(ChannelModel, 'updateOne');

    await ingestMessage(message);

    expect(deleteMany).not.toHaveBeenCalled();
    // Not even activity is recorded — a paused channel is not receiving.
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('6. ingests again as soon as the channel is active', async () => {
    mockStatuses([{ usernameKey: 'internfreak', isActive: true }]);
    mockUpdateOne();

    const result = await ingestMessage(message);

    expect(result.outcome).toBe('queued');
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueMessage).mock.calls[0]?.[0]).toMatchObject({
      telegramChannel: 'internfreak',
      telegramMessageId: 5310,
    });
  });
});

describe('ensureConfiguredChannels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it('7. upserts each configured channel', async () => {
    const updateOne = mockUpdateOne();

    const touched = await ensureConfiguredChannels(['internfreak', '@getjobss']);

    expect(touched).toBe(2);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0]?.[0]).toEqual({ usernameKey: 'internfreak' });
    // The stored key is normalized; a leading "@" is not part of it.
    expect(updateOne.mock.calls[1]?.[0]).toEqual({ usernameKey: 'getjobss' });
    expect(updateOne.mock.calls[1]?.[2]).toEqual({ upsert: true });
  });

  it('8. sets status only on insert, so a restart cannot un-pause a channel', async () => {
    const updateOne = mockUpdateOne();

    await ensureConfiguredChannels(['internfreak']);

    const update = updateOne.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
      $setOnInsert: Record<string, unknown>;
    };

    expect(update.$setOnInsert).toEqual({ isActive: true, pausedAt: null });
    // The whole point: an existing document's status is never written.
    expect(update.$set).toEqual({ username: 'internfreak' });
    expect(update.$set).not.toHaveProperty('isActive');
  });

  it('9. ignores blank entries and survives a write failure', async () => {
    const updateOne = vi.spyOn(ChannelModel, 'updateOne').mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('write failed')),
    } as unknown as ReturnType<typeof ChannelModel.updateOne>);

    const touched = await ensureConfiguredChannels(['  ', '@', 'internfreak']);

    expect(touched).toBe(0);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

describe('recordChannelActivity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('10. moves the high-water mark forward only', async () => {
    const updateOne = mockUpdateOne();

    await recordChannelActivity({ username: '@internfreak', messageId: 5310 });

    expect(updateOne.mock.calls[0]?.[0]).toEqual({ usernameKey: 'internfreak' });
    expect(updateOne.mock.calls[0]?.[1]).toEqual({
      $max: { lastMessageId: 5310 },
      $set: { lastSyncedAt: expect.any(Date) },
    });
  });

  it('11. never throws — reporting cannot break ingestion', async () => {
    vi.spyOn(ChannelModel, 'updateOne').mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('write failed')),
    } as unknown as ReturnType<typeof ChannelModel.updateOne>);

    await expect(
      recordChannelActivity({ username: 'internfreak', messageId: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('mergeChannelNames', () => {
  it('12. dedupes configured and stored channels case-insensitively', () => {
    expect(mergeChannelNames(['HireMeFresh', 'jobs_SQL'], ['hiremefresh', 'internfreak'])).toEqual([
      'HireMeFresh',
      'jobs_SQL',
      'internfreak',
    ]);
  });

  it('13. tolerates a leading @ and blank entries', () => {
    expect(mergeChannelNames(['@getjobss', '  '], ['@getjobss', ''])).toEqual(['getjobss']);
  });
});
