// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Access guard for the agent-profile page (#676): unauthenticated to /login, a
// below-manager caller gets the deny notice, the OOO-only flag diverts managers
// to /admin/ooo, and an unknown agent id resolves to notFound(). Plus the #550
// control-visibility rule: the manager+ mutate controls only render when the
// viewer may actually manage this target (canManageUser strict-outrank), so a
// manager never sees buttons that 403 on a peer/higher-ranked profile. Real role
// helpers are exercised; auth, navigation, the launch flag and the DB are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
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
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// #2073: the agent's own booking link, by its readable name since #3026. Null (no
// link) unless a test says otherwise.
const agentLinkStore = vi.hoisted(() => ({
  loadAgentLinkName: vi.fn(async (_userId: string): Promise<string | null> => null),
}));
vi.mock("@/lib/agent-link/store", () => agentLinkStore);
// #3595: the calls the last coverage sweep could not place. None unless a test says
// otherwise; the loader's own rules are tested beside it.
const strandedStore = vi.hoisted(() => ({
  loadAgentStrandedCalls: vi.fn(
    async (
      _agentId: string,
      _nowMs: number,
    ): Promise<{
      calls: { bookingId: string; status: "unplaceable" | "failed"; detail: string | null; startsAt: string | null; attendeeName: string | null }[];
      moves: string[];
    }> => ({ calls: [], moves: [] }),
  ),
}));
vi.mock("@/lib/booking/agent-stranded-calls", () => strandedStore);

import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";
import { SAVE_OUTCOME_COPY } from "@/lib/admin/save-outcomes";
import { GOOGLE_RELINK_COPY } from "@/lib/auth/google-identity-copy";
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
  // #1874 made the Salesforce owned attributes read only, and #2120 made the
  // last one read only too: the routing attributes panel writes nothing now, so
  // it contributes no button to this list.
  /deactivate account/i,
];

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
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
  strandedStore.loadAgentStrandedCalls.mockResolvedValue({ calls: [], moves: [] });
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

  // #3030: the header pill reads Redistribute for an advisor the Twilio sync
  // holds back, from the same `heldByTwilio` the refused toggle below uses, so the
  // pill and the control cannot disagree about who is held.
  it("names an advisor Twilio holds back as Redistribute, and nobody else", async () => {
    const renderWith = async (agent: Record<string, unknown>) => {
      asManager();
      dbState.agent = agent;
      dbState.sched = { id: "s1", timezone: "America/New_York" };
      dbState.rules = [{ weekday: 1, start_minute: 540, end_minute: 1020 }];
      const r = render(await AgentProfilePage(props));
      const value = r.container.querySelector("[data-bookable-mark]")!.closest("span.rounded-pill")!.textContent;
      r.unmount();
      return value;
    };
    const tagged = { redistribute_tagged: "Y" };
    expect(await renderWith({ ...agentOf("agent"), attributes: tagged })).toBe("Redistribute");
    expect(await renderWith({ ...agentOf("agent"), bookable: true, attributes: tagged })).toBe("Bookable");
    expect(await renderWith({ ...agentOf("agent"), attributes: { redistribute: "Y" } })).toBe("Not bookable");
  });

  // The link says All agents, so it opens the roster. It used to open /admin,
  // which is the admin Overview, and a manager is redirected from there
  // (2026-10-02), so the link only reached the roster by bouncing.
  it("sends All agents back to the roster", async () => {
    asManager();
    dbState.agent = agentOf("agent");
    dbState.sched = { id: "s1", timezone: "America/New_York" };
    dbState.rules = [{ weekday: 1, start_minute: 540, end_minute: 1020 }];
    dbState.usersList = [{ id: "x1", name: "Aria", email: "aria@trypennie.com", role: "agent", deactivated_at: null }];
    render(await AgentProfilePage(props));
    expect(screen.getByRole("link", { name: /all agents/i }).getAttribute("href")).toBe("/admin/agents");
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

// #2123: each control is explained where it IS. The reactivating sentence used to
// sit inside the explanation of deactivating, which is a fact a reader has to hold
// until it becomes relevant. It is not deleted with the trim, because the claim it
// corrects is the one thing on this panel a reader previously acted on and got
// wrong ("Fully reversible by reactivating" was false), and losing it would put
// that belief straight back.
describe("AgentProfilePage explains the control it is showing (#2123)", () => {
  const withStatus = async (deactivatedAt: string | null) => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), deactivated_at: deactivatedAt };
    render(await AgentProfilePage(props));
    return screen.getByText("Account status").closest("section") as HTMLElement;
  };

  it("explains deactivating on an active account, and says nothing about reactivating", async () => {
    const panel = await withStatus(null);
    expect(panel.textContent).toMatch(/Deactivating says this person has left/i);
    expect(panel.textContent).not.toMatch(/Reactivating brings the account back/i);
  });

  it("explains reactivating on a deactivated account, including what it does not restore", async () => {
    const panel = await withStatus("2026-06-01T00:00:00.000Z");
    expect(panel.textContent).toMatch(/Reactivating brings the account back/i);
    expect(panel.textContent).toMatch(/does not make them bookable again/i);
    expect(panel.textContent).not.toMatch(/Deactivating says this person has left/i);
  });

  // The list of internal systems is gone. Naming four to make one point spends
  // the reader's attention on three things they cannot check.
  it("names one system a reader can check, not four", async () => {
    const panel = await withStatus(null);
    expect(panel.textContent).toMatch(/booking pool/i);
    for (const named of [/round robin/i, /calendar sync/i, /every picker/i]) {
      expect(panel.textContent).not.toMatch(named);
    }
  });
});

