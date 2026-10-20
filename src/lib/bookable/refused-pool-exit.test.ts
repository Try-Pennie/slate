import { describe, it, expect, vi, beforeEach } from "vitest";

// #3700: an advisor whose Google calendar is definitively refused (the account was
// archived, unlicensed or removed) for a sustained period is taken out of the pool by
// the sync lane, through the owned routable write, and Slack is told. Driven through
// injected deps: the store below applies the write's compare and swap itself, so
// "the second run changed nothing" is decided by the store, not by a flag (L70).

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import {
  REFUSED_POOL_EXIT_AFTER_MS,
  REFUSED_POOL_EXIT_MIN_FAILED_READS,
  isRefusedThroughoutPeriod,
  refusedAdvisorIds,
  takeRefusedAdvisorsOutOfPool,
  type RefusedCalendarRow,
  type RefusedAdvisorRow,
  type RefusedPoolExitDeps,
} from "./refused-pool-exit";
import { GONE_BACKOFF_STREAK } from "@/lib/google/sync-coalesce";

const NOW = Date.parse("2026-10-20T15:00:00.000Z");
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function cal(over: Partial<RefusedCalendarRow> = {}): RefusedCalendarRow {
  return {
    user_id: "u-1",
    calendar_id: "dana@trypennie.com",
    consecutive_failures: 9,
    last_success_at: ago(2 * HOUR),
    last_failure_kind: "not-provisioned",
    ...over,
  };
}

function advisor(over: Partial<RefusedAdvisorRow> = {}): RefusedAdvisorRow {
  return {
    id: "u-1",
    name: "Dana Whitfield",
    email: "dana@trypennie.com",
    org_id: "org-1",
    bookable: true,
    deactivated_at: null,
    manager_name: "Morgan Lee",
    ...over,
  };
}

function harness(opts: {
  calendars?: RefusedCalendarRow[] | null;
  advisors?: RefusedAdvisorRow[] | null;
  pools?: string[] | Error;
  holdOutError?: Error;
} = {}) {
  const bookable = new Map<string, boolean>();
  for (const a of opts.advisors === undefined ? [advisor()] : opts.advisors ?? []) bookable.set(a.id, a.bookable);
  const writes: { userId: string; stampIso: string }[] = [];
  const posts: { key: string; cooldownMs: number; text: string }[] = [];
  const audits: { targetUserId: string; details: Record<string, unknown> }[] = [];
  const deps: RefusedPoolExitDeps = {
    loadCalendars: vi.fn(async () => (opts.calendars === undefined ? [cal()] : opts.calendars)),
    loadAdvisors: vi.fn(async () => (opts.advisors === undefined ? [advisor()] : opts.advisors)),
    poolsOnlyThem: vi.fn(async () => {
      if (opts.pools instanceof Error) throw opts.pools;
      return opts.pools === undefined ? [] : opts.pools;
    }),
    holdOut: vi.fn(async (userId: string, stampIso: string) => {
      if (opts.holdOutError) throw opts.holdOutError;
      // The owned write's compare and swap: only a bookable row changes.
      if (bookable.get(userId) !== true) return false;
      bookable.set(userId, false);
      writes.push({ userId, stampIso });
      return true;
    }),
    audit: vi.fn(async (e) => {
      audits.push({ targetUserId: e.targetUserId ?? "", details: e.details ?? {} });
    }),
    notify: vi.fn(async (key: string, cooldownMs: number, text: string) => {
      posts.push({ key, cooldownMs, text });
    }),
    now: () => NOW,
  };
  return { deps, writes, posts, audits, bookable };
}

beforeEach(() => vi.clearAllMocks());

