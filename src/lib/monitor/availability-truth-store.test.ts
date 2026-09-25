import { describe, it, expect, vi, beforeEach } from "vitest";

// The live-Google half of the availability-truth probe (#1315).
//
// What matters here is the ESCALATION and which way each unknown falls. A slot
// is offered because SOME eligible agent was believed free, so finding one
// genuinely free agent settles it in a single Google call, and only a suspected
// disagreement is worth spending the rest of the shared subrequest budget on.
//
// And the direction of every failure: an unreadable calendar must leave the slot
// unverified, never "drift". Scoring Google's own errors as drift would turn a
// Google blip into a page about our cache.

const supabaseAdmin = vi.hoisted(() => vi.fn());
const freeBusyMany = vi.hoisted(() => vi.fn());
const calendarsForEmails = vi.hoisted(() => vi.fn());
const freeAgentsFromBusy = vi.hoisted(() => vi.fn());
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/google/calendar", () => ({ freeBusyMany }));
vi.mock("@/lib/booking/service", () => ({ calendarsForEmails, FREEBUSY_MAX_ITEMS: 20 }));
vi.mock("@/lib/booking/core", () => ({ freeAgentsFromBusy }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin }));
vi.mock("@/lib/log", () => ({ log }));

import { verifySlotLive, verifyWindowsLive, driftAlertContext } from "./availability-truth-store";

const START = "2026-08-11T14:00:00.000Z";
const END = "2026-08-11T14:30:00.000Z";

/** 25 agents: two chunks at the 20-calendar cap, so escalation is observable. */
const MANY = Array.from({ length: 25 }, (_, i) => `a${i}@x`);

beforeEach(() => {
  vi.clearAllMocks();
  calendarsForEmails.mockImplementation(async (emails: string[]) => ({
    byEmail: new Map(emails.map((e) => [e, [e]])),
    readFailed: new Set<string>(),
  }));
  freeBusyMany.mockResolvedValue(new Map());
});

describe("verifySlotLive", () => {
  it("reads every chunk of the eligible set, with no early stop", async () => {
    // There is nothing to escalate over a RANGE: a later offered time may need
    // exactly the chunk an earlier one would have let us skip, so every chunk is
    // read once and every window is then judged against the same read.
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("free");
    expect(freeBusyMany).toHaveBeenCalledTimes(2);
  });

  it("judges the whole eligible set at once, not one chunk at a time", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a22@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("free");
    // One verdict from one judging call over all 25 agents: a per-chunk verdict
    // could call a slot drifted on the strength of the chunk it happened to see.
    expect(freeAgentsFromBusy).toHaveBeenCalledTimes(1);
    expect(freeAgentsFromBusy.mock.calls[0][0]).toHaveLength(MANY.length);
  });

  it("reports drift only when EVERY eligible agent read cleanly and none is free", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("drift");
    expect(freeBusyMany).toHaveBeenCalledTimes(2);
  });

  it("reports unverified when an agent's calendar could not be read", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set(["a3@x"]) });
    // The unread agent may well be free, so this is not evidence of drift.
    expect(await verifySlotLive(MANY, START, END)).toBe("unverified");
  });

  it("reports unverified when the users/calendars lookup failed for anyone", async () => {
    calendarsForEmails.mockResolvedValue({
      byEmail: new Map([["a0@x", ["a0@x"]]]),
      readFailed: new Set(["a1@x"]),
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    expect(await verifySlotLive(["a0@x", "a1@x"], START, END)).toBe("unverified");
  });

  it("reports unverified when Google throws, rather than letting an outage read as drift", async () => {
    freeBusyMany.mockRejectedValue(new Error("backendError"));
    expect(await verifySlotLive(["a0@x"], START, END)).toBe("unverified");
  });

  it("asks Google about the booking's whole window", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifySlotLive(["a0@x"], START, END);
    expect(freeBusyMany).toHaveBeenCalledWith(expect.any(String), START, END, ["a0@x"]);
  });

  it("reports unverified when the slot window itself is unreadable", async () => {
    // A NaN bound would make every busy interval fail the overlap test, so every
    // agent would read FREE and the probe would quietly report no drift. That is
    // the guard silently passing, which is worse here than an error.
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(["a0@x"], "not-a-timestamp", END)).toBe("unverified");
    expect(await verifySlotLive(["a0@x"], START, "")).toBe("unverified");
    expect(freeBusyMany).not.toHaveBeenCalled();
  });

  it("reports unverified for an empty eligible set rather than a vacuous drift", async () => {
    // No agents means no free agent, which is trivially true and says nothing
    // about the cache. The caller screens this out; the guard is defence in depth.
    expect(await verifySlotLive([], START, END)).toBe("unverified");
    expect(freeBusyMany).not.toHaveBeenCalled();
  });
});


