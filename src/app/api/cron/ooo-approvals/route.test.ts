import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the OOO approvals-digest cron (#676): an unauthenticated
// caller must be rejected with 401 before the time gate is read or any DB row
// is queried. The digest content/timing logic is covered elsewhere.
//
// Plus #2383: both of this lane's reads used to swallow their `error`, so a
// refused query arrived as null, became an empty array, and the route answered
// 200 with `{ sent: false, count: 0 }` under a comment saying "Skip silently on
// empty days". No CSV, no alert, and a morning that could not be read looked
// exactly like a morning with nothing to report. There is no second attempt
// either: the window is yesterday relative to the clock, so a day this lane
// drops falls out of every later run's window.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const from = vi.hoisted(() => vi.fn());
const email = vi.hoisted(() => ({
  sendGmailEmail: vi.fn(async (_msg: unknown): Promise<void> => {}),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_key: string, _cooldownMs: number, _text: string): Promise<void> => {},
  ),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/email", () => email);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/env", () => ({
  oooApprovalsRecipients: () => ["salesmanagers@trypennie.com"],
  oooApprovalsBcc: () => [],
  oooApprovalsReplyTo: () => null,
  oooCalendarActorEmail: () => "ooo@trypennie.com",
}));

import { GET } from "./route";
import { noteAlertKey } from "@/lib/notify/alert-recording";

const noAuthReq = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const forcedReq = () =>
  ({
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams("force=1") },
  }) as unknown as Parameters<typeof GET>[0];

// A supabase query builder whose every chained method returns itself. One form
// resolves with rows, the other with a refusal: `unwrap` throws only on a real
// `error`, so a builder that can never produce one could not reach the path
// these tests exist for, and would read exactly like a passing check (L1).
function builderFor(result: unknown, filters?: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt", "order", "in"]) {
    b[m] = (col?: string, value?: unknown) => {
      if (filters && col !== undefined) filters[`${m}:${col}`] = value;
      return b;
    };
  }
  (b as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
  return b;
}

/**
 * The `lane_heartbeats` half of the mock (#2543).
 *
 * This lane reads ONE stamp as its catch-up watermark and writes two, so a fake
 * that only knew `ooo_requests` and `users` would have the route calling methods
 * this builder does not have. Keeping the stamps here rather than in a second
 * suite is deliberate: the watermark decides the WINDOW the approvals query runs
 * over, so the read, the query and the mark moving are one behaviour.
 */
const heartbeats = vi.hoisted(() => ({
  /** The stored `ooo-approvals-report` stamp, or null for a lane that never ran. */
  reportStamp: null as string | null,
  /** Set to make the stamp read come back as a real database error. */
  readError: null as { message: string } | null,
  /** Every lane stamped this run, in order. */
  written: [] as string[],
}));

function heartbeatBuilder() {
  return {
    select: () => ({
      eq: (_col: string, lane: string) => ({
        maybeSingle: async () => {
          if (heartbeats.readError) return { data: null, error: heartbeats.readError };
          const at = lane === "ooo-approvals-report" ? heartbeats.reportStamp : null;
          return { data: at ? { last_ran_at: at } : null, error: null };
        },
      }),
    }),
    upsert: async (row: { lane: string }) => {
      heartbeats.written.push(row.lane);
      return { error: null };
    },
  };
}

const REFUSAL = {
  data: null,
  error: { message: "57014 canceling statement due to statement timeout" },
};

const approvedRows = [
  {
    id: "r1",
    legacy_request_id: null,
    user_id: "a1",
    manager_id: "m1",
    starts_at: "2026-07-10T13:00:00Z",
    ends_at: "2026-07-10T15:00:00Z",
    decided_at: "2026-07-09T14:00:00Z",
    display_tz_label: "ET",
  },
];
const userRows = [
  { id: "a1", name: "Agent One" },
  { id: "m1", name: "Manager One" },
];

beforeEach(() => {
  vi.clearAllMocks();
  email.sendGmailEmail.mockResolvedValue(undefined);
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
  heartbeats.reportStamp = null;
  heartbeats.readError = null;
  heartbeats.written = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Both domain reads answer, and the stamps behave. */
function healthyTables(filters?: Record<string, unknown>) {
  from.mockImplementation((table: string) => {
    if (table === "lane_heartbeats") return heartbeatBuilder();
    return builderFor({ data: table === "ooo_requests" ? approvedRows : userRows }, filters);
  });
}

describe("GET /api/cron/ooo-approvals", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(noAuthReq());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("emails the CSV when both reads answer", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    healthyTables();

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.count).toBe(1);
    expect(email.sendGmailEmail).toHaveBeenCalledTimes(1);
    // The names really came from the second read, which is what makes the
    // refusal test below about something a reader would notice.
    const sent = email.sendGmailEmail.mock.calls[0][0] as {
      attachments: { content: string }[];
    };
    expect(sent.attachments[0].content).toContain("Agent One");
  });

  it("refuses the tick when the approvals read fails, instead of reporting an empty day", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      table === "lane_heartbeats" ? heartbeatBuilder() : builderFor(REFUSAL),
    );

    await expect(GET(forcedReq())).rejects.toThrow(/approvals digest requests/);
    // Nothing was sent off the unreadable day, and nothing claimed a count.
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
    // #2543: and the mark does NOT move, so tomorrow's run covers this morning too.
    expect(heartbeats.written).not.toContain("ooo-approvals-report");
  });

  it("refuses the tick when the names read fails, rather than emailing a CSV naming nobody", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) => {
      if (table === "lane_heartbeats") return heartbeatBuilder();
      return table === "users" ? builderFor(REFUSAL) : builderFor({ data: approvedRows });
    });

    await expect(GET(forcedReq())).rejects.toThrow(/approvals digest names/);
    // A report about who was away with every name blank looks complete, which is
    // worse than no report at all.
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
    expect(heartbeats.written).not.toContain("ooo-approvals-report");
  });
});

