import { errors } from 'telegram';
import type { Api } from 'telegram';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_MESSAGES_WALKED,
  runBackfill,
  type MessageHistorySource,
} from '../src/telegram/backfill.js';
import type { IngestionInput, IngestionOutcome } from '../src/telegram/ingestion.js';

/** Fixed reference clock so the 7-day cutoff is deterministic. */
const NOW_MS = Date.UTC(2026, 7, 31, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

const CHANNEL = 'jobs_and_internships_updates';

/** A minimal stand-in for what GramJS yields from `iterMessages`. */
interface FakeMessage {
  id: number;
  date: number;
  message?: string;
}

function post(id: number, daysAgo: number, message = `Company: Acme ${id}\nRole: Intern`) {
  return { id, date: NOW_SECONDS - Math.round(daysAgo * DAY), message };
}

/**
 * Builds a history source that yields `messages` newest-first (as Telegram
 * does), honours the `limit` GramJS is given, and records what was consumed.
 */
function createSource(messages: unknown[], failAfter?: () => never) {
  const consumed: unknown[] = [];

  const source = {
    iterMessages: (_entity: unknown, params: { limit?: number }) =>
      (async function* () {
        const limit = params.limit ?? messages.length;

        for (const message of messages.slice(0, limit)) {
          consumed.push(message);
          yield message;
        }
        if (failAfter) failAfter();
      })(),
  } as unknown as MessageHistorySource;

  return { source, consumed };
}

function createIngest(outcomes: Partial<Record<number, IngestionOutcome>> = {}) {
  const calls: IngestionInput[] = [];

  const ingest = vi.fn(async (input: IngestionInput) => {
    calls.push(input);
    return { outcome: outcomes[input.messageId] ?? 'queued', messageId: input.messageId };
  });

  return { ingest, calls };
}

function run(
  ingest: (input: IngestionInput) => Promise<{ outcome: IngestionOutcome; messageId: number }>,
  source: MessageHistorySource,
) {
  return runBackfill({
    client: source,
    entity: {} as Api.Channel,
    channelUsername: CHANNEL,
    now: NOW_MS,
    ingest,
  });
}

describe('runBackfill', () => {
  it('1. ingests only messages inside the 7-day window', async () => {
    const messages: FakeMessage[] = [post(300, 0.5), post(299, 6.9), post(298, 7.5), post(297, 30)];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest();

    const summary = await run(ingest, source);

    expect(calls.map((call) => call.messageId)).toEqual([299, 300]);
    expect(summary.eligible).toBe(2);
    expect(summary.queued).toBe(2);
    expect(summary.cutoff).toEqual(new Date((NOW_SECONDS - 7 * DAY) * 1000));
  });

  it('2. stops walking history at the first message older than the cutoff', async () => {
    const messages: FakeMessage[] = [post(300, 1), post(299, 8), post(298, 9), post(297, 10)];
    const { source, consumed } = createSource(messages);
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    // The walk reads the boundary message, then stops — 298 and 297 are never fetched.
    expect(consumed).toHaveLength(2);
    expect(summary.fetched).toBe(2);
    expect(summary.eligible).toBe(1);
  });

  it('3. processes eligible messages oldest → newest', async () => {
    const messages: FakeMessage[] = [post(300, 0.1), post(299, 2), post(298, 5), post(297, 20)];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest();

    await run(ingest, source);

    expect(calls.map((call) => call.messageId)).toEqual([298, 299, 300]);

    const dates = calls.map((call) => call.date);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('4. passes text, telegram date and channel through to ingestion', async () => {
    const messages: FakeMessage[] = [post(500, 1, 'Company: Acme\nApply: https://acme.test/apply')];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest();

    await run(ingest, source);

    expect(calls[0]).toEqual({
      text: 'Company: Acme\nApply: https://acme.test/apply',
      messageId: 500,
      date: NOW_SECONDS - DAY,
      channelUsername: CHANNEL,
      channelId: null,
    });
  });

  it('5. reports nothing to backfill when no message is recent enough', async () => {
    const messages: FakeMessage[] = [post(300, 8), post(299, 9)];
    const { source } = createSource(messages);
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    expect(ingest).not.toHaveBeenCalled();
    expect(summary.eligible).toBe(0);
    expect(summary.queued).toBe(0);
    expect(summary.fetched).toBe(1);
  });

  it('6. tallies duplicates, skips and errors without stopping', async () => {
    const messages: FakeMessage[] = [post(304, 1), post(303, 2), post(302, 3), post(301, 4)];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest({
      301: 'queued',
      302: 'duplicate',
      303: 'skipped',
      304: 'error',
    });

    const summary = await run(ingest, source);

    expect(calls).toHaveLength(4);
    expect(summary).toMatchObject({
      eligible: 4,
      queued: 1,
      duplicates: 1,
      skipped: 1,
      errors: 1,
    });
  });

  it('7. is idempotent on a second run — every message reports as duplicate', async () => {
    const messages: FakeMessage[] = [post(300, 1), post(299, 2)];
    const { source } = createSource(messages);
    const { ingest } = createIngest({ 299: 'duplicate', 300: 'duplicate' });

    const summary = await run(ingest, source);

    expect(summary.duplicates).toBe(2);
    expect(summary.queued).toBe(0);
  });

  it('8. skips media-only posts with no caption instead of inventing data', async () => {
    const messages: FakeMessage[] = [{ id: 300, date: NOW_SECONDS - DAY }, post(299, 2)];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest({ 300: 'skipped' });

    const summary = await run(ingest, source);

    // Reaches the pipeline with empty text, which reports it as skipped.
    expect(calls.find((call) => call.messageId === 300)?.text).toBe('');
    expect(summary.skipped).toBe(1);
    expect(summary.queued).toBe(1);
  });

  it('9. reports a FLOOD_WAIT and stops instead of retrying', async () => {
    const messages: FakeMessage[] = [post(300, 1), post(299, 2)];
    const { source } = createSource(messages, () => {
      throw new errors.FloodWaitError({ capture: 42 });
    });
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    expect(summary.floodWaitSeconds).toBe(42);
    expect(summary.errors).toBe(0);
    // Messages collected before the rate limit are still ingested.
    expect(summary.queued).toBe(2);
  });

  it('10. records a fetch failure and still ingests what it collected', async () => {
    const messages: FakeMessage[] = [post(300, 1)];
    const { source } = createSource(messages, () => {
      throw new Error('connection reset');
    });
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    expect(summary.fetchError).toBe('connection reset');
    expect(summary.errors).toBe(1);
    expect(summary.queued).toBe(1);
  });

  it('11. keeps going when ingestion throws unexpectedly', async () => {
    const messages: FakeMessage[] = [post(300, 1), post(299, 2)];
    const { source } = createSource(messages);

    const ingest = vi.fn(async (input: IngestionInput) => {
      if (input.messageId === 299) throw new Error('mongo unavailable');
      return { outcome: 'queued' as IngestionOutcome, messageId: input.messageId };
    });

    const summary = await run(ingest, source);

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(summary.errors).toBe(1);
    expect(summary.queued).toBe(1);
  });

  it('12. honours a custom window and ignores unusable entries', async () => {
    const messages: unknown[] = [post(300, 0.5), 'not-a-message', post(299, 2.5), post(298, 4)];
    const { source } = createSource(messages);
    const { ingest, calls } = createIngest();

    const summary = await runBackfill({
      client: source,
      entity: {} as Api.Channel,
      channelUsername: CHANNEL,
      windowDays: 3,
      now: NOW_MS,
      ingest,
    });

    expect(calls.map((call) => call.messageId)).toEqual([299, 300]);
    expect(summary.fetched).toBe(4);
    expect(summary.eligible).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('13. flags truncation when the walk ceiling is hit before the cutoff', async () => {
    // Every message is recent, so only the ceiling can stop the walk.
    const messages = Array.from({ length: MAX_MESSAGES_WALKED + 50 }, (_unused, index) =>
      post(1000 + index, 1),
    );
    const { source, consumed } = createSource(messages);
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    expect(consumed).toHaveLength(MAX_MESSAGES_WALKED);
    expect(summary.fetched).toBe(MAX_MESSAGES_WALKED);
    expect(summary.truncated).toBe(true);
  });

  it('14. does not flag truncation on a short channel history', async () => {
    const messages: FakeMessage[] = [post(300, 1), post(299, 2)];
    const { source } = createSource(messages);
    const { ingest } = createIngest();

    const summary = await run(ingest, source);

    expect(summary.truncated).toBe(false);
    expect(summary.eligible).toBe(2);
  });
});
