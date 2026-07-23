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

// Per-table read results the page render path consults. `throwSettings` makes the
// default-bucket reads reject so the missing-table fallback (#1016) is exercised.
const db = vi.hoisted(() => ({
  throwSettings: false,
  results: {} as Record<string, { data: unknown; error: unknown }>,
}));
const from = vi.hoisted(() => {
  return vi.fn((table: string) => {
    const res = () => {
      if (db.throwSettings && (table === "booking_settings" || table === "buckets")) {
        return Promise.reject(new Error("relation does not exist"));
      }
      return Promise.resolve(db.results[table] ?? { data: null, error: null });
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => res(),
      maybeSingle: () => res(),
      in: () => res(),
      then: (resolve: (v: unknown) => void) => res().then(resolve),
    };
    return b;
  });
});

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import MonitorSettingsPage from "./page";

const props = { searchParams: Promise.resolve({}) };
const ADMIN = {
  id: "ad1",
  role: "admin",
  org_id: "o1",
  email: "a@x",
  theme_preference: null,
  bookable: false,
  avatar_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  db.throwSettings = false;
  db.results = {
    monitor_settings: { data: [], error: null },
    monitor_alert_config: { data: null, error: null },
    users: { data: [], error: null },
    booking_settings: { data: { default_bucket_code: "100" }, error: null },
    buckets: {
      data: [
        { code: "100", name: "Debt A" },
        { code: "200", name: "Debt B" },
      ],
      error: null,
    },
  };
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

describe("MonitorSettingsPage default-bucket section (#1016)", () => {
  it("renders the non-test buckets as options with the current default selected", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));
    const select = screen.getByLabelText("Default bucket") as HTMLSelectElement;
    expect(select.value).toBe("100");
    expect(screen.getByRole("option", { name: /100 \(Debt A\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /200 \(Debt B\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /No default/i })).toBeTruthy();
  });

  it("falls back to no-default without crashing when the config table is missing", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.throwSettings = true;
    render(await MonitorSettingsPage(props));
    const select = screen.getByLabelText("Default bucket") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByText(/No bookable buckets found/i)).toBeTruthy();
  });
});