// --- driftAlertContext (#1373): an unread state is NOT an empty set ---
//
// The whole aggregation rests on this. An empty set is the positive claim
// "nothing else is drifting", which suppresses the combined page and, on a
// healthy verdict, all-clears a condition still true off a read that never
// happened. The two shared helpers in notify/dispatch degrade a failed read to
// an empty set deliberately, which is right for their callers and exactly wrong
// here, so this reads strictly and the failure has to surface as null (L10/L11).

/** A supabase double whose `alert_state` read can be made to fail. */
function dbWith(opts: { buckets?: { code: string }[]; keys?: string[]; alertError?: string }) {
  return () => ({
    from: (table: string) => {
      if (table === "buckets") {
        const res = { data: opts.buckets ?? [{ code: "101" }, { code: "202" }], error: null };
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => Promise.resolve(res),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        in: () =>
          Promise.resolve(
            opts.alertError
              ? { data: null, error: { message: opts.alertError } }
              : { data: (opts.keys ?? []).map((key) => ({ key })), error: null },
          ),
      };
      return chain;
    },
  });
}

describe("driftAlertContext", () => {
  it("returns null when the alert state cannot be read, never an empty set", async () => {
    supabaseAdmin.mockImplementation(dbWith({ alertError: "column key does not exist" }));
    expect(await driftAlertContext()).toBeNull();
  });

  it("reports a genuinely empty state as empty, so a quiet system is not mistaken for a broken read", async () => {
    supabaseAdmin.mockImplementation(dbWith({ keys: [] }));
    const ctx = await driftAlertContext();
    expect(ctx).toEqual({
      seenDrifting: [],
      perBucketFiring: [],
      aggregateFiring: false,
      totalBuckets: 2,
    });
  });

  it("separates the drift markers from the firing pages and the aggregate", async () => {
    supabaseAdmin.mockImplementation(
      dbWith({
        keys: [
          "availability_drift_seen:101",
          "availability_drift_seen:202",
          "alert_firing:availability_drift:101",
          "alert_firing:availability_drift:all",
        ],
      }),
    );
    const ctx = await driftAlertContext();
    expect(ctx).toEqual({
      seenDrifting: ["101", "202"],
      perBucketFiring: ["101"],
      aggregateFiring: true,
      totalBuckets: 2,
    });
  });

  it("ignores a marker for a bucket no longer on the ladder, so it cannot keep the aggregate alive", async () => {
    supabaseAdmin.mockImplementation(
      dbWith({ buckets: [{ code: "101" }], keys: ["availability_drift_seen:999"] }),
    );
    const ctx = await driftAlertContext();
    expect(ctx?.seenDrifting).toEqual([]);
  });

  it("returns null when there are no buckets to rotate over", async () => {
    supabaseAdmin.mockImplementation(dbWith({ buckets: [] }));
    expect(await driftAlertContext()).toBeNull();
  });
});


// --- verifyWindowsLive (#1381): every offered time, from ONE range read ---
//
// The whole point of full coverage. `freeBusy` is a range query, so the number
// of Google calls is set by how many CALENDAR chunks there are, never by how
// many offered times are being judged.

