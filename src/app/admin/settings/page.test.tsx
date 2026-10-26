// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Access guard for the monitor-settings page (#676): unauthenticated to /login,
// the OOO-only launch flag diverts non-super-admins to /admin/ooo, and once
// scheduling is live a below-admin caller gets the deny notice. Real
// canEditOrgSettings is exercised; auth, redirect and the launch flag are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const pilot = vi.hoisted(() => {
  const every = { active: true, percent: 100, tiers: "1;2;3;4;5", lastModified: null };
  return { every, read: vi.fn(async () => every as Record<string, unknown>) };
});
const EVERY_LOW_LEAD = pilot.every;
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
      const r = db.results[table] ?? { data: null, error: null };
      // A list row naming no primary key is given one by its position: a paged read
      // cuts its next page on it, and refuses a row without it (keyset paging,
      // 2026-10-25). Fixtures here reuse one row object many times.
      if (!Array.isArray(r.data)) return Promise.resolve(r);
      return Promise.resolve({
        ...r,
        data: r.data.map((row: unknown, i: number) =>
          row !== null && typeof row === "object" && !("id" in row) ? { id: `${table}-${i}`, ...row } : row,
        ),
      });
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
    for (const m of ["select", "eq", "order", "in", "gte", "lte", "is", "limit", "neq", "range", "or", "like"]) {
      b[m] = () => b;
    }
    return b;
  });
});

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// The pilot switch in Salesforce, which decides whether the Low pages are judged. Every
// Low lead on Slate by default, so the cases that are not about it see the table.
vi.mock("@/lib/salesforce/pilot-settings", () => ({ pilotSettingsCache: { read: pilot.read } }));

// #1748 broke the single "Booking and alert settings" hub into four routes. Each
// block below now drives the route that owns the panel it was written about; the
// tests did not move because the behaviour changed, they moved because the screen
// they assert on did.
import AlertSettingsPage from "../alerts/page";
import BucketsPage from "../buckets/page";
import BusinessHoursPage from "../business-hours/page";
import { ALERT_FIELDS } from "@/lib/monitor/settings";
import { alertSwitchCopy } from "@/lib/monitor/alert-switch-copy";

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
  env.consoleHiddenFor.mockReturnValue(false);
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

describe("AlertSettings guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(AlertSettingsPage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("diverts a non-super-admin to /admin/ooo while the OOO-only flag is on", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    env.consoleHiddenFor.mockReturnValueOnce(true);
    await expect(AlertSettingsPage(props)).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo/);
  });

  it("shows the deny notice to a below-admin caller once scheduling is live", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    env.consoleHiddenFor.mockReturnValueOnce(false);
    render(await AlertSettingsPage(props));
    expect(screen.getByText(/admin account to open this page/i)).toBeTruthy();
  });
});

