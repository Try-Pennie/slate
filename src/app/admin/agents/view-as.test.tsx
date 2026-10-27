// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
//
// #1794 moved that control inside a per row actions menu, so every assertion here
// has to OPEN the menu first. That is not a mechanical adjustment: with the menu
// closed the three refusal cases below pass without rendering anything at all,
// which is the exact vacuous pass the positive control in this file was written to
// catch, and it caught it.

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
  { id: "u1", email: "agent@x.com", name: "Ada Agent", role: "agent", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u2", email: "mgr@x.com", name: "Mo Manager", role: "manager", bookable: true, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u3", email: "adm@x.com", name: "Alex Admin", role: "admin", bookable: false, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
  { id: "u4", email: "sup@x.com", name: "Su Super", role: "super_admin", bookable: false, attributes: {}, deactivated_at: null, manager_id: null, avatar_url: null },
];

function mockDb() {
  admin.supabaseAdmin.mockReturnValue({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "not", "order", "limit", "range"]) b[m] = () => b;
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

/** That person's row menu trigger, or null when the row is not on screen. */
const menuFor = (name: string) =>
  screen.queryByRole("button", { name: new RegExp(`Actions for ${name}`, "i") });

/**
 * Open one person's row menu and hand back the "View as" item inside it, or null.
 *
 * Opening a second menu closes the first (the trigger's mousedown lands outside
 * the open one), so these are asked one at a time rather than all at once.
 */
async function viewAsFor(name: string) {
  const trigger = menuFor(name);
  if (!trigger) return null;
  await userEvent.click(trigger);
  return screen.queryByRole("menuitem", { name: new RegExp(`View as ${name}`, "i") });
}

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  mockDb();
});

describe("view as, from the row (#1749)", () => {
  it("offers the action on everyone an admin outranks", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    expect(await viewAsFor("Ada Agent")).toBeTruthy();
    expect(await viewAsFor("Mo Manager")).toBeTruthy();
  });

  it("does not render it on a peer, whose row could only ever refuse", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    // canImpersonate requires ranking STRICTLY below, so an admin viewing another
    // admin is refused. A control that can only produce that error is worse than
    // no control, because it reads as available until it is pressed.
    expect(await viewAsFor("Alex Admin")).toBeNull();
  });

  it("does not render it on someone who outranks you", async () => {
    asRole("admin", "adminme");
    render(await AgentRosterPage(props));

    expect(await viewAsFor("Su Super")).toBeNull();
  });

  it("gives a super admin the action on the admin below them", async () => {
    // The positive control for the two refusals above: without it, a page that
    // rendered NO view-as controls at all would satisfy both of them (L159).
    asRole("super_admin", "superme");
    render(await AgentRosterPage(props));

    expect(await viewAsFor("Alex Admin")).toBeTruthy();
    expect(await viewAsFor("Ada Agent")).toBeTruthy();
  });

  it("offers a super admin nothing on their own row", async () => {
    asRole("super_admin", "u4");
    render(await AgentRosterPage(props));

    // Viewing as yourself is refused by the action, so the row must not offer it.
    expect(await viewAsFor("Su Super")).toBeNull();
  });

  it("shows a manager no view-as controls at all", async () => {
    // Impersonation is admin and up. A manager manages the roster and sees the
    // same table, so every row would carry a control they can never use.
    asRole("manager", "mgrme");
    render(await AgentRosterPage(props));

    // The menu is still there, because every row keeps the same shape (#1794);
    // what a manager must never find inside it is an impersonation control. Asked
    // with a menu OPEN, or this passes on a page that drew nothing.
    const trigger = menuFor("Ada Agent");
    expect(trigger).toBeTruthy();
    await userEvent.click(trigger!);
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("menuitem", { name: /View as/i })).toHaveLength(0);
  });

  it("names the person in the control, so the row it acts on is unambiguous", async () => {
    asRole("super_admin", "superme");
    render(await AgentRosterPage(props));

    // A table of identical controls is one addressed by POSITION (L237), and a
    // three dot menu makes every TRIGGER identical on purpose, so the identity has
    // to live in two places now: the trigger's accessible name, and the item.
    const triggers = screen
      .getAllByRole("button", { name: /^Actions for /i })
      .map((b) => b.getAttribute("aria-label") ?? "");
    expect(triggers.length).toBeGreaterThan(1);
    expect(new Set(triggers).size).toBe(triggers.length);

    const names: string[] = [];
    for (const who of ["Ada Agent", "Alex Admin"]) {
      const item = await viewAsFor(who);
      expect(item).toBeTruthy();
      names.push(item!.textContent ?? "");
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries the person's email, which is what the action resolves", async () => {
    asRole("super_admin", "superme");
    render(await AgentRosterPage(props));

    // The action looks the target up by email, so the row's form must submit the
    // row's OWN address. Only the open menu's form is in the document, so each row
    // is opened and read in turn.
    // #1843: the menu is portalled to the body so no scroll container can clip
    // it, so it is NOT inside the render container. The assertion is unchanged;
    // only where the element lives has moved.
    const emailIn = async (who: string) => {
      const t = menuFor(who);
      if (!t) return [];
      await userEvent.click(t);
      return [...document.body.querySelectorAll('input[name="email"][type="hidden"]')].map(
        (i) => (i as HTMLInputElement).value,
      );
    };
    expect(await emailIn("Ada Agent")).toEqual(["agent@x.com"]);
    expect(await emailIn("Alex Admin")).toEqual(["adm@x.com"]);
    // A super admin cannot view as themselves, so their row carries no form at all.
    asRole("super_admin", "u4");
    expect(await emailIn("Su Super")).toEqual([]);
  });
});
