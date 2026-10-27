// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #652: the header is the single surface that both shows an active "view as"
// session AND surfaces a silently-dropped one. This pins the wiring: which
// impersonation state renders which banner. Data-fetching branches are skipped by
// passing no userId, so only the impersonation view drives the render.
const view = vi.hoisted(() => ({ v: { status: "none" } as unknown }));
vi.mock("@/lib/auth", () => ({ getImpersonationView: async () => view.v }));
vi.mock("@/app/admin/actions", () => ({
  stopImpersonation: vi.fn(),
  endDroppedImpersonation: vi.fn(async () => {}),
}));
// #1165: the pending-OOO badge read is a `{ count }` destructure. The fake lets a
// test make that read FAIL so the badge's behaviour on a broken read is pinned,
// rather than the failure quietly scoring as "no requests pending".
const db = vi.hoisted(() => ({
  oooCountError: null as { message: string } | null,
  oooCount: 0,
  /** Every read, in the order it was ISSUED and then in the order it SETTLED. */
  trace: [] as string[],
  /** Tables held open until a test releases them, so ordering is decided not raced. */
  hold: null as null | Set<string>,
  release: {} as Record<string, () => void>,
}));
const supabaseAdmin = vi.hoisted(() =>
  vi.fn(() => ({
    from: (table: string) => {
      const answer = () =>
        table === "ooo_requests"
          ? { count: db.oooCountError ? null : db.oooCount, error: db.oooCountError }
          : { data: [], error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        not: () => b,
        then: (resolve: (v: unknown) => unknown) => {
          db.trace.push(`${table}:issued`);
          const gate = db.hold?.has(table)
            ? new Promise<void>((res) => { db.release[table] = res; })
            : Promise.resolve();
          return gate.then(() => {
            db.trace.push(`${table}:settled`);
            return resolve(answer());
          });
        },
      };
      return b;
    },
  })),
);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin }));
vi.mock("@/lib/env", () => ({ consoleHiddenFor: () => false }));

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import { AppHeader } from "@/components/AppHeader";
import { themeBootScript } from "@/lib/theme/boot";

const props = {
  email: "admin@trypennie.com",
  role: "admin",
  active: "admin" as const,
  themePreference: "light" as const,
};

beforeEach(() => {
  // jsdom implements no matchMedia, and the header now mounts ThemeSync, which
  // subscribes to one (#2100).
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  view.v = { status: "none" };
  db.oooCountError = null;
  db.oooCount = 0;
  db.trace = [];
  db.hold = null;
  db.release = {};
  logSpy.warn.mockClear();
});

