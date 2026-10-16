import { describe, it, expect, vi, beforeEach } from "vitest";

// #2241: every Google call the CONFIRM path makes must be stubbed under
// SLATE_LOADTEST.
//
// The stub gated the read and watch lanes (listCalendars, freeBusy, freeBusyMany,
// watchCalendar, stopChannel, syncEvents) and nothing else, so a booking path load
// run could not confirm a single booking: `completeReservation` calls `createEvent`
// live before `insertBooking`, and `deleteEventBestEffort` on the rollback. The
// July soak (#440) never drove a confirm, which is why this was invisible.
//
// The proof is BEHAVIOURAL rather than a scan: the network is made to throw, so a
// call that is not gated fails loudly here. `scripts/test-loadtest-stub-coverage.ts`
// is the other half, and covers the call that has not been written yet.
//
// The env var is set at module scope, before `@/lib/google/calendar` is imported,
// because `LOADTEST` is read once when `loadtest-stub.ts` is evaluated. Vitest runs
// each file in its own fork with its own module registry, so this reaches nothing
// else.
process.env.SLATE_LOADTEST = "true";
// Zero, explicitly: the fault injector is deterministic over the call key, so a
// non-zero value here would make these assertions depend on which keys the fixture
// happens to produce.
process.env.SLATE_LOADTEST_FAULT_PCT = "0";

const NETWORK = "the confirm path reached the network under SLATE_LOADTEST";
vi.mock("@/lib/google/dwd", () => ({
  getDelegatedToken: async () => {
    throw new Error(NETWORK);
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error(NETWORK);
  });
});

const EMAIL = "agent@trypennie.com";
const EVENT = {
  summary: "Pennie call",
  start: "2026-09-14T15:00:00.000Z",
  end: "2026-09-14T15:20:00.000Z",
  timezone: "America/New_York",
};

describe("the confirm path under SLATE_LOADTEST", () => {
  it("creates an event without touching Google, and returns the client id it was given", async () => {
    const { createEvent } = await import("@/lib/google/calendar");
    const clientId = "slate" + "a".repeat(64);
    await expect(createEvent(EMAIL, EVENT, clientId)).resolves.toBe(clientId);
  });

  it("returns the SAME id for a repeated create, which is the 409 reuse it models", async () => {
    // Real Google 409s a duplicate client id and the call GETs the existing event,
    // so a retry of one intent yields one event. A pure function of the client id
    // has exactly that property and needs no state to keep it across isolates.
    const { createEvent } = await import("@/lib/google/calendar");
    const clientId = "slate" + "b".repeat(64);
    const first = await createEvent(EMAIL, EVENT, clientId);
    const second = await createEvent(EMAIL, EVENT, clientId);
    expect(second).toBe(first);
  });

  it("mints a stable id of its own when no client id is supplied", async () => {
    const { createEvent } = await import("@/lib/google/calendar");
    const a = await createEvent(EMAIL, EVENT);
    const b = await createEvent(EMAIL, EVENT);
    expect(a).toBe(b);
    expect(a).not.toBe("");
    // Distinguishable from a real Google id, since nothing real was created.
    expect(a.startsWith("lt-evt-")).toBe(true);
  });

  it("gives two different bookings two different ids", async () => {
    // A single constant would make every load-run booking share one event id, and
    // any invariant counting distinct events would read as catastrophically wrong.
    const { createEvent } = await import("@/lib/google/calendar");
    const a = await createEvent(EMAIL, EVENT);
    const b = await createEvent(EMAIL, { ...EVENT, start: "2026-09-14T16:00:00.000Z" });
    expect(a).not.toBe(b);
  });

  it("deletes an event without touching Google", async () => {
    const { deleteEvent } = await import("@/lib/google/calendar");
    await expect(deleteEvent(EMAIL, "slate-evt-1")).resolves.toBeUndefined();
    await expect(
      deleteEvent(EMAIL, "slate-evt-1", { notifyAttendee: false }),
    ).resolves.toBeUndefined();
  });

  it("moves an event without touching Google", async () => {
    const { updateEventTime } = await import("@/lib/google/calendar");
    await expect(
      updateEventTime(EMAIL, "slate-evt-1", EVENT.start, EVENT.end, EVENT.timezone),
    ).resolves.toBeUndefined();
  });

  it("reads an event back without touching Google, and reports it present", async () => {
    const { getEventOnPrimary, eventExists } = await import("@/lib/google/calendar");
    const got = await getEventOnPrimary(EMAIL, "slate-evt-1");
    expect(got?.id).toBe("slate-evt-1");
    expect(got?.status).toBe("confirmed");
    // `eventExists` is what the creation-orphan check asks, and it reads through
    // this same GET, so gating one gates both.
    await expect(eventExists(EMAIL, "slate-evt-1")).resolves.toBe(true);
  });

  it("patches the lead's details on the invite without touching Google", async () => {
    const { updateEventContact, updateEventDescription } = await import(
      "@/lib/google/calendar"
    );
    await expect(
      updateEventContact(EMAIL, "slate-evt-1", { attendeeEmail: "lead@example.com" }),
    ).resolves.toBeUndefined();
    await expect(
      updateEventDescription(EMAIL, "slate-evt-1", "a new body"),
    ).resolves.toBeUndefined();
  });
});

