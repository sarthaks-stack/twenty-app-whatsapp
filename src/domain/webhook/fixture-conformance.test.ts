import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildDedupKey, buildItemDedupKeys } from '../dedup-key';
import { MESSAGE_TYPE } from '../constants';
import { effectiveMediaKind, normaliseInboundMessage } from '../inbound-normalise';
import { classifyChange } from './classify-change';
import { isMetaSampleDelivery } from './sample-delivery';
import type { MetaWebhookBody } from './types';

/**
 * Runs the pure ingestion logic over every recorded delivery.
 *
 * The unit tests above build payloads from the spec; this one builds nothing.
 * It replays 33 deliveries Meta actually sent — which is the only way to catch
 * the class of bug that has already cost this project twice: a field that is
 * present in the documentation and absent in reality (or the reverse, as with
 * the inlined media URL), and a classifier suffix that only appears on shapes
 * no hand-written test thought to construct.
 *
 * It asserts invariants rather than expected values, so a new capture extends
 * the coverage without needing a new assertion.
 */

const FIXTURE_DIR = join(process.cwd(), 'src/__tests__/fixtures/meta');

type Fixture = {
  file: string;
  capturedAt: string;
  isMetaDashboardSample?: boolean;
  body: MetaWebhookBody;
};

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Omit<Fixture, 'file'>),
  }));

const changes = fixtures.flatMap((fixture) =>
  (fixture.body.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).map((change) => ({
      fixture,
      entryId: entry.id,
      entryTime: (entry as { time?: number }).time,
      change,
    })),
  ),
);

const inboundMessages = changes.flatMap(({ fixture, change }) =>
  (change.value?.messages ?? []).map((message) => ({ fixture, message })),
);

describe('the recorded corpus', () => {
  it('is present and has both real deliveries and dashboard samples', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(33);
    expect(fixtures.some((f) => f.isMetaDashboardSample === true)).toBe(true);
    expect(fixtures.some((f) => f.isMetaDashboardSample !== true)).toBe(true);
  });

  it('labels every dashboard sample and no real delivery', () => {
    for (const fixture of fixtures) {
      expect(isMetaSampleDelivery(fixture.body)).toBe(fixture.isMetaDashboardSample === true);
    }
  });
});

describe('dedup keys over real deliveries', () => {
  it('produces a non-empty key for every change', () => {
    for (const { entryId, entryTime, change, fixture } of changes) {
      const key = buildDedupKey({ entryId, entryTime, change });

      expect(key, fixture.file).toMatch(/^[a-z-]+:.+$/);
      expect(key.endsWith(':')).toBe(false);
    }
  });

  it('is deterministic — a replay of the corpus yields identical keys', () => {
    const first = changes.map(({ entryId, entryTime, change }) =>
      buildDedupKey({ entryId, entryTime, change }),
    );
    const second = changes.map(({ entryId, entryTime, change }) =>
      buildDedupKey({ entryId, entryTime, change }),
    );

    expect(second).toEqual(first);
  });

  /**
   * The corpus contains six status events captured inside 1.3 s, three of them
   * sharing one timestamp. If the key collapsed them the app would lose real
   * lifecycle transitions — which is precisely what AR-8 has to get right.
   */
  it('keeps every distinct change in the corpus distinct', () => {
    const keys = changes.map(({ entryId, entryTime, change }) =>
      buildDedupKey({ entryId, entryTime, change }),
    );

    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

    expect(duplicates).toEqual([]);
  });

  it('gives an item key to every message and status in the corpus', () => {
    for (const { entryId, entryTime, change } of changes) {
      const expected =
        (change.value?.messages ?? []).length + (change.value?.statuses ?? []).length;

      if (expected > 0) {
        expect(buildItemDedupKeys({ entryId, entryTime, change })).toHaveLength(expected);
      }
    }
  });
});

describe('normalisation over real deliveries', () => {
  it('found inbound messages to test', () => {
    expect(inboundMessages.length).toBeGreaterThanOrEqual(15);
  });

  it('never drops a message: every one gets a type, a timestamp and a preview', () => {
    for (const { fixture, message } of inboundMessages) {
      const result = normaliseInboundMessage(message);

      expect(Object.values(MESSAGE_TYPE), fixture.file).toContain(result.messageType);
      expect(result.waTimestamp.getTime(), fixture.file).toBeGreaterThan(0);
      expect(result.preview.length, fixture.file).toBeLessThanOrEqual(120);
    }
  });

  /**
   * The corpus was captured by sending one of every type from a real device,
   * so a regression that silently routed a known type into the placeholder
   * branch would show up here and nowhere else.
   */
  it('classifies every captured real message as a supported type', () => {
    const unsupported = inboundMessages
      .filter(({ fixture }) => fixture.isMetaDashboardSample !== true)
      .map(({ fixture, message }) => ({ file: fixture.file, ...normaliseInboundMessage(message) }))
      .filter((result) => result.messageType === MESSAGE_TYPE.UNSUPPORTED)
      .map((result) => result.file);

    expect(unsupported).toEqual([]);
  });

  it('covers the media, text and interactive families', () => {
    const types = new Set(
      inboundMessages.map(({ message }) => normaliseInboundMessage(message).messageType),
    );

    for (const expected of [
      MESSAGE_TYPE.TEXT,
      MESSAGE_TYPE.IMAGE,
      MESSAGE_TYPE.VIDEO,
      MESSAGE_TYPE.AUDIO,
      MESSAGE_TYPE.DOCUMENT,
      MESSAGE_TYPE.STICKER,
      MESSAGE_TYPE.LOCATION,
      MESSAGE_TYPE.CONTACTS,
      MESSAGE_TYPE.REACTION,
      MESSAGE_TYPE.BUTTON_REPLY,
      MESSAGE_TYPE.LIST_REPLY,
    ]) {
      expect([...types], `missing ${expected}`).toContain(expected);
    }
  });

  it('gives every media message an id the worker can fetch', () => {
    for (const { fixture, message } of inboundMessages) {
      const result = normaliseInboundMessage(message);
      if (!result.isMedia) continue;

      expect(result.mediaMeta?.mediaId, fixture.file).toBeTruthy();
      expect(effectiveMediaKind(result.mediaMeta, result.messageType), fixture.file).not.toBeNull();
    }
  });

  it('agrees with the classifier on which messages are reactions', () => {
    for (const { change } of changes) {
      const classified = classifyChange(change);

      const reactions = (change.value?.messages ?? []).filter(
        (message) => normaliseInboundMessage(message).messageType === MESSAGE_TYPE.REACTION,
      ).length;

      const slugged = classified.slugs.filter((slug) => slug.startsWith('inbound-reaction')).length;

      expect(slugged).toBe(reactions);
    }
  });
});