describe("Buckets default-bucket section (#1016)", () => {
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

  /**
   * The value the form would POST for the default bucket picker.
   *
   * #1849 replaced the native select here with a picker of our own, so the value
   * lives in the hidden input the form submits rather than on a `<select>`. That
   * is what these assertions were about all along: which code the page would
   * save. Reading the hidden input keeps them measuring the same thing.
   */
  function defaultBucketValue(): string {
    const el = document.querySelector(
      'input[type="hidden"][name="default_bucket_code"]',
    ) as HTMLInputElement | null;
    // Never coerce a missing control to "", which is also a real value here: the
    // whole point of these tests is telling a failed read from an unset default.
    if (!el) throw new Error("the default bucket control is not on the page at all");
    return el.value;
  }

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
    render(await BucketsPage(props));

    // Asserted BEFORE the value, and separately, because the page turns a failed
    // read into the same empty select a genuinely missing default produces. Read
    // together these say which of the two happened: a bare `select.value` failure
    // cannot (#1555, L11).
    expect(db.reads).toContain("booking_settings");
    expect(db.reads).toContain("buckets");
    expect(screen.queryByText(/No bookable buckets found/i)).toBeNull();

    expect(defaultBucketValue()).toBe("100");

    // The rows exist only while the picker is open, so open it.
    await userEvent.click(screen.getByRole("combobox", { name: "Default bucket" }));
    expect(screen.getByRole("option", { name: /100 \(Debt A\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /200 \(Debt B\)/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /No default/i })).toBeTruthy();
  });

  it("falls back to no-default without crashing when the config table is missing", async () => {
    await withSettingsReadsFailing(async () => {
      auth.currentUser.mockResolvedValueOnce(ADMIN);
      render(await BucketsPage(props));
      expect(defaultBucketValue()).toBe("");
      expect(screen.getByText(/No bookable buckets found/i)).toBeTruthy();
    });
  });

  // The two states above must be distinguishable, or the assertions in the happy
  // path are decoration: if a failed read rendered the same screen as a healthy
  // one with no default set, nothing here could tell them apart (L1).
  it("renders a different screen when the reads fail than when they succeed", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BucketsPage(props));
    const healthy = defaultBucketValue();
    const healthyReads = [...db.reads];
    cleanup();

    db.reads = [];
    await withSettingsReadsFailing(async () => {
      auth.currentUser.mockResolvedValueOnce(ADMIN);
      render(await BucketsPage(props));
      const failed = defaultBucketValue();
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
describe("AlertSettings quieted-alarm notice (#1289)", () => {
  const quietRows = [
    {
      key: "empty_tier",
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
    render(await AlertSettingsPage(props));

    expect(screen.getByText(/2 alarms are set to repeat less often/i)).toBeTruthy();
    // Said in units a person reads, not as 10080 against 360.
    // Scoped to the notice: the same label also names the field further down.
    const anomaly = document.querySelector('[data-quieted-alarm="availability_data_anomaly"]');
    expect(anomaly?.textContent).toContain("Data-anomaly page cooldown");
    expect(anomaly?.textContent).toContain("7 days");
    expect(anomaly?.textContent).toContain("1 day");
    expect(anomaly?.textContent).toMatch(/changed Aug 4/);
    // Worst offender first: both are a week here, so the one with the shortest
    // default is the most quieted. Since #3801 that is the empty tier page, an urgent
    // condition repeating hourly, against the anomaly page's daily default.
    const listed = [...document.querySelectorAll("[data-quieted-alarm]")].map((n) =>
      n.getAttribute("data-quieted-alarm"),
    );
    expect(listed).toEqual(["empty_tier", "availability_data_anomaly"]);
  });

  it("says nothing when every cooldown is at or below its default", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = {
      // At its default, and one deliberately shorter (noisier, not quieter).
      data: [
        { key: "empty_tier", cooldown_min: 60, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null },
        { key: "low_booking_volume", cooldown_min: 5, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null },
      ],
      error: null,
    };
    render(await AlertSettingsPage(props));
    expect(screen.queryByText(/repeat less often/i)).toBeNull();
  });

  // Dan, 2026-10-26: the below tier alert has no cooldown any more, so no row here
  // paces it. A value stored before then stays in the table and is passed over:
  // neither drawn as a field nor reported as a quieted alarm.
  it("draws no cooldown for the below tier alert, and passes over a value stored for it", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = {
      data: [
        { key: "booking_below_lead_tier", cooldown_min: 10080, updated_at: "2026-10-01T10:00:00.000Z", updated_by: null },
      ],
      error: null,
    };
    render(await AlertSettingsPage(props));

    expect(document.getElementById("cooldown_booking_below_lead_tier")).toBeNull();
    expect(screen.queryByText(/A lead booked with a team below their tier/)).toBeNull();
    expect(screen.queryByText(/repeat less often/i)).toBeNull();
  });

  // A stored value the resolver discards leaves the alert AT its default, so the
  // notice must stay silent: pointing at it would send someone to fix a setting
  // that is already correct.
  it("stays silent for a stored value the alerts ignore", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = {
      data: [{ key: "empty_tier", cooldown_min: 0, updated_at: "2026-08-05T10:00:00.000Z", updated_by: null }],
      error: null,
    };
    render(await AlertSettingsPage(props));
    expect(screen.queryByText(/repeat less often/i)).toBeNull();
  });

  // The default used to be a placeholder, which disappears the moment a value is
  // stored, which is exactly when knowing the default matters. It is its own
  // column now (#1955) rather than a clause in a sentence, so it is there either
  // way and the digits line up down the page.
  it("shows each field's default even when a value is stored", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = { data: quietRows, error: null };
    render(await AlertSettingsPage(props));

    // The field that HAS a stored value still states its default beside it.
    const field = screen.getByLabelText(/Data-anomaly page cooldown/);
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/default 1440/i);
    // And every field has one, not just the overridden one.
    const defaults = [...document.querySelectorAll('[id$="_default"]')];
    // Plus the two that decide when a debt tier page ends (#3227), and the nearly
    // full pool line (#3559).
    expect(defaults.length).toBe(ALERT_FIELDS.length + 3);
  });

  // #3559: the nearly full pool line, set under that notice's own cooldown, with
  // the stored value, its default and the range the save accepts.
  it("shows the nearly full pool line under the nearly full notice", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = {
      data: { id: 1, pool_nearly_full_open_pct: 15 },
      error: null,
    };
    render(await AlertSettingsPage(props));
    const pct = screen.getByLabelText(/Percent still open/) as HTMLInputElement;
    expect(pct.name).toBe("pool_nearly_full_open_pct");
    expect(pct.value).toBe("15");
    expect(pct.min).toBe("1");
    expect(pct.max).toBe("50");
    expect(document.getElementById(pct.getAttribute("aria-describedby")!)?.textContent).toMatch(/default 10$/);
    // Directly under its own alert's cooldown, not under another alert's.
    const row = pct.closest("li");
    expect(row?.previousElementSibling?.querySelector('[name="cooldown_pool_nearly_full"]')).toBeTruthy();
  });

  // #3227: when a debt tier page ends, set under that alert's own cooldown, with
  // the stored value, its default and the range the save accepts.
  it("shows the tier recovery settings under the debt tier alert", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = {
      data: { id: 1, empty_tier_recovery_min_times: 5, empty_tier_recovery_hold_min: null },
      error: null,
    };
    render(await AlertSettingsPage(props));
    const times = screen.getByLabelText(/Open times before it ends/) as HTMLInputElement;
    expect(times.name).toBe("empty_tier_recovery_min_times");
    expect(times.value).toBe("5");
    expect(times.min).toBe("1");
    expect(times.max).toBe("50");
    expect(document.getElementById(times.getAttribute("aria-describedby")!)?.textContent).toMatch(/default 3$/);
    const hold = screen.getByLabelText(/Minutes held before it ends/) as HTMLInputElement;
    expect(hold.name).toBe("empty_tier_recovery_hold_min");
    expect(hold.value).toBe("");
    expect(hold.min).toBe("0");
    expect(hold.max).toBe("240");
    expect(document.getElementById(hold.getAttribute("aria-describedby")!)?.textContent).toMatch(/default 30$/);
  });

  // #1955: the one interesting fact on the section was buried in a grey sentence
  // identical to the 22 that said nothing. The design says it instead: the value
  // and its default sit on ONE line, so a 10080 beside "default 30" is visible
  // without reading, and the notice above the section already names every
  // override with its value, its default and the date. A third statement on the
  // row would be decoration (L558).
  it("puts each value beside its own default, so an override needs no sentence", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_settings = { data: quietRows, error: null };
    render(await AlertSettingsPage(props));

    const row = document
      .querySelector('label[for="cooldown_availability_data_anomaly"]')
      ?.closest("li");
    // The stored value and the default are both on the row.
    expect((row?.querySelector("input") as HTMLInputElement | null)?.value).toBe("10080");
    expect(row?.textContent).toMatch(/default 1440/);
    // And the row does NOT restate the consequence, which the notice above the
    // section already carries.
    expect(row?.textContent).not.toMatch(/repeats less often/i);
    expect(screen.getByText(/set to repeat less often than their defaults/i)).toBeTruthy();
  });

  // What each alert DOES is the only place any of them is explained, so it stays
  // reachable by mouse and by screen reader even though 23 visible sentences is
  // the wall of text this redesign removed (L579).
  it("keeps what each alert does reachable rather than visible", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));
    const label = document.querySelector('label[for="cooldown_availability_data_anomaly"]');
    expect(label?.getAttribute("title")).toMatch(/cache disagrees with the calendars/i);
    expect(label?.querySelector(".sr-only")?.textContent).toMatch(
      /cache disagrees with the calendars/i,
    );
  });

  // Grouped by volume, loudest first, which is the axis the section had none of.
  it("groups the settings by how loud they are, pages first", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));
    const headings = [...document.querySelectorAll("h3")].map((h) =>
      (h.textContent ?? "").trim(),
    );
    const volumes = headings.filter((h) =>
      /^(Pages|Alerts|Notices|Whispers)\b/.test(h),
    );
    expect(volumes.map((h) => h.split(" ")[0])).toEqual([
      "Pages",
      "Alerts",
      "Notices",
      "Whispers",
    ]);
  });
});