describe("the time off calendar field says what it is (#2161)", () => {
  const asAdminViewing = async (role: "manager" | "admin" | "agent") => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf(role);
    render(await AgentProfilePage(props));
  };

  it("names whose calendar it is, rather than an internal abbreviation", async () => {
    await asAdminViewing("manager");
    // Dan asked what the field was for. "OOO calendar ID" is a term a reader
    // cannot know, and the placeholder showing a Google id says only what to type.
    expect(screen.getByLabelText(/team time off calendar/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^OOO calendar ID$/i)).toBeNull();
  });

  it("explains the DOMAIN: what lands there, and what leaving it blank does", async () => {
    await asAdminViewing("manager");
    const field = screen.getByLabelText(/team time off calendar/i);

    // Reachable by a screen reader, not just printed near the box (L604).
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy!);
    expect(hint).not.toBeNull();

    // The two facts a reader cannot get from the code: what is written here, and
    // that blank is a real choice rather than an unfinished one.
    expect(hint!.textContent).toMatch(/approved time off/i);
    expect(hint!.textContent).toMatch(/blank/i);
    // And NOT a description of the control itself.
    expect(hint!.textContent).not.toMatch(/this field|enter the|type the/i);
  });

  it("focuses the box when its label is clicked, which needs a real association", async () => {
    await asAdminViewing("manager");
    const field = screen.getByLabelText(/team time off calendar/i) as HTMLInputElement;
    const label = document.querySelector(`label[for="${field.id}"]`);
    expect(field.id).toBeTruthy();
    expect(label).not.toBeNull();
  });

  it("is not shown on a plain agent, who has no team to write time off for", async () => {
    await asAdminViewing("agent");
    expect(screen.queryByLabelText(/team time off calendar/i)).toBeNull();
  });

  // #3100: found by the first browser run. `setOooCalendarId` redirects with
  // `?ok=agent-ooo-calendar`, and this page drew only the working hours outcome,
  // so the save wrote the calendar and said nothing at all (L608).
  it("says the calendar was saved when the save comes back", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("manager");
    render(
      await AgentProfilePage({
        ...props,
        searchParams: Promise.resolve({ ok: "agent-ooo-calendar" }),
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(SAVE_OUTCOME_COPY["agent-ooo-calendar"]);
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
    env.consoleHiddenFor.mockReturnValueOnce(true);
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

  // #1474 keeps the field READ ONLY; #1877 trims what it says down to the label
  // and the name. The label is asserted EXACTLY, because the two things removed
  // here were both qualifiers appended to explain what the field is for, and that
  // is precisely how a qualifier creeps back.
  it("shows the manager of record as the label and the name, with no qualifier and no control", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), manager_id: "mgr1" };
    dbState.usersList = [
      { id: "mgr1", name: "Rosa Vance", email: "rosa@trypennie.com", role: "manager", deactivated_at: null },
    ];
    render(await AgentProfilePage(props));

    expect(screen.queryByRole("button", { name: /set manager/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /manager/i })).toBeNull();

    // The name is still there, so the trim did not take the value with it.
    expect(screen.queryByText("Rosa Vance")).toBeTruthy();

    const label = screen.getByText("Manager");
    expect(label.textContent).toBe("Manager");
    expect(screen.queryByText(/time off approvals/i)).toBeNull();
    expect(screen.queryByText(/set in salesforce/i)).toBeNull();
    expect(screen.queryByText(/synced hourly/i)).toBeNull();
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

// #1769. "I clicked make bookable and it worked but it didn't immediately look
// like it did anything." The action returned void and revalidated /admin, which is
// not this page, so the only thing that changed on screen was one button being
// replaced by another in the corner of a dense row. And the refusal THREW, on a
// route with no error boundary, so Next scrubbed the one sentence that said what
// to do.
describe("AgentProfilePage says what the pool toggle did (#1769)", () => {
  const renderWith = async (bookable?: string) => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(
      await AgentProfilePage({
        params: Promise.resolve({ id: "x1" }),
        searchParams: Promise.resolve(bookable ? { bookable } : {}),
      }),
    );
  };

  it("confirms what changed, rather than leaving a swapped button to be spotted", async () => {
    await renderWith("on");
    const said = screen.getByRole("status").textContent ?? "";
    expect(said).toMatch(/now bookable/i);
    expect(said).toMatch(/routed/i);
  });

  it("says which way it went", async () => {
    await renderWith("off");
    expect(screen.getByRole("status").textContent).toMatch(/no longer bookable/i);
  });

  // The two refusals need DIFFERENT actions from the reader, so they must not
  // arrive as one message (L11): an account gone from the Workspace is a
  // credential repair, and a Google wobble is worth retrying.
  it("tells an unreachable calendar apart from a check that could not be made", async () => {
    await renderWith("blocked-gone");
    const gone = screen.getByRole("status").textContent ?? "";
    expect(gone).toMatch(/unreachable/i);
    expect(gone).toMatch(/fix the calendar/i);
    expect(gone).not.toMatch(/try again shortly/i);
    cleanup();

    await renderWith("blocked-transient");
    const transient = screen.getByRole("status").textContent ?? "";
    expect(transient).toMatch(/temporary/i);
    expect(transient).toMatch(/try again shortly/i);
    expect(transient).not.toMatch(/fix the calendar/i);
  });

  it("stays silent on an ordinary visit, so the banner always means something", async () => {
    await renderWith();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays silent on a code it does not recognise, rather than rendering a blank banner", async () => {
    // The code arrives in the URL, so anybody can type one.
    await renderWith("../../etc/passwd");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("puts a pending state on every submit, including the slowest one", async () => {
    await renderWith();
    // Make bookable makes a LIVE Google call before it writes anything, so it is
    // the one press that must never read as nothing having happened.
    for (const name of [/set role/i, /save hours/i]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // A raw <button> has no aria-busy attribute at all; SubmitButton always
    // renders one, which is what says a press was registered.
    const busy = document.querySelectorAll("button[aria-busy]");
    expect(busy.length).toBeGreaterThanOrEqual(3);
  });
});

// #1878. Two things in the header band, one issue because either one alone forces
// a layout decision the other would redo.
//
// The role was named TWICE on this page: a pill in the header and the Role
// control under Access. The page's own recorded rule decided which goes: the
// Bookable pill is there because "nothing else on this page names the fact", and
// the role fails that test, so the pill is the redundant one.
//
// The catch is that the control naming it renders only for an admin who may
// assign a role, so deleting the pill outright would leave a manager (and an
// admin looking at a super admin) with the role named NOWHERE. The role is
// therefore named exactly once in BOTH cases: as the control where it can be
// changed, and as read only text where it cannot.
//
// The fixtures use team lead and super admin rather than agent on purpose. "agent"
// appears a dozen times in this page's prose, so a count of it could never tell a
// duplicate rendering apart from a sentence.
// #1988: the other half of the confirmation, and it is deliberately its own
// test. Asserting that the action redirects with an outcome proves nothing about
// whether the page ever renders anything for it, and asserting that the page
// renders a notice proves nothing about whether the action sets the flag. Both
// halves, or the feature can be half shipped and green.
describe("AgentProfilePage confirms a saved week (#1988)", () => {
  const renderWith = async (ok?: string) => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(
      await AgentProfilePage({
        params: Promise.resolve({ id: "x1" }),
        searchParams: Promise.resolve(ok ? { ok } : {}),
      }),
    );
  };

  // #1997: the banner says "Hours saved." and stops there. It used to recite the
  // week, which put the week on screen three times at once: here, in the summary
  // paragraph beneath, and in the day rows that hold every one of those times in
  // fields. The assertion that it NAMES the week is deleted rather than adjusted,
  // because that is the behaviour being removed (L252).
  it("confirms the save without reciting the week the rows already show", async () => {
    await renderWith("working-hours");
    const said = screen.getAllByRole("status").map((n) => n.textContent ?? "");
    const notice = said.find((t) => /hours saved/i.test(t));
    expect(notice).toBe("Hours saved.");
  });

  it("says nothing on an ordinary visit", async () => {
    await renderWith();
    const said = screen.queryAllByRole("status").map((n) => n.textContent ?? "");
    expect(said.some((t) => /hours saved/i.test(t))).toBe(false);
  });
});

describe("AgentProfilePage names the role once, and the header carries view as (#1878)", () => {
  const header = () =>
    screen.getByRole("heading", { level: 1 }).closest("section") as HTMLElement;

  it("names the role once, in the control that changes it, for someone who may", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("team_lead");
    render(await AgentProfilePage(props));

    expect(screen.getByRole("combobox", { name: /role/i })).toBeTruthy();
    expect(screen.getAllByText(/team lead/i)).toHaveLength(1);
    // And the one place naming it is the control, not a label beside it.
    expect(header().textContent).not.toMatch(/team lead/i);
  });

  // An admin cannot assign any role to a super admin (#550), so the control is
  // absent and the role would otherwise vanish from the page entirely.
  it("names the role once as text for a reader who cannot change it", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("super_admin");
    render(await AgentProfilePage(props));

    expect(screen.queryByRole("combobox", { name: /role/i })).toBeNull();
    expect(screen.getAllByText(/super admin/i)).toHaveLength(1);
  });

  it("puts view as inside the header card rather than loose beneath it", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(await AgentProfilePage(props));

    const button = screen.getByRole("button", { name: /view as/i });
    expect(header().contains(button)).toBe(true);
    // A control, not another pill: the pills are labels and this does something,
    // so it wears the shared secondary button treatment (asserted against the
    // constant, so it cannot drift from the other buttons on the page) and it
    // sits in a different group from them.
    for (const part of btnSecondaryCls.split(/\s+/)) {
      expect(button.className, `view as must carry ${part}`).toContain(part);
    }
    const pill = screen.getByText("Not bookable");
    expect(pill.closest("div")).not.toBe(button.closest("div"));
  });

  // The case a test written by somebody with permission will not naturally cover:
  // an admin cannot view as another admin (#588), so the button is simply absent.
  it("renders the header with the status pills unmoved when view as is absent", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("admin"), bookable: true };
    render(await AgentProfilePage(props));

    expect(screen.queryByRole("button", { name: /view as/i })).toBeNull();
    const pill = screen.getByText("Bookable");
    expect(header().contains(pill)).toBe(true);
    // The quantity being protected: the pills' own group is not pinned to the
    // right edge, so what sits after it cannot move them. A group carrying
    // `ml-auto` shifts as soon as the button beside it disappears.
    const group = pill.closest("div");
    expect(group?.className ?? "").not.toMatch(/ml-auto/);
  });
});

