// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// /admin/program-leads (#4392). ADMINS ONLY (Dan, 2026-10-29: anything added in the UI for
// program leads is visible to admins only, never team leads or lower): the page answers not
// found to every role below admin and nothing is read, a coordinator is nobody to the console
// and is sent to sign in, and the sidebar entry is there for admin and super admin only.
// The rest pins the page's states: the 14 days, their empty reading and their unreadable one
// as different screens (L10), the columns labelled by which day they count by, and the limit
// control with its saved and refused outcomes on this page.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
const settings = vi.hoisted(() => ({
  readProgramLeadTimesSettings: vi.fn(async (): Promise<{ enabled: boolean; dayLimit: number } | null> => ({ enabled: true, dayLimit: 50 })),
}));
const days = vi.hoisted(() => ({ loadProgramLeadDays: vi.fn() }));
const actions = vi.hoisted(() => ({ setPlaceholderDayLimit: vi.fn(async () => {}) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), consoleHiddenFor: () => false }));
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/admin/program-lead-days-load", () => days);
vi.mock("@/app/admin/actions", () => actions);
vi.mock("@/lib/log", () => ({ log }));

import ProgramLeadsPage from "./page";
import { adminNavFor } from "@/lib/admin/nav";
import { ROLES } from "@/lib/auth/roles";
import { PROGRAM_LEADS_COPY as COPY } from "@/lib/admin/program-leads-copy";
import { placeholderDaysBack } from "@/lib/booking/program-lead-times";
import type { ProgramLeadDay } from "@/lib/admin/program-lead-days";
import type { Role } from "@/lib/db/types";

const user = (role: Role) => ({ id: "me", org_id: "org-1", role, email: "me@trypennie.com" });
const renderPage = async (sp: Record<string, string> = {}) => render(await ProgramLeadsPage({ searchParams: Promise.resolve(sp) }));
const fails = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as Error).message);

const DAYS = placeholderDaysBack(Date.UTC(2026, 9, 29, 19, 0), 14);
const quietDay = (day: string): ProgramLeadDay => ({ day, bookings: 0, onPlaceholder: 0, noRegalCall: 0, notKnownYet: 0, limitRefused: 0, fallbacks: 0 });
const QUIET = DAYS.map(quietDay);
const BUSY = DAYS.map((d, i) =>
  i === 2
    ? { day: d, bookings: 12, onPlaceholder: 5, noRegalCall: 1, notKnownYet: 2, limitRefused: 3, fallbacks: 4 }
    : quietDay(d),
);

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.currentUser.mockResolvedValue(user("admin"));
  settings.readProgramLeadTimesSettings.mockResolvedValue({ enabled: true, dayLimit: 50 });
  days.loadProgramLeadDays.mockResolvedValue(BUSY);
});

