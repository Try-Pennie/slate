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

// #1289: two cooldowns were stretched to a weekly repeat on purpose while the
// routing pool is off, and nothing in the product said so. An alarm quieted for a
// good reason is indistinguishable from an alarm that was always quiet, so the
// screen now names every one that repeats less often than the code intends.
describe("MonitorSettingsPage quieted-alarm notice (#1289)", () => {
  const quietRows = [
    {
      key: "empty_buckets",
      cooldown_min: 10080,
      updated_at: "2026-08-05T10:00:00.000Z",
      updated_by: null,
    },
    {
      key: "availability_data_anomaly",
      cooldown_min: 10080,
      updated_at: "2026-08-04T09:00:00.000Z",
      updated_by: null,
    },
  ];

  it("names each quieted alarm with its value, its default and when it changed", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = { data: quietRows, error: null };
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/2 alarms are set to repeat less often/i)).toBeTruthy();
    // Said in units a person reads, not as 10080 against 360.
    // Scoped to the notice: the same label also names the field further down.
    const anomaly = document.querySelector('[data-quieted-alarm="availability_data_anomaly"]');
    expect(anomaly?.textContent).toContain("Data-anomaly page cooldown");
    expect(anomaly?.textContent).toContain("7 days");
    expect(anomaly?.textContent).toContain("30 minutes");
    expect(anomaly?.textContent).toMatch(/changed Aug 4/);
    // Worst offender first: both are a week here, so the one with the shortest
    // default is the most quieted.
    const listed = [...document.querySelectorAll("[data-quieted-alarm]")].map((n) =>
      n.getAttribute("data-quieted-alarm"),
    );
    expect(listed).toEqual(["availability_data_anomaly", "empty_buckets"]);
  });

  it("says nothing when every cooldown is at or below its default", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = {
      // At its default, and one deliberately shorter (noisier, not quieter).
      data: [
        { key: "empty_buckets", cooldown_min: 360, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null },
        { key: "low_booking_volume", cooldown_min: 5, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null },
      ],
      error: null,
    };
    render(await MonitorSettingsPage(props));
    expect(screen.queryByText(/repeat less often/i)).toBeNull();
  });

  // A stored value the resolver discards leaves the alert AT its default, so the
  // notice must stay silent: pointing at it would send someone to fix a setting
  // that is already correct.
  it("stays silent for a stored value the alerts ignore", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = {
      data: [{ key: "empty_buckets", cooldown_min: 0, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null }],
      error: null,
    };
    render(await MonitorSettingsPage(props));
    expect(screen.queryByText(/repeat less often/i)).toBeNull();
  });

  // The default used to be a placeholder, which disappears the moment a value is
  // stored, which is exactly when knowing the default matters.
  it("shows each field's default even when a value is stored", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = { data: quietRows, error: null };
    render(await MonitorSettingsPage(props));

    const help = screen.getByText(/Urgent page when the cache disagrees/).textContent ?? "";
    expect(help).toContain("Default 30 minutes");
    expect(help).toMatch(/currently 7 days/);
  });
});

describe("MonitorSettingsPage alert toggles", () => {
  // The label IS the contract (L21). "Arm the low-volume alert (page Slack when
  // ...)" told the reader neither what turning it on does nor, more importantly,
  // what is still happening while it is off, and "page" read as a web page rather
  // than an alert. Dan could not tell from the screen what the control did.
  //
  // Finding each box by its ACCESSIBLE NAME also pins the label to its input, so
  // a future edit cannot leave a checkbox a screen reader announces as unlabelled.

  it("names each toggle by what it makes happen, in plain words", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByRole("checkbox", { name: /send a slack alert when bookings drop off/i })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /send a slack alert when customers are failing to book/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /send a slack alert when we offer times that are not really free/i }),
    ).toBeTruthy();
  });

  it("says what is still happening while a toggle is OFF, so 'off' is not read as 'not running'", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    // Both checks keep measuring while disarmed; only the notification stops.
    expect(screen.getByText(/Slate still counts bookings, but nobody is notified/i)).toBeTruthy();
    expect(
      screen.getByText(/Slate still checks every 5 minutes and records what it finds in the logs, but nobody is notified/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/samples the times each bucket is offering and checks them against the real calendars/i),
    ).toBeTruthy();
  });

  it("uses no alerting jargon in either label", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    for (const box of screen.getAllByRole("checkbox")) {
      const name = box.getAttribute("aria-label") ?? box.parentElement?.textContent ?? "";
      expect(name).not.toMatch(/\barm\b/i);
      expect(name).not.toMatch(/\bpage Slack\b/i);
    }
  });
});
