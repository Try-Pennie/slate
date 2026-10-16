import { describe, it, expect, vi, beforeEach } from "vitest";

// #3266: the pages a booking raises AFTER it has committed (the busy block's
// write through, the misroute check) must never cost the lead their answer.
//
// They used to be awaited inside the confirm's budget, so a slow Slack or
// alert_state write held the answer of a booking that already existed, and once
// the budget was spent the page itself was refused ("slack did not answer within
// 0ms", 2026-10-04 21:31 UTC). On a lead's request they are handed to the work that
// runs after the response, outside every budget (`afterResponse`, #3232). The cron
// drains carry no budget and no lead, and keep sending them inline.
//
// Each case proves both halves: the answer does not wait on the page, and the page
// is still sent when the deferred work runs.

/** What the next `rpc(...)` answers. */
let rpcResult: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async () => rpcResult,
    from: () => ({
      upsert: async () => ({ error: { message: "planted insert refusal" } }),
    }),
  }),
}));

/** The work handed past the response, by its context label. */
const deferred = vi.hoisted(() => [] as { context: string; work: () => Promise<unknown> }[]);
vi.mock("@/lib/after-response", () => ({
  afterResponse: (context: string, work: () => Promise<unknown>) => {
    deferred.push({ context, work });
  },
  deferWebhookSend: () => {},
}));

/** A page that never answers unless a test says so: a slow Slack. */
const sendThrottledAlert = vi.hoisted(() => vi.fn((_key: string, _ms: number, _text: string): Promise<void> => new Promise(() => {})));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert,
}));

const alertIfMisroute = vi.hoisted(() => vi.fn((): Promise<void> => new Promise(() => {})));
vi.mock("@/lib/routing/record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/routing/record")>()),
  alertIfMisroute,
}));

const logged = vi.hoisted(() => [] as { level: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/log", () => ({
  log: {
    info: () => {},
    warn: (_tag: string, fields: Record<string, unknown>) => logged.push({ level: "warn", fields }),
    error: (_tag: string, fields: Record<string, unknown>) => logged.push({ level: "error", fields }),
  },
}));

import { realDeps } from "./service";
import type { CommitFreshInput } from "./orchestration";
import type { BusyBlockInsert } from "@/lib/booking/core";

/** A lead's request: the user facing paths pass a webhook scheduler, which is what
 *  marks them as answering somebody who is waiting. */
const leadFacing = () => realDeps(() => {});

/** Whether `p` settles before a page that never answers could. */
async function answersWithoutWaiting(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);
}

const booking = {
  id: "10000000-0000-4000-8000-000000000001",
  org_id: "o1",
  status: "confirmed",
  starts_at: "2031-03-04T15:00:00+00:00",
  ends_at: "2031-03-04T15:20:00+00:00",
  manage_token: "tok",
  assigned_user_id: "A",
};
const routing = { orgId: "o1", bookingId: booking.id, bucketCode: "100", chosenAttributes: { tier: ["low"] } };
const req = {
  booking,
  reservationId: "r1",
  webhook: { unbuilt: "not under test" },
  routing,
} as unknown as CommitFreshInput;

function committed(failed: Record<string, string>) {
  // The webhook is left unbuilt (its own step failed), so the answer carries no
  // deliveries and the only work after the save is the two pages under test.
  return {
    data: { status: "committed", booking, enqueue: null, failed: { webhook: "not under test", ...failed }, reservation_deleted: true },
    error: null,
  };
}

beforeEach(() => {
  deferred.length = 0;
  logged.length = 0;
  sendThrottledAlert.mockClear();
  sendThrottledAlert.mockImplementation(() => new Promise(() => {}));
  alertIfMisroute.mockClear();
});

