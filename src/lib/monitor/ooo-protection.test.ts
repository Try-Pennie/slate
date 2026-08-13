import { describe, it, expect, vi, beforeEach } from "vitest";

// #1467: nothing asked whether an approved time off is actually blocking
// anything. #1464 went from "availability is blocked correctly" to blocking
// nothing in 31 seconds, and the only reason anyone knows is that a person read
// three Slack messages side by side and noticed the third contradicted the
// second.
//
// This is the mirror of the availability truth probe (#1315): that one asks
// whether the times Slate OFFERS are really free, this one asks whether the
// times Slate has promised to protect are really blocked. What is under test is
// the DECISION: which measured state pages, which clears, and which states must
// do neither.
const recordConsecutiveStreak = vi.hoisted(() =>
  vi.fn(async (_key: string, _windowSeconds: number, _afterTicks: number) => false),
);
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  runOooProtectionCheck,
  unprotectedTimeOff,
  fallbackOnlyTimeOff,
  formatOooProtectionAlert,
  formatFallbackClearedRecovery,
  OOO_FALLBACK_KEY,
  OOO_PROTECTION_KEY,
  OOO_PROTECTION_ALERT_AFTER_TICKS,
  type ApprovedTimeOff,
  type CachedBusyWindow,
  type UnprotectedTimeOff,
} from "./ooo-protection";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const COOLDOWN_MS = 60 * 60_000;

const request = (over: Partial<ApprovedTimeOff> = {}): ApprovedTimeOff => ({
  id: "req-1",
  userId: "u1",
  agentName: "Brodie Davis",
  agentEmail: "brodie@trypennie.com",
  startsAt: "2026-08-14T21:00:00.000Z",
  endsAt: "2026-08-14T23:00:00.000Z",
  displayTzId: "America/New_York",
  displayTzLabel: "ET",
  agentEventId: null,
  busyBlockEffect: "ok",
  agentEventEffect: null,
  ...over,
});

const busy = (over: Partial<CachedBusyWindow> = {}): CachedBusyWindow => ({
  userId: "u1",
  startsAt: "2026-08-14T21:00:00.000Z",
  endsAt: "2026-08-14T23:00:00.000Z",
  ...over,
});

beforeEach(() => vi.clearAllMocks());

// --- the predicate: what counts as still protected --------------------------