describe("the period rule, one calendar at a time", () => {
  it("is several reads, more than the backoff's own streak", () => {
    expect(REFUSED_POOL_EXIT_MIN_FAILED_READS).toBeGreaterThan(GONE_BACKOFF_STREAK);
    expect(REFUSED_POOL_EXIT_AFTER_MS).toBe(HOUR);
  });

  it("a calendar refused since before the period, on several reads, counts", () => {
    expect(isRefusedThroughoutPeriod(cal(), NOW)).toBe(true);
    expect(isRefusedThroughoutPeriod(cal({ last_failure_kind: "gone" }), NOW)).toBe(true);
  });

  it("the period must have fully passed since the last good read", () => {
    expect(isRefusedThroughoutPeriod(cal({ last_success_at: ago(HOUR) }), NOW)).toBe(true);
    expect(isRefusedThroughoutPeriod(cal({ last_success_at: ago(HOUR - 1) }), NOW)).toBe(false);
  });

  it("one failed read is not a measured period, however old the last good read", () => {
    expect(isRefusedThroughoutPeriod(cal({ consecutive_failures: 1 }), NOW)).toBe(false);
    expect(
      isRefusedThroughoutPeriod(cal({ consecutive_failures: REFUSED_POOL_EXIT_MIN_FAILED_READS - 1 }), NOW),
    ).toBe(false);
    expect(
      isRefusedThroughoutPeriod(cal({ consecutive_failures: REFUSED_POOL_EXIT_MIN_FAILED_READS }), NOW),
    ).toBe(true);
  });

  it("a transient failure never counts, however long it runs", () => {
    expect(isRefusedThroughoutPeriod(cal({ last_failure_kind: "transient", consecutive_failures: 90 }), NOW)).toBe(false);
  });

  it("an unclassified failure is not acted on: nothing says what kind it was", () => {
    expect(isRefusedThroughoutPeriod(cal({ last_failure_kind: null }), NOW)).toBe(false);
  });

  it("an old failure followed by a good read is healthy", () => {
    expect(
      isRefusedThroughoutPeriod(
        cal({ consecutive_failures: 0, last_failure_kind: null, last_success_at: ago(60_000) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("a calendar that never read cleanly has no measured period, so it is left alone", () => {
    expect(isRefusedThroughoutPeriod(cal({ last_success_at: null }), NOW)).toBe(false);
    expect(isRefusedThroughoutPeriod(cal({ last_success_at: "not a date" }), NOW)).toBe(false);
  });
});

describe("the advisor rule: every calendar they hold", () => {
  it("an advisor whose only calendar is refused is named", () => {
    expect(refusedAdvisorIds([cal()], NOW)).toEqual(["u-1"]);
  });

  it("a failing secondary calendar beside a good primary leaves them in", () => {
    const primary = cal({ consecutive_failures: 0, last_failure_kind: null, last_success_at: ago(60_000) });
    const secondary = cal({ calendar_id: "team@group.calendar.google.com", last_failure_kind: "gone" });
    expect(refusedAdvisorIds([primary, secondary], NOW)).toEqual([]);
  });

  it("two refused calendars name the advisor once", () => {
    expect(refusedAdvisorIds([cal(), cal({ calendar_id: "other@trypennie.com" })], NOW)).toEqual(["u-1"]);
  });
});

describe("taking them out", () => {
  it("an advisor refused for longer than the period is made not bookable and Slack is told", async () => {
    const h = harness();
    const result = await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps);
    expect(result).toEqual({ removed: ["u-1"] });
    expect(h.writes).toEqual([{ userId: "u-1", stampIso: new Date(NOW).toISOString() }]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.key).toBe("refused_advisor_left_pool:u-1");
    expect(h.posts[0]!.text).toContain("Dana Whitfield");
    expect(h.posts[0]!.text).toContain("dana@trypennie.com");
    expect(h.posts[0]!.text).toContain("Morgan Lee");
    expect(h.posts[0]!.text).toMatch(/taken out of the booking pool/);
    expect(h.audits).toEqual([
      {
        targetUserId: "u-1",
        details: expect.objectContaining({ bookable: false, via: "calendar-refused", failure: "not-provisioned" }),
      },
    ]);
  });

  it("a single failed read leaves them bookable", async () => {
    const h = harness({ calendars: [cal({ consecutive_failures: 1 })] });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: [] });
    expect(h.writes).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  it("a transient failure leaves them bookable", async () => {
    const h = harness({ calendars: [cal({ last_failure_kind: "transient", consecutive_failures: 60 })] });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: [] });
    expect(h.writes).toEqual([]);
  });

  it("a stale old failure followed by a good read leaves them bookable", async () => {
    const h = harness({
      calendars: [cal({ consecutive_failures: 0, last_failure_kind: null, last_success_at: ago(30_000) })],
    });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: [] });
    expect(h.writes).toEqual([]);
  });

  it("a failing secondary calendar with a good primary leaves them bookable", async () => {
    const h = harness({
      calendars: [
        cal({ consecutive_failures: 0, last_failure_kind: null, last_success_at: ago(30_000) }),
        cal({ calendar_id: "team@group.calendar.google.com", last_failure_kind: "gone", consecutive_failures: 40 }),
      ],
    });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: [] });
    expect(h.writes).toEqual([]);
  });

  it("a failed health read changes nothing and answers unknown, not empty", async () => {
    const h = harness({ calendars: null });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toBeNull();
    expect(h.deps.loadAdvisors).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  it("a failed advisor read changes nothing and answers unknown", async () => {
    const h = harness({ advisors: null });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  it("running twice writes once and posts once", async () => {
    const h = harness();
    await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps);
    const second = await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps);
    expect(second).toEqual({ removed: [] });
    expect(h.writes).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("two overlapping runs that both read the advisor as bookable still write and post once", async () => {
    const h = harness();
    // Both runs read before either writes: the store's compare and swap decides.
    await Promise.all([
      takeRefusedAdvisorsOutOfPool(["u-1"], h.deps),
      takeRefusedAdvisorsOutOfPool(["u-1"], h.deps),
    ]);
    expect(h.writes).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
  });

  it("an advisor already out of the pool, or departed, is left alone", async () => {
    const h = harness({
      advisors: [advisor({ bookable: false }), advisor({ id: "u-2", deactivated_at: ago(HOUR) })],
      calendars: [cal(), cal({ user_id: "u-2" })],
    });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1", "u-2"], h.deps)).toEqual({ removed: [] });
    expect(h.deps.holdOut).not.toHaveBeenCalled();
    expect(h.posts).toEqual([]);
  });

  it("removing the last bookable advisor of a pool still removes them, and says so", async () => {
    const h = harness({ pools: ["Low Beyond", "Medium Beyond"] });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: ["u-1"] });
    expect(h.posts[0]!.text).toContain("Low Beyond");
    expect(h.posts[0]!.text).toContain("Medium Beyond");
    expect(h.posts[0]!.text).toMatch(/nobody bookable/i);
  });

  it("a pool check that could not be made still removes them, and says it could not check", async () => {
    const h = harness({ pools: new Error("buckets read failed") });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: ["u-1"] });
    expect(h.posts[0]!.text).toMatch(/could not check/i);
  });

  it("a refused write posts nothing for that advisor and carries on with the rest", async () => {
    const h = harness({ holdOutError: new Error("permission denied") });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: [] });
    expect(h.posts).toEqual([]);
    expect(logged.error).toHaveBeenCalled();
  });

  it("a Slack send that throws does not undo or hide the removal", async () => {
    const h = harness();
    h.deps.notify = vi.fn(async () => {
      throw new Error("slack down");
    });
    expect(await takeRefusedAdvisorsOutOfPool(["u-1"], h.deps)).toEqual({ removed: ["u-1"] });
    expect(h.writes).toHaveLength(1);
    expect(logged.error).toHaveBeenCalled();
  });

  it("nobody failing this tick reads nothing at all", async () => {
    const h = harness();
    expect(await takeRefusedAdvisorsOutOfPool([], h.deps)).toEqual({ removed: [] });
    expect(h.deps.loadCalendars).not.toHaveBeenCalled();
  });
});
