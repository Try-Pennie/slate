// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
  /** Every table the render path read, in order (#1555). */
  reads: [] as string[],
}));
const from = vi.hoisted(() => {
  return vi.fn((table: string) => {
    db.reads.push(table);
    const res = () => {
      if (db.throwSettings && (table === "booking_settings" || table === "buckets")) {
        return Promise.reject(new Error("relation does not exist"));
      }
      return Promise.resolve(db.results[table] ?? { data: null, error: null });
    };
    const b: Record<string, unknown> = {
      maybeSingle: () => res(),
      single: () => res(),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        res().then(resolve, reject),
    };
    // Every filter/ordering method is chainable and the builder is awaitable, so
    // a read that ends on `.limit()` or `.is()` resolves the same way one ending
    // on `.order()` does (#1658 drives reads with both shapes).
    for (const m of ["select", "eq", "order", "in", "gte", "lte", "is", "limit", "neq", "range"]) {
      b[m] = () => b;
    }
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
  db.reads = [];
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
  /**
   * Run one render with the settings and bucket reads rejecting, and put the fake
   * back whatever happens (#1555).
   *
   * The failing read and the healthy one are the SAME shared object, and the page
   * swallows a read failure into "no default, no options" (its catch is
   * deliberate, so the settings screen survives a missing table). That means a
   * test which inherited a throwing fake would fail exactly the way a genuine
   * regression does, with `select.value` empty and nothing saying why. beforeEach
   * already resets the flag; this makes it impossible for a test to leave it set
   * in the first place, rather than relying on the reset alone.
   */
  async function withSettingsReadsFailing(run: () => Promise<void>): Promise<void> {
    db.throwSettings = true;
    try {
      await run();
    } finally {
      db.throwSettings = false;
    }
  }

  it("renders the non-test buckets as options with the current default selected", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    // Asserted BEFORE the value, and separately, because the page turns a failed
    // read into the same empty select a genuinely missing default produces. Read
    // together these say which of the two happened: a bare `select.value` failure
    // cannot (#1555, L11).
    expect(db.reads).toContain("booking_settings");
    expect(db.reads).toContain("buckets");
    expect(screen.queryByText(/No bookable buckets found/i)).toBeNull();

    const select = screen.getByLabelText("Default bucket") as HTMLSelectElement;
    expect(select.value).toBe("100");
    expect(screen.getByRole("option", { name: /100 \(Debt A\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /200 \(Debt B\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /No default/i })).toBeTruthy();
  });

  it("falls back to no-default without crashing when the config table is missing", async () => {
    await withSettingsReadsFailing(async () => {
      auth.currentUser.mockResolvedValueOnce(ADMIN);
      render(await MonitorSettingsPage(props));
      const select = screen.getByLabelText("Default bucket") as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(screen.getByText(/No bookable buckets found/i)).toBeTruthy();
    });
  });

  // The two states above must be distinguishable, or the assertions in the happy
  // path are decoration: if a failed read rendered the same screen as a healthy
  // one with no default set, nothing here could tell them apart (L1).
  it("renders a different screen when the reads fail than when they succeed", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));
    const healthy = (screen.getByLabelText("Default bucket") as HTMLSelectElement).value;
    const healthyReads = [...db.reads];
    cleanup();

    db.reads = [];
    await withSettingsReadsFailing(async () => {
      auth.currentUser.mockResolvedValueOnce(ADMIN);
      render(await MonitorSettingsPage(props));
      const failed = (screen.getByLabelText("Default bucket") as HTMLSelectElement).value;
      expect(failed).not.toBe(healthy);
      // Both attempted the same reads, so the difference is the read's ANSWER and
      // not a different code path being taken.
      expect(db.reads).toContain("booking_settings");
      expect(healthyReads).toContain("booking_settings");
    });
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

// #1658: three reads feed the hours block, and until now one shared catch gave
// them one shared outcome, `coverage = { ok: false }`. That outcome's own wording
// blames the ROSTER, so a failed WEEK read drew seven unchecked weekdays (the
// screen stating Pennie is closed every day) beside a notice about a read that may
// have been perfectly fine, and a failed EXCEPTIONS read drew the categorical all
// clear "No dates are set. Every day follows the weekly pattern above." on a read
// that never ran. Distinct causes get distinct messages (L11), and a surface
// derived from several reads gates on every one of them (L530).
describe("MonitorSettingsPage hours block: each read answers for itself (#1658)", () => {
  const READ_ERROR = { data: null, error: { message: "statement timeout" } };
  const WEEK = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    is_open: true,
    start_minute: 480,
    end_minute: 1200,
  }));
  const EXCEPTIONS = [
    { on_date: "2026-12-25", is_open: false, start_minute: null, end_minute: null, note: "Christmas" },
  ];

  beforeEach(() => {
    db.results.business_hours = { data: WEEK, error: null };
    db.results.business_hours_exceptions = { data: EXCEPTIONS, error: null };
    db.results.organizations = {
      data: {
        default_timezone: "America/New_York",
        default_start_minute: 540,
        default_end_minute: 1020,
        default_weekdays: [1, 2, 3, 4, 5],
      },
      error: null,
    };
  });

  // The control every negative below needs: with all three readable, the week is
  // drawn, the exceptions are drawn, and no unreadable notice appears at all. A
  // "the false all clear is gone" assertion is otherwise satisfied by a page that
  // renders nothing (L159).
  it("CONTROL: draws the week and the dates when every read succeeds", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/Christmas/)).toBeTruthy();
    expect(screen.queryByText(/No dates are set/i)).toBeNull();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
    // Five open weekdays are actually ticked, so an unchecked week below is a
    // difference in the ANSWER and not in what the page can draw.
    const openDays = [...document.querySelectorAll('input[type="checkbox"]')].filter(
      (el) => (el as HTMLInputElement).checked,
    );
    expect(openDays.length).toBeGreaterThan(0);
  });

  it("says the week could not be read instead of drawing Pennie closed every day", async () => {
    db.results.business_hours = READ_ERROR;
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/hours for the week could not be read/i)).toBeTruthy();
    // And it must not draw the week at all: an unchecked weekday is the claim
    // that Pennie is shut that day.
    expect(screen.queryByLabelText(/Monday/i)).toBeNull();
    // The roster wording belongs to the roster read, which was fine here.
    expect(screen.queryByText(/roster could not be read/i)).toBeNull();
  });

  it("says the dates could not be read instead of claiming no dates are set", async () => {
    db.results.business_hours_exceptions = READ_ERROR;
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/dates that override the weekly pattern could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No dates are set/i)).toBeNull();
    // The week is a different read and was readable, so it still draws.
    expect(screen.queryByText(/hours for the week could not be read/i)).toBeNull();
  });

  it("keeps the roster wording for a roster failure, with the week and dates still drawn", async () => {
    db.results.users = READ_ERROR;
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/roster could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Christmas/)).toBeTruthy();
    expect(screen.queryByText(/hours for the week could not be read/i)).toBeNull();
    expect(screen.queryByText(/dates that override/i)).toBeNull();
  });
});

// #1651 item 3: a bound `error` satisfies the swallowed-read scanner, but its only
// consequence here was `org = null`, and the section renders behind `{org && …}`,
// so the whole panel vanished with nothing said. The guard checks that `error` is
// BOUND, never that it produces a distinct screen.
describe("MonitorSettingsPage org defaults panel (#1651)", () => {
  it("says the starting hours could not be read rather than dropping the panel", async () => {
    db.results.organizations = { data: null, error: { message: "statement timeout" } };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.getByText(/starting hours for a new agent could not be read/i)).toBeTruthy();
    // The heading stays, so the panel is visibly present and unreadable rather
    // than absent, which is indistinguishable from a page that never had it.
    expect(screen.getAllByText(/Starting hours for a new agent/i).length).toBeGreaterThan(0);
  });

  it("CONTROL: renders the editable defaults when the read succeeds", async () => {
    db.results.organizations = {
      data: {
        default_timezone: "America/New_York",
        default_start_minute: 540,
        default_end_minute: 1020,
        default_weekdays: [1, 2, 3, 4, 5],
      },
      error: null,
    };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await MonitorSettingsPage(props));

    expect(screen.queryByText(/starting hours for a new agent could not be read/i)).toBeNull();
    expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("America/New_York");
  });
});