describe("verifyWindowsLive", () => {
  const win = (h: number) => ({
    startIso: `2026-08-11T${String(h).padStart(2, "0")}:00:00.000Z`,
    endIso: `2026-08-11T${String(h).padStart(2, "0")}:30:00.000Z`,
  });

  it("judges many windows from a single read per calendar chunk", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    const windows = [win(9), win(10), win(11), win(12), win(13), win(14)];
    const out = await verifyWindowsLive(["a0@x"], windows);
    expect(out).toEqual(["free", "free", "free", "free", "free", "free"]);
    // Six windows, ONE Google call. This is the assertion the issue exists for.
    expect(freeBusyMany).toHaveBeenCalledTimes(1);
    expect(freeAgentsFromBusy).toHaveBeenCalledTimes(windows.length);
  });

  it("reads the range spanning every window, so no window falls outside it", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(["a0@x"], [win(9), win(17)]);
    expect(freeBusyMany).toHaveBeenCalledWith(
      expect.any(String),
      "2026-08-11T09:00:00.000Z",
      "2026-08-11T17:30:00.000Z",
      ["a0@x"],
    );
  });

  it("spans the range even when the windows arrive out of order", async () => {
    // Taking the ends rather than the min and max would read a backwards range
    // and Google would answer for nothing at all, which reads as everyone free.
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(["a0@x"], [win(17), win(9)]);
    expect(freeBusyMany).toHaveBeenCalledWith(
      expect.any(String),
      "2026-08-11T09:00:00.000Z",
      "2026-08-11T17:30:00.000Z",
      ["a0@x"],
    );
  });

  it("returns one verdict per window, in the order given", async () => {
    freeAgentsFromBusy
      .mockReturnValueOnce({ free: new Set(["a0@x"]), needsFallback: new Set() })
      .mockReturnValueOnce({ free: new Set(), needsFallback: new Set() })
      .mockReturnValueOnce({ free: new Set(), needsFallback: new Set(["a0@x"]) });
    const out = await verifyWindowsLive(["a0@x"], [win(9), win(10), win(11)]);
    expect(out).toEqual(["free", "drift", "unverified"]);
  });

  it("returns null when the range could not be read at all", async () => {
    // Not a list of "unverified": null means nothing was compared, which the
    // caller reports as its own outcome rather than as a sample of bad slots.
    freeBusyMany.mockRejectedValue(new Error("backendError"));
    expect(await verifyWindowsLive(["a0@x"], [win(9), win(10)])).toBeNull();
  });

  it("returns null when no agent maps to a calendar", async () => {
    calendarsForEmails.mockResolvedValue({ byEmail: new Map(), readFailed: new Set(["a0@x"]) });
    expect(await verifyWindowsLive(["a0@x"], [win(9)])).toBeNull();
  });

  it("holds back drift for an agent whose calendar list could not be read", async () => {
    calendarsForEmails.mockResolvedValue({
      byEmail: new Map([["a0@x", ["a0@x"]]]),
      readFailed: new Set(["a1@x"]),
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    // The unread agent may well be free, on EVERY window, so none of them can be
    // called drift however cleanly the rest read.
    expect(await verifyWindowsLive(["a0@x", "a1@x"], [win(9), win(10)])).toEqual([
      "unverified",
      "unverified",
    ]);
  });

  it("marks only the unreadable window unverified, leaving the rest judged", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    const out = await verifyWindowsLive(["a0@x"], [
      win(9),
      { startIso: "not-a-timestamp", endIso: "also-not" },
      win(11),
    ]);
    expect(out).toEqual(["drift", "unverified", "drift"]);
  });

  it("asks Google nothing when there are no windows", async () => {
    expect(await verifyWindowsLive(["a0@x"], [])).toEqual([]);
    expect(freeBusyMany).not.toHaveBeenCalled();
  });
});


// --- the delegated SUBJECT, and why one bad account must not blind the probe ---
//
// A batched freeBusy is read as one agent's identity. If that agent's own
// account cannot use Calendar, Google refuses the WHOLE call (403
// notACalendarUser), not just their calendar, so the probe reports every offered
// time unverified and goes silent. That is not hypothetical: on 2026-08-11 the
// alphabetically first agent in the real roster was exactly this, so the
// alphabetically-first subject picked the one account guaranteed to fail.
//
// The booking path survives this because a total bulk failure there falls back
// to per-agent checks. The probe had no fallback at all.