describe("AlertSettings alert toggles", () => {
  // The label IS the contract (L21). "Arm the low-volume alert (page Slack when
  // ...)" told the reader neither what turning it on does nor, more importantly,
  // what is still happening while it is off, and "page" read as a web page rather
  // than an alert. Dan could not tell from the screen what the control did.
  //
  // Finding each box by its ACCESSIBLE NAME also pins the label to its input, so
  // a future edit cannot leave a checkbox a screen reader announces as unlabelled.

  it("names each toggle by what it makes happen, in plain words", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));

    expect(screen.getByRole("checkbox", { name: /send a slack alert when bookings drop off/i })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /send a slack alert when customers are failing to book/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /send a slack alert when we offer times that are not really free/i }),
    ).toBeTruthy();
  });

  // Dan, 2026-10-26: "I think in general this page is too noisy. We should probably
  // show on OR off based on the current state and the wording probably can be less
  // 'wordy'." Each switch says only what its current state means, read through the
  // box's own aria-describedby so the sentence stays tied to the control it explains.
  const SWITCHES = [
    "low_volume_armed",
    "failure_rate_armed",
    "availability_drift_armed",
    "roster_coverage_armed",
    "awaiting_activation_armed",
    "below_lead_tier_armed",
    "regal_calls_armed",
  ] as const;
  const helpFor = (name: string): string => {
    const box = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    const id = box?.getAttribute("aria-describedby");
    return ((id && document.getElementById(id)?.textContent) || "").replace(/\s+/g, " ").trim();
  };
  const armedConfig = Object.fromEntries(SWITCHES.map((s) => [s, true]));

  it("draws one sentence per switch for the card, and the copy covers exactly these switches", () => {
    expect(alertSwitchCopy(null).map((s) => s.name)).toEqual([...SWITCHES]);
  });

  it("shows only the off sentence under every switch that is off", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));

    for (const s of alertSwitchCopy(null)) {
      expect((document.querySelector(`input[name="${s.name}"]`) as HTMLInputElement).checked).toBe(false);
      expect(helpFor(s.name)).toBe(s.off);
      expect(helpFor(s.name)).not.toContain(s.on);
    }
  });

  it("shows only the on sentence under every switch that is on", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: armedConfig, error: null };
    render(await AlertSettingsPage(props));

    for (const s of alertSwitchCopy(null)) {
      expect((document.querySelector(`input[name="${s.name}"]`) as HTMLInputElement).checked).toBe(true);
      expect(helpFor(s.name)).toBe(s.on);
      expect(helpFor(s.name)).not.toContain(s.off);
    }
  });

  it("carries no state labels and nothing about the interface, in either state", async () => {
    for (const data of [null, armedConfig]) {
      cleanup();
      auth.currentUser.mockResolvedValueOnce(ADMIN);
      db.results.monitor_alert_config = { data, error: null };
      render(await AlertSettingsPage(props));
      for (const name of SWITCHES) {
        const help = helpFor(name);
        expect(help).not.toBe("");
        expect(help).not.toMatch(/\b(On|Off):/);
        expect(help).not.toMatch(/nobody is notified|Saving applies|no deploy needed/i);
      }
    }
  });

  // The below tier alert posts once per call and again only on a change
  // (CHANGE_ONLY_KEYS, #4235); a call put right has been silent since 2026-10-07.
  it("says the below tier alert posts once per call and again only when the call or the lead changes", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: { below_lead_tier_armed: true }, error: null };
    render(await AlertSettingsPage(props));

    const help = helpFor("below_lead_tier_armed");
    expect(help).toMatch(/one alert per call/i);
    expect(help).toMatch(/time, advisor or bucket/i);
    expect(help).toMatch(/the lead's tier/i);
    expect(help).not.toMatch(/follow up|is moved|score comes down|is cancelled/i);
  });

  it("names the cal.com cutover under the below tier switch while it is off, and the retirement once it is", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: { calcom_retired: false }, error: null };
    render(await AlertSettingsPage(props));
    expect(helpFor("below_lead_tier_armed")).toMatch(/Turn this on before cutover/);

    cleanup();
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: { calcom_retired: true }, error: null };
    render(await AlertSettingsPage(props));
    expect(helpFor("below_lead_tier_armed")).toMatch(/cal\.com is retired/);
    expect(helpFor("below_lead_tier_armed")).not.toMatch(/before cutover/);
  });

  // The sentence follows the box as it is ticked, before any save: it says what the
  // switch will do once saved, and the unsaved changes guard already marks the form.
  it("swaps the sentence the moment a box is ticked or cleared, before saving", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));
    const copy = alertSwitchCopy(null).find((s) => s.name === "awaiting_activation_armed")!;
    const box = document.querySelector<HTMLInputElement>('input[name="awaiting_activation_armed"]')!;

    expect(helpFor(copy.name)).toBe(copy.off);
    await userEvent.click(box);
    expect(box.checked).toBe(true);
    expect(helpFor(copy.name)).toBe(copy.on);
    await userEvent.click(box);
    expect(helpFor(copy.name)).toBe(copy.off);
  });

  // A form reset changes the box without a change event, so the sentence must read
  // the box itself afterwards rather than trust what the last click left behind.
  it("puts the sentence back with the box when the form is reset", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));
    const copy = alertSwitchCopy(null).find((s) => s.name === "awaiting_activation_armed")!;
    const box = document.querySelector<HTMLInputElement>('input[name="awaiting_activation_armed"]')!;

    await userEvent.click(box);
    expect(helpFor(copy.name)).toBe(copy.on);
    await act(async () => {
      box.form!.reset();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(box.checked).toBe(false);
    expect(helpFor(copy.name)).toBe(copy.off);
  });

  it("uses no alerting jargon in either label", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(props));

    for (const box of screen.getAllByRole("checkbox")) {
      const name = box.getAttribute("aria-label") ?? box.parentElement?.textContent ?? "";
      expect(name).not.toMatch(/\barm\b/i);
      expect(name).not.toMatch(/\bpage Slack\b/i);
    }
  });
});

