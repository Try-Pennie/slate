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
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({
        data:
          table === "users"
            ? dbState.agent
            : table === "availability_schedules"
              ? dbState.sched
              : null,
      }),
      single: async () => ({ data: dbState.org }),
      then: (res: (v: { data: unknown }) => void) =>
        res({
          data:
            table === "users"
              ? dbState.usersList
              : table === "availability_rules"
                ? dbState.rules
                : [],
        }),
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
const MANAGE_BUTTONS = [
  /make bookable/i,
  /set manager/i,
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
  previewBulkReassign.mockResolvedValue(0);
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