// #1875. Three asks, and the third is the one that mattered: "I am not clear how
// deactivating differs from making somebody unbookable." The screen was never
// going to tell him, and what it did say was wrong.
//
// The copy claims are asserted in scripts/test-account-status-copy.ts, where the
// sentences live. These are the PAGE facts: where the section sits, and that the
// two opposite decisions in it no longer look identical.
// #2145: the rare, the dangerous and the irreversible go behind one disclosure.
// Dan: "let's put all of this into a collapsed section ... I want deactivate
// account hard to reach especially."
describe("AgentProfilePage puts the rare and the dangerous behind a disclosure (#2145)", () => {
  const renderWith = async (query: Record<string, string> = {}) => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agentOf("agent");
    render(
      await AgentProfilePage({
        params: Promise.resolve({ id: "a1" }),
        searchParams: Promise.resolve(query),
      }),
    );
  };

  const disclosure = () => document.querySelector("details") as HTMLDetailsElement | null;

  it("is closed on arrival, so deactivate is never one click from an ordinary visit", async () => {
    await renderWith();
    expect(disclosure()).toBeTruthy();
    expect(disclosure()!.open).toBe(false);
    // Inside it, all three: what they route for, the mover, and the account.
    expect(disclosure()!.textContent).toContain("Routing attributes");
    expect(disclosure()!.textContent).toContain(COVERAGE_PANEL_NAME);
    expect(disclosure()!.textContent).toContain("Account status");
  });

  it("names the operations rather than the panels", async () => {
    await renderWith();
    const summary = document.querySelector("summary");
    // A reader deciding whether to open it needs to know what they could DO in
    // there. "Routing attributes, coverage and account status" would be a list of
    // section headings, which is a gloss on the interface (L604).
    expect(summary?.textContent).toMatch(/bookings/i);
    expect(summary?.textContent).toMatch(/account/i);
  });

  it("opens when the page is addressed with a job, so the time off queue's link lands on it", async () => {
    // #1239: the queue deep links to the sweep an approval enqueued. A disclosure
    // closed over the target would make that link land on nothing.
    await renderWith({ job: "job-1" });
    expect(disclosure()!.open).toBe(true);
  });

  it("leaves the things somebody came for open above it", async () => {
    await renderWith();
    const hours = screen.getByText("Working hours");
    expect(disclosure()!.contains(hours)).toBe(false);
  });

  it("hides no signal: a departed agent still says so beside their name", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), deactivated_at: "2026-08-01T00:00:00Z" };
    render(await AgentProfilePage(props));
    // The word appears inside the closed section too (the account panel names the
    // state it is in), so this asks the question that matters: is there one
    // OUTSIDE it. That is the whole point: the status a reader needs at a glance
    // from in there is already at the top of the page.
    const outside = screen
      .getAllByText("Deactivated")
      .filter((el) => !disclosure()!.contains(el));
    expect(outside.length).toBe(1);
  });
});