describe("AppHeader section links for a coordinator (#4205, D32)", () => {
  // Dan, design round 9: "this isn't what they'd see." A coordinator opens no staff page,
  // so their header is the Pennie logo and the account menu, with no section links.
  it("gives a coordinator no Me tabs and no section links", async () => {
    render(await AppHeader({ ...props, email: "sc@trypennie.com", role: "coordinator" }));
    expect(screen.queryByText("My Availability")).toBeNull();
    expect(screen.queryByText("My Time Off")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Slate sections" })).toBeNull();
    expect(screen.getByRole("button", { name: /account and settings/ })).toBeTruthy();
  });

  it("draws the coordinator page's header with no section links, whoever opens it", async () => {
    render(await AppHeader({ ...props, sections: false }));
    expect(screen.queryByRole("navigation", { name: "Slate sections" })).toBeNull();
  });

  it("still gives everybody else their tabs (the control)", async () => {
    render(await AppHeader(props));
    expect(screen.getByRole("navigation", { name: "Slate sections" })).toBeTruthy();
    expect(screen.getByText("My Availability")).toBeTruthy();
  });
});

describe("AppHeader impersonation banners (#652)", () => {
  // #1836 made this the ONLY place in the app that explains what "view as" does.
  // A standing warning above the roster used to say it too, in worse form: shown
  // to every admin who was not impersonating anyone, and unable to name the
  // person because there was nobody to name. Removing it is only safe while this
  // banner carries all three parts, so all three are asserted here rather than
  // just the name and the button.
  it("shows the active 'viewing as' banner, naming the target and explaining the risk", async () => {
    view.v = {
      status: "active",
      real: { id: "admin-1" },
      target: { id: "agent-9", name: "Agent Nine", email: "a9@x.com", role: "agent" },
    };
    render(await AppHeader(props));
    // 1. who you are acting as, by name, which the removed prose could never do
    expect(screen.getByText(/Agent Nine/)).toBeTruthy();
    // 2. what that means, which is the half the removed prose was standing in for.
    // #2037 rewrote the sentence: it is two elements now, so that a line can break
    // only at the period, and it says "recorded" because that is the part that
    // matters to somebody deciding whether to click.
    expect(screen.getByText(/anything you do here is recorded as them/i)).toBeTruthy();
    // 3. the way back
    expect(screen.getByRole("button", { name: /stop viewing as them/i })).toBeTruthy();
    expect(screen.queryByText(/timed out|no longer available/i)).toBeNull();
  });

  it("shows the timed-out drop notice, not the active banner, when dropped/expired", async () => {
    view.v = { status: "dropped", reason: "expired" };
    render(await AppHeader(props));
    expect(screen.getByText(/timed out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop viewing as them/i })).toBeNull();
    // #2037 (IM9): this notice says the dangerous state is OVER, so it stays an
    // ordinary bar and must not wear the marker's treatment. What makes that safe
    // is that the ACTIVE state is no longer a bar at all, so the two cannot be
    // confused the way two navy bars could.
    expect(document.querySelector("[data-impersonation-frame]")).toBeNull();
    expect(document.querySelector("[data-impersonation-strip]")).toBeNull();
    // And nothing claims the mode, so the page is not inset for a notice.
    expect(document.documentElement.dataset.impersonating).toBeUndefined();
  });

  it("shows the unavailable drop notice when dropped/unavailable", async () => {
    view.v = { status: "dropped", reason: "unavailable" };
    render(await AppHeader(props));
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
  });

  it("shows no impersonation banner for a plain session", async () => {
    render(await AppHeader(props));
    expect(screen.queryByRole("button", { name: /stop viewing as them/i })).toBeNull();
    expect(screen.queryByText(/timed out|no longer available/i)).toBeNull();
  });
});