describe("the same calls with the flag OFF", () => {
  it("reach the network, so the assertions above are about the gate", async () => {
    // The positive control (L1). Without it every case above is satisfied by a
    // fixture where the network could never have been reached anyway.
    vi.resetModules();
    process.env.SLATE_LOADTEST = "false";
    try {
      const { createEvent, deleteEvent, updateEventTime, getEventOnPrimary } =
        await import("@/lib/google/calendar");
      await expect(createEvent(EMAIL, EVENT, "slate-x")).rejects.toThrow(NETWORK);
      await expect(deleteEvent(EMAIL, "slate-x")).rejects.toThrow(NETWORK);
      await expect(
        updateEventTime(EMAIL, "slate-x", EVENT.start, EVENT.end, EVENT.timezone),
      ).rejects.toThrow(NETWORK);
      await expect(getEventOnPrimary(EMAIL, "slate-x")).rejects.toThrow(NETWORK);
    } finally {
      process.env.SLATE_LOADTEST = "true";
      vi.resetModules();
    }
  });
});

// #3490: the stand in can take production's time. Proved through the real calendar module
// rather than only the helper, so a branch that stopped waiting is caught here as well as by
// scripts/test-loadtest-google-delay.ts's scan. Fake timers, so nothing waits for real (L524).
describe("the Google delay under SLATE_LOADTEST (#3490)", () => {
  it("holds a calendar write for the drawn delay, then answers", async () => {
    const { createEvent } = await import("@/lib/google/calendar");
    process.env.SLATE_LOADTEST_GOOGLE_DELAY = "write=5000/8000";
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      let answered: string | null = null;
      const pending = createEvent(EMAIL, EVENT, "slate-delay").then((id) => (answered = id));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(answered).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(answered).toBe("slate-delay");
    } finally {
      random.mockRestore();
      vi.useRealTimers();
      delete process.env.SLATE_LOADTEST_GOOGLE_DELAY;
    }
  });

  it("asks nothing and so waits nothing for a read of no calendars, as production answers at once", async () => {
    const { freeBusy } = await import("@/lib/google/calendar");
    process.env.SLATE_LOADTEST_GOOGLE_DELAY = "read=3000/5000";
    vi.useFakeTimers();
    try {
      // No timer is advanced: a stand in that waited here would never resolve.
      await expect(freeBusy(EMAIL, EVENT.start, EVENT.end, [])).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
      delete process.env.SLATE_LOADTEST_GOOGLE_DELAY;
    }
  });

  it("answers at once with the setting unset, as every run before it did", async () => {
    const { freeBusy } = await import("@/lib/google/calendar");
    vi.useFakeTimers();
    try {
      // No timer is advanced: a stand in that waited would never resolve here.
      await expect(freeBusy(EMAIL, EVENT.start, EVENT.end, [EMAIL])).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
