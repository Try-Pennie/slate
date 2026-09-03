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
const db = vi.hoisted(() => ({ oooCountError: null as { message: string } | null, oooCount: 0 }));
const supabaseAdmin = vi.hoisted(() =>
  vi.fn(() => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        not: () => b,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            table === "ooo_requests"
              ? { count: db.oooCountError ? null : db.oooCount, error: db.oooCountError }
              : { data: [], error: null },
          ).then(resolve),
      };
      return b;
    },
  })),
);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin }));
vi.mock("@/lib/env", () => ({ oooOnlyFor: () => false }));

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import { AppHeader } from "@/components/AppHeader";

const props = { email: "admin@trypennie.com", role: "admin", active: "admin" as const };

beforeEach(() => {
  view.v = { status: "none" };
  db.oooCountError = null;
  db.oooCount = 0;
  logSpy.warn.mockClear();
});

describe("AppHeader impersonation banners (#652)", () => {
  // #1836 made this the ONLY place in the app that explains what "view as" does.
  // A standing warning above the roster used to say it too, in worse form: shown
  // to every admin who was not impersonating anyone, and unable to name the
  // person because there was nobody to name. Removing it is only safe while this
  // banner carries all three parts, so all three are asserted here rather than
  // just the name and the button.
  it("shows the active 'viewing as' banner, naming the target and explaining the risk", async () => {
    view.v = {
      status: "active",
      real: { id: "admin-1" },
      target: { id: "agent-9", name: "Agent Nine", email: "a9@x.com", role: "agent" },
    };
    render(await AppHeader(props));
    // 1. who you are acting as, by name, which the removed prose could never do
    expect(screen.getByText(/Agent Nine/)).toBeTruthy();
    // 2. what that means, which is the half the removed prose was standing in for
    expect(screen.getByText(/actions you take happen as them/i)).toBeTruthy();
    // 3. the way back
    expect(screen.getByRole("button", { name: /stop viewing as them/i })).toBeTruthy();
    expect(screen.queryByText(/timed out|no longer available/i)).toBeNull();
  });

  it("shows the timed-out drop notice, not the active banner, when dropped/expired", async () => {
    view.v = { status: "dropped", reason: "expired" };
    render(await AppHeader(props));
    expect(screen.getByText(/timed out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop viewing as them/i })).toBeNull();
  });

  it("shows the unavailable drop notice when dropped/unavailable", async () => {
    view.v = { status: "dropped", reason: "unavailable" };
    render(await AppHeader(props));
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
  });

  it("shows no impersonation banner for a plain session", async () => {
    render(await AppHeader(props));
    expect(screen.queryByRole("button", { name: /stop viewing as them/i })).toBeNull();
    expect(screen.queryByText(/timed out|no longer available/i)).toBeNull();
  });
});

// #1165: the badge read destructured `{ count }` and ignored `error`, so a read
// that FAILED scored as zero pending requests: the badge vanished exactly as it
// does when the queue is genuinely empty, and nothing anywhere recorded that the
// count had not been read. The badge itself stays hidden (the header must render
// either way, and the Team Requests page is the source of truth one click away),
// but the failure has to reach the logs instead of passing as a healthy zero.
describe("pending-OOO badge on a failed count read (#1165)", () => {
  const withIds = { ...props, userId: "mgr-1", orgId: "org-1" };

  it("shows the badge when the count reads cleanly", async () => {
    db.oooCount = 3;
    render(await AppHeader(withIds));
    expect(screen.getByText(/3 requests pending/i)).toBeTruthy();
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it("logs the failure instead of silently rendering an empty queue", async () => {
    db.oooCount = 3; // there ARE pending requests; only the read is broken
    db.oooCountError = { message: "permission denied for table ooo_requests" };

    render(await AppHeader(withIds));

    expect(screen.queryByText(/requests? pending/i)).toBeNull();
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logSpy.warn.mock.calls[0])).toMatch(/pending/i);
  });
});