describe("unprotectedTimeOff", () => {
  it("reports an approved future window with no calendar event and no cached busy time", () => {
    const found = unprotectedTimeOff([request()], [], NOW);

    expect(found).toHaveLength(1);
    expect(found[0]?.requestId).toBe("req-1");
    expect(found[0]?.agentName).toBe("Brodie Davis");
  });

  it("counts an agent calendar event as protection on its own", () => {
    // The event is on the agent's own calendar, so Google's own answer blocks the
    // window whether or not our cache currently mirrors it.
    const found = unprotectedTimeOff([request({ agentEventId: "evt-1" })], [], NOW);

    expect(found).toEqual([]);
  });

  it("counts a cached busy row that covers the whole window as protection", () => {
    const found = unprotectedTimeOff([request()], [busy()], NOW);

    expect(found).toEqual([]);
  });

  it("reports a window only PARTLY covered, because the rest is still bookable", () => {
    const found = unprotectedTimeOff(
      [request()],
      [busy({ endsAt: "2026-08-14T22:00:00.000Z" })],
      NOW,
    );

    expect(found).toHaveLength(1);
  });

  it("accepts two abutting rows that together cover the window", () => {
    const found = unprotectedTimeOff(
      [request()],
      [
        busy({ endsAt: "2026-08-14T22:00:00.000Z" }),
        busy({ startsAt: "2026-08-14T22:00:00.000Z" }),
      ],
      NOW,
    );

    expect(found).toEqual([]);
  });

  it("reports a gap between two rows that leave the middle of the window open", () => {
    const found = unprotectedTimeOff(
      [request()],
      [
        busy({ endsAt: "2026-08-14T21:30:00.000Z" }),
        busy({ startsAt: "2026-08-14T22:30:00.000Z" }),
      ],
      NOW,
    );

    expect(found).toHaveLength(1);
  });

  it("ignores another agent's cached busy time", () => {
    const found = unprotectedTimeOff([request()], [busy({ userId: "u2" })], NOW);

    expect(found).toHaveLength(1);
  });

  it("ignores a window that has already passed, since nothing can be booked into it", () => {
    const found = unprotectedTimeOff(
      [
        request({
          startsAt: "2026-08-13T21:00:00.000Z",
          endsAt: "2026-08-13T23:00:00.000Z",
        }),
      ],
      [],
      NOW,
    );

    expect(found).toEqual([]);
  });

  it("judges only the remaining part of a window that is already under way", () => {
    // Started an hour ago, runs two more. The first hour cannot be booked into,
    // so a row covering only the remainder is full protection.
    const inProgress = request({
      startsAt: "2026-08-14T11:00:00.000Z",
      endsAt: "2026-08-14T14:00:00.000Z",
    });
    const covered = unprotectedTimeOff(
      [inProgress],
      [busy({ startsAt: "2026-08-14T12:00:00.000Z", endsAt: "2026-08-14T14:00:00.000Z" })],
      NOW,
    );
    expect(covered).toEqual([]);

    const uncovered = unprotectedTimeOff(
      [inProgress],
      [busy({ startsAt: "2026-08-14T11:00:00.000Z", endsAt: "2026-08-14T12:00:00.000Z" })],
      NOW,
    );
    expect(uncovered).toHaveLength(1);
  });

  it("does not let an unreadable cached row stand in as protection", () => {
    // A stamp that cannot be parsed compares false against every bound, so an
    // interval built from it would silently look like whatever the arithmetic
    // landed on. It must never be the thing that says a window is covered.
    const found = unprotectedTimeOff([request()], [busy({ endsAt: "not a timestamp" })], NOW);

    expect(found).toHaveLength(1);
  });

  it("names the self sealing signature when the record still claims the block is fine", () => {
    const found = unprotectedTimeOff(
      [request({ busyBlockEffect: "ok (slate fallback)" })],
      [],
      NOW,
    );

    expect(found[0]?.claimedOk).toBe(true);
  });

  it("does not claim a self sealing signature when the record admits the write failed", () => {
    const found = unprotectedTimeOff(
      [request({ busyBlockEffect: "failed: no calendar access" })],
      [],
      NOW,
    );

    expect(found[0]?.claimedOk).toBe(false);
  });
});

// --- the copy ---------------------------------------------------------------

describe("formatOooProtectionAlert", () => {
  const found: UnprotectedTimeOff = {
    requestId: "req-1",
    userId: "u1",
    agentName: "Brodie Davis",
    agentEmail: "brodie@trypennie.com",
    startsAt: "2026-08-14T21:00:00.000Z",
    endsAt: "2026-08-14T23:00:00.000Z",
    displayTzId: "America/New_York",
    displayTzLabel: "ET",
    claimedOk: true,
  };

  it("names the agent, says a lead can be booked into it, and points at the request", () => {
    const text = formatOooProtectionAlert([found], "https://slate.test");

    expect(text).toContain("Brodie Davis");
    expect(text).toMatch(/book/i);
    expect(text).toContain("https://slate.test/admin/ooo?request=req-1");
  });

  it("says when the record still claims the block is fine, because no retry will act on it", () => {
    const text = formatOooProtectionAlert([found], "https://slate.test");

    expect(text).toMatch(/still records|still reads|claims/i);
  });

  it("carries no dash punctuation, no emoji, and leaks nothing", () => {
    const text = formatOooProtectionAlert(
      [found, { ...found, requestId: "req-2", claimedOk: false, agentName: null }],
      "https://slate.test",
    );

    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    expect(text).not.toMatch(/^Slate\b/);
  });
});

// --- the tick: which state pages, which clears, which does neither ----------