// #2739: the ramp end form lives low on the page, so both of its outcomes are
// drawn beside it, where the person pressed (L608), and a failed read back after
// a save still shows what the save did rather than claiming nothing changed (L11).
describe("AlertSettings ramp end outcomes (#2739)", () => {
  const learningCard = () => document.getElementById("volume-learning")!;
  const withParams = (sp: Record<string, string>) => ({ searchParams: Promise.resolve(sp) });

  it("draws a refusal of the ramp end form beside it, not at the top", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(withParams({ error: "Pick the day the ramp ended.", form: "volume-ramp-end" })));
    expect(learningCard().textContent).toContain("Pick the day the ramp ended.");
    // Once on the page, inside the card.
    expect(screen.getAllByText("Pick the day the ramp ended.")).toHaveLength(1);
  });

  it("control: a refusal from another form stays at the top", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(withParams({ error: "Cooldown (x) must be a whole number." })));
    expect(screen.getByText("Cooldown (x) must be a whole number.")).toBeTruthy();
    expect(learningCard().textContent).not.toContain("Cooldown (x)");
  });

  it("draws a saved ramp end beside the form", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await AlertSettingsPage(withParams({ ok: "volume-ramp-end-set" })));
    expect(learningCard().textContent).toContain("Ramp end saved.");
    expect(screen.getAllByText(/Ramp end saved\./)).toHaveLength(1);
  });

  it("keeps the save's confirmation when the settings cannot be read back, and does not claim nothing changed", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: null, error: { message: "read timeout" } };
    render(await AlertSettingsPage(withParams({ ok: "volume-ramp-end-cleared" })));
    const card = learningCard().textContent!;
    expect(card).toContain("Ramp end cleared.");
    expect(card).toContain("could not be read back");
    expect(card).not.toContain("Nothing has changed");
  });

  it("control: an unreadable read with no save says it cannot tell, and that nothing changed", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.monitor_alert_config = { data: null, error: { message: "read timeout" } };
    render(await AlertSettingsPage(props));
    const card = learningCard().textContent!;
    expect(card).toContain("cannot say whether a ramp end is set");
    expect(card).toContain("Nothing has changed");
  });
});

