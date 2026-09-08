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
  useMyDefaultHours: vi.fn(),
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
    // Both writes that replace the week: the form's save and the two reset
    // buttons, either of which overwrites hours nobody has read.
    expect(screen.queryByRole("button", { name: /default hours/i })).toBeNull();
    // And no claim the read never measured. "You have no working hours set" is
    // the sentence that makes pressing the button the obvious thing to do.
    expect(screen.queryByText(/You have no working hours set/i)).toBeNull();
  });

  it("says so when the SCHEDULE read succeeded and the RULES read failed", async () => {
    mockDb({ availability_rules: fails("availability_rules read exploded") });
    render(await MePage(props()));
    expect(screen.getByText(/working hours could not be read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /default hours/i })).toBeNull();
    expect(screen.queryByText(/You have no working hours set/i)).toBeNull();
  });

});