describe("AgentProfilePage account status sits last and looks its weight (#1875)", () => {
  const renderAs = async (agent: Record<string, unknown>) => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role: "manager", org_id: "o1" });
    dbState.agent = agent;
    render(await AgentProfilePage(props));
  };

  it("puts account status after the panel that moves the bookings", async () => {
    await renderAs(agentOf("agent"));

    const status = screen.getByText("Account status");
    const mover = screen.getByText(COVERAGE_PANEL_NAME);
    // Node order, so this asserts what a reader scrolls past rather than a
    // margin. Moving the bookings comes first because that is the order the work
    // happens in: move them, then close the account.
    expect(mover.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dresses deactivate as destructive and reactivate as ordinary", async () => {
    await renderAs(agentOf("agent"));
    const deactivate = screen.getByRole("button", { name: /deactivate account/i });
    expect(deactivate.className).toBe(btnDangerCls);
    cleanup();

    // The same control in the other direction is a plain secondary: bringing an
    // account back is not the dangerous half.
    await renderAs({ ...agentOf("agent"), deactivated_at: "2026-08-01T00:00:00Z" });
    const reactivate = screen.getByRole("button", { name: /reactivate account/i });
    expect(reactivate.className).toBe(btnSecondaryCls);
    expect(reactivate.className).not.toBe(btnDangerCls);
  });

  // The case Dan was reacting to: an agent with an empty calendar is one click
  // from being offboarded, because the #1215 confirm is deliberately skipped when
  // no APPOINTMENT is stranded. The press is still not reversible, so the
  // treatment stays.
  it("keeps the destructive treatment on the one click path", async () => {
    previewBulkReassign.mockResolvedValueOnce(0);
    await renderAs(agentOf("agent"));

    const deactivate = screen.getByRole("button", { name: /deactivate account/i });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deactivate.className).toBe(btnDangerCls);
  });

  it("tells the two axes apart on the screen where they have to be chosen between", async () => {
    await renderAs(agentOf("agent"));
    const panel = screen.getByText("Account status").closest("section") as HTMLElement;
    const text = panel.textContent ?? "";

    expect(text).not.toMatch(/fully reversible/i);
    // The other axis, named, with where its control is.
    expect(text).toMatch(/Not bookable under Access/i);
  });
});

