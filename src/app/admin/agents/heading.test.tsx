// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1810, Dan on "Agents (102 bookable / 136)": "I don't know what I want here but
// the (102 bookable / 136) doesn't really make sense. like I get what it means but
// it's not immediately obvious".
//
// Two problems. It read as a ratio with a word on only one of its numbers, so you
// attached "bookable" to the first and then worked out what the second was. And
// the two halves counted different populations: the numerator excluded offboarded
// people, the denominator counted them, so it advertised a total the table below
// could never reach (L16).
//
// The decision was to delete it rather than reword it, because the page answers
// both questions better elsewhere. These pin that the deletion did not take the
// unreadable signal with it, which is the one thing on this page that must not
// become silent (#1629).

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
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
  usePathname: () => "/admin/agents",
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
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

const ROSTER = [
  { id: "u1", email: "a@x.com", name: "Ada Agent", role: "agent", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u2", email: "g@x.com", name: "Gone Person", role: "agent", bookable: false, attributes: {}, deactivated_at: "2026-08-24T00:00:00Z", manager_id: null, avatar_url: null },
];

function mockDb(result: { data: unknown; error: unknown }) {
  admin.supabaseAdmin.mockReturnValue({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "not", "order", "limit", "range"]) b[m] = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return b;
    },
  });
}

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  auth.currentUser.mockResolvedValue({
    id: "me1",
    role: "super_admin",
    org_id: "o1",
    email: "me@x.com",
    name: "Me",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  });
});

describe("the agent roster heading (#1810)", () => {
  it("is the word Agents and nothing else", async () => {
    mockDb({ data: ROSTER, error: null });
    render(await AgentRosterPage(props));
    const heading = screen.getByRole("heading", { name: "Agents" });
    expect(heading.textContent).toBe("Agents");
  });

  it("carries no count beside it, in any wording", async () => {
    mockDb({ data: ROSTER, error: null });
    render(await AgentRosterPage(props));
    const heading = screen.getByRole("heading", { name: "Agents" });
    expect(heading.textContent).not.toMatch(/\d/);
    expect(heading.textContent).not.toMatch(/bookable|unavailable/i);
  });

  it("still says so when the roster could not be read", async () => {
    // The signal that must survive the deletion. An unreadable roster and an
    // empty one draw the same table, and this is the page somebody opens when
    // access is not working (#1629).
    mockDb({ data: null, error: { message: "permission denied" } });
    render(await AgentRosterPage(props));
    expect(screen.getByText(/roster could not be read/i)).toBeTruthy();
    // And it is not merely a heading tweak: the notice is its own element, so the
    // heading staying plain does not make the failure quiet.
    expect(screen.getByRole("heading", { name: "Agents" }).textContent).toBe("Agents");
  });

  it("does not say the roster could not be read when it could", async () => {
    // The positive control (L1): a notice that always rendered would satisfy the
    // case above.
    mockDb({ data: ROSTER, error: null });
    render(await AgentRosterPage(props));
    expect(screen.queryByText(/roster could not be read/i)).toBeNull();
  });
});
