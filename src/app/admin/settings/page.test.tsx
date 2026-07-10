// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the monitor-settings page (#676): unauthenticated to /login,
// the OOO-only launch flag diverts non-super-admins to /admin/ooo, and once
// scheduling is live a below-admin caller gets the deny notice. Real
// canEditOrgSettings is exercised; auth, redirect and the launch flag are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));

import MonitorSettingsPage from "./page";

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
});

describe("MonitorSettingsPage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(MonitorSettingsPage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("diverts a non-super-admin to /admin/ooo while the OOO-only flag is on", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    env.oooOnlyFor.mockReturnValueOnce(true);
    await expect(MonitorSettingsPage(props)).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo/);
  });

  it("shows the deny notice to a below-admin caller once scheduling is live", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    env.oooOnlyFor.mockReturnValueOnce(false);
    render(await MonitorSettingsPage(props));
    expect(screen.getByText(/admin account to change alert settings/i)).toBeTruthy();
  });
});
