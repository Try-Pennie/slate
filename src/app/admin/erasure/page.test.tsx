// @vitest-environment jsdom
/**
 * Access guard for the erasure purge worklist (#1124).
 *
 * This surface lists the audit trail of erased people and triggers a destructive
 * warehouse write, so who may reach it is asserted here rather than assumed:
 * signed out goes to login, below admin gets a refusal and NO worklist, the
 * OOO only launch flag diverts, and an admin gets the page scoped to their own
 * org. The real `canEditOrgSettings` is exercised; auth, the redirect, the launch
 * flag, the loader and the header chrome are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const loader = vi.hoisted(() => ({ loadErasureWorklist: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/snowflake/erasure-worklist-load", () => loader);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import ErasureWorklistPage from "./page";

const user = (role: string) => ({
  id: "u1",
  role,
  org_id: "org-1",
  email: "a@x",
  theme_preference: null,
  bookable: false,
  avatar_url: null,
});

const READY = {
  kind: "ready",
  entries: [],
  trail: { entryCount: 0, bookingCount: 0, otherOrgBookingCount: 0 },
  warehouse: { kind: "measured" },
};

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  loader.loadErasureWorklist.mockResolvedValue(READY);
});

describe("ErasureWorklistPage access", () => {
  it("sends a signed out visitor to login", async () => {
    auth.currentUser.mockResolvedValue(null);
    await expect(ErasureWorklistPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(loader.loadErasureWorklist).not.toHaveBeenCalled();
  });

  it("refuses a manager, and reads nothing on their behalf", async () => {
    auth.currentUser.mockResolvedValue(user("manager"));
    render(await ErasureWorklistPage());
    expect(screen.getByText(/need an admin account/i)).toBeTruthy();
    expect(loader.loadErasureWorklist).not.toHaveBeenCalled();
  });

  it("refuses an agent", async () => {
    auth.currentUser.mockResolvedValue(user("agent"));
    render(await ErasureWorklistPage());
    expect(screen.getByText(/need an admin account/i)).toBeTruthy();
  });

  it("diverts while the OOO only launch flag is on", async () => {
    auth.currentUser.mockResolvedValue(user("admin"));
    env.oooOnlyFor.mockReturnValue(true);
    await expect(ErasureWorklistPage()).rejects.toThrow("NEXT_REDIRECT:/admin/ooo");
  });

  it("renders for an admin, scoped to their own org", async () => {
    auth.currentUser.mockResolvedValue(user("admin"));
    render(await ErasureWorklistPage());
    expect(loader.loadErasureWorklist).toHaveBeenCalledWith("org-1");
    expect(screen.getByText(/No erasure has been recorded yet/)).toBeTruthy();
  });

  it("renders the unreadable screen when the trail could not be read", async () => {
    auth.currentUser.mockResolvedValue(user("admin"));
    loader.loadErasureWorklist.mockResolvedValue({
      kind: "trail-unreadable",
      reason: "permission denied for audit_log",
    });
    render(await ErasureWorklistPage());
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read/i);
    // Not the reassuring one.
    expect(screen.queryByText(/No erasure has been recorded yet/)).toBeNull();
  });
});
