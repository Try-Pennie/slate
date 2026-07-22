import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the OOO manager-digest cron (#676): an unauthenticated caller
// must be rejected with 401 before the time gate is read or any DB row is
// queried. Plus (#194): the digest sends interactive Approve/Decline blocks, and
// one manager's Slack failure must not abort the rest of the run.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const from = vi.hoisted(() => vi.fn());
const slack = vi.hoisted(() => ({
  dmSlackUserByEmail: vi.fn(
    async (_email: string, _text: string, _blocks?: unknown[]): Promise<boolean> => true,
  ),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/slack", () => slack);
vi.mock("@/lib/env", () => ({ appUrl: () => "https://slate.test" }));
// Keep log noise out of the failure-path test (it logs the DM failure).
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const noAuthReq = () => ({}) as unknown as Parameters<typeof GET>[0];
const forcedReq = () =>
  ({
    nextUrl: { searchParams: new URLSearchParams("force=1") },
  }) as unknown as Parameters<typeof GET>[0];

// A supabase query builder whose every chained method returns itself and which
// resolves (when awaited) to { data: rows }.
function builderFor(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "in"]) b[m] = () => b;
  (b as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows });
  return b;
}

const pendingRows = [
  {
    id: "r1",
    user_id: "a1",
    manager_id: "m1",
    starts_at: "2026-07-10T13:00:00Z",
    ends_at: "2026-07-10T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "vacation",
  },
  {
    id: "r2",
    user_id: "a2",
    manager_id: "m1",
    starts_at: "2026-07-11T13:00:00Z",
    ends_at: "2026-07-11T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "appointment",
  },
  {
    id: "r3",
    user_id: "a3",
    manager_id: "m2",
    starts_at: "2026-07-12T13:00:00Z",
    ends_at: "2026-07-12T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "personal",
  },
];
const userRows = [
  { id: "m1", email: "m1@x.com", name: "Manager One" },
  { id: "m2", email: "m2@x.com", name: "Manager Two" },
  { id: "a1", email: "a1@x.com", name: "Agent One" },
  { id: "a2", email: "a2@x.com", name: "Agent Two" },
  { id: "a3", email: "a3@x.com", name: "Agent Three" },
];

function wireDb() {
  from.mockImplementation((table: string) =>
    builderFor(table === "ooo_requests" ? pendingRows : userRows),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/ooo-digest", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(noAuthReq());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("DMs each manager an interactive digest with Approve/Decline action rows", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(2); // one DM per resolvable manager
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(2);

    // Every DM carries the interactive blocks (3rd arg) with at least one actions row.
    for (const call of slack.dmSlackUserByEmail.mock.calls) {
      const blocks = call[2] as { type?: string }[];
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.some((b) => b.type === "actions")).toBe(true);
    }
    // The busiest manager (m1, two requests) gets two action rows.
    const m1Call = slack.dmSlackUserByEmail.mock.calls.find((c) => c[0] === "m1@x.com")!;
    const m1Blocks = m1Call[2] as { type?: string }[];
    expect(m1Blocks.filter((b) => b.type === "actions")).toHaveLength(2);
  });

  it("keeps sending the other managers when one manager's DM throws (fail-loud, not fail-silent)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    // m1 (busiest, sent first) blows up; m2 must still get its digest.
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => {
      if (email === "m1@x.com") throw new Error("slack 500");
      return true;
    });

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200); // one bad DM does not 500 the whole tick
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(2); // m2 still attempted
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1); // the failure is surfaced, not swallowed
  });
});
