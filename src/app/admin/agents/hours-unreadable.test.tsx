// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1802: the roster reads working hours in its own boundary. A failed read must
// cost the Hours column and nothing else, and must SAY so: a column of "None"
// would tell an operator nobody has hours, which is a claim the page never
// measured (L10, #1165). The sign in column rests on the roster read alone, so
// it stays.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/admin/agents",
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/admin/actions", () => ({
  startImpersonation: vi.fn(),
  syncSalesforceNow: vi.fn(),
  refreshAdvisorPhotosNow: vi.fn(),
}));
// #3027: the roster reads advisor photos through its own store; every row holds a
// directory photo here, so these suites judge only what they are about.
vi.mock("@/lib/advisor-photos/store", () => ({
  loadPhotoRecords: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { state: "photo" as const, sha256: "a".repeat(64) }])),
}));

import AgentRosterPage from "./page";

const base = {
  role: "agent",
  bookable: true,
  attributes: {},
  deactivated_at: null,
  manager_id: null,
  avatar_url: null,
  is_test: false,
  created_at: "2026-09-01T00:00:00Z",
};
const ROSTER = [
  { ...base, id: "u1", email: "ada@x.com", name: "Ada Seeded", auth_user_id: null },
  { ...base, id: "u2", email: "bob@x.com", name: "Bob Chosen", auth_user_id: "auth-2" },
];
const ORG = { default_timezone: "America/New_York", default_start_minute: 480, default_end_minute: 1020, default_weekdays: [1, 2, 3, 4, 5] };
const SCHEDULES = [
  { id: "s1", user_id: "u1", timezone: "America/New_York", hours_source: "seed", hours_set_at: null, created_at: "2026-09-01T00:00:00Z" },
  { id: "s2", user_id: "u2", timezone: "America/Phoenix", hours_source: "agent", hours_set_at: null, created_at: "2026-09-01T00:00:00Z" },
];
const RULES = [
  { id: "r1", schedule_id: "s1", weekday: 1, start_minute: 480, end_minute: 1020 },
  { id: "r2", schedule_id: "s2", weekday: 2, start_minute: 540, end_minute: 1020 },
];

function mockDb(schedulesFail: boolean) {
  const answers: Record<string, () => unknown> = {
    users: () => ({ data: ROSTER, error: null }),
    organizations: () => ({ data: ORG, error: null }),
    availability_schedules: () =>
      schedulesFail ? { data: null, error: { message: "permission denied" } } : { data: SCHEDULES, error: null },
    availability_rules: () => ({ data: RULES, error: null }),
  };
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "range"]) b[m] = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) => Promise.resolve(answers[table]!()).then(resolve);
      return b;
    },
  });
}

const page = async (schedulesFail: boolean, searchParams: Record<string, string> = {}) => {
  mockDb(schedulesFail);
  render(await AgentRosterPage({ searchParams: Promise.resolve(searchParams) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  auth.currentUser.mockResolvedValue({ id: "me1", role: "super_admin", org_id: "o1", email: "me@x.com" });
});

describe("the roster when working hours cannot be read (#1802)", () => {
  it("shows each agent's hours state when the read works", async () => {
    await page(false);
    expect(screen.getByRole("columnheader", { name: /^Hours/ })).toBeTruthy();
    expect(screen.getByText("Seeded default")).toBeTruthy();
    expect(screen.queryByText(/Working hours could not be read/)).toBeNull();
  });

  it("says so once, drops the Hours column, and keeps the roster and its sign in column", async () => {
    await page(true);
    expect(screen.getByText(/Working hours could not be read/)).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /^Hours/ })).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Signed in" })).toBeTruthy();
    expect(screen.getByText("Ada Seeded")).toBeTruthy();
    expect(screen.getByText("Bob Chosen")).toBeTruthy();
  });

  it("ignores an hours filter in the URL it can no longer honour", async () => {
    // With no picker on the page, a linked ?hours= would otherwise empty the
    // table for a reason no control shows.
    await page(true, { hours: "seeded" });
    expect(screen.getByText("Ada Seeded")).toBeTruthy();
    expect(screen.getByText("Bob Chosen")).toBeTruthy();
  });
});
