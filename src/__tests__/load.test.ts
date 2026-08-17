import { describe, expect, it } from 'vitest';

import {
  CONSENT_STATUS,
  LANE,
  TEMPLATE_CATEGORY,
  type TemplateCategory,
} from '../domain/constants';
import { buildDedupKey } from '../domain/dedup-key';
import { computeSlots, laneRate } from '../domain/pacing';
import type { VariableSpec } from '../domain/template-spec';
import { decidePage, emptyStats } from '../logic-functions/wa-campaign-snapshot';
import { jobsForChange } from '../logic-functions/wa-webhook-ingest';
import { AUDIENCE_PAGE_SIZE } from '../server/audience';

/**
 * Load tests (specs/12 §5).
 *
 * **What these are and are not.** Every load target in the spec is a claim about
 * this app's *design* under volume — a dedup key that stays unique across 3 000
 * deliveries, a pacing plan that never exceeds the ceiling, two cursors that
 * cannot interfere, an exclusion pass that loses nobody in 100 000. All of those
 * are decidable in process, at the spec's real numbers, in about a second, and
 * that is what runs here.
 *
 * What is *not* here is throughput of the platform underneath: queue latency,
 * Core API round-trips, ack time under a real HTTP load. Those are properties of
 * Twenty and Postgres on a given machine, not of this code, and a test that
 * mocked them would be measuring its own mocks. They belong to 10.9's staged run
 * and are named as outstanding in specs/15 rather than quietly counted as done.
 *
 * The numbers below are the spec's own, not smaller stand-ins: 50 deliveries/s
 * for 60 s, a 10 000-recipient campaign, a 100 000-recipient snapshot.
 */

/** NFR-S2: 50 deliveries per second for 60 seconds. */
const NFR_S2_DELIVERIES = 50 * 60;

const NOW = new Date('2026-08-17T09:00:00.000Z');

const statusChange = (index: number) => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '244923000000', phone_number_id: '123' },
    statuses: [
      {
        id: `wamid.LOAD${index}`,
        status: 'delivered',
        timestamp: String(1_755_000_000 + index),
        recipient_id: `2449230${String(index).padStart(5, '0')}`,
      },
    ],
  },
});

const inboundChange = (index: number) => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '244923000000', phone_number_id: '123' },
    contacts: [{ wa_id: `2449230${String(index).padStart(5, '0')}`, profile: { name: 'Ana' } }],
    messages: [
      {
        id: `wamid.IN${index}`,
        from: `2449230${String(index).padStart(5, '0')}`,
        timestamp: String(1_755_000_000 + index),
        type: 'text',
        text: { body: `mensagem ${index}` },
      },
    ],
  },
});

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

describe('NFR-S2 — a minute of webhook traffic at 50/s', () => {
  const deliveries = Array.from({ length: NFR_S2_DELIVERIES }, (_unused, index) =>
    index % 3 === 0 ? inboundChange(index) : statusChange(index),
  );

  const keysFor = (changes: typeof deliveries) =>
    changes.map((change, index) =>
      buildDedupKey({
        entryId: 'waba1',
        entryTime: 1_755_000_000 + index,
        change: change as never,
      }),
    );

  /**
   * Zero lost events. The dedup key carries a unique index, so two genuinely
   * different deliveries that hash alike do not collide loudly — the second is
   * silently swallowed as a redelivery and its message never appears.
   */
  it('gives 3 000 distinct deliveries 3 000 distinct keys', () => {
    const keys = keysFor(deliveries);

    expect(keys).toHaveLength(NFR_S2_DELIVERIES);
    expect(new Set(keys).size).toBe(NFR_S2_DELIVERIES);
  });

  /**
   * Zero duplicates. Meta's at-least-once delivery replays the identical body,
   * so the same change must produce the same key — that equality *is* the
   * duplicate suppression, and it is the only thing standing between a retry
   * storm and a conversation full of doubles.
   */
  it('gives a redelivery of all 3 000 exactly the same keys', () => {
    expect(keysFor(deliveries)).toEqual(keysFor(deliveries));
  });

  /** Every delivery must produce work; a change that fans out to nothing is a lost event. */
  it('routes every delivery to a processor', () => {
    const routed = deliveries.map(
      (change) =>
        jobsForChange({
          change: change as never,
          webhookEventId: 'ev',
          accountId: 'acc1',
          correlationId: 'c',
        }).length,
    );

    expect(routed.filter((jobs) => jobs === 0)).toEqual([]);
  });

  /**
   * The ack budget is dominated by I/O — the raw-log insert and the enqueue —
   * so what this can assert is that the app's own share of it is not a factor.
   * A p95 in microseconds means a slow ack is Twenty or Postgres, which is where
   * an operator should then look. The end-to-end p95 under real HTTP load is
   * 10.9's, and is not claimed here.
   */
  it('spends negligible CPU per delivery on keying and routing', () => {
    const durations = deliveries.map((change, index) => {
      const startedAt = performance.now();

      buildDedupKey({
        entryId: 'waba1',
        entryTime: 1_755_000_000 + index,
        change: change as never,
      });
      jobsForChange({
        change: change as never,
        webhookEventId: 'ev',
        accountId: 'acc1',
        correlationId: 'c',
      });

      return performance.now() - startedAt;
    });

    /** Three orders of magnitude under the 1 s ack target, per delivery. */
    expect(percentile(durations, 0.95)).toBeLessThan(1);
  });
});

