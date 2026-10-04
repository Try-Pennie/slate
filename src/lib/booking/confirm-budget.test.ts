import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3102: the WORST CASE of a confirm, not one call's. The confirm makes many
// Supabase reads and a few Google calls in a row, so per request deadlines alone
// add up past the booker's 20 second abort and the lead sees the browser give up
// instead of our retryable 503. This drives the real Supabase client and the real
// Google calls against a dependency that answers every request just inside its
// own limit (7.9s, the slowest statement measured on production), on fake timers,
// and measures how long the whole sequence can hold the lead.

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  appUrl: () => "https://x.test",
  publicSupabaseUrl: () => "https://x.test",
  supabaseSecretKey: () => "sb_secret_test",
  googlePushUrl: () => "https://x.test/push",
  googleChannelToken: () => "t",
  slackBotToken: () => "xoxb-test",
}));
const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);
// The real service boundary, with the booking itself replaced by the confirm
// shaped sequence and the page's send replaced by the read it starts with, so
// the path below is the service's own: the work fails, the outage page is sent,
// and only then does the route's failure path run.
const orchestrationCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/orchestration")>()),
  createBooking: orchestrationCreate,
}));
const pageSends = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/notify/dispatch", async () => {
  const { supabaseAdmin: admin } = await import("@/lib/supabase/admin");
  return {
    resolveRecovered: vi.fn(),
    sendThrottledAlert: async () => {
      pageSends.count++;
      // The throttle's alert_state read, against the same slow dependency.
      await admin().from("alert_state").select("key");
    },
  };
});

import {
  BOOKING_CONFIRM_BUDGET_MS,
  BOOKING_CLEANUP_BUDGET_MS,
  BOOKING_CONFIRM_WORST_CASE_MS,
  withinBookingCleanupBudget,
  withinBookingConfirmBudget,
} from "./confirm-budget";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { createEvent, freeBusyMany } from "@/lib/google/calendar";
import { REQUEST_TIMEOUT_MS } from "@/lib/http";
import { postSlack } from "@/lib/notify/slack";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { createBooking, VerifyUnavailableError, type CreateBookingInput } from "@/lib/booking/service";

const SLOW_MS = 7_900;

/** A confirm shaped sequence: reads, verify, insert, one after another. */
async function confirmShapedWork() {
  for (let i = 0; i < 6; i++) unwrap(await supabaseAdmin().from("buckets").select("id"), "read");
  await freeBusyMany("ops@x.com", "2026-07-01T15:00:00Z", "2026-07-01T15:30:00Z", ["a@x.com"]);
  await createEvent("a@x.com", {
    summary: "s",
    start: "2026-07-01T15:00:00Z",
    end: "2026-07-01T15:30:00Z",
    timezone: "America/New_York",
  });
}

/** Run `work`, advancing fake time until it settles; how long it held, and how it ended. */
async function measure(work: () => Promise<unknown>) {
  const startedAt = Date.now();
  let settledAt: number | null = null;
  let outcome: unknown = "pending";
  work().then(
    () => {
      settledAt = Date.now();
      outcome = "resolved";
    },
    (e: unknown) => {
      settledAt = Date.now();
      outcome = e;
    },
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(settledAt).not.toBeNull();
  return { heldMs: (settledAt as unknown as number) - startedAt, outcome };
}

describe("the confirm path's worst case (#3102)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dwd.getDelegatedToken.mockResolvedValue("tok");
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response("[]", { status: 200 })), SLOW_MS),
        ),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves the booker's abort a margin of at least five seconds", () => {
    expect(BOOKING_CONFIRM_WORST_CASE_MS).toBe(BOOKING_CONFIRM_BUDGET_MS + BOOKING_CLEANUP_BUDGET_MS);
    expect(BOOKING_CONFIRM_WORST_CASE_MS + 5_000).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  it("CONTROL: without the budget the same sequence holds the lead far past the abort", async () => {
    const { heldMs } = await measure(confirmShapedWork);
    expect(heldMs).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it("inside the budget the sequence ends by the budget, as a recognisable timeout", async () => {
    const { heldMs, outcome } = await measure(() => withinBookingConfirmBudget(confirmShapedWork));
    expect(heldMs).toBeLessThanOrEqual(BOOKING_CONFIRM_BUDGET_MS);
    expect(isDeadlineExceeded(outcome)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("and the cleanup after it is bounded too, so the whole path fits its worst case", async () => {
    const { heldMs } = await measure(() =>
      withinBookingConfirmBudget(async () => {
        await confirmShapedWork().catch(() => {});
        // The refunds a timed out confirm still owes the lead, three in a row.
        await withinBookingCleanupBudget(async () => {
          for (let i = 0; i < 3; i++) await supabaseAdmin().rpc("rate_limit_refund", { p_key: "k" });
        });
      }),
    );
    expect(heldMs).toBeLessThanOrEqual(BOOKING_CONFIRM_WORST_CASE_MS);
  });

  // #3163 (L743): the outage page's own Slack post is part of the cleanup, and a
  // Slack answering just inside its own 8 second limit is a post that PASSES. It
  // used to wait on that limit alone, outside the allowance, so a confirm that
  // spent its budget and then paged through a slow but answering Slack held the
  // lead 12 + 8 seconds and the booker gave up at 20, showing the browser's
  // failure instead of our retryable answer.
  it("a Slack post in the cleanup is held to the allowance, so a slow but answering Slack cannot outlast the worst case", async () => {
    let posted: { ok: boolean; error?: string } | null = null;
    const { heldMs } = await measure(() =>
      withinBookingConfirmBudget(async () => {
        await confirmShapedWork().catch(() => {});
        posted = await withinBookingCleanupBudget(() => postSlack({ text: "page", channel: "C1" }));
      }),
    );
    expect(heldMs).toBeLessThanOrEqual(BOOKING_CONFIRM_WORST_CASE_MS);
    // Cut short, it still answers not posted rather than throwing (its contract).
    expect(posted).toMatchObject({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("outside any budget a Slack post keeps its own limit, so a slow but answering Slack still lands", async () => {
    const { heldMs, outcome } = await measure(() => postSlack({ text: "page", channel: "C1" }));
    expect(outcome).toBe("resolved");
    expect(heldMs).toBe(SLOW_MS);
  });

  // The path a timed out /booking really takes: the service sends the outage page
  // (under the cleanup allowance), throws, and the route's failure path then runs
  // the refunds (under the cleanup allowance again). Those two are opened one
  // after the other, not nested, so unless the allowance is ONE per request the
  // second restarts it and the path holds the lead 12 + 2 + 2 seconds.
  it("the service's page and the route's failure path share ONE cleanup allowance", async () => {
    orchestrationCreate.mockImplementation(confirmShapedWork);
    pageSends.count = 0;
    let failure: unknown = null;
    const { heldMs } = await measure(() =>
      withinBookingConfirmBudget(async () => {
        try {
          await createBooking({} as CreateBookingInput);
        } catch (err) {
          failure = err;
          await withinBookingCleanupBudget(async () => {
            for (let i = 0; i < 3; i++) await supabaseAdmin().rpc("rate_limit_refund", { p_key: "k" });
          });
        }
      }),
    );
    expect(failure).toBeInstanceOf(VerifyUnavailableError);
    expect(pageSends.count).toBe(1);
    expect(heldMs).toBeLessThanOrEqual(BOOKING_CONFIRM_WORST_CASE_MS);
  });
});
