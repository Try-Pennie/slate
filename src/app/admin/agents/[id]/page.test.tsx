// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Access guard for the agent-profile page (#676): unauthenticated to /login, a
// below-manager caller gets the deny notice, the OOO-only flag diverts managers
// to /admin/ooo, and an unknown agent id resolves to notFound(). Plus the #550
// control-visibility rule: the manager+ mutate controls only render when the
// viewer may actually manage this target (canManageUser strict-outrank), so a
// manager never sees buttons that 403 on a peer/higher-ranked profile. Real role
// helpers are exercised; auth, navigation, the launch flag and the DB are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
// Table-aware fake: users.maybeSingle -> the target agent; the awaited users
// builder -> the roster list; availability_schedules -> sched; organizations ->
// org; availability_rules -> rules. A thenable `then` covers the awaited-builder
// reads; maybeSingle/single cover the terminal reads.
const dbState = vi.hoisted(() => ({
  agent: null as unknown,
  sched: null as unknown,
  org: {
    default_timezone: "America/New_York",
    default_start_minute: 540,
    default_end_minute: 1020,
    default_weekdays: [1, 2, 3, 4, 5],
  } as unknown,
  usersList: [] as unknown[],
  rules: [] as unknown[],
  /**
   * #1649: one error seam per READ, not one for the page. The four reads here
   * fail differently and each draws a different wrong screen, so a fixture that
   * fails everything at once could not tell them apart: the assertion would pass
   * on a page that only guarded one of them.
   *
   * `users` is read twice (the target agent by maybeSingle, the roster by the
   * awaited builder), which is exactly why the key is the read and not the table.
   */
  agentError: null as { message: string } | null,
  schedError: null as { message: string } | null,
  rosterError: null as { message: string } | null,
  orgError: null as { message: string } | null,
  rulesError: null as { message: string } | null,
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        const err = table === "users" ? dbState.agentError : dbState.schedError;
        if (err) return { data: null, error: err };
        return {
          data:
            table === "users"
              ? dbState.agent
              : table === "availability_schedules"
                ? dbState.sched
                : null,
          error: null,
        };
      },
      single: async () =>
        dbState.orgError
          ? { data: null, error: dbState.orgError }
          : { data: dbState.org, error: null },
      then: (res: (v: { data: unknown; error?: unknown }) => void) => {
        const err = table === "users" ? dbState.rosterError : dbState.rulesError;
        if (err) return res({ data: null, error: err });
        return res({
          data:
            table === "users"
              ? dbState.usersList
              : table === "availability_rules"
                ? dbState.rules
                : [],
          error: null,
        });
      },
    };
    return q;
  }),
);

// #1215: the deactivate confirm's number must come from the SAME helper the
// coverage sweep enqueues from, so the warning and the panel can never disagree
// about the same gap.
const previewBulkReassign = vi.hoisted(() =>
  vi.fn(async (_userId: string, _rangeStartIso: string, _rangeEndIso: string | null) => 0),
);

vi.mock("@/lib/booking/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/service")>()),
  previewBulkReassign,
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import AgentProfilePage from "./page";

const props = { params: Promise.resolve({ id: "x1" }) };

// A renderable target agent of a given role.
function agentOf(role: string, id = "x1"): Record<string, unknown> {
  return {
    id,
    org_id: "o1",
    email: `${id}@ex.com`,
    name: id,
    role,
    bookable: false,
    manager_id: null,
    ooo_calendar_id: null,
    attributes: {},
    avatar_url: null,
    deactivated_at: null,
  };
}

