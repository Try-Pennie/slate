// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1647: /me read `availability_schedules` and `availability_rules` with the
// error dropped, so an unreadable schedule rendered the working hours form with
// the DEFAULT week ticked (Monday to Friday, 9 to 5, the `workingHoursDays`
// fallback for an agent who has nothing stored yet). The agent presses Save,
// `replace_availability_rules` replaces every rule for the schedule, and the
// hours they actually worked are gone. Nothing on the screen could tell them:
// a read that failed and a schedule that was never set up render the same form,
// beside a banner saying they have no hours and a button offering to fix it.
//
// So every test below asserts BOTH halves: the section says it could not be
// read, and the control that would have written the guess is absent. The
// healthy control in the same fixture is what makes the negatives mean
// something: it stores a TUESDAY-only rule, which the fallback week never
// produces, so "the form is not showing a guess" and "the page rendered
// nothing at all" cannot both satisfy the same assertion (L159).
//
// THE TIME OFF TESTS MOVED to `time-off/page-unreadable.test.tsx` on
// 2026-09-08, when this page split in two. They were not dropped: the same
// unreadable-read behaviours are asserted there, against the page that now
// renders them.
//
// One test was CONSUMED by the split rather than moved (L373): "leaves the time
// off section working when only the hours failed". It guarded a coupling that
// no longer exists, because the two are separate routes issuing separate reads,
// so nothing here can take time off down with it. The rule it defended still
// stands; there is simply no mechanism left that could violate it, and a test
// whose premise the change removed goes red for a reason that looks exactly
// like a real defect.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({
  redirect,
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/me",
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// Every server action a form on this page points at. Named individually rather
// than through a Proxy, so a NEW action added to the page fails here loudly
// instead of silently resolving to a no-op.
vi.mock("@/app/admin/actions", () => ({
  setMyWorkingHours: vi.fn(),
}));
// #3549: the cal.com comparison is its own async component with its own tests
// (`CalcomHoursNote.test.tsx`). Stubbed here to a marker carrying what it was
// handed, so these tests can assert the page WIRES it (who gets it, with which
// week) without making a cal.com read.
vi.mock("./CalcomHoursNote", () => ({
  CalcomHoursNote: (p: { hoursSource: string | null; slate: { timezone: string; rules: unknown[] } }) => (
    <p data-testid="calcom-note">{`${p.hoursSource} ${p.slate.timezone} ${p.slate.rules.length}`}</p>
  ),
}));

import MePage from "./page";

const ME = {
  id: "u1",
  role: "agent",
  org_id: "o1",
  email: "ada@x.com",
  name: "Ada Byron",
  theme_preference: null,
  bookable: true,
  avatar_url: null,
  manager_id: "m1",
};

type Result = { data: unknown; error: { message: string } | null };

/**
 * A schedule that is genuinely NOT the default week: one Tuesday rule, 8 to 4,
 * in Chicago. The `workingHoursDays` fallback ticks Monday to Friday at 9 to 5,
 * so any assertion that Monday is unticked is answered ONLY by the stored rules
 * actually reaching the form.
 */
const HEALTHY: Record<string, Result> = {
  availability_schedules: { data: { id: "s1", timezone: "America/Chicago" }, error: null },
  availability_rules: {
    data: [{ weekday: 2, start_minute: 480, end_minute: 960 }],
    error: null,
  },
};

function mockDb(overrides: Record<string, Result> = {}) {
  const byTable = { ...HEALTHY, ...overrides };
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const result = byTable[table] ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve(result);
      b.single = b.maybeSingle;
      b.then = (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve);
      return b;
    },
  });
}

const props = (searchParams: Record<string, string> = {}) => ({
  searchParams: Promise.resolve(searchParams),
});
const fails = (message: string): Result => ({ data: null, error: { message } });

beforeEach(() => {
  vi.clearAllMocks();
  auth.currentUser.mockResolvedValue(ME);
});