// #1874. "These should be idiot proof, with no typos possible."
//
// They were three text boxes, and two of them (`debt_team`, `backend_service`)
// are what routing MATCHES on: a typo produces no error, it produces an agent
// who silently belongs to no bucket, and the only symptom is a pool one person
// shorter than expected.
//
// A picker would have made a bad value unrepresentable and would still have been
// an override that silently reverted, because the hourly roster sync deletes and
// rewrites all three. Dan chose read only for all three (2026-09-04), which is the
// call #1474 already made for the manager field: an editable control that is undone
// within the hour is worse than none. #2152 changed which half of that sync rewrites
// the two routing values, from Salesforce to Twilio, and not that one does.

/** Every field in the routing attributes row, so a count is never hardcoded. */
function attrFields(): HTMLElement[] {
  const panel = screen.getByText("Routing attributes").closest("section") as HTMLElement;
  const row = panel.querySelector("[data-attr-row]") as HTMLElement;
  return [...row.children] as HTMLElement[];
}

describe("AgentProfilePage routing attributes are read only (#1874)", () => {
  const withAttrs = async (attributes: Record<string, unknown>) => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), attributes };
    render(await AgentProfilePage(props));
  };

  it("offers no way to type any of the three Salesforce owned values", async () => {
    await withAttrs({ debt_team: ["ultra_high", "very_high"], backend_service: "achieve", role: "Sales" });

    // The exact defect: a text box whose contents routing matches on.
    for (const name of ["debt_team", "backend_service", "agent_role"]) {
      expect(document.querySelector(`[name="${name}"]`)).toBeNull();
    }
    // And not as a picker either, which is the other thing that would have been
    // reverted by the sync within the hour.
    expect(screen.queryByRole("combobox", { name: /debt team/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /backend/i })).toBeNull();
  });

  it("still shows the values, since read only is not the same as hidden", async () => {
    await withAttrs({ debt_team: ["ultra_high", "very_high"], backend_service: "achieve", role: "Sales" });

    // #2120: in full words, not the stored keys and not the roster's ladder. The
    // keys are the machine spelling of a vocabulary that has labels, and the
    // ladder's five letters earn their place in a COLUMN, where they align down
    // every row; a single record has no column, so the letters would buy nothing
    // and cost a legend the reader has to go and find.
    expect(screen.queryByText("ultra_high, very_high")).toBeNull();
    expect(document.querySelector("[data-ledger]")).toBeNull();
    expect(screen.getByText("Very High, Ultra High")).toBeTruthy();

    // The backend gets the same vocabulary treatment, for the same reason.
    expect(screen.getByText("Achieve")).toBeTruthy();
    expect(screen.queryByText("achieve")).toBeNull();
  });

  // The words and the roster's accessible name are one composition, so a reader
  // comparing the two screens can never be told different things about one agent.
  it("says a gap as a list, since a range would claim a rung this agent does not cover", async () => {
    await withAttrs({ debt_team: ["low", "high"] });
    expect(screen.getByText("Low, High")).toBeTruthy();
  });

  // #2120: `role` is the Salesforce Profile name, and NOTHING routes on it: all
  // every bucket keys on debt_team and backend_service. A field
  // nothing routes on, under a heading about routing, is a fact the reader has to
  // work out is irrelevant. The audit trail still records it (`details.profile`),
  // so the data and the record of who was made bookable are untouched.
  it("does not print the Salesforce profile, which nothing routes on", async () => {
    await withAttrs({ debt_team: ["low"], backend_service: "achieve", role: "Sales" });
    const panel = screen.getByText("Routing attributes").closest("section") as HTMLElement;
    expect(panel.textContent).not.toMatch(/Salesforce profile/i);
    expect(panel.textContent).not.toMatch(/\bSales\b/);
  });

  // A blank beside a label reads as a panel that failed to load, not as an agent
  // with no team (L10, L67). Named in the SAME words the fields beside it use for
  // the same state, because one meaning on one surface gets one vocabulary (L118).
  it("names an absent debt team in the same words its neighbours use", async () => {
    await withAttrs({});
    // EVERY field in the row, counted from the row rather than from a number
    // written here: the row held three fields until #2218 retired one of them, and
    // a literal 3 went red for a reason that had nothing to do with absent values.
    const fields = attrFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.textContent).toMatch(/Not set/);
  });

  // A blank is not a team. Asking the raw attribute rather than the function that
  // composes the words would print an empty string for exactly this agent, and
  // the two would be answering different questions about one value (L70).
  it("names a blank stored team as absent, since a blank is not a team", async () => {
    await withAttrs({ debt_team: ["", "  "] });
    const fields = attrFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.textContent).toMatch(/Not set/);
  });

  // A value that is not one of the five rungs is still coverage, and dropping it
  // would under report the agent on the panel that exists to show what they
  // cover (L113). Shown as stored, so it reads as a data question.
  it("names a stored value that is not a rung, rather than dropping it", async () => {
    await withAttrs({ debt_team: ["low", "credit"] });
    expect(screen.getByText("Low, plus credit")).toBeTruthy();
  });

  // #2120: the panel explained the INTERFACE. "What this agent can be routed for.
  // The first three come from Salesforce and are rewritten by the hourly roster
  // sync, so they are shown here rather than edited" tells the reader what the
  // panel is and which system owns it, which is a sentence written for whoever
  // built it. The read only-ness is carried by there being no control, and the
  // reason lives in the code comment where a maintainer will meet it.
  it("explains no part of itself", async () => {
    await withAttrs({});
    const panel = screen.getByText("Routing attributes").closest("section") as HTMLElement;
    expect(panel.textContent).not.toMatch(/come from Salesforce/i);
    expect(panel.textContent).not.toMatch(/hourly roster sync/i);
    expect(panel.textContent).not.toMatch(/rather than edited/i);
    expect(panel.textContent).not.toMatch(/What this agent can be routed for/i);
  });

  // #2218 RETIRED LEGAL ELIGIBLE. Six cases stood here about the third field in
  // this row: that it offered no control, that it sat in line with the other two,
  // that every reader saw it, and how its three stored states read as words. The
  // attribute is gone, so all six were about a field that no longer exists (L373).
  //
  // What survives them is the ROW, which still has to hold the two attributes that
  // remain rather than quietly becoming a single value with a heading over it.
  it("shows the routing attributes that remain, in one row", async () => {
    await withAttrs({ debt_team: ["low"], backend_service: "achieve" });
    const panel = screen.getByText("Routing attributes").closest("section") as HTMLElement;
    const row = panel.querySelector("[data-attr-row]") as HTMLElement;
    expect(row).toBeTruthy();
    for (const label of ["Debt team(s)", "Backend"]) {
      expect(row.textContent).toContain(label);
    }
    expect(row.textContent).not.toMatch(/legal/i);
  });
});

