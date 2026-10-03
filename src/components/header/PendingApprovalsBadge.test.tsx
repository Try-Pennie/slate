// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #652: the header is the single surface that both shows an active "view as"
// session AND surfaces a silently-dropped one. This pins the wiring: which
// impersonation state renders which banner. Data-fetching branches are skipped by
// passing no userId, so only the impersonation view drives the render.
const view = vi.hoisted(() => ({ v: { status: "none" } as unknown }));
vi.mock("@/lib/auth", () => ({ getImpersonationView: async () => view.v }));
vi.mock("@/app/admin/actions", () => ({
  stopImpersonation: vi.fn(),
  endDroppedImpersonation: vi.fn(async () => {}),
}));
// #1165: the pending-OOO badge read is a `{ count }` destructure. The fake lets a
// test make that read FAIL so the badge's behaviour on a broken read is pinned,
// rather than the failure quietly scoring as "no requests pending".
const db = vi.hoisted(() => ({
  oooCountError: null as { message: string } | null,
  oooCount: 0,
  /** Every read, in the order it was ISSUED and then in the order it SETTLED. */
  trace: [] as string[],
  /** Tables held open until a test releases them, so ordering is decided not raced. */
  hold: null as null | Set<string>,
  release: {} as Record<string, () => void>,
  /** The filters the count applied, as `method:column:value` (#3114). */
  filters: [] as string[],
}));
const supabaseAdmin = vi.hoisted(() =>
  vi.fn(() => ({
    from: (table: string) => {
      const answer = () =>
        table === "ooo_requests"
          ? { count: db.oooCountError ? null : db.oooCount, error: db.oooCountError }
          : { data: [], error: null };
      const record = (method: string) => (col: string, ...rest: unknown[]) => {
        if (table === "ooo_requests") db.filters.push(`${method}:${col}:${rest.map(String).join(":")}`);
        return b;
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: record("eq"),
        neq: record("neq"),
        in: record("in"),
        not: record("not"),
        then: (resolve: (v: unknown) => unknown) => {
          db.trace.push(`${table}:issued`);
          const gate = db.hold?.has(table)
            ? new Promise<void>((res) => { db.release[table] = res; })
            : Promise.resolve();
          return gate.then(() => {
            db.trace.push(`${table}:settled`);
            return resolve(answer());
          });
        },
      };
      return b;
    },
  })),
);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin }));
vi.mock("@/lib/env", () => ({ consoleHiddenFor: () => false }));

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import { PendingApprovalsBadge } from "@/components/header/PendingApprovalsBadge";

const props = { role: "manager", userId: "mgr-1", orgId: "org-1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  db.oooCountError = null;
  db.oooCount = 0;
  db.trace = [];
  db.hold = null;
  db.release = {};
  db.filters = [];
});

// #1847 moved this read out of the header so nothing waits on it. The BEHAVIOUR
// did not move: these are the header's own cases, brought here with the code
// they describe, because a test left behind on the component that no longer does
// the work would pass while measuring the wrong thing.
describe("the pending approvals badge (#1165, moved by #1847)", () => {
  it("shows the count when the read is clean", async () => {
    db.oooCount = 3;
    render(await PendingApprovalsBadge(props));
    expect(screen.getByText(/3 requests pending/i)).toBeTruthy();
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  // #1165: a failed count came back null and `?? 0` hid the badge, which is
  // exactly what an empty queue looks like, so a broken read presented as
  // "nothing waiting for you".
  it("logs a failed read instead of rendering an empty queue", async () => {
    db.oooCount = 3; // there ARE pending requests; only the read is broken
    db.oooCountError = { message: "permission denied for table ooo_requests" };

    render(await PendingApprovalsBadge(props));

    expect(screen.queryByText(/requests? pending/i)).toBeNull();
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logSpy.warn.mock.calls[0])).toMatch(/pending/i);
  });

  it("renders nothing at all when the queue is empty", async () => {
    db.oooCount = 0;
    const { container } = render(await PendingApprovalsBadge(props));
    // Not an empty pill: a badge holding zero reads as a thing to go and look at.
    expect(container.textContent).toBe("");
  });

  // #3114: the badge counts what the Team Requests queue shows, which is what the
  // viewer can decide (pendingQueueScope, held equal to canModerate). It used to
  // drop every admin-authored request, which is now wrong: an admin cannot decide
  // their own, so the OTHER moderators must be nudged about it.
  describe("counts exactly the queue the viewer can decide (#3114)", () => {
    const base = ["eq:org_id:org-1", "eq:status:pending"];

    it("an admin counts everyone's but their own, including other admins'", async () => {
      render(await PendingApprovalsBadge({ role: "admin", userId: "ada", orgId: "org-1" }));
      expect(db.filters).toEqual([...base, "neq:user_id:ada"]);
      // No staff list is read any more, so no admin's request is filtered out.
      expect(db.trace.some((t) => t.startsWith("users:"))).toBe(false);
    });

    it("a team lead counts the whole org, an admin's request included", async () => {
      render(await PendingApprovalsBadge({ role: "team_lead", userId: "lee", orgId: "org-1" }));
      expect(db.filters).toEqual(base);
    });

    it("a manager counts only the requests naming them", async () => {
      render(await PendingApprovalsBadge(props));
      expect(db.filters).toEqual([...base, "eq:manager_id:mgr-1"]);
    });

    it("an agent, who can decide nothing, reads nothing and shows nothing", async () => {
      db.oooCount = 4;
      const { container } = render(
        await PendingApprovalsBadge({ role: "agent", userId: "aria", orgId: "org-1" }),
      );
      expect(db.trace).toEqual([]);
      expect(container.textContent).toBe("");
    });
  });

  it("renders nothing without the ids it needs, rather than reading anything", async () => {
    render(await PendingApprovalsBadge({ role: "manager", userId: null, orgId: "org-1" }));
    expect(db.trace).toEqual([]);
  });
});