// #2543: the lane got one attempt a day, cron has no retries, and the window was
// yesterday relative to the clock, so a dropped morning fell out of every later
// run. Neither lane was in any bounds map either, so a lane that stopped firing was
// watched by nothing at all.
describe("GET /api/cron/ooo-approvals: the catch-up watermark (#2543)", () => {
  beforeEach(() => cron.isAuthorizedCron.mockReturnValue(true));

  it("stamps the attempt even on the tick the time gate no-ops", async () => {
    // Both daily triggers reach the route and one of them is not 7am ET. That
    // tick still proves the dispatcher is firing, which is all the attempt stamp
    // ever claims.
    healthyTables();
    const res = await GET({
      headers: new Headers(),
      nextUrl: { searchParams: new URLSearchParams() },
    } as unknown as Parameters<typeof GET>[0]);
    const body = await res.json();

    expect(typeof body.skipped === "string" || body.sent !== undefined).toBe(true);
    expect(heartbeats.written).toContain("ooo-approvals");
  });

  it("moves the mark only AFTER the send succeeded", async () => {
    healthyTables();
    await GET(forcedReq());
    expect(email.sendGmailEmail).toHaveBeenCalledTimes(1);
    expect(heartbeats.written).toContain("ooo-approvals-report");
  });

  it("leaves the mark where it was when the email itself failed", async () => {
    healthyTables();
    email.sendGmailEmail.mockRejectedValueOnce(new Error("gmail said no"));
    const res = await GET(forcedReq());
    expect(res.status).toBe(500);
    // The whole point of the mark: a morning nobody received is reported again.
    expect(heartbeats.written).not.toContain("ooo-approvals-report");
  });

  // One failure, one message (Dan, 2026-10-03). This lane pages about a failed
  // send itself, so its 500 must tell the dispatcher, or the generic lane page
  // goes out too. The fake send notes its key exactly as the real one does when
  // it returns (pinned in src/lib/notify/alert-recording.test.ts).
  it("tells the dispatcher it already paged, so the failure is one message", async () => {
    healthyTables();
    email.sendGmailEmail.mockRejectedValueOnce(new Error("gmail said no"));
    dispatch.sendThrottledAlert.mockImplementationOnce(async (key: string) => {
      noteAlertKey(key);
    });
    const res = await GET(forcedReq());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-slate-lane-alerted")).toBe("ooo_approvals_digest");
  });

  it("leaves the generic page to speak when its own page could not be sent", async () => {
    healthyTables();
    email.sendGmailEmail.mockRejectedValueOnce(new Error("gmail said no"));
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    const res = await GET(forcedReq());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-slate-lane-alerted")).toBeNull();
  });

  it("covers the whole gap when earlier mornings were missed", async () => {
    const filters: Record<string, unknown> = {};
    // The last report went out four days ago, so this run owes four days.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    heartbeats.reportStamp = fourDaysAgo.toISOString();
    healthyTables(filters);

    await GET(forcedReq());

    const from4 = String(filters["gte:decided_at"]);
    const spanDays = Math.round(
      (Date.parse(String(filters["lt:decided_at"])) - Date.parse(from4)) / (24 * 60 * 60_000),
    );
    expect(spanDays).toBe(4);
    // And the email says so, rather than calling four days of approvals yesterday's.
    const sent = email.sendGmailEmail.mock.calls[0]![0] as { subject: string; body: string };
    expect(sent.subject).not.toMatch(/Yesterday/);
    expect(sent.body).toMatch(/4 days/);
  });

  it("reports nothing twice when the mark already covers today", async () => {
    // What the second daily trigger and a forced re-run both produce.
    heartbeats.reportStamp = new Date().toISOString();
    healthyTables();

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(body.alreadyCovered).toBe(true);
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
    // Still a measured outcome about its own window, so the mark stays fresh.
    expect(heartbeats.written).toContain("ooo-approvals-report");
  });

  it("moves the mark on a day that genuinely had no approvals", async () => {
    from.mockImplementation((table: string) => {
      if (table === "lane_heartbeats") return heartbeatBuilder();
      return builderFor({ data: [] });
    });

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(body.sent).toBe(false);
    expect(body.count).toBe(0);
    // Finding nothing IS a conclusion. Leaving the mark would make every quiet
    // week read as a lane that had stopped, and widen tomorrow's window over days
    // this run already looked at.
    expect(heartbeats.written).toContain("ooo-approvals-report");
  });

  // THE FAILURE PATH for the mark itself. A read that FAILED must not read as
  // "never reported", which would narrow this run to yesterday and then move the
  // mark past the days it skipped: unmeasured, and irrecoverable.
  it("refuses the run when the mark itself cannot be read, and stamps nothing", async () => {
    heartbeats.readError = { message: "connection reset" };
    healthyTables();

    await expect(GET(forcedReq())).rejects.toThrow(/connection reset/);
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
    expect(heartbeats.written).not.toContain("ooo-approvals-report");
    // The attempt stamp still landed: the cron DID reach the route, and that is a
    // different fact from the report going out (L11).
    expect(heartbeats.written).toContain("ooo-approvals");
  });
});
