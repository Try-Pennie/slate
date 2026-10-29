// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The coordinator booking page's gate (#4205): only somebody who may use the desk (a
// coordinator, or an admin who trains them) reaches it; anybody else, signed out or an
// advisor or manager, is sent to sign in with a coordinator account. The placeholder advisor
// can never be signed in at all: the session gate refuses its row before any page asks
// (scripts/test-active-session-gate.ts, src/app/api/auth/callback/route.test.ts), so
// `coordinatorDeskUser` never answers it. `?frame=` draws a design frame only behind the
// e2e flag on this machine, and only after the gate.

const auth = vi.hoisted(() => ({ coordinatorDeskUser: vi.fn(), currentUser: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
const fixtureRead = vi.hoisted(() => ({ readDesignFixture: vi.fn(async () => null) }));
const reasonOptions = vi.hoisted(() => ({
  loadReasonOptions: vi.fn(async () => ({
    reschedule: { selectable: [{ code: "schedule_conflict", label: "Schedule conflict" }, { code: "other", label: "Other" }] },
  })),
}));
vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("@/lib/admin/design-fixture-read", () => fixtureRead);
vi.mock("@/lib/booking/reason-options", () => reasonOptions);
vi.mock("@/app/coordinator/actions", () => ({ lookupCoordinatorCustomer: vi.fn(), placeCoordinatorCall: vi.fn(), checkCoordinatorTransfer: vi.fn() }));

import CoordinatorPage from "./page";
import { canUseCoordinatorDesk, ROLES } from "@/lib/auth/roles";

const params = (sp: Record<string, string> = {}) => ({ searchParams: Promise.resolve(sp) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.coordinatorDeskUser.mockResolvedValue(null);
  auth.currentUser.mockResolvedValue(null);
});
afterEach(cleanup);

describe("who reaches /coordinator (#4205)", () => {
  it("sends somebody signed out to sign in", async () => {
    await expect(CoordinatorPage(params())).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("sends a signed in advisor or manager to sign in with a coordinator account, reading nothing", async () => {
    // coordinatorDeskUser answers null for every role but a coordinator or an admin.
    auth.currentUser.mockResolvedValue({ id: "a1", role: "agent" });
    await expect(CoordinatorPage(params())).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(fixtureRead.readDesignFixture).not.toHaveBeenCalled();
    expect(reasonOptions.loadReasonOptions).not.toHaveBeenCalled();
  });

  it("draws the page for a coordinator, empty and ready for a Lead", async () => {
    auth.coordinatorDeskUser.mockResolvedValue({ id: "c1", role: "coordinator", is_test: false });
    render(await CoordinatorPage(params()));
    expect(screen.getByRole("heading", { level: 1, name: "Book a call" })).toBeTruthy();
    expect(screen.getByLabelText("Salesforce Lead")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find customer" })).toBeTruthy();
  });

  it("asks for a design frame only after the gate", async () => {
    await expect(CoordinatorPage(params({ frame: "f-locked" }))).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(fixtureRead.readDesignFixture).not.toHaveBeenCalled();
  });

  it("draws the live transfer design's frame from its two committed fixtures (#4380)", async () => {
    auth.coordinatorDeskUser.mockResolvedValue({ id: "c1", role: "coordinator", is_test: false });
    const { readFileSync } = await import("node:fs");
    fixtureRead.readDesignFixture.mockImplementation((async (_frame: string, name: string) =>
      JSON.parse(readFileSync(`${process.cwd()}/docs/design/fixtures/${name}.json`, "utf8"))) as never);
    render(await CoordinatorPage(params({ frame: "f1" })));
    expect(screen.getByRole("heading", { name: "Advisors are free now" })).toBeTruthy();
    expect(screen.getByText("786-504-0671")).toBeTruthy();
    expect(screen.getByText("Sam Okafor")).toBeTruthy();
    expect(fixtureRead.readDesignFixture.mock.calls.map((c) => (c as unknown[])[1]).sort()).toEqual(["coordinator-booking", "coordinator-call-me-now"]);
  });

  it("is open to coordinators and admins only, decided in one table", () => {
    expect(ROLES.filter(canUseCoordinatorDesk)).toEqual(["coordinator", "admin", "super_admin"]);
  });
});