// The manager+ mutate controls that must track canManageUser (#550).
//
// "Set manager" is deliberately absent (#1474): Salesforce owns that link and the
// hourly sync converges on it, so an editable control here would be undone within
// the hour. The manager of record is displayed instead, asserted below.
const MANAGE_BUTTONS = [
  /make bookable/i,
  /save hours/i,
  /save attributes/i,
  /deactivate account/i,
];

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  dbState.agent = null;
  dbState.sched = null;
  dbState.usersList = [];
  dbState.rules = [];
  dbState.agentError = null;
  dbState.schedError = null;
  dbState.rosterError = null;
  dbState.orgError = null;
  dbState.rulesError = null;
  previewBulkReassign.mockResolvedValue(0);
});

// #1649: #1629 turned four reads on this page into `unwrap` and touched no test.
// Each draws a DIFFERENT wrong screen when swallowed, and three of the four feed
// a FORM whose save replaces exactly what the form is showing, so a blank drawn
// from a failed read is not merely wrong to look at: the next click writes it
// back as fact.
describe("the reads behind this page refuse rather than draw a blank (#1649)", () => {
  const asManager = () =>
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });

  it("does not report a 404 when the agent row could not be READ", async () => {
    asManager();
    dbState.agentError = { message: "permission denied for table users" };
    await expect(AgentProfilePage(props)).rejects.toThrow(/agent detail row/);
    // Specifically not notFound(): telling an admin the agent does not exist
    // sends them to create an account that is already there.
    expect(notFound).not.toHaveBeenCalled();
  });

  it("still reports a real 404 when the read works and finds nothing", async () => {
    asManager();
    dbState.agent = null;
    await expect(AgentProfilePage(props)).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(notFound).toHaveBeenCalled();
  });

  it("refuses when the agent's schedule could not be read, rather than rendering an empty week", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.schedError = { message: "deadlock detected" };
    await expect(AgentProfilePage(props)).rejects.toThrow(/agent schedule/);
  });

  it("refuses when the schedule's rules could not be read", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.sched = { id: "s1", timezone: "America/New_York" };
    dbState.rulesError = { message: "statement timeout" };
    await expect(AgentProfilePage(props)).rejects.toThrow(/agent schedule rules/);
  });

  it("refuses when the roster could not be read, rather than showing the manager as unassigned", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.rosterError = { message: "permission denied for table users" };
    await expect(AgentProfilePage(props)).rejects.toThrow(/agent detail roster/);
  });

  it("refuses when the org could not be read", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.orgError = { message: "permission denied for table organizations" };
    await expect(AgentProfilePage(props)).rejects.toThrow(/agent detail org/);
  });

  // The control, in the same fixture: with every read healthy the page renders,
  // so the six refusals above cannot be passing because this page stopped
  // rendering at all.
  it("renders the profile when every read works", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.sched = { id: "s1", timezone: "America/New_York" };
    dbState.rules = [{ weekday: 1, start_minute: 540, end_minute: 1020 }];
    dbState.usersList = [{ id: "x1", name: "Aria", email: "aria@trypennie.com", role: "agent", deactivated_at: null }];
    render(await AgentProfilePage(props));
    expect(screen.getByRole("button", { name: /deactivate account/i })).toBeTruthy();
  });
});