describe("the booking link card (#2073, #3026)", () => {
  const asAdmin = () => auth.currentUser.mockResolvedValue({ id: "a1", role: "admin", org_id: "o1", email: "a1@ex.com" });

  it("shows an admin the readable link and no way to replace it", async () => {
    asAdmin();
    dbState.agent = agentOf("agent");
    agentLinkStore.loadAgentLinkName.mockResolvedValue("rdaboub");
    render(await AgentProfilePage(props));
    expect((screen.getByLabelText("Booking link") as HTMLInputElement).value).toMatch(/\/book\/advisor\/rdaboub$/);
    expect(agentLinkStore.loadAgentLinkName).toHaveBeenCalledWith("x1");
    // #3026: the replace control is gone (Dan, 2026-10-02). Abuse is handled by
    // making the advisor not bookable.
    expect(screen.queryByRole("button", { name: /(Replace|Create) link/ })).toBeNull();
  });

  it("says so when the agent has no link, with nothing to create", async () => {
    asAdmin();
    dbState.agent = agentOf("agent");
    agentLinkStore.loadAgentLinkName.mockResolvedValue(null);
    render(await AgentProfilePage(props));
    expect(screen.getByText(/has no booking link yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /(Replace|Create) link/ })).toBeNull();
  });

  it("says the link could not be read rather than that there is none", async () => {
    asAdmin();
    dbState.agent = agentOf("agent");
    agentLinkStore.loadAgentLinkName.mockRejectedValue(new Error("db down"));
    render(await AgentProfilePage(props));
    expect(screen.getByText(/booking link could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/has no booking link yet/)).toBeNull();
  });

  it("is not shown to a manager", async () => {
    auth.currentUser.mockResolvedValue({ id: "m1", role: "manager", org_id: "o1", email: "m1@ex.com" });
    dbState.agent = agentOf("agent");
    agentLinkStore.loadAgentLinkName.mockResolvedValue("rdaboub");
    render(await AgentProfilePage(props));
    expect(screen.queryByText("Booking link")).toBeNull();
    expect(agentLinkStore.loadAgentLinkName).not.toHaveBeenCalled();
  });
});

