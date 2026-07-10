// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the OOO queue page (#676): unauthenticated to /login, and a
// below-manager caller gets the deny notice instead of the request queue. Real
// canManageAgents is exercised; only auth and the navigation redirect are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));

import OooQueuePage from "./page";

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => vi.clearAllMocks());

describe("OooQueuePage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(OooQueuePage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await OooQueuePage(props));
    expect(screen.getByText(/manager or admin account to review time off/i)).toBeTruthy();
  });
});