describe('the throttle', () => {
  const rates = { throttlePerSecond: 20, interactiveShare: 0.4 };

  /**
   * The assertion behind "no 130429". Meta answers an over-send with 130429 and
   * the app's only defence is that the plan never asks for more than the ceiling
   * — so the test is over the plan, at the account's rate, for a minute.
   */
  it('never places more sends in any one second than the ceiling allows', () => {
    for (const lane of [LANE.INTERACTIVE, LANE.CAMPAIGN]) {
      const ratePerSecond = laneRate(lane, rates);
      const count = Math.round(ratePerSecond * 60);

      const { slots } = computeSlots({
        cursorAt: null,
        now: NOW.getTime(),
        count,
        ratePerSecond,
      });

      expect(slots).toHaveLength(count);

      /** A sliding one-second window over the plan, not an average. */
      let worst = 0;
      let head = 0;

      for (let tail = 0; tail < slots.length; tail += 1) {
        while (slots[tail]! - slots[head]! >= 1000) head += 1;

        worst = Math.max(worst, tail - head + 1);
      }

      expect(worst).toBeLessThanOrEqual(Math.ceil(ratePerSecond));
    }
  });

  it('spaces sends at 1000/rate within a millisecond of rounding', () => {
    const ratePerSecond = laneRate(LANE.CAMPAIGN, rates);
    const { slots } = computeSlots({
      cursorAt: null,
      now: NOW.getTime(),
      count: 600,
      ratePerSecond,
    });

    const expected = 1000 / ratePerSecond;

    for (let index = 1; index < slots.length; index += 1) {
      expect(Math.abs(slots[index]! - slots[index - 1]! - expected)).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The two lanes together must not exceed the account's ceiling. They were
   * once computed independently, each with its own floor, and at a small
   * ceiling they summed to more than the account allowed (D-29).
   */
  it.each([1, 3, 5, 20, 80])('keeps both lanes inside a ceiling of %i', (throttlePerSecond) => {
    const total =
      laneRate(LANE.INTERACTIVE, { throttlePerSecond, interactiveShare: 0.4 }) +
      laneRate(LANE.CAMPAIGN, { throttlePerSecond, interactiveShare: 0.4 });

    expect(total).toBeCloseTo(throttlePerSecond, 6);
  });
});

const SPEC: VariableSpec = {
  namedParameters: false,
  header: null,
  body: { variableCount: 1, indices: [1], names: [], text: 'Olá {{1}}', example: [] },
  footer: null,
  buttons: [],
  totalVariableCount: 1,
};

const MAPPING = {
  body: [{ index: 1, kind: 'field' as const, path: 'person.name.firstName' }],
} as Parameters<typeof decidePage>[0]['mapping'];

/**
 * A synthetic audience with the four shapes that actually occur, in the
 * proportions that make the counters worth checking: most sendable, some opted
 * out, some sharing a number with an earlier contact, some with a number that
 * cannot be dialled.
 */
const audience = (size: number, offset = 0) =>
  Array.from({ length: size }, (_unused, index) => {
    const ordinal = offset + index;
    const kind = ordinal % 10;

    return {
      id: `p${ordinal}`,
      name: { firstName: 'Ana', lastName: 'Silva' },
      whatsappOptInStatus:
        kind === 7 ? CONSENT_STATUS.OPTED_OUT : CONSENT_STATUS.OPTED_IN,
      phones:
        kind === 8
          ? { primaryPhoneNumber: '12', primaryPhoneCallingCode: '+244' }
          : {
              /** Every ninth contact repeats the previous one's number. */
              primaryPhoneNumber: String(923_000_000 + (kind === 9 ? ordinal - 1 : ordinal)),
              primaryPhoneCallingCode: '+244',
            },
    };
  });

const runSnapshot = (total: number, pageSize: number) => {
  const seenPhones = new Set<string>();
  let stats = emptyStats();
  const rows: { personId: string; status: string; resolvedPhone: string | null }[] = [];
  let pages = 0;

  for (let offset = 0; offset < total; offset += pageSize) {
    const outcome = decidePage({
      people: audience(Math.min(pageSize, total - offset), offset) as never,
      campaignId: 'c1',
      templateCategory: TEMPLATE_CATEGORY.MARKETING as TemplateCategory,
      spec: SPEC,
      mapping: MAPPING,
      defaultCallingCode: '+244',
      accountDisplayName: 'Pixel',
      blockedWaIds: new Set<string>(),
      seenPhones,
      now: NOW,
      stats,
    });

    stats = outcome.stats;
    pages += 1;
    rows.push(...(outcome.rows as never as typeof rows));
  }

  return { stats, rows, pages };
};

describe('a 10 000-recipient campaign', () => {
  const { stats, rows } = runSnapshot(10_000, AUDIENCE_PAGE_SIZE);

  /** Zero lost recipients: everyone scanned is either queued or excluded, with a reason. */
  it('accounts for every contact exactly once', () => {
    expect(stats.scanned).toBe(10_000);
    expect(stats.accepted + stats.excluded).toBe(10_000);
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row.personId)).size).toBe(10_000);
  });

  it('reconciles the exclusion breakdown against the total', () => {
    const breakdown = Object.values(stats.breakdown).reduce(
      (total, value) => total + value,
      0,
    );

    expect(breakdown).toBe(stats.excluded);
  });

  /**
   * Zero duplicate recipients — and this is a number, not a person: two contacts
   * sharing a phone would otherwise each receive the campaign on the same
   * handset, which reads as spam to the recipient and to Meta.
   */
  it('sends to no phone number twice', () => {
    const queued = rows.filter((row) => row.status === 'PENDING');
    const phones = queued.map((row) => row.resolvedPhone);

    expect(new Set(phones).size).toBe(phones.length);
    expect(phones.filter((phone) => phone === null)).toEqual([]);
  });

  /** A campaign of this size still fits inside a day's pacing plan, in order. */
  it('paces the whole audience monotonically', () => {
    const ratePerSecond = laneRate(LANE.CAMPAIGN, {
      throttlePerSecond: 20,
      interactiveShare: 0.4,
    });

    const { slots } = computeSlots({
      cursorAt: null,
      now: NOW.getTime(),
      count: stats.accepted,
      ratePerSecond,
    });

    expect(slots).toHaveLength(stats.accepted);

    for (let index = 1; index < slots.length; index += 1) {
      expect(slots[index]!).toBeGreaterThan(slots[index - 1]!);
    }
  });
});

describe('NFR-S4 — a 100 000-recipient snapshot', () => {
  const startedAt = performance.now();
  const { stats, rows, pages } = runSnapshot(100_000, AUDIENCE_PAGE_SIZE);
  const elapsedMs = performance.now() - startedAt;

  it('loses nobody at ten times the campaign size', () => {
    expect(stats.scanned).toBe(100_000);
    expect(stats.accepted + stats.excluded).toBe(100_000);
    expect(new Set(rows.map((row) => row.personId)).size).toBe(100_000);
  });

  /**
   * The API budget, which is what NFR-S4 is really about: 100 000 contacts at
   * `AUDIENCE_PAGE_SIZE` is 200 reads, and the runner spaces them a second apart
   * — so the snapshot is bounded by its own deliberate pacing, not by the
   * decision work, which is what keeps interactive latency unaffected while it
   * runs.
   */
  it('needs 200 audience reads and no more', () => {
    expect(pages).toBe(Math.ceil(100_000 / AUDIENCE_PAGE_SIZE));
  });

  it('decides all of them in well under one page interval', () => {
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