// #3028, which reverses #2097's choice to leave the control usable. The hourly
// Twilio sync turns off every bookable advisor whose worker carries Redistribute,
// so "Make bookable" for one of them was undone within the hour, and admins pressed
// it twice for the same person before anybody worked out why. #2097's two tests
// here asserted the old sentence on the MARK, and are deleted rather than adjusted
// (L252): the question is now the tag, and the control refuses.
describe("AgentProfilePage refuses a flip the Twilio sync would undo (#3028)", () => {
  const renderAgent = async (bookable: boolean, attributes: Record<string, unknown>) => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), bookable, attributes };
    render(await AgentProfilePage(props));
  };

  it("disables Make bookable for an advisor on Redistribute, and says why beside it", async () => {
    await renderAgent(false, { redistribute_tagged: "Y" });
    const button = screen.getByRole("button", { name: /make bookable/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // And it LOOKS refused, not merely inert: a busy button keeps full ink.
    expect(button.hasAttribute("data-refused")).toBe(true);
    // The reason has to reach somebody who cannot see the sentence beside a
    // control they cannot press, so it is the button's description.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy as string);
    expect(reason?.textContent).toMatch(/Twilio has this advisor on Redistribute/);
    // The remedy names the place they will act (L399).
    expect(reason?.textContent).toMatch(/remove the tag in Twilio/i);
  });

  it("leaves Make bookable alone for an advisor Twilio does not hold", async () => {
    await renderAgent(false, { debt_team: ["low"] });
    const button = screen.getByRole("button", { name: /make bookable/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.hasAttribute("data-refused")).toBe(false);
    expect(document.body.textContent ?? "").not.toMatch(/redistribute/i);
  });

  it("still lets an admin take an advisor on Redistribute out of the pool", async () => {
    await renderAgent(true, { redistribute_tagged: "Y" });
    const button = screen.getByRole("button", { name: /make not bookable/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("does not refuse on the mark alone, which the sync never flips on", async () => {
    await renderAgent(false, { redistribute: "Y" });
    const button = screen.getByRole("button", { name: /make bookable/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // The action refuses the same case, for a tab opened before the tag landed. Its
  // outcome has to land somewhere, or the refusal is a page that reloads unchanged.
  it("says so when the action refused the flip", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), attributes: { redistribute_tagged: "Y" } };
    render(
      await AgentProfilePage({
        params: Promise.resolve({ id: "x1" }),
        searchParams: Promise.resolve({ bookable: "blocked-redistribute" }),
      }),
    );
    const said = screen.getAllByRole("status").map((el) => el.textContent ?? "");
    const banner = said.find((t) => /not made bookable/i.test(t) && /Redistribute/.test(t));
    expect(banner).toBeTruthy();
    // The remedy, named where it is made (L399), and honest that the stored copy of
    // the tag only moves at the next hourly sync (L111).
    expect(banner).toMatch(/remove the tag in Twilio/i);
    expect(banner).toMatch(/next hourly sync/i);
  });

  it("says nothing was changed when the agent's record could not be read", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "ad1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), attributes: {} };
    render(
      await AgentProfilePage({
        params: Promise.resolve({ id: "x1" }),
        searchParams: Promise.resolve({ bookable: "unreadable" }),
      }),
    );
    const said = screen.getAllByRole("status").map((el) => el.textContent ?? "");
    expect(said.some((t) => /nothing was changed/i.test(t) && /could not read/i.test(t))).toBe(true);
  });
});

// #3595: the calls the last coverage sweep could not place, at the top of the page
// (Dan's design round, 2026-10-21). Somebody arriving from the coverage alert has to
// find them without opening the closed section, which by design hides no signal.
describe("AgentProfilePage lists the calls the last move could not place (#3595)", () => {
  const stranded = {
    calls: [
      {
        bookingId: "bk-1",
        status: "unplaceable" as const,
        detail: "No other advisor was free at this time",
        startsAt: "2026-10-23T14:00:00Z",
        attendeeName: "Marisol Ortega",
      },
    ],
    moves: ["2026-10-11T23:57:00Z"],
  };
  const renderAs = async (role = "manager", agentRole = "agent") => {
    auth.currentUser.mockResolvedValueOnce({ id: "m1", role, org_id: "o1" });
    dbState.agent = agentOf(agentRole);
    render(await AgentProfilePage(props));
  };
  const disclosure = () => document.querySelector("details") as HTMLDetailsElement;

  it("puts them under the agent's own card, before Access and outside the closed section", async () => {
    strandedStore.loadAgentStrandedCalls.mockResolvedValue(stranded);
    await renderAs();
    const heading = screen.getByText("Couldn't place (1)");
    expect(disclosure().contains(heading)).toBe(false);
    const access = screen.getByText("Access");
    expect(heading.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const header = screen.getByRole("heading", { level: 1 });
    expect(header.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Place by hand" }).getAttribute("href")).toBe("/admin/bookings/bk-1");
    expect(strandedStore.loadAgentStrandedCalls).toHaveBeenCalledWith("x1", expect.any(Number));
  });

  it("shows no card when nothing waits, so a healthy agent's page reads as before", async () => {
    await renderAs();
    expect(screen.queryByText(/Couldn't place/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the list could not be checked when the read fails, never that nothing waits", async () => {
    strandedStore.loadAgentStrandedCalls.mockRejectedValue(new Error("bulk_reassign_items unreadable"));
    await renderAs();
    const alert = screen.getAllByRole("alert").find((el) => /could not check/i.test(el.textContent ?? ""));
    expect(alert).toBeTruthy();
    expect(disclosure().contains(alert!)).toBe(false);
    // The rest of the page still renders around it.
    expect(screen.getByText("Access")).toBeTruthy();
  });

  it("is not read for somebody who cannot manage this agent, matching the Move panel it feeds", async () => {
    strandedStore.loadAgentStrandedCalls.mockResolvedValue(stranded);
    await renderAs("manager", "admin");
    expect(strandedStore.loadAgentStrandedCalls).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn't place/)).toBeNull();
  });
});

// #3526: sign in refuses a Google account other than the one a person's Slate
// account was set up with, so a rehire on a new Google account needs an admin to
// let the new one in. The control is the smallest one that does it, on the
// person's own page, and only where it can do something.
describe("linking a new Google account (#3526)", () => {
  const renderAs = async (viewer: "admin" | "manager", sub: string | null = "sub-old", query = {}) => {
    // Renders from earlier tests stay mounted in this file, so a role query would
    // find their notices too.
    cleanup();
    auth.currentUser.mockResolvedValueOnce({ id: "v1", role: viewer, org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), google_sub: sub };
    render(await AgentProfilePage({ ...props, searchParams: Promise.resolve(query) }));
  };

  it("offers an admin the control when a Google account is on record, confirmed with its consequence", async () => {
    await renderAs("admin");
    await userEvent.click(screen.getByRole("button", { name: GOOGLE_RELINK_COPY.openLabel }));
    // The confirm names what happens next, not a generic "are you sure".
    const group = screen.getByRole("group", { name: GOOGLE_RELINK_COPY.question("x1") });
    expect(group.textContent).toContain(GOOGLE_RELINK_COPY.consequence("x1", "x1@ex.com"));
    expect(screen.getByRole("button", { name: GOOGLE_RELINK_COPY.confirmLabel })).toBeTruthy();
  });

  it("is not offered when no Google account is on record, since there is nothing to unlink", async () => {
    await renderAs("admin", null);
    expect(screen.queryByRole("button", { name: GOOGLE_RELINK_COPY.openLabel })).toBeNull();
  });

  // A row with no account recorded can still be refused on every request (its sign
  // in holds no Google account, or two), so the way out has to be on offer there too.
  it("is offered when a sign in is on record even though no account is", async () => {
    cleanup();
    auth.currentUser.mockResolvedValueOnce({ id: "v1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("agent"), google_sub: null, auth_user_id: "auth-stuck" };
    render(await AgentProfilePage({ ...props, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("button", { name: GOOGLE_RELINK_COPY.openLabel })).toBeTruthy();
    // No Google account is recorded for them, so the line above the button cannot
    // speak of "the Google account they have been using".
    expect(screen.getByText(GOOGLE_RELINK_COPY.signInOnlyExplanation("x1"))).toBeTruthy();
    expect(screen.queryByText(GOOGLE_RELINK_COPY.explanation("x1"))).toBeNull();
  });

  it("explains the control in terms of the account they use when one is recorded", async () => {
    await renderAs("admin");
    expect(screen.getByText(GOOGLE_RELINK_COPY.explanation("x1"))).toBeTruthy();
    expect(screen.queryByText(GOOGLE_RELINK_COPY.signInOnlyExplanation("x1"))).toBeNull();
  });

  it("is not offered on an admin's own page, since it would delete their own sign in", async () => {
    cleanup();
    auth.currentUser.mockResolvedValueOnce({ id: "x1", role: "admin", org_id: "o1" });
    dbState.agent = { ...agentOf("admin"), google_sub: "sub-old" };
    render(await AgentProfilePage({ ...props, searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("button", { name: GOOGLE_RELINK_COPY.openLabel })).toBeNull();
  });

  it("is not offered to a manager, matching the action's admin only check", async () => {
    await renderAs("manager");
    expect(screen.queryByRole("button", { name: GOOGLE_RELINK_COPY.openLabel })).toBeNull();
  });

  it("says what changed when the relink comes back", async () => {
    await renderAs("admin", null, { ok: "agent-google-relinked" });
    // Other live regions on the page are empty; exactly one carries this outcome.
    const said = screen
      .getAllByRole("status")
      .filter((el) => el.textContent === SAVE_OUTCOME_COPY["agent-google-relinked"]);
    expect(said).toHaveLength(1);
  });
});
