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
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/env", () => ({ oooOnlyFor: () => false }));

import { AppHeader } from "@/components/AppHeader";

const props = { email: "admin@trypennie.com", role: "admin", active: "admin" as const };

beforeEach(() => {
  view.v = { status: "none" };
});

describe("AppHeader impersonation banners (#652)", () => {
  it("shows the active 'viewing as' banner when impersonating", async () => {
    view.v = {
      status: "active",
      real: { id: "admin-1" },
      target: { id: "agent-9", name: "Agent Nine", email: "a9@x.com", role: "agent" },
    };
    render(await AppHeader(props));
    expect(screen.getByText(/Agent Nine/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop viewing as them/i })).toBeTruthy();
    expect(screen.queryByText(/timed out|no longer available/i)).toBeNull();
  });

  it("shows the timed-out drop notice, not the active banner, when dropped/expired", async () => {
    view.v = { status: "dropped", reason: "expired" };
    render(await AppHeader(props));
    expect(screen.getByText(/timed out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop viewing as them/i })).toBeNull();
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
