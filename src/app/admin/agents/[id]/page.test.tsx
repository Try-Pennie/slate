import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the agent-profile page (#676): unauthenticated to /login, a
// below-manager caller gets the deny notice, the OOO-only flag diverts managers
// to /admin/ooo, and an unknown agent id resolves to notFound(). Real role
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
const dbState = vi.hoisted(() => ({ single: null as unknown }));
const from = vi.hoisted(() =>
  vi.fn(() => {
    const q: Record<string, unknown> = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      maybeSingle: vi.fn(async () => ({ data: dbState.single })),
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import AgentProfilePage from "./page";

const props = { params: Promise.resolve({ id: "x1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  dbState.single = null;
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
    dbState.single = null;
    await expect(AgentProfilePage(props)).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