describe("a fresh booking's save on a lead's request (#3266)", () => {
  it("answers without waiting on the busy block page or the misroute check, and both still go", async () => {
    rpcResult = committed({ busy: "planted move refusal" });
    const answered = await answersWithoutWaiting(leadFacing().commitFreshBooking(req));
    expect(answered).toBe(true);
    // Nothing was sent in front of the answer.
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(alertIfMisroute).not.toHaveBeenCalled();

    expect(deferred.map((d) => d.context).sort()).toEqual(["busy-block-page", "misroute-page"]);
    for (const d of deferred) void d.work();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]?.[0]).toBe("busy_block_write_through");
    expect(sendThrottledAlert.mock.calls[0]?.[2]).toMatch(/planted move refusal/);
    expect(alertIfMisroute).toHaveBeenCalledWith(routing);
  });

  it("still logs the failed move at once, in front of the answer, so the record never waits on the page", async () => {
    rpcResult = committed({ busy: "planted move refusal" });
    await answersWithoutWaiting(leadFacing().commitFreshBooking(req));
    expect(logged.some((l) => l.level === "error" && l.fields.msg === "busy_blocks move failed")).toBe(true);
  });

  it("a page that fails to send after the response is logged as an error by its key, never dropped", async () => {
    rpcResult = committed({ busy: "planted move refusal" });
    sendThrottledAlert.mockImplementation(async () => {
      throw new Error("slack did not answer");
    });
    await leadFacing().commitFreshBooking(req);
    const page = deferred.find((d) => d.context === "busy-block-page");
    // The deferred work itself settles, so `afterResponse` has nothing to swallow.
    await expect(page?.work()).resolves.toBeUndefined();
    expect(logged).toContainEqual({ level: "error", fields: { msg: "alert send failed", key: "busy_block_write_through" } });
  });

  it("control: on a cron drain (no lead waiting, no budget) both are sent inline, as they always were", async () => {
    rpcResult = committed({ busy: "planted move refusal" });
    sendThrottledAlert.mockImplementation(async () => {});
    alertIfMisroute.mockImplementation(async () => {});
    await realDeps().commitFreshBooking(req);
    expect(deferred).toHaveLength(0);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(alertIfMisroute).toHaveBeenCalledTimes(1);
  });

  it("control: a save whose block landed defers no busy block page", async () => {
    rpcResult = committed({});
    await leadFacing().commitFreshBooking(req);
    expect(deferred.map((d) => d.context)).toEqual(["misroute-page"]);
  });
});

describe("a busy block move on a lead's request (#3266)", () => {
  it("answers without waiting on the write through page, and the page still goes", async () => {
    rpcResult = { data: null, error: { message: "planted move refusal" } };
    const answered = await answersWithoutWaiting(leadFacing().moveBusyBlock("A", booking.starts_at, booking.ends_at, booking.id));
    expect(answered).toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(deferred.map((d) => d.context)).toEqual(["busy-block-page"]);
    void deferred[0]?.work();
    expect(sendThrottledAlert.mock.calls[0]?.[0]).toBe("busy_block_write_through");
  });

  it("control: on a cron drain the page is sent inline", async () => {
    rpcResult = { data: null, error: { message: "planted move refusal" } };
    sendThrottledAlert.mockImplementation(async () => {});
    await realDeps().moveBusyBlock("A", booking.starts_at, booking.ends_at, booking.id);
    expect(deferred).toHaveLength(0);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });
});

describe("a busy block insert on a lead's request (#3266)", () => {
  // Today only the reconcile sweep (a cron drain) inserts blocks, so this is the
  // dependency keeping its promise if a lead facing path ever does.
  const block = {
    user_id: "A",
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    source: "slate",
    booking_id: booking.id,
  } as BusyBlockInsert;

  it("answers without waiting on the insert's page, and the page still goes", async () => {
    const answered = await answersWithoutWaiting(leadFacing().insertBusyBlocks([block]));
    expect(answered).toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(deferred.map((d) => d.context)).toEqual(["busy-block-page"]);
    void deferred[0]?.work();
    expect(sendThrottledAlert.mock.calls[0]?.[0]).toBe("busy_block_write_through");
  });

  it("control: on a cron drain the page is sent inline", async () => {
    sendThrottledAlert.mockImplementation(async () => {});
    await realDeps().insertBusyBlocks([block]);
    expect(deferred).toHaveLength(0);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });
});
