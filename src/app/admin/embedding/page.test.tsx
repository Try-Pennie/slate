// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// #3137: the admin page that shows who frames the booker and holds the lock. Pinned: the
// access gates, the refused sites listed first with the lock's consequence counted from
// them, and a failed read drawn as a failure rather than as nobody framing the booker.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const guard = vi.hoisted(() => ({ readFrameLockSetting: vi.fn(async (): Promise<boolean | null> => false) }));
const range = vi.hoisted(() =>
  vi.fn(async (): Promise<{ data: unknown[] | null; error: { message: string } | null }> => ({ data: [], error: null })),
);
const from = vi.hoisted(() =>
  vi.fn(() => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.gte = () => b;
    b.order = () => b;
    b.range = range;
    return b;
  }),
);
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/embed/frame-guard", () => guard);
vi.mock("@/app/admin/actions", () => ({ setFrameLock: vi.fn() }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import EmbeddingPage from "./page";

const ADMIN = { id: "ad1", role: "admin", org_id: "o1", email: "a@x", theme_preference: null, bookable: false, avatar_url: null };
const page = () => EmbeddingPage({ searchParams: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.currentUser.mockResolvedValue(ADMIN);
  guard.readFrameLockSetting.mockResolvedValue(false);
  range.mockResolvedValue({ data: [], error: null });
});

describe("EmbeddingPage", () => {
  it("sends a signed out visitor to sign in, and refuses a manager", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(page()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    auth.currentUser.mockResolvedValueOnce({ ...ADMIN, role: "manager" });
    render(await page());
    expect(screen.queryByText(/Framing lock/)).toBeNull();
  });

  it("lists a site the lock would refuse first, and counts it in the lock's question", async () => {
    range.mockResolvedValueOnce({
      data: [
        { day: "2026-10-03", origin: "https://www.trypennie.com", surface: "book", loads: 500, last_seen: "2026-10-03T15:00:00Z" },
        { day: "2026-10-03", origin: "https://partner.example", surface: "manage", loads: 4, last_seen: "2026-10-03T14:00:00Z" },
      ],
      error: null,
    });
    const { container } = render(await page());
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["refused", "allowed"]);
    expect(rows[0].textContent).toContain("https://partner.example");
    expect(rows[0].textContent).toContain("Not on the allow list");
    expect(rows[0].textContent).toContain("manage 4");
    expect(container.querySelector("[data-state='unlocked']")).toBeTruthy();
  });

  it("says when the daily limit on named sites was reached, and only then", async () => {
    range.mockResolvedValueOnce({
      data: [
        { day: "2026-10-02", origin: "(other)", surface: "book", loads: 90, last_seen: "2026-10-02T15:00:00Z" },
        { day: "2026-10-03", origin: "(other)", surface: "manage", loads: 5, last_seen: "2026-10-03T15:00:00Z" },
      ],
      error: null,
    });
    const { container } = render(await page());
    expect(container.querySelector("[data-notice='capped']")?.textContent).toMatch(/On 2 days/);

    range.mockResolvedValueOnce({
      data: [{ day: "2026-10-03", origin: "https://partner.example", surface: "book", loads: 1, last_seen: "2026-10-03T15:00:00Z" }],
      error: null,
    });
    const again = render(await page());
    expect(again.container.querySelector("[data-notice='capped']")).toBeNull();
  });

  it("counts sites folded into other sites in the lock's question, rather than saying none framed it", async () => {
    range.mockResolvedValueOnce({
      data: [{ day: "2026-10-03", origin: "(other)", surface: "book", loads: 30, last_seen: "2026-10-03T15:00:00Z" }],
      error: null,
    });
    const { container } = render(await page());
    // The question appears once the opener is pressed, as a person meets it.
    fireEvent.click(screen.getByRole("button", { name: "Lock framing" }));
    const confirm = container.querySelector("[data-state='unlocked']")?.textContent ?? "";
    expect(confirm).toMatch(/allow list will be able to show the booker/);
    expect(confirm).not.toMatch(/No site outside the allow list/);
    expect(confirm).toMatch(/counted together/);
  });

  it("says so when the record cannot be read, rather than showing nobody framing the booker", async () => {
    range.mockResolvedValueOnce({ data: null, error: { message: "relation does not exist" } });
    render(await page());
    expect(screen.getByRole("alert").textContent).toMatch(/Could not read who has framed the booker/);
    expect(screen.queryByText(/No framed booker loads/)).toBeNull();
  });

  it("draws an empty record as a statement, and an unreadable switch as its own state", async () => {
    guard.readFrameLockSetting.mockResolvedValueOnce(null);
    const { container } = render(await page());
    expect(screen.getByText(/No framed booker loads recorded/)).toBeTruthy();
    expect(container.querySelector("[data-state='unreadable']")).toBeTruthy();
  });

  it("shows the locked state with a way back", async () => {
    guard.readFrameLockSetting.mockResolvedValueOnce(true);
    render(await page());
    expect(screen.getByRole("button", { name: "Unlock framing" })).toBeTruthy();
  });
});
