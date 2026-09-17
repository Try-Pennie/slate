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

const noAuthReq = () => ({}) as unknown as Parameters<typeof GET>[0];
const forcedReq = () =>
  ({
    nextUrl: { searchParams: new URLSearchParams("force=1") },
  }) as unknown as Parameters<typeof GET>[0];

// A supabase query builder whose every chained method returns itself. One form
// resolves with rows, the other with a refusal: `unwrap` throws only on a real
// `error`, so a builder that can never produce one could not reach the path
// these tests exist for, and would read exactly like a passing check (L1).
function builderFor(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt", "order", "in"]) {
    b[m] = () => b;
  }
  (b as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
  return b;
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
});

describe("GET /api/cron/ooo-approvals", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(noAuthReq());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("emails the CSV when both reads answer", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      builderFor({ data: table === "ooo_requests" ? approvedRows : userRows }),
    );

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
    from.mockImplementation(() => builderFor(REFUSAL));

    await expect(GET(forcedReq())).rejects.toThrow(/approvals digest requests/);
    // Nothing was sent off the unreadable day, and nothing claimed a count.
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
  });

  it("refuses the tick when the names read fails, rather than emailing a CSV naming nobody", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      table === "users" ? builderFor(REFUSAL) : builderFor({ data: approvedRows }),
    );

    await expect(GET(forcedReq())).rejects.toThrow(/approvals digest names/);
    // A report about who was away with every name blank looks complete, which is
    // worse than no report at all.
    expect(email.sendGmailEmail).not.toHaveBeenCalled();
  });
});