describe("readAgentBusyRange subject selection", () => {
  const RANGE = ["2026-08-11T09:00:00.000Z", "2026-08-11T17:00:00.000Z"] as const;

  it("moves to another subject when the first one's account cannot use Calendar", async () => {
    const notACalendarUser = Object.assign(new Error("freeBusy.many failed: 403"), {
      status: 403,
      reason: "notACalendarUser",
    });
    freeBusyMany.mockImplementation(async (subject: string) => {
      if (subject === "a0@x") throw notACalendarUser;
      return new Map([["a0@x", { busy: [], error: false }]]);
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a1@x"]), needsFallback: new Set() });
    const out = await verifyWindowsLive(["a0@x", "a1@x"], [
      { startIso: RANGE[0], endIso: RANGE[1] },
    ]);
    expect(out).toEqual(["free"]);
    // It retried as a DIFFERENT identity rather than giving up on the bucket.
    expect(freeBusyMany.mock.calls.map((c) => c[0])).toEqual(["a0@x", "a1@x"]);
  });

  it("returns null when every candidate subject is refused", async () => {
    // Still fails safe: a range nobody could read says nothing about the cache,
    // so it must not present as a set of clean slots.
    freeBusyMany.mockRejectedValue(new Error("403 notACalendarUser"));
    expect(
      await verifyWindowsLive(["a0@x", "a1@x"], [{ startIso: RANGE[0], endIso: RANGE[1] }]),
    ).toBeNull();
  });

  it("does not walk the whole roster looking for a working subject", async () => {
    // A genuine Google outage refuses every subject, and retrying 200 times
    // would spend the lane's whole budget discovering that.
    freeBusyMany.mockRejectedValue(new Error("503 backendError"));
    const many = Array.from({ length: 30 }, (_, i) => `b${i}@x`);
    expect(await verifyWindowsLive(many, [{ startIso: RANGE[0], endIso: RANGE[1] }])).toBeNull();
    const subjects = new Set(freeBusyMany.mock.calls.map((c) => c[0]));
    expect(subjects.size).toBeLessThanOrEqual(3);
  });

  it("chunks by CALENDAR, not by agent, since that is the unit Google caps", async () => {
    // freeBusy accepts at most 20 calendars per call. Chunking 20 AGENTS at a
    // time sends 20 times however many calendars each of them has, so a roster
    // where anyone has two calendars silently overflows the cap (L81: size the
    // batch in the unit the limit is actually expressed in).
    const agents = Array.from({ length: 15 }, (_, i) => `c${i}@x`);
    calendarsForEmails.mockResolvedValue({
      byEmail: new Map(agents.map((e) => [e, [`${e}/primary`, `${e}/secondary`]])),
      readFailed: new Set<string>(),
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["c0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(agents, [{ startIso: RANGE[0], endIso: RANGE[1] }]);
    const perCall = freeBusyMany.mock.calls.map((c) => (c[3] as string[]).length);
    expect(perCall.every((n) => n <= 20)).toBe(true);
    expect(perCall.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("costs one attempt when the first subject works", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(["a0@x", "a1@x"], [{ startIso: RANGE[0], endIso: RANGE[1] }]);
    expect(freeBusyMany).toHaveBeenCalledTimes(1);
  });
});

// #1397: the range read costs one Google call per 20 CALENDARS in a bucket's
// eligible set, so it grows with the roster rather than with anything the tick
// samples. Measured 2026-09-25 the largest pool (79 calendars) costs 4 calls
// against the 5 of the shape #1381 replaced; past 100 calendars it costs more.
// The lane shares its budget with three others and a cost drift there once took
// three days to surface somewhere else (#1245), so every read says what it spent.
describe("readAgentBusyRange cost", () => {
  const WINDOW = [{ startIso: "2026-08-11T09:00:00.000Z", endIso: "2026-08-11T17:00:00.000Z" }];
  const costLine = () =>
    log.info.mock.calls.find((c) => (c[1] as { msg?: string }).msg === "range read")?.[1];

  it("logs the calendars read and the Google calls spent", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(MANY, WINDOW);
    expect(costLine()).toEqual({
      msg: "range read",
      calendars: 25,
      google_calls: 2,
      subjects_tried: 1,
    });
  });

  it("counts the calls a refused subject spent, not only the read that worked", async () => {
    // A subject refused on its SECOND chunk has already spent one call, so a
    // count taken from the successful attempt alone would under-report.
    let calls = 0;
    freeBusyMany.mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error("403 notACalendarUser");
      return new Map();
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifyWindowsLive(MANY, WINDOW);
    expect(costLine()).toMatchObject({ calendars: 25, google_calls: 4, subjects_tried: 2 });
  });

  it("logs nothing about cost when no read succeeded", async () => {
    freeBusyMany.mockRejectedValue(new Error("503 backendError"));
    expect(await verifyWindowsLive(MANY, WINDOW)).toBeNull();
    expect(costLine()).toBeUndefined();
  });
});
