// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The time off half of #1647, moved here on 2026-09-08 when `/me` split into
// My Availability and My Time Off. Every one of these behaviours is still live;
// only the route changed, so the tests MOVED rather than being deleted (L430).
//
// The class is a read whose dropped error renders the same screen an empty
// answer renders. On this page the empty answer is "you have asked for no time
// off", said to somebody who is on the page precisely to ask, and the obvious
// reply to it is to ask again: a second request for the same days. The change
// form is worse still, because a failed read leaves `editing` null and silently
// downgrades a CHANGE into a new request.
//
// The healthy control in the same fixture is what makes the negatives mean
// something: without it "the section says it could not be read" is equally
// satisfied by a page that rendered nothing at all (L159).
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
  usePathname: () => "/me/time-off",
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// Every server action a form on this page points at. Named individually rather
// than through a Proxy, so a NEW action added to the page fails here loudly
// instead of silently resolving to a no-op.
vi.mock("@/app/me/actions", () => ({
  cancelMyOoo: vi.fn(),
  modifyMyOoo: vi.fn(),
  submitMyOoo: vi.fn(),
}));

import MeTimeOffPage from "./page";

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

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const HEALTHY: Record<string, Result> = {
  availability_schedules: { data: { timezone: "America/Chicago" }, error: null },
  ooo_requests: {
    data: [
      {
        id: "r1",
        user_id: "u1",
        manager_id: "m1",
        status: "pending",
        starts_at: iso(3),
        ends_at: iso(4),
        display_tz_id: "America/Chicago",
        display_tz_label: "CT",
        all_day: true,
        reason: "Family wedding",
        notes: null,
        rejection_note: null,
        created_at: iso(-1),
      },
    ],
    error: null,
  },
  users: { data: { name: "Mona Lisa", email: "mona@x.com" }, error: null },
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

describe("MeTimeOffPage with every read healthy (the control)", () => {
  it("lists the stored request, names the reviewer, and raises no unreadable notice", async () => {
    mockDb();
    render(await MeTimeOffPage(props()));
    expect(screen.getByText(/Family wedding/)).toBeTruthy();
    expect(screen.getAllByText(/Mona Lisa/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Request time off/i })).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("heads the form with the word the tab uses, not 'time away'", async () => {
    // The heading said "Request time away" while the button beneath it said
    // "Request time off", which is two words for one unit inside one card
    // (L118). Settled on "time off" (Dan, 2026-09-08), the phrasing the rest of
    // the product already used.
    mockDb();
    render(await MeTimeOffPage(props()));
    expect(screen.getByRole("heading", { name: /Request time off/i })).toBeTruthy();
    expect(screen.queryByText(/time away/i)).toBeNull();
  });
});

describe("MeTimeOffPage when the time off requests cannot be read (#1647)", () => {
  it("says so rather than reporting no upcoming time off", async () => {
    mockDb({ ooo_requests: fails("ooo_requests read exploded") });
    render(await MeTimeOffPage(props()));
    expect(screen.getByText(/time off requests could not be read/i)).toBeTruthy();
    // The empty state answers "have I already asked for this?" with a wrong no.
    expect(screen.queryByText(/No upcoming time off/i)).toBeNull();
  });

  it("withholds the change form when the request being edited could not be read", async () => {
    mockDb({ ooo_requests: fails("ooo_requests read exploded") });
    render(await MeTimeOffPage(props({ edit: "r1" })));
    // Without this the page silently downgrades a change into a NEW request, so
    // the agent submits a second one for the same days.
    expect(screen.queryByRole("button", { name: /Request time off/i })).toBeNull();
    expect(screen.getByText(/That request could not be read/i)).toBeTruthy();
  });

  it("summarizes nothing rather than a quiet week in the greeting", async () => {
    // Every other sentence in that band is a count, and a count off a read that
    // never ran is the one thing the greeting must not say. This used to be
    // reached only in the OOO-only phase, which is why it mocked the launch
    // flag; the greeting is unconditional now, so the flag is gone from the
    // fixture rather than being pinned at a value nothing reads.
    mockDb({ ooo_requests: fails("ooo_requests read exploded") });
    render(await MeTimeOffPage(props()));
    expect(screen.queryByText(/Need a day off\?/i)).toBeNull();
    expect(screen.queryByText(/Nothing pending/i)).toBeNull();
    // The greeting's own sentence, not the list notice below it: both say
    // "could not be read just now", and matching either would let this pass
    // on a greeting that said nothing at all.
    expect(screen.getByText(/nothing summarized here/i)).toBeTruthy();
  });
});

describe("MeTimeOffPage when the manager row cannot be read (#1647)", () => {
  it("names the manager it knows exists rather than the no-manager pool", async () => {
    mockDb({ users: fails("users read exploded") });
    render(await MeTimeOffPage(props()));
    // manager_id is set, so "a team lead or admin signs off on these" tells an
    // agent who HAS a manager that they have none: a claim nothing measured.
    expect(screen.queryByText(/a team lead or admin/i)).toBeNull();
    expect(screen.getAllByText(/Your manager signs off on these/i).length).toBeGreaterThan(0);
  });

  it("still names a real manager when the row reads (the control)", async () => {
    mockDb();
    render(await MeTimeOffPage(props()));
    expect(screen.getAllByText(/Mona Lisa signs off on these/i).length).toBeGreaterThan(0);
  });
});