// #2765: the Low pages' own floors are not coverage while bookings arrive without the
// page they came from, so the card says how many did in their place, measured by the
// same `measurePageSources` the readiness gate reads.
describe("AlertSettings per page floors wait on recorded sources (#2765)", () => {
  const learningCard = () => document.getElementById("volume-learning")!;
  const coverageRows = () => learningCard().querySelectorAll("[data-page-coverage]");

  // A stored refit, as the daily refit writes one. The day is the one just ended, read
  // off the real clock, so no stamp here ages into another state (an overdue refit,
  // say) as the calendar moves.
  const shareRecord = (share: number) => {
    const to = new Date(Date.now() - 60_000).toISOString();
    const from = new Date(Date.now() - 24 * 60 * 60_000 - 60_000).toISOString();
    const slate = Math.round(share * 400);
    return {
      to,
      row: {
        volume_learning: {
          version: 3,
          declaredRampEndOn: null,
          fittedAt: to,
          tiers: { "1": { firstBookingAt: null, rampStartAt: null, result: null } },
          carriedShare: {
            measuredAt: to,
            from,
            to,
            tiers: {
              "1": {
                applied: { share, slate, calcom: 400 - slate, level: null, from, to },
                last: { slate, calcom: 400 - slate, level: null, outcome: "applied" },
                heldSince: null,
              },
            },
          },
        },
      },
    };
  };
  let stored = shareRecord(0.75);
  beforeEach(() => {
    stored = shareRecord(0.75);
    db.results.monitor_alert_config = { data: stored.row, error: null };
    pilot.read.mockReset();
    pilot.read.mockResolvedValue(EVERY_LOW_LEAD);
  });

  it("says the pages are not judged, in place of their floors, while the pilot splits Low", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    pilot.read.mockResolvedValue({ ...EVERY_LOW_LEAD, percent: 50 });
    db.results.business_hours = { data: [], error: null };
    db.results.business_hours_exceptions = { data: [], error: null };
    render(await AlertSettingsPage(props));
    expect(learningCard().querySelector("[data-page-pilot]")!.textContent).toBe(
      "Per page Low alerts are off while the pilot sends Slate 50% of Low leads. They turn on at 100%.",
    );
    expect(coverageRows()).toHaveLength(0);
  });

  it("control: with every Low lead on Slate, shows the pages' floors and no pilot line", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    // #2974: the real booking count is read as rows, so the fake answers every bookings
    // read with 40 sourced page bookings framed by the production site.
    const sourced = { id: "b1", source: "offerhub", parent_origin: "https://trypennie.com", referrer_origin: null };
    db.results.bookings = { data: Array.from({ length: 40 }, (_, i) => ({ ...sourced, id: `sourced-${i}` })), error: null } as { data: unknown; error: unknown };
    db.results.business_hours = { data: [], error: null };
    db.results.business_hours_exceptions = { data: [], error: null };
    render(await AlertSettingsPage(props));
    expect(learningCard().querySelector("[data-page-pilot]")).toBeNull();
    expect(coverageRows().length).toBeGreaterThan(0);
  });

  it("says where to look when the pilot settings cannot be read", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    pilot.read.mockRejectedValue(new Error("salesforce down"));
    db.results.business_hours = { data: [], error: null };
    db.results.business_hours_exceptions = { data: [], error: null };
    render(await AlertSettingsPage(props));
    const said = learningCard().querySelector("[data-page-pilot]")!.textContent!;
    expect(said).toMatch(/^Per page Low alerts are off: the pilot settings in Salesforce could not be read/);
    expect(said).toContain("Website Configuration (trypennie.com)");
    expect(coverageRows()).toHaveLength(0);
  });

  it("says how many bookings recorded no source, instead of the pages' floors", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    // The fake answers every bookings read alike: 40 real, 40 unsourced rows framed
    // by the production site, a row found.
    const framed = { id: "b1", source: "not-given", parent_origin: "https://trypennie.com", referrer_origin: null };
    db.results.bookings = { data: Array.from({ length: 40 }, (_, i) => ({ ...framed, id: `framed-${i}` })), error: null, count: 40 } as { data: unknown; error: unknown };
    render(await AlertSettingsPage(props));
    const said = learningCard().querySelector("[data-page-sources]")!.textContent!;
    expect(said).toMatch(/^Source not recorded on 40 of 40 bookings in the last 7 days/);
    expect(coverageRows()).toHaveLength(0);
    expect(db.reads.filter((t) => t === "bookings").length).toBeGreaterThan(0);
  });

  it("says a failed source read could not be read, never that every booking carried one", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    db.results.bookings = { data: null, error: { message: "statement timeout" } };
    render(await AlertSettingsPage(props));
    expect(learningCard().querySelector("[data-page-sources]")!.textContent).toContain("could not be read");
    expect(coverageRows()).toHaveLength(0);
  });

  // #2960: unsourced bookings made by hand with no host page are set aside: the floors
  // show, and the card says how many were set aside on their own line.
  it("sets aside hand made bookings with no host page, and says how many", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    const byHand = { id: "b1", source: "not-given", parent_origin: null, referrer_origin: null };
    // #2974: the real booking count is read as rows: 40 sourced page bookings beside the
    // 4 made by hand, and every bookings read is answered alike.
    const sourced = { id: "b2", source: "offerhub", parent_origin: "https://trypennie.com", referrer_origin: null };
    db.results.bookings = {
      data: [...Array.from({ length: 40 }, (_, i) => ({ ...sourced, id: `sourced-${i}` })), ...Array.from({ length: 4 }, (_, i) => ({ ...byHand, id: `byHand-${i}` }))],
      error: null,
    } as { data: unknown; error: unknown };
    db.results.business_hours = { data: [], error: null };
    db.results.business_hours_exceptions = { data: [], error: null };
    render(await AlertSettingsPage(props));
    expect(learningCard().querySelector("[data-page-sources]")).toBeNull();
    expect(coverageRows().length).toBeGreaterThan(0);
    expect(learningCard().querySelector("[data-page-sources-set-aside]")!.textContent).toMatch(
      /^4 bookings in the last 7 days were made with no host page/,
    );
  });

  it("control: every real booking sourced shows the pages' floors", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    // #2974: the real booking count is read as rows, so the fake answers every bookings
    // read with 40 sourced page bookings framed by the production site.
    const sourced = { id: "b1", source: "offerhub", parent_origin: "https://trypennie.com", referrer_origin: null };
    db.results.bookings = { data: Array.from({ length: 40 }, (_, i) => ({ ...sourced, id: `sourced-${i}` })), error: null } as { data: unknown; error: unknown };
    db.results.business_hours = { data: [], error: null };
    db.results.business_hours_exceptions = { data: [], error: null };
    render(await AlertSettingsPage(props));
    expect(learningCard().querySelector("[data-page-sources]")).toBeNull();
    expect(coverageRows().length).toBeGreaterThan(0);
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
describe("BusinessHours hours block: each read answers for itself (#1658)", () => {
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
    render(await BusinessHoursPage(props));

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
    render(await BusinessHoursPage(props));

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
    render(await BusinessHoursPage(props));

    expect(screen.getByText(/dates that override the weekly pattern could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No dates are set/i)).toBeNull();
    // The week is a different read and was readable, so it still draws.
    expect(screen.queryByText(/hours for the week could not be read/i)).toBeNull();
  });

  it("keeps the roster wording for a roster failure, with the week and dates still drawn", async () => {
    db.results.users = READ_ERROR;
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

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
//
// #1892 moved the panel onto the Hours page, so these render THAT page. They are
// relocated rather than deleted: the defect they pin travels with the panel, and
// a fourth read on a page with three could-not-measure states is exactly where it
// would come back (L530).
describe("the new agent starting hours panel (#1651, moved by #1892)", () => {
  it("says the starting hours could not be read rather than dropping the panel", async () => {
    db.results.organizations = { data: null, error: { message: "statement timeout" } };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

    expect(screen.getByText(/starting hours for a new agent could not be read/i)).toBeTruthy();
    // The heading stays, so the panel is visibly present and unreadable rather
    // than absent, which is indistinguishable from a page that never had it.
    expect(screen.getAllByText(/New agent starting hours/i).length).toBeGreaterThan(0);
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
    render(await BusinessHoursPage(props));

    expect(screen.queryByText(/starting hours for a new agent could not be read/i)).toBeNull();
    expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("America/New_York");
  });

  // #1892: the four reads on this page each answer for themselves. An unreadable
  // org row must not empty the week, and an unreadable week must not empty this.
  it("keeps the other three panels when only the org defaults are unreadable", async () => {
    db.results.organizations = { data: null, error: { message: "statement timeout" } };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

    expect(screen.getByText(/starting hours for a new agent could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/hours for the week could not be read/i)).toBeNull();
    expect(screen.queryByText(/dates that override/i)).toBeNull();
  });

  // #1297's risk, carried by STRUCTURE now that the two live on one page: the org
  // window and the seeding template must not read as one thing. Separate cards,
  // separate saves, the org window first.
  it("keeps the org window and the new agent template apart", async () => {
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
    render(await BusinessHoursPage(props));

    const orgHeading = screen.getByText("Business hours", { selector: "h2" });
    const templateHeading = screen.getByText("New agent starting hours");
    // Different cards, so neither can be read as part of the other.
    expect(orgHeading.closest("section")).not.toBe(templateHeading.closest("section"));
    // The org window comes first.
    expect(
      orgHeading.compareDocumentPosition(templateHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Its own save, so one press can never write both.
    expect(screen.getByRole("button", { name: /save starting hours/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /save business hours/i })).toBeTruthy();
  });
});

// #3922: Dan read "Most days offered" holding 4 under a paragraph saying a lead is
// offered 3 days, and asked which was true. Both were: 3 was fixed in code and is
// what every lead sees, the box was how far the last resort (#2841) may reach. The
// card is now the settled design (docs/design/days-offered.html, four rounds): the
// offered days are a stored setting, the last resort is entered as extra days, and
// a fact line states the furthest day with the sum that makes it.
describe("the days offered card (#3922)", () => {
  async function card(stored: { offered_open_days?: number; horizon_days?: number | null } = {}) {
    db.results.booking_settings = { data: { offered_open_days: 3, horizon_days: 4, ...stored }, error: null };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));
    const section = screen.getByText("Days offered", { selector: "h2" }).closest("section");
    expect(section).not.toBeNull();
    return section!;
  }

  it("holds today's values in two of Slate's own dropdowns: 3 offered and 1 extra", async () => {
    const section = await card();
    const offered = screen.getByRole("combobox", { name: "Offered open days" });
    const extra = screen.getByRole("combobox", { name: "Last resort extra days" });
    expect(section.contains(offered) && section.contains(extra)).toBe(true);
    expect(offered.textContent).toBe("3");
    expect(extra.textContent).toBe("1");
    // Nothing native and nothing typed: no select, no number box.
    expect(section.querySelector("select, input[type='number']")).toBeNull();
  });

  it("follows the stored value: 4 offered and a reach of 6 read as 4 and 2", async () => {
    await card({ offered_open_days: 4, horizon_days: 6 });
    expect(screen.getByRole("combobox", { name: "Offered open days" }).textContent).toBe("4");
    expect(screen.getByRole("combobox", { name: "Last resort extra days" }).textContent).toBe("2");
    expect(screen.getByText("Furthest a lead can be offered").parentElement?.textContent).toContain(
      "Day 6 (4 offered + 2 extra)",
    );
  });

  it("states the furthest day with the sum that makes it", async () => {
    const section = await card();
    const term = screen.getByText("Furthest a lead can be offered");
    expect(section.contains(term)).toBe(true);
    expect(term.parentElement?.textContent).toBe("Furthest a lead can be offeredDay 4 (3 offered + 1 extra)");
  });

  it("says when today counts under the heading, and the old paragraph is gone", async () => {
    const section = await card();
    expect(section.textContent).toContain("Today counts only before 6pm New York time.");
    expect(section.textContent).not.toMatch(/This number is how far|Most days offered|last resort reach/i);
    expect(section.textContent).toContain("Every lead sees this many open days.");
    expect(section.textContent).toContain("Added when every tier a lead may use is full. 0 means no last resort.");
  });

  it("has one button, named for the card", async () => {
    const section = await card();
    const buttons = [...section.querySelectorAll("button[type='submit'], button:not([type])")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Save days offered"]);
    expect(screen.queryByRole("button", { name: /booking horizon|last resort reach/i })).toBeNull();
  });

  it("names the page's job as how many days a lead is offered", async () => {
    await card();
    expect(document.body.textContent).toContain("how many days a lead is offered");
    expect(document.body.textContent).not.toContain("how far ahead a lead can book");
  });

  // An unreadable row draws its own notice, never the card filled with guesses a
  // save would then write back as fact (L530).
  it("says the days offered could not be read rather than drawing guessed values", async () => {
    db.results.booking_settings = { data: null, error: { message: "read timeout" } };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));
    const section = screen.getByText("Days offered", { selector: "h2" }).closest("section")!;
    expect(section.textContent).toContain("The days offered could not be read just now");
    expect(section.querySelector("[role='combobox']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save days offered" })).toBeNull();
  });

  it("confirms a save in the card's own name", async () => {
    db.results.booking_settings = { data: { offered_open_days: 3, horizon_days: 4 }, error: null };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage({ searchParams: Promise.resolve({ ok: "days-offered" }) }));
    expect(screen.getByText("Days offered saved.")).toBeTruthy();
  });
});