describe("who has /admin/program-leads", () => {
  for (const role of ["admin", "super_admin"] as Role[]) {
    it(`opens for ${role}`, async () => {
      auth.currentUser.mockResolvedValue(user(role));
      await renderPage();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(COPY.page.title);
      expect(days.loadProgramLeadDays).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of ["team_lead", "manager", "agent"] as Role[]) {
    it(`is not found for ${role}, with nothing read and nothing drawn`, async () => {
      auth.currentUser.mockResolvedValue(user(role));
      expect(await fails(renderPage())).toBe("NEXT_NOT_FOUND");
      expect(days.loadProgramLeadDays).not.toHaveBeenCalled();
      expect(settings.readProgramLeadTimesSettings).not.toHaveBeenCalled();
    });
  }

  it("sends a coordinator, whom the console resolves as nobody, to sign in, with nothing read", async () => {
    auth.currentUser.mockResolvedValue(null);
    expect(await fails(renderPage())).toBe("NEXT_REDIRECT:/login");
    expect(days.loadProgramLeadDays).not.toHaveBeenCalled();
    expect(settings.readProgramLeadTimesSettings).not.toHaveBeenCalled();
  });

  it("is in the sidebar for admin and super admin and absent for every other role", () => {
    const has = (role: Role) => adminNavFor(role, false).some((g) => g.items.some((i) => i.href === "/admin/program-leads"));
    expect(has("admin")).toBe(true);
    expect(has("super_admin")).toBe(true);
    for (const role of ROLES.filter((r) => r !== "admin" && r !== "super_admin")) expect(has(role), role).toBe(false);
    expect(ROLES.filter((r) => !has(r)).sort()).toEqual(["agent", "coordinator", "manager", "team_lead"]);
  });
});

describe("the last 14 days", () => {
  it("labels each column group by the day it counts by, and draws one row per day, today first", async () => {
    await renderPage();
    const table = screen.getByRole("table");
    const groups = [...table.querySelectorAll('thead th[scope="colgroup"]')].map((th) => th.textContent);
    expect(groups).toEqual([COPY.days.byCallDay, COPY.days.byEventDay]);
    const cols = [...table.querySelectorAll('thead th[scope="col"]')].map((th) => th.childNodes[0]?.textContent);
    expect(cols).toEqual([
      COPY.days.dayColumn,
      COPY.days.bookings,
      COPY.days.onPlaceholder,
      COPY.days.noRegalCall,
      COPY.days.limitRefused,
      COPY.days.fallbacks,
    ]);
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(14);
    expect(rows[0]!.querySelector("th")!.textContent).toBe(COPY.days.today);
  });

  it("draws a day's counts in their columns, with the calls not known yet said apart", async () => {
    await renderPage();
    const row = [...screen.getByRole("table").querySelectorAll("tbody tr")][2]!;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells[0]).toBe("12");
    expect(cells[1]).toBe("5");
    expect(cells[2]).toContain("1");
    expect(cells[2]).toContain(COPY.days.notKnownYet(2));
    expect(cells[3]).toBe("3");
    expect(cells[4]).toBe("4");
  });

  it("says what the two domain terms mean on the term, for a screen reader as well as a pointer", async () => {
    await renderPage();
    const head = screen.getByRole("table").querySelector("thead")!;
    expect(head.textContent).toContain(COPY.days.noRegalCallTerm);
    expect(head.textContent).toContain(COPY.days.fallbacksTerm);
  });

  it("an empty fortnight says so in words, with no table of zeros", async () => {
    days.loadProgramLeadDays.mockResolvedValue(QUIET);
    await renderPage();
    expect(screen.getByText(COPY.days.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(COPY.days.unreadable)).toBeNull();
  });

  it("a failed read is its own screen, never the empty one, and is logged", async () => {
    days.loadProgramLeadDays.mockRejectedValue(new Error("selectAllPages failed"));
    await renderPage();
    expect(screen.getByRole("alert").textContent).toBe(COPY.days.unreadable);
    expect(screen.queryByText(COPY.days.empty)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});

describe("the placeholder day limit", () => {
  const box = () => screen.getByRole("heading", { level: 2, name: COPY.limit.heading }).closest("section")!;

  it("is a number box from 0 to 500 holding the stored limit, saved by the admin action", async () => {
    await renderPage();
    const input = within(box()).getByLabelText(COPY.limit.label) as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.name).toBe("placeholder_day_limit");
    expect(input.min).toBe("0");
    expect(input.max).toBe("500");
    expect(input.step).toBe("1");
    expect(input.defaultValue).toBe("50");
    expect(within(box()).getByRole("button", { name: COPY.limit.save })).toBeTruthy();
  });

  it("comes after the days, which are what the page is opened for (L609)", async () => {
    await renderPage();
    const table = screen.getByRole("table");
    expect(table.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an unreadable limit says so and offers no box, rather than a guessed number", async () => {
    settings.readProgramLeadTimesSettings.mockResolvedValue(null);
    await renderPage();
    expect(box().textContent).toContain(COPY.limit.unreadable);
    expect(within(box()).queryByRole("spinbutton")).toBeNull();
    expect(within(box()).queryByRole("button")).toBeNull();
  });

  it("says what a save did, on this page", async () => {
    await renderPage({ ok: "placeholder-day-limit" });
    expect(screen.getByRole("status").textContent).toContain("Placeholder day limit saved.");
  });

  it("says why a save was refused, on this page", async () => {
    await renderPage({ error: "Enter a whole number from 0 to 500." });
    expect(screen.getByRole("alert").textContent).toContain("Enter a whole number from 0 to 500.");
  });
});
