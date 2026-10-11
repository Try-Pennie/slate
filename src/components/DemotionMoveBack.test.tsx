// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DemotionMoveBack from "@/components/DemotionMoveBack";
import { demotionMoveView, type DemotionMoveRecord } from "@/lib/booking/demotion-revert";

// The panel on a booking an automatic demotion reroute moved (#3615). Its words are built and
// read in scripts/test-demotion-revert.ts; this checks the panel shows them, asks before it moves
// anything, sends the right request, and answers each outcome on the page.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const NOW = Date.parse("2026-10-12T15:00:00.000Z");
const names: Record<string, string> = { jordan: "Jordan Lee", sam: "Sam Park", admin1: "Dan Wright" };
const move = (over: Partial<DemotionMoveRecord> = {}): DemotionMoveRecord => ({
  itemId: "it1",
  bookingId: "bk1",
  jobId: "job1",
  orgId: "org1",
  outUserId: "jordan",
  toUserId: "sam",
  status: "moved",
  movedAt: "2026-10-11T19:00:00.000Z",
  demotionMarkedAt: "2026-10-11T18:00:00.000Z",
  change: { from: { debtTeam: ["ultra_high", "high"], backendService: [] }, to: { debtTeam: ["high"], backendService: [] } },
  revertedAt: null,
  revertedBy: null,
  ...over,
});
const viewFor = (m: DemotionMoveRecord, assigned = "sam") =>
  demotionMoveView({
    move: m,
    booking: { status: "confirmed", assigned_user_id: assigned, starts_at: "2026-10-14T15:00:00.000Z" },
    original: { email: "jordan@trypennie.com", deactivated_at: null },
    nowMs: NOW,
    nameOf: (id) => names[id ?? ""] ?? "someone",
  })!;

function mockFetch(reply: { status?: number; body: unknown }) {
  const fn = vi.fn(async () => ({ ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body }) as Response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
const bodies = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));

beforeEach(() => vi.clearAllMocks());

describe("DemotionMoveBack (#3615)", () => {
  it("says who moved where and what changed, and asks before moving anything", async () => {
    const fetchFn = mockFetch({ body: { outcome: "moved-back" } });
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    expect(screen.getByText(/Slate moved this call from Jordan Lee to Sam Park automatically/)).toBeTruthy();
    expect(screen.getByText(/Debt tiers went from Ultra High and High to High/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Jordan Lee takes this call again");
    // The confirm takes focus, so a keyboard user lands on the decision rather than the page.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move back" }));

    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(bodies(fetchFn)).toEqual([{ overrideCap: false }]);
    expect(String((fetchFn.mock.calls[0] as unknown as [string])[0])).toBe("/api/admin/bookings/bk1/move-back");
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the call where it is when the reader backs out, returning focus to the opener", async () => {
    const fetchFn = mockFetch({ body: {} });
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep with Sam Park" }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
  });

  it("asks again when the original advisor is at their daily limit, and only then overrides it", async () => {
    const fetchFn = mockFetch({ status: 409, body: { code: "DAILY_CAP_EXCEEDED", error: "cap" } });
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(screen.getByText(/Jordan Lee is already at their daily limit/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();

    fetchFn.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ outcome: "moved-back" }) }) as Response);
    await userEvent.click(screen.getByRole("button", { name: "Move back anyway" }));
    expect(bodies(fetchFn)).toEqual([{ overrideCap: false }, { overrideCap: true }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("says a refusal in its own words, and redraws the page, which knows who has the call now", async () => {
    mockFetch({ status: 409, body: { reason: "moved-since", error: "x" } });
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(screen.getByRole("alert").textContent).toContain("moved again after this page loaded");
    expect(screen.getByRole("alert").textContent).not.toContain("Sam Park");
    expect(refresh).toHaveBeenCalled();
  });

  it("says a failure it could not classify as a failure, never as done", async () => {
    mockFetch({ status: 500, body: { error: "boom" } });
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(screen.getByRole("alert").textContent).toContain("could not be moved back");
    expect(refresh).not.toHaveBeenCalled();
  });

  // A reply that never came may still have moved the call, so the page is redrawn to show where
  // it is and the message says it does not know, rather than calling it a failure (L717).
  it("says it cannot tell when no answer came back, and redraws the page to show where the call is", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("network went away");
    }) as unknown as typeof fetch;
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(screen.getByRole("alert").textContent).toContain("No answer came back");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows working, then still working, while the move is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: (r: Response) => void = () => {};
    global.fetch = vi.fn(() => new Promise<Response>((r) => (release = r))) as unknown as typeof fetch;
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move())} />);
    await userEvent.click(screen.getByRole("button", { name: "Move back to Jordan Lee" }));
    await userEvent.click(screen.getByRole("button", { name: "Move back" }));
    expect(screen.getByRole("button", { name: "Moving back…" })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    expect(screen.getByRole("status").textContent).toContain("taking longer than usual");
    await act(async () => {
      release({ ok: true, status: 200, json: async () => ({ outcome: "moved-back" }) } as Response);
    });
    vi.useRealTimers();
  });

  it("states a finished undo without offering it again", () => {
    render(<DemotionMoveBack bookingId="bk1" view={viewFor(move({ revertedAt: "2026-10-12T14:00:00.000Z", revertedBy: "admin1" }), "jordan")} />);
    expect(screen.getByText("Dan Wright moved this call back to Jordan Lee after Slate moved it automatically.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