describe("runOooProtectionCheck", () => {
  const run = (
    load: () => Promise<{ requests: ApprovedTimeOff[]; blocks: CachedBusyWindow[] }>,
  ) =>
    runOooProtectionCheck({
      load,
      nowMs: NOW,
      appBaseUrl: "https://slate.test",
      cooldownMs: COOLDOWN_MS,
    });

  it("pages once the gap has persisted, naming the unprotected time off", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);

    const res = await run(async () => ({ requests: [request()], blocks: [] }));

    expect(res.status).toBe("unprotected");
    expect(res.unprotected).toBe(1);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]?.[0]).toBe(OOO_PROTECTION_KEY);
    expect(sendThrottledAlert.mock.calls[0]?.[2]).toContain("Brodie Davis");
  });

  it("stays quiet on the first tick, so a write still in flight is not a page", async () => {
    // Approval flips the status before its calendar and busy block writes land, and
    // a Google create can take seconds. A tick landing in that window sees an
    // approved request with no protection yet, which is not damage.
    recordConsecutiveStreak.mockResolvedValueOnce(false);

    const res = await run(async () => ({ requests: [request()], blocks: [] }));

    expect(res.status).toBe("unprotected");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak.mock.calls[0]?.[2]).toBe(OOO_PROTECTION_ALERT_AFTER_TICKS);
  });

  it("clears on a MEASURED all protected, and reports a verdict was reached", async () => {
    const res = await run(async () => ({
      requests: [request({ agentEventId: "evt-1" })],
      blocks: [],
    }));

    expect(res.status).toBe("clear");
    expect(res.reachedVerdict).toBe(true);
    expect(clearFailureStreak).toHaveBeenCalledWith(OOO_PROTECTION_KEY);
    expect(resolveAlert.mock.calls.map((c) => c[0])).toContain(OOO_PROTECTION_KEY);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("counts a scan that found no approved time off as a measured verdict", async () => {
    // The read succeeded and the question was answered: nothing approved can be
    // unprotected. The scanned count is reported so a permanently empty read is
    // visible in the log rather than reading as a healthy all clear.
    const res = await run(async () => ({ requests: [], blocks: [] }));

    expect(res.status).toBe("clear");
    expect(res.scanned).toBe(0);
    expect(res.reachedVerdict).toBe(true);
  });

  it("does NEITHER when the read fails: no all clear, no streak cleared, no verdict", async () => {
    // An unread worklist comes back empty, and an empty result here is
    // indistinguishable from "every time off is protected". Announcing recovery
    // off it would clear a real page at the moment the system is least able to
    // tell anyone (#1134, #1152), and stamping a verdict would report the
    // detector healthy for exactly as long as it is blind (#1394).
    const res = await run(async () => {
      throw new Error("supabase unreachable");
    });

    expect(res.status).toBe("unreadable");
    expect(res.reachedVerdict).toBe(false);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("keeps measuring when the alert dispatch itself throws", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));

    const res = await run(async () => ({ requests: [request()], blocks: [] }));

    expect(res.status).toBe("unprotected");
    expect(res.reachedVerdict).toBe(true);
  });
});

// --- records Slate never acted on (#1485) -----------------------------------
//
// Measured on production the hour this check shipped: of 35 approved periods
// still ahead of us, 10 matched, every one carrying no side effects at all
// because it was imported from the old Apps Script tool rather than approved
// through Slate. So the page fired ten times over on its first tick, none of it
// the defect it exists to catch. Select on a RECORDED outcome, never on the bare
// approved status, which is the same rule the cal.com override sweep learned
// (#1253, where 631 of 634 flag-keyed rows predated the feature).

describe("requests Slate never acted on", () => {
  const imported = request({ busyBlockEffect: null, agentEventId: null });

  it("is not reported as unprotected, because Slate never wrote its cover", () => {
    expect(unprotectedTimeOff([imported], [], NOW)).toEqual([]);
  });

  it("is still counted, so the exclusion is never silent", async () => {
    const logged: Record<string, unknown>[] = [];
    const res = await runOooProtectionCheck({
      load: async () => ({ requests: [imported], blocks: [] }),
      nowMs: NOW,
      appBaseUrl: "https://slate.test",
      cooldownMs: COOLDOWN_MS,
      log: (f) => logged.push(f),
    });

    expect(res.notHandled).toBe(1);
    expect(logged[0]?.not_handled).toBe(1);
  });

  it("still reports one Slate DID act on, in the same scan", () => {
    // Both directions, or the exclusion could be hiding everything (L1). The
    // recorded "ok" over a cover that is gone is exactly #1464.
    const slateWrote = request({
      id: "req-2",
      userId: "u2",
      busyBlockEffect: "ok (slate fallback)",
    });

    const out = unprotectedTimeOff([imported, slateWrote], [], NOW);

    expect(out.map((f) => f.requestId)).toEqual(["req-2"]);
  });

  it("judges one whose recorded outcome is a FAILURE, which is a real gap", () => {
    const failed = request({ busyBlockEffect: "failed: no calendar access" });

    expect(unprotectedTimeOff([failed], [], NOW)).toHaveLength(1);
  });

  it("judges one that only recorded a calendar event attempt", () => {
    // A request whose agent_event step ran and failed, with no busy_block entry
    // yet, is still one Slate acted on.
    const attempted = request({ agentEventEffect: "failed: aborted" });

    expect(unprotectedTimeOff([attempted], [], NOW)).toHaveLength(1);
  });
});