describe("MePage with every read healthy (the control)", () => {
  it("renders the STORED week, offers the save, and raises no unreadable notice", async () => {
    mockDb();
    render(await MePage(props()));
    // The stored Tuesday-only rule, which the default-week fallback never draws.
    expect((screen.getByLabelText("Tuesday") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Monday") as HTMLInputElement).checked).toBe(false);
    // One typeable field per bound now (#1764), spelled the way a person reads it,
    // rather than an hour, a minute and an AM or PM select.
    expect((screen.getByLabelText("Tuesday start time") as HTMLInputElement).value).toBe("8:00am");
    // The schedule's own timezone reached the form, not the fallback. #1849 made
    // the control a picker, so the value the form would post lives in its hidden
    // input; the assertion is unchanged.
    expect(
      (document.querySelector('input[name="timezone"]') as HTMLInputElement).value,
    ).toBe("America/Chicago");
    // The save is offered, and the "you have no hours" banner is not raised.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByText(/You have no working hours set/i)).toBeNull();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("shows the agent whether they are bookable", async () => {
    // Dan's reason for putting it here (2026-09-08): an agent who thinks they
    // should be getting calls and is not can see why without asking anybody.
    // Before the split this pill was on a page no agent could open.
    mockDb();
    render(await MePage(props()));
    expect(screen.getByText("Bookable")).toBeTruthy();
  });

  it("says a not-bookable agent is not bookable, rather than saying nothing", async () => {
    // The absence of the pill would read as "nothing to report", which is the
    // opposite of what it means. `wording="self"` says "yet", because the
    // reader is the agent and the state is one they are working towards.
    mockDb();
    auth.currentUser.mockResolvedValue({ ...ME, bookable: false });
    render(await MePage(props()));
    expect(screen.getByText("Not bookable yet")).toBeTruthy();
  });

  it("tells an advisor Twilio holds back that they are on Redistribute (#3030)", async () => {
    mockDb();
    auth.currentUser.mockResolvedValue({ ...ME, bookable: false, attributes: { redistribute_tagged: "Y" } });
    render(await MePage(props()));
    expect(screen.getByText("On Redistribute")).toBeTruthy();
    expect(screen.queryByText("Not bookable yet")).toBeNull();
  });

  it("offers no company default hours control and no manager reminder", async () => {
    // #2103. Both were removed on Dan's read of the rendered page: an agent does
    // not need to know the company default exists, and the manager line was a
    // standing reminder of something they cannot act on.
    //
    // Removing the control costs nothing, because a new agent never needed it:
    // `runRosterSync` calls `ensureDefaultSchedules` in the same run that
    // inserts them, so their week is already seeded by the time they can open
    // this page. The button was a manual route to something that had already
    // happened.
    mockDb();
    render(await MePage(props()));
    expect(screen.queryByRole("button", { name: /default hours/i })).toBeNull();
    expect(screen.queryByText(/company default/i)).toBeNull();
    expect(screen.queryByText(/your manager controls/i)).toBeNull();
    // The control that DOES write is still here, so this is not passing on a
    // page that failed to render (L159).
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("sends a single day off to the time off page instead of this form", async () => {
    // The failure this steer exists to prevent: an agent edits their weekly
    // hours to take next Tuesday off and never puts them back, which narrows
    // their availability for good with nothing reporting it.
    mockDb();
    render(await MePage(props()));
    const link = screen.getByRole("link", { name: /request time off/i });
    expect(link.getAttribute("href")).toBe("/me/time-off");
    expect(screen.getByText(/applies to every week/i)).toBeTruthy();
  });
});

describe("MePage when the working hours cannot be read (#1647)", () => {
  it("says the hours could not be read and withholds every control that would replace them", async () => {
    mockDb({ availability_schedules: fails("availability_schedules read exploded") });
    render(await MePage(props()));
    expect(screen.getByText(/working hours could not be read/i)).toBeTruthy();
    // No form at all: a ticked default week is the guess that gets saved.
    expect(screen.queryByLabelText("Monday")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // #2103: this used to also assert the two "default hours" buttons were
    // withheld. They are gone from the page entirely now, so asserting their
    // absence here would pass whatever this branch did (L159). Save is the only
    // control left that replaces the week, and it is the one that matters.
    //
    // And no claim the read never measured. "You have no working hours set" is
    // the sentence that makes pressing the button the obvious thing to do.
    expect(screen.queryByText(/You have no working hours set/i)).toBeNull();
  });

  it("says so when the SCHEDULE read succeeded and the RULES read failed", async () => {
    mockDb({ availability_rules: fails("availability_rules read exploded") });
    render(await MePage(props()));
    expect(screen.getByText(/working hours could not be read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByText(/You have no working hours set/i)).toBeNull();
  });

});

describe("MePage and the agent's own booking link (#2073, #3026)", () => {
  it("shows the readable link with a copy control", async () => {
    mockDb({ agent_link_names: { data: { name: "rdaboub" }, error: null } });
    render(await MePage(props()));
    const field = screen.getByLabelText("Booking link") as HTMLInputElement;
    expect(field.value).toMatch(/\/book\/advisor\/rdaboub$/);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("says an unreadable link could not be read, never that there is none, and leaves the hours working", async () => {
    mockDb({ agent_link_names: fails("agent_link_names read exploded") });
    render(await MePage(props()));
    expect(screen.getByText(/booking link could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/do not have a booking link/i)).toBeNull();
    expect(screen.queryByLabelText("Booking link")).toBeNull();
    // The failure is the link's alone.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("says there is no link yet when the read found none", async () => {
    mockDb({ agent_link_names: { data: null, error: null } });
    render(await MePage(props()));
    expect(screen.getByText(/do not have a booking link yet/i)).toBeTruthy();
    expect(screen.queryByText(/booking link could not be read/i)).toBeNull();
  });
});

describe("MePage says where a week came from when Slate recorded it (#1757)", () => {
  it("tells an agent whose week was copied from cal.com to check it", async () => {
    mockDb({
      availability_schedules: {
        data: { id: "s1", timezone: "America/Chicago", hours_source: "calcom-import" },
        error: null,
      },
    });
    render(await MePage(props()));
    expect(screen.getByText(/copied from your cal\.com schedule/i)).toBeTruthy();
  });

  it("claims nothing for a week the agent saved, or one written before the record existed", async () => {
    for (const hours_source of ["agent", null]) {
      mockDb({
        availability_schedules: {
          data: { id: "s1", timezone: "America/Chicago", hours_source },
          error: null,
        },
      });
      const { unmount } = render(await MePage(props()));
      expect(screen.queryByText(/copied from your cal\.com/i)).toBeNull();
      // The stored week still rendered, so the absence is not a blank page (L159).
      expect((screen.getByLabelText("Tuesday") as HTMLInputElement).checked).toBe(true);
      unmount();
    }
  });
});

describe("MePage compares an advisor's own week with cal.com (#3549)", () => {
  it("hands the stored week to the comparison when the advisor wrote it", async () => {
    mockDb({
      availability_schedules: {
        data: { id: "s1", timezone: "America/Chicago", hours_source: "agent" },
        error: null,
      },
    });
    render(await MePage(props()));
    expect(screen.getByTestId("calcom-note").textContent).toBe("agent America/Chicago 1");
  });

  it("does not compare a week the daily copy keeps in step", async () => {
    for (const hours_source of ["calcom-import", "admin", "seed", null]) {
      mockDb({
        availability_schedules: {
          data: { id: "s1", timezone: "America/Chicago", hours_source },
          error: null,
        },
      });
      const { unmount } = render(await MePage(props()));
      expect(screen.queryByTestId("calcom-note")).toBeNull();
      expect((screen.getByLabelText("Tuesday") as HTMLInputElement).checked).toBe(true);
      unmount();
    }
  });
});
