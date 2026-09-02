// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1749: "View as another user" used to be the first card on /admin, asking for a
// free text email. In practice you almost always want a SPECIFIC person you are
// already looking at, so you copied an address out of the roster two screens down
// and pasted it back into the box at the top.
//
// The action lives on the person now. The part that needs a test is not the
// convenience but the GATE: impersonation carries a role ceiling (#588), and
// canImpersonate refuses a target who outranks or equals you. On a free text field
// that refusal arrives after you type and press, which is acceptable. A per row
// control is different: rendering it on every row puts a visible control on rows
// where pressing it can only ever produce that error (L109).

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
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
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/app/admin/actions", () => ({
  startImpersonation: vi.fn(),
  syncSalesforceNow: vi.fn(),
}));

import AgentRosterPage from "./page";

const ROSTER = [
  { id: "u1", email: "agent@x.com", name: "Ada Agent", role: "agent", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u2", email: "mgr@x.com", name: "Mo Manager", role: "manager", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u3", email: "adm@x.com", name: "Alex Admin", role: "admin", bookable: false, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u4", email: "sup@x.com", name: "Su Super", role: "super_admin", bookable: false, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
];

function mockDb() {
  admin.supabaseAdmin.mockReturnValue({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit", "range"]) b[m] = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: ROSTER, error: null }).then(resolve);
      return b;
    },
  });
}

const props = { searchParams: Promise.resolve({}) };
const asRole = (role: string, id = "me1") =>
  auth.currentUser.mockResolvedValue({
    id,
    role,
    org_id: "o1",
    email: "me@x.com",
    name: "Me",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  });

/** The per-row control for one person, by the name in their row. */
const viewAsFor = (name: string) =>
  screen.queryByRole("button", { name: new RegExp(`View as ${name}`, "i") });

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  mockDb();
});

describe("view as, from the row (#1749)", () => {
  it("offers the action on everyone an admin outranks", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    expect(viewAsFor("Ada Agent")).toBeTruthy();
    expect(viewAsFor("Mo Manager")).toBeTruthy();
  });

  it("does not render it on a peer, whose row could only ever refuse", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    // canImpersonate requires ranking STRICTLY below, so an admin viewing another
    // admin is refused. A control that can only produce that error is worse than
    // no control, because it reads as available until it is pressed.
    expect(viewAsFor("Alex Admin")).toBeNull();
  });

  it("does not render it on someone who outranks you", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    expect(viewAsFor("Su Super")).toBeNull();
  });

  it("gives a super admin the action on the admin below them", async () => {
    // The positive control for the two refusals above: without it, a page that
    // rendered NO view-as controls at all would satisfy both of them (L159).
    asRole("super_admin", "superme");
    render(await AgentRosterPage(props));

    expect(viewAsFor("Alex Admin")).toBeTruthy();
    expect(viewAsFor("Ada Agent")).toBeTruthy();
  });

  it("offers a super admin nothing on their own row", async () => {
    asRole("super_admin", "u4");
    render(await AgentRosterPage(props));

    // Viewing as yourself is refused by the action, so the row must not offer it.
    expect(viewAsFor("Su Super")).toBeNull();
  });

  it("shows a manager no view-as controls at all", async () => {
    // Impersonation is admin and up. A manager manages the roster and sees the
    // same table, so every row would carry a control they can never use.
    asRole("manager", "mgrme");
    render(await AgentRosterPage(props));

    expect(screen.queryAllByRole("button", { name: /View as/i })).toHaveLength(0);
  });

  it("names the person in the control, so the row it acts on is unambiguous", async () => {
    asRole("super_admin", "superme");
    render(await AgentRosterPage(props));

    // A table of identical "View as" buttons is a control addressed by POSITION
    // (L237). The accessible name has to carry who it is for.
    const names = screen
      .getAllByRole("button", { name: /View as/i })
      .map((b) => b.textContent ?? "");
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries the person's email, which is what the action resolves", async () => {
    asRole("super_admin", "superme");
    const { container } = render(await AgentRosterPage(props));

    // The action looks the target up by email, so the row's form must submit the
    // row's own address rather than whatever is typed in the fallback field.
    const emails = [...container.querySelectorAll('input[name="email"][type="hidden"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(emails).toContain("agent@x.com");
    expect(emails).toContain("adm@x.com");
    expect(emails).not.toContain("sup@x.com");
  });
});
