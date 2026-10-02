import { describe, it, expect, vi, beforeEach } from "vitest";

// #2927: the monitor lane's pilot offer sample, bound to the real systems. The
// decisions are pinned by scripts/test-pilot-offers.ts; this pins the WIRING, which
// a wrong argument would break without any decision test noticing: cal.com is asked
// through the Low routing form with a Low lead's fields over the next 24 hours, Slate
// through the booker's own read of bucket 112 filtered by its notice, and both rows
// land in pilot_offer_samples.

const calcom = vi.hoisted(() => ({ calcomRoutedSlots: vi.fn() }));
vi.mock("@/lib/calcom/client", () => calcom);
const slots = vi.hoisted(() => ({ getBucketSlotsWithFallback: vi.fn() }));
vi.mock("@/lib/availability/slot-cache", () => slots);

import { runPilotOfferSampleLive } from "./pilot-offers-live";
import { PILOT_OFFER_CALCOM_FORM } from "./pilot-offers";

const NOW = Date.parse("2026-10-01T13:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function fakeDb(lastSampledAt: string | null) {
  const inserted: unknown[] = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe("pilot_offer_samples");
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: lastSampledAt ? { sampled_at: lastSampledAt } : null, error: null }),
            }),
          }),
        }),
        insert: (rows: unknown[]) => {
          inserted.push(...rows);
          return { select: async () => ({ data: rows, error: null }) };
        },
      };
    },
  };
  return { db: db as never, inserted };
}

beforeEach(() => {
  calcom.calcomRoutedSlots.mockReset();
  slots.getBucketSlotsWithFallback.mockReset();
});

describe("runPilotOfferSampleLive", () => {
  it("asks cal.com's Low routing form and Slate's booker read, and stores both rows", async () => {
    calcom.calcomRoutedSlots.mockResolvedValue({
      status: 200,
      data: { eventTypeId: 1314152, slots: { d: [{ start: iso(60) }, { start: iso(30 * 60) }] } },
    });
    slots.getBucketSlotsWithFallback.mockResolvedValue({
      // 10 minutes out is inside a 120 minute notice and must be dropped, as the
      // availability route drops it; 200 and 300 minutes out are offered.
      slots: [iso(10), iso(200), iso(300)],
      eventType: { min_notice_min: 120 },
    });
    const { db, inserted } = fakeDb(null);

    const out = await runPilotOfferSampleLive(db, NOW);

    expect(out).toEqual({ sampled: true, calcom: "ok", slate: "ok" });
    expect(calcom.calcomRoutedSlots).toHaveBeenCalledWith(
      PILOT_OFFER_CALCOM_FORM,
      { xbc: 112, adv: 1, bes: 1, leg: 2 },
      {
        start: new Date(NOW).toISOString(),
        end: new Date(NOW + 24 * 3_600_000).toISOString(),
        timeZone: "America/New_York",
      },
    );
    expect(slots.getBucketSlotsWithFallback).toHaveBeenCalledWith("112", new Date(NOW).toISOString(), false, NOW);
    expect(inserted).toEqual([
      expect.objectContaining({
        system: "calcom",
        ok: true,
        earliest_offered_at: iso(60),
        offered_24h: 1,
        calcom_time_zone: "America/New_York",
      }),
      expect.objectContaining({ system: "slate", ok: true, earliest_offered_at: iso(200), offered_24h: 2 }),
    ]);
  });

  it("stores an unknown bucket as a failed Slate reading, not as nothing offered", async () => {
    calcom.calcomRoutedSlots.mockResolvedValue({ status: 200, data: { slots: {} } });
    slots.getBucketSlotsWithFallback.mockResolvedValue(null);
    const { db, inserted } = fakeDb(null);

    await runPilotOfferSampleLive(db, NOW);

    expect(inserted[1]).toEqual(
      expect.objectContaining({ system: "slate", ok: false, offered_24h: null, error: "bucket 112 was not found" }),
    );
  });

  it("stores cal.com not being configured as a failed reading", async () => {
    calcom.calcomRoutedSlots.mockRejectedValue(new Error("cal.com is not configured here"));
    slots.getBucketSlotsWithFallback.mockResolvedValue({ slots: [], eventType: { min_notice_min: 0 } });
    const { db, inserted } = fakeDb(null);

    await runPilotOfferSampleLive(db, NOW);

    expect(inserted[0]).toEqual(
      expect.objectContaining({ system: "calcom", ok: false, error: "cal.com is not configured here" }),
    );
  });

  it("asks neither system when a sample was taken five minutes ago", async () => {
    const { db, inserted } = fakeDb(new Date(NOW - 5 * 60_000).toISOString());

    expect(await runPilotOfferSampleLive(db, NOW)).toEqual({ sampled: false });
    expect(calcom.calcomRoutedSlots).not.toHaveBeenCalled();
    expect(slots.getBucketSlotsWithFallback).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("samples when the stored stamp cannot be read, rather than skipping", async () => {
    calcom.calcomRoutedSlots.mockResolvedValue({ status: 200, data: { slots: {} } });
    slots.getBucketSlotsWithFallback.mockResolvedValue({ slots: [], eventType: { min_notice_min: 0 } });
    const { db } = fakeDb("not a time");

    expect(await runPilotOfferSampleLive(db, NOW)).toEqual({ sampled: true, calcom: "ok", slate: "ok" });
  });
});
