import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the staffing-depth view (#584): unauthenticated visitors are
// redirected to /login, and a signed-in agent (below manager) gets the deny
// notice instead of the report. Real canManageAgents is exercised; only auth and
// the navigation redirect are mocked (both fire before any DB read).
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));

import TiersPage from "./page";

beforeEach(() => vi.clearAllMocks());

describe("TiersPage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(TiersPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a signed-in agent instead of the report", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await TiersPage());
    expect(screen.getByText(/manager or admin account to view staffing depth/i)).toBeTruthy();
  });
});