// --- the fallback condition, and its all-clear (#1470) ----------------------
//
// `ooo_busy_block_fallback` was classified as an incident, so it could never
// retract itself. Its text said "Availability is blocked correctly; flagging the
// fallback", which in #1464 was true for 31 seconds and false forever after, and
// the reader's last word on that time off was a claim that had quietly gone
// false. It is a condition: it ends when nothing is relying on the Slate block
// any more, either because the calendar event was created or because the window
// has passed.

describe("fallbackOnlyTimeOff", () => {
  it("reports an approved window covered only by cached busy time, with no calendar event", () => {
    const found = fallbackOnlyTimeOff([request()], [busy()], NOW);

    expect(found).toHaveLength(1);
    expect(found[0]?.requestId).toBe("req-1");
  });

  it("does not report one whose calendar event exists", () => {
    const found = fallbackOnlyTimeOff([request({ agentEventId: "evt-1" })], [busy()], NOW);

    expect(found).toEqual([]);
  });

  it("does not report one that is blocking nothing at all, which is the other alert", () => {
    // Two different conditions with two different remedies: this one is degraded
    // but working, that one is a window a lead can be booked into.
    expect(fallbackOnlyTimeOff([request()], [], NOW)).toEqual([]);
    expect(unprotectedTimeOff([request()], [], NOW)).toHaveLength(1);
  });

  it("does not report a window that has already passed", () => {
    const found = fallbackOnlyTimeOff(
      [request({ startsAt: "2026-08-13T21:00:00.000Z", endsAt: "2026-08-13T23:00:00.000Z" })],
      [busy({ startsAt: "2026-08-13T21:00:00.000Z", endsAt: "2026-08-13T23:00:00.000Z" })],
      NOW,
    );

    expect(found).toEqual([]);
  });
});

describe("the fallback all-clear", () => {
  const run = (
    load: () => Promise<{ requests: ApprovedTimeOff[]; blocks: CachedBusyWindow[] }>,
  ) =>
    runOooProtectionCheck({
      load,
      nowMs: NOW,
      appBaseUrl: "https://slate.test",
      cooldownMs: COOLDOWN_MS,
    });

  it("clears the fallback notice once nothing is relying on the Slate block", async () => {
    await run(async () => ({
      requests: [request({ agentEventId: "evt-1" })],
      blocks: [busy()],
    }));

    expect(resolveAlert.mock.calls.map((c) => c[0])).toContain(OOO_FALLBACK_KEY);
  });

  it("stays quiet while a window is still relying on it", async () => {
    await run(async () => ({ requests: [request()], blocks: [busy()] }));

    expect(resolveAlert.mock.calls.map((c) => c[0])).not.toContain(OOO_FALLBACK_KEY);
  });

  it("does not clear it from a read that FAILED", async () => {
    // The #1134 / #1152 defect: an unread list comes back empty, and an empty
    // result here is indistinguishable from "nothing is relying on the fallback".
    await run(async () => {
      throw new Error("supabase unreachable");
    });

    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("clears it even while a DIFFERENT window is unprotected", async () => {
    // Two independent conditions must not share one status (L53): a window
    // blocking nothing at all is not a reason to keep saying something is
    // relying on the fallback.
    await run(async () => ({
      requests: [request({ id: "req-2", userId: "u2" })],
      blocks: [],
    }));

    expect(resolveAlert.mock.calls.map((c) => c[0])).toContain(OOO_FALLBACK_KEY);
  });

  it("says what is no longer true, without claiming a repair it did not measure", () => {
    const text = formatFallbackClearedRecovery();

    expect(text).toMatch(/no action is needed/i);
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
  });
});