// #3325: the shared confirm line's switch is the last card on the page, below the
// settings edited on an ordinary day (Dan, 2026-10-19). It is its own read and its own
// card, and an unreadable read draws its own state rather than either answer (L530).
describe("the shared confirm line switch (#3325)", () => {
  function cards() {
    const pause = screen.getByText("Online booking", { selector: "h2" }).closest("section");
    const line = screen.getByText("Shared confirm line", { selector: "h2" }).closest("section");
    return { pause, line };
  }

  // Last on the page, below every setting edited on an ordinary day, because it is
  // switched on once and then left alone (Dan, 2026-10-19). It used to sit directly
  // after the pause (#3325); online booking stays first as the emergency switch.
  it("draws its own card as the last section, with online booking first", async () => {
    db.results.booking_settings = { data: { shared_confirm_line: false }, error: null };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

    const { pause, line } = cards();
    expect(line).not.toBe(pause);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe("Online booking");
    expect(headings.at(-1)).toBe("Shared confirm line");
    expect(line?.nextElementSibling).toBeNull();
    expect(line?.querySelector('[data-state="off"]')).toBeTruthy();
  });

  it("draws the line as on when the stored switch is on", async () => {
    db.results.booking_settings = { data: { shared_confirm_line: true }, error: null };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

    expect(cards().line?.querySelector('[data-state="on"]')).toBeTruthy();
  });

  it("says it could not read the switch rather than drawing it off", async () => {
    db.results.booking_settings = { data: null, error: { message: "statement timeout" } };
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    render(await BusinessHoursPage(props));

    const { line } = cards();
    expect(line?.querySelector('[data-state="unreadable"]')).toBeTruthy();
    expect(line?.querySelector('[data-state="off"]')).toBeNull();
  });
});