// Dan, 2026-10-02: the Overview at /admin is an admin's page, and a manager or
// team lead is redirected from it to the roster. Their Admin tab points at the
// roster directly so nobody bounces through a redirect on every click.
describe("the Admin tab's destination", () => {
  const adminTab = () => screen.getByRole("link", { name: "Admin" });

  it.each(["manager", "team_lead"])("takes a %s straight to the roster", async (role) => {
    render(await AppHeader({ ...props, role }));
    expect(adminTab().getAttribute("href")).toBe("/admin/agents");
  });

  it.each(["admin", "super_admin"])("takes a %s to the Overview", async (role) => {
    render(await AppHeader({ ...props, role }));
    expect(adminTab().getAttribute("href")).toBe("/admin");
  });

  it("shows an agent no Admin tab at all", async () => {
    render(await AppHeader({ ...props, role: "agent" }));
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});

// #1165's badge cases live in PendingApprovalsBadge.test.tsx since #1847, with
// the code that does the read. What they pin is unchanged: a count that FAILED
// used to score as zero pending requests, so the badge vanished exactly as it
// does when the queue is genuinely empty and nothing recorded that the count had
// not been read. Moving the assertions with the read is the point; leaving them
// here would have them asking a component that no longer does it, and passing.



// #1847: the header's two INDEPENDENT reads are issued together.
//
// It ran three reads in a strict chain, which on a full page load is a serial
// prefix in front of the page. The calendar read and the staff-id read do not
// depend on each other; the pending count does depend on the staff ids, because
// it filters the queue on them, and that ordering is asserted too or "parallel"
// would be satisfied by firing a query before its own input exists.
//
// NOT ON THE NAVIGATION PATH, and the issue is corrected to say so: Next reuses
// the admin layout between console pages, so this header does not re-render when
// somebody clicks from one page to another. The saving is on a first visit or a
// refresh. That was measured before this was built rather than assumed.
//
// No sleeps: the reads are held open by promises the test releases by hand, so
// the ordering is decided rather than raced (L290).
describe("the header does not wait on the badge (#1847)", () => {
  const withIds = { ...props, userId: "mgr-1", orgId: "org-1" };

  // THE QUANTITY THIS PROTECTS is the await graph, not a duration: a duration
  // measures whatever else the machine is running (L224).
  //
  // Measured in production on 2026-09-03, an admin page came back in 100 to
  // 563ms of wall time on 8 to 37ms of Worker CPU. On /admin/agents the roster
  // read the person asked for finished at +391ms while the badge count had not
  // started until +390ms: the content was ready and waiting on a nudge.
  it("resolves without having issued the badge's reads at all", async () => {
    render(await AppHeader(withIds));

    expect(screen.getByText("Team Time Off")).toBeTruthy();
    expect(db.trace).toContain("agent_calendars:issued");

    expect(db.trace).not.toContain("users:issued");
    expect(db.trace).not.toContain("ooo_requests:issued");
  });

  // The control, because the assertion above is a NEGATIVE and would pass just
  // as well against a fake that never records anything (L159).
  it("and the fake really does record a read the header still makes", async () => {
    render(await AppHeader(withIds));
    expect(db.trace.filter((e) => e.endsWith(":issued")).length).toBeGreaterThan(0);
  });

  it("still holds the calendar read, whose banner must not arrive late", async () => {
    render(await AppHeader(withIds));
    expect(db.trace).toContain("agent_calendars:settled");
  });
});

describe("AppHeader theme (#2100)", () => {
  // The measured cause of #2100: the theme control read the IMPERSONATED
  // person's preference and wrote the ADMIN's account row, so under "view as"
  // the two halves could never agree and a choice looked discarded. The header
  // is where that is settled now, because it is the one surface that knows both
  // identities and is mounted for the whole visit.
  const asAdminViewingAgent = {
    status: "active",
    real: { id: "admin-1", theme_preference: "dark" },
    target: {
      id: "agent-9",
      name: "Agent Nine",
      email: "a9@x.com",
      role: "agent",
      theme_preference: "system",
    },
  };

  it("paints the signed in person's own theme, not the one they are viewing as", async () => {
    view.v = asAdminViewingAgent;
    // The page renders FOR the agent, so this prop is the agent's preference.
    const { container } = render(await AppHeader({ ...props, themePreference: "system" }));

    const script = [...container.querySelectorAll("script")]
      .map((s) => s.innerHTML)
      .find((t) => t.includes("data-theme"));
    expect(script).toBe(
      themeBootScript({ kind: "preference", preference: "dark", remember: true }),
    );
  });

  it("paints your own theme when you are signed in as yourself", async () => {
    view.v = { status: "none" };
    const { container } = render(await AppHeader({ ...props, themePreference: "system" }));

    const script = [...container.querySelectorAll("script")]
      .map((s) => s.innerHTML)
      .find((t) => t.includes("data-theme"));
    expect(script).toBe(
      themeBootScript({ kind: "preference", preference: "system", remember: true }),
    );
  });

  it("applies the theme outside the account menu, so opening it is not what themes the page", async () => {
    view.v = { status: "none" };
    const { container } = render(await AppHeader(props));

    // The panel renders nothing until it is opened, so anything inside it cannot
    // be what paints the page. The script is in the header's own markup.
    const script = [...container.querySelectorAll("script")].find((s) =>
      s.innerHTML.includes("data-theme"),
    );
    expect(script).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: /theme/i })).toBeNull();
  });
});