// #1215. The count in the confirm and the work the coverage sweep would enqueue
// are the same question, so they must come from the same code. Asking it twice is
// how the warning ends up saying "3 appointments" while the panel moves 5.
describe("AgentProfilePage deactivate confirm (#1215)", () => {
  const renderFor = async (count: number | Error) => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("agent");
    if (count instanceof Error) previewBulkReassign.mockRejectedValueOnce(count);
    else previewBulkReassign.mockResolvedValueOnce(count);
    render(await AgentProfilePage(props));
  };

  it("asks the coverage helper how many appointments this agent still holds", async () => {
    await renderFor(3);
    expect(previewBulkReassign).toHaveBeenCalledTimes(1);
    expect(previewBulkReassign.mock.calls[0][0]).toBe("x1");
  });

  it("warns with that count before deactivating", async () => {
    await renderFor(3);
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/3 upcoming appointments/i);
  });

  // A read that failed is not a clean bill of health (L11). It must not become a
  // one-click deactivate that implies nothing was booked.
  it("still confirms when the count could not be read", async () => {
    await renderFor(new Error("relation \"bookings\" does not exist"));
    await userEvent.click(screen.getByRole("button", { name: /deactivate account/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/could not|couldn't/i);
  });

  // Asserted on the rendered shape rather than by clicking: this form's action is
  // the REAL server action, so a click here would fire setUserLifecycle. That the
  // submit path works is pinned in DeactivateAgentButton.test.tsx, which supplies
  // its own form. A submit-type button with no confirm in the way IS the one-click
  // deactivate; a confirm would render a type="button" instead.
  // The bookable toggle is the other way out of the pool, so it asks the same
  // question. Rendered for a BOOKABLE agent, where the toggle reads "Make not
  // bookable"; the opposite direction strands nothing and stays one click.
  it("warns on the bookable toggle too, in that control's words", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), bookable: true };
    previewBulkReassign.mockResolvedValueOnce(2);
    render(await AgentProfilePage(props));
    await userEvent.click(screen.getByRole("button", { name: /make not bookable/i }));
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/2 upcoming appointments/i);
    expect(screen.getByRole("button", { name: /make not bookable anyway/i })).toBeTruthy();
  });

  // Both controls read the count once between them, so the page cannot show two
  // different answers to the same question.
  it("reads the count once for both pool-exit controls", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), bookable: true };
    previewBulkReassign.mockResolvedValueOnce(2);
    render(await AgentProfilePage(props));
    expect(previewBulkReassign).toHaveBeenCalledTimes(1);
  });

  it("deactivates in one click when the agent holds nothing", async () => {
    await renderFor(0);
    const button = screen.getByRole("button", { name: /deactivate account/i });
    expect(button.getAttribute("type")).not.toBe("button");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AgentProfilePage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(AgentProfilePage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await AgentProfilePage(props));
    expect(screen.getByText(/manager or admin account to manage agents/i)).toBeTruthy();
  });

  it("diverts a manager to /admin/ooo while the OOO-only flag is on", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    env.oooOnlyFor.mockReturnValueOnce(true);
    await expect(AgentProfilePage(props)).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo/);
  });

  it("returns notFound for an unknown agent id", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = null;
    await expect(AgentProfilePage(props)).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe("AgentProfilePage control visibility (#550)", () => {
  it("shows the manager+ mutate controls when the viewer outranks the target", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(await AgentProfilePage(props));
    for (const label of MANAGE_BUTTONS) {
      expect(screen.queryByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByText(/cannot change their settings/i)).toBeNull();
  });

  // #1474: the manager of record is READ ONLY, and the page has to say where it
  // comes from. Without the second half a reader sees a value with no way to change
  // it and no reason, which is a dead end rather than a deliberate one.
  it("shows the manager of record without offering to change it, and names Salesforce", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(await AgentProfilePage(props));

    expect(screen.queryByRole("button", { name: /set manager/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /manager/i })).toBeNull();
    expect(screen.queryByText(/manager \(time off approvals\)/i)).toBeTruthy();
    expect(screen.queryByText(/set in salesforce/i)).toBeTruthy();
  });

  it("hides the mutate controls (and explains why) when a manager views an admin", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("admin");
    render(await AgentProfilePage(props));
    for (const label of MANAGE_BUTTONS) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    expect(screen.queryByText(/cannot change their settings/i)).toBeTruthy();
    // Read-only account status stays visible (it never 403s).
    expect(screen.queryByText(/^Active$|^Deactivated$/)).toBeTruthy();
  });

  it("hides the mutate controls when a manager views a peer manager (equal rank never manages)", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("manager", "m2");
    render(await AgentProfilePage(props));
    expect(screen.queryByRole("button", { name: /save hours/i })).toBeNull();
    expect(screen.queryByText(/cannot change their settings/i)).toBeTruthy();
  });
});
