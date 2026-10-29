// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The Coordinator booking page (#4264), settled as docs/design/coordinator-admin.html.
//
// D2: only a super admin has the page and its sidebar item; every other role is refused without a
// glimpse of it (not found, or the redirect the console already gives them). D3: the switch lives
// here and on no page holding settings leads meet, the Hours page above all, where drawing it made
// it read as though leads on the website could book Marcia. The rest pins the page's states: the
// switch's three, and the list's rows, empty and failed, each its own screen (L10).
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
const hdrs = vi.hoisted(() => ({ host: "slate.trypennie.app" }));
const settings = vi.hoisted(() => ({
  readPlaceholderBookingEnabled: vi.fn(async (): Promise<boolean | null> => false),
  readTransferOfferSettings: vi.fn(async (): Promise<{ threshold: number; line: string } | null> => ({ threshold: 3, line: "786-504-0671" })),
}));
const coordinators = vi.hoisted(() => ({ loadCoordinators: vi.fn() }));
const actions = vi.hoisted(() => ({
  setPlaceholderBookingEnabled: vi.fn(async () => {}),
  removeCoordinator: vi.fn(async () => {}),
  setTransferOfferSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", hdrs.host]]) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), consoleHiddenFor: () => false }));
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/admin/coordinators-load", () => coordinators);
vi.mock("@/app/admin/actions", () => actions);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import CoordinatorBookingPage from "./page";
import { adminNavFor } from "@/lib/admin/nav";
import { btnCls, btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";
import { COORDINATOR_BOOKING_COPY as COPY } from "@/lib/admin/coordinator-booking-copy";
import { ROLES } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

const user = (role: Role) => ({ id: "me", org_id: "org-1", role, email: "me@trypennie.com" });
const ROWS = [
  { id: "c1", name: "Aisha Bello", email: "abello@trypennie.com", lastSignedIn: "2 hours ago" },
  { id: "c2", name: "Grace Okafor", email: "gokafor@trypennie.com", lastSignedIn: "yesterday" },
  { id: "c3", name: "Tomas Rivera", email: "trivera@trypennie.com", lastSignedIn: "38 days ago" },
];
const renderPage = async (sp: Record<string, string> = {}) =>
  render(await CoordinatorBookingPage({ searchParams: Promise.resolve(sp) }));
const fails = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as Error).message);
/** The switch: the smallest element holding its heading and its controls, as the design's checks find it. */
const switchBox = () => screen.getByRole("heading", { level: 3, name: COPY.switch.heading }).parentElement!;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hdrs.host = "slate.trypennie.app";
  delete process.env.SLATE_DESIGN_FIXTURES;
  auth.currentUser.mockResolvedValue(user("super_admin"));
  settings.readPlaceholderBookingEnabled.mockResolvedValue(false);
  settings.readTransferOfferSettings.mockResolvedValue({ threshold: 3, line: "786-504-0671" });
  coordinators.loadCoordinators.mockResolvedValue({ ok: true, rows: ROWS });
});

describe("/admin/coordinator-booking, who has it (D2)", () => {
  it("opens for a super admin, reading the switch and the caller's own organisation's coordinators", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Coordinator booking");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Scheduling coordinators");
    expect(settings.readPlaceholderBookingEnabled).toHaveBeenCalledTimes(1);
    expect(coordinators.loadCoordinators).toHaveBeenCalledWith("org-1");
  });

  for (const role of ["admin", "team_lead", "manager", "agent"] as Role[]) {
    it(`is not found for ${role}, with nothing read and nothing drawn`, async () => {
      auth.currentUser.mockResolvedValue(user(role));
      expect(await fails(renderPage())).toBe("NEXT_NOT_FOUND");
      expect(settings.readPlaceholderBookingEnabled).not.toHaveBeenCalled();
      expect(coordinators.loadCoordinators).not.toHaveBeenCalled();
    });
  }

  it("sends a coordinator, whom the console resolves as nobody, to sign in, with nothing read", async () => {
    // `currentUser` answers null for a coordinator (#4205): they open no staff page.
    auth.currentUser.mockResolvedValue(null);
    expect(await fails(renderPage())).toBe("NEXT_REDIRECT:/login");
    expect(settings.readPlaceholderBookingEnabled).not.toHaveBeenCalled();
    expect(coordinators.loadCoordinators).not.toHaveBeenCalled();
  });

  it("is in the sidebar for a super admin and absent for every other role", () => {
    const has = (role: Role) =>
      adminNavFor(role, false).some((g) => g.items.some((i) => i.href === "/admin/coordinator-booking"));
    expect(has("super_admin")).toBe(true);
    for (const role of ROLES.filter((r) => r !== "super_admin")) expect(has(role), role).toBe(false);
  });
});

describe("the switch lives only here (D3)", () => {
  const SRC = join(process.cwd(), "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
    });
  const all = files(SRC);
  const SWITCH_MARKS = ["PlaceholderBookingSwitch", "setPlaceholderBookingEnabled", "COORDINATOR_BOOKING_COPY.switch", COPY.switch.heading];

  it("is drawn by no page but this one, the Hours page included", () => {
    const pages = all.filter((p) => p.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(20);
    const hours = readFileSync(join(SRC, "app/admin/business-hours/page.tsx"), "utf8");
    for (const mark of SWITCH_MARKS) expect(hours, mark).not.toContain(mark);
    const elsewhere = pages
      .filter((p) => !p.endsWith(join("admin", "coordinator-booking", "page.tsx")))
      .filter((p) => SWITCH_MARKS.some((m) => readFileSync(p, "utf8").includes(m)));
    expect(elsewhere).toEqual([]);
  });

  it("is imported by nothing but this page", () => {
    const importers = all.filter(
      (p) => !p.endsWith("PlaceholderBookingSwitch.tsx") && readFileSync(p, "utf8").includes("components/admin/PlaceholderBookingSwitch"),
    );
    expect(importers.map((p) => p.slice(SRC.length + 1))).toEqual(["app/admin/coordinator-booking/page.tsx"]);
  });

  it("is drawn above the list of coordinators, in the one card", async () => {
    await renderPage();
    const section = screen.getByRole("heading", { level: 2 }).closest("section")!;
    const heading = within(section).getByRole("heading", { level: 3, name: COPY.switch.heading });
    const table = within(section).getByRole("table");
    expect(heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.nextElementSibling?.textContent).toBe(COPY.switch.rule);
  });
});

describe("the switch's three states", () => {
  it("off: says only that, and turning it on is a danger button that asks first, in place", async () => {
    const u = userEvent.setup();
    await renderPage();
    const box = switchBox();
    expect(box.textContent).toContain(COPY.switch.off);
    expect(box.textContent).not.toContain(COPY.switch.on);
    const buttons = within(box).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([COPY.switch.turnOn]);
    expect(buttons[0]!.className).toBe(btnDangerCls);
    await u.click(buttons[0]!);
    expect(actions.setPlaceholderBookingEnabled).not.toHaveBeenCalled();
    const ask = within(box).getByRole("alert");
    expect(ask.querySelector("p")?.textContent).toBe(COPY.switch.confirmOn);
    const asked = within(ask).getAllByRole("button");
    expect(asked.map((b) => b.textContent)).toEqual([COPY.switch.turnOn, "Cancel"]);
    expect(asked[0]!.className).toBe(btnDangerCls);
    expect(asked[1]!.className).toBe(btnSecondaryCls);
    expect(document.activeElement).toBe(asked[0]);
    expect((box.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("true");
  });

  it("on: says only that, and turning it off is one press on the main button", async () => {
    settings.readPlaceholderBookingEnabled.mockResolvedValue(true);
    await renderPage();
    const box = switchBox();
    expect(box.textContent).toContain(COPY.switch.on);
    expect(box.textContent).not.toContain(COPY.switch.off);
    const buttons = within(box).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([COPY.switch.turnOff]);
    expect(buttons[0]!.className).toBe(btnCls);
    expect(buttons[0]!.getAttribute("type")).toBe("submit");
    expect(within(box).queryByRole("alert")).toBeNull();
    expect((box.querySelector('input[name="on"]') as HTMLInputElement).value).toBe("false");
  });

  it("unreadable: says so by name and offers no control, rather than drawing either answer", async () => {
    settings.readPlaceholderBookingEnabled.mockResolvedValue(null);
    await renderPage();
    const box = switchBox();
    expect(box.textContent).toContain("Could not read whether coordinators can book a call nobody is free for.");
    expect(box.textContent).not.toContain(COPY.switch.off);
    expect(box.textContent).not.toContain(COPY.switch.on);
    expect(within(box).queryAllByRole("button")).toEqual([]);
  });
});

describe("the coordinators", () => {
  const section = () => screen.getByRole("heading", { level: 2 }).closest("section")!;

  it("lists every coordinator in the order read, alphabetical, with email and last sign in", async () => {
    await renderPage();
    const table = within(section()).getByRole("table");
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Coordinator", "Last signed in", "Remove"]);
    const rows = [...table.querySelectorAll("tbody tr")];
    const cell = (r: Element, sel: string, i: number) => r.querySelectorAll(sel)[i]?.textContent;
    expect(rows.map((r) => [cell(r, "td p", 0), cell(r, "td p", 1), cell(r, "td", 1)])).toEqual([
      ["Aisha Bello", "abello@trypennie.com", "2 hours ago"],
      ["Grace Okafor", "gokafor@trypennie.com", "yesterday"],
      ["Tomas Rivera", "trivera@trypennie.com", "38 days ago"],
    ]);
    const removes = within(table).getAllByRole("button");
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Aisha Bello", "Remove Grace Okafor", "Remove Tomas Rivera"]);
    // Red: a removal cannot be undone, since Team access turns away anyone who has left (D11).
    for (const b of removes) expect(b.className).toBe(btnDangerCls);
  });

  it("says nobody has access yet, with no table, when there is nobody", async () => {
    coordinators.loadCoordinators.mockResolvedValue({ ok: true, rows: [] });
    await renderPage();
    expect(within(section()).queryByRole("table")).toBeNull();
    expect(section().textContent).toContain(COPY.list.empty);
  });

  it("says the read failed, and that nobody's access changed, never an empty list", async () => {
    coordinators.loadCoordinators.mockResolvedValue({ ok: false });
    await renderPage();
    expect(within(section()).queryByRole("table")).toBeNull();
    expect(section().textContent).not.toContain(COPY.list.empty);
    const alert = within(section()).getAllByRole("alert").find((a) => !a.querySelector("button"))!;
    expect(alert.textContent).toBe(`${COPY.list.failed}${COPY.list.failedMeanwhile}`);
  });

  it("asks before removing, under the person, naming them and what stays", async () => {
    const u = userEvent.setup();
    await renderPage();
    await u.click(screen.getByRole("button", { name: "Remove Aisha Bello" }));
    expect(actions.removeCoordinator).not.toHaveBeenCalled();
    const table = within(section()).getByRole("table");
    const aisha = [...table.querySelectorAll("tbody tr")][0]!;
    expect(aisha.querySelector("button")).toBeNull();
    const ask = aisha.nextElementSibling!.querySelector('[role="alert"]')!;
    expect(ask.querySelector("p")?.textContent).toBe(
      "Aisha Bello will no longer be able to sign in to Slate or book calls. This can't be undone. The calls Aisha has already booked stay as they are.",
    );
    const buttons = within(ask as HTMLElement).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Remove Aisha Bello", "Cancel"]);
    expect(buttons[0]!.className).toContain("pn-btn--danger");
    expect(document.activeElement).toBe(buttons[0]);
    // Who to remove is the confirm's own name and value, so only that press can name them.
    expect([buttons[0]!.getAttribute("name"), buttons[0]!.getAttribute("value")]).toEqual(["user_id", "c1"]);
    // Backing out puts the row's Remove back and focus on it.
    await u.click(buttons[1]!);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Aisha Bello" }));
    expect(within(section()).queryAllByRole("alert")).toEqual([]);
  });
});

describe("what a save says", () => {
  it("names which way the switch went, on this page", async () => {
    await renderPage({ ok: "placeholder-on" });
    expect(document.body.textContent).toContain("From the next booking, a coordinator can put a call nobody is free for on Marcia.");
  });

  it("says what Remove did", async () => {
    await renderPage({ ok: "coordinator-removed" });
    expect(document.body.textContent).toContain("They can no longer sign in to Slate or book calls");
  });

  it("draws a refusal as text", async () => {
    await renderPage({ error: "That person is not a coordinator here, so nothing was changed." });
    expect(document.body.textContent).toContain("That person is not a coordinator here, so nothing was changed.");
  });
});

describe("the design's frames (?frame=)", () => {
  it("are never served from a deployment: the real reads answer instead", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "slate.trypennie.app";
    await renderPage({ frame: "f-on" });
    expect(settings.readPlaceholderBookingEnabled).toHaveBeenCalled();
    expect(screen.queryByText("Marco Delgado")).toBeNull();
  });

  it("draw the fixture on this machine behind the flag, after the role gate", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "localhost:3000";
    await renderPage({ frame: "f-remove" });
    expect(settings.readPlaceholderBookingEnabled).not.toHaveBeenCalled();
    expect(coordinators.loadCoordinators).not.toHaveBeenCalled();
    expect(screen.getByText("Marco Delgado")).toBeTruthy();
    expect(screen.getAllByRole("alert")[0]!.textContent).toContain("Aisha Bello will no longer be able to sign in");
    // Drawn open without taking focus, as a page on arrival never should.
    expect(document.activeElement).toBe(document.body);

    auth.currentUser.mockResolvedValue(user("admin"));
    expect(await fails(renderPage({ frame: "f-off" }))).toBe("NEXT_NOT_FOUND");
  });
});

// #4380: when the coordinator page offers a live transfer, and to which line. A super admin sets
// both here, beside the coordinators' other setting; an unreadable read says so and offers no
// form, rather than drawing the defaults as though they were stored.
describe("the live transfer settings (#4380)", () => {
  const box = () => screen.getByRole("heading", { level: 3, name: "Live transfer" }).parentElement!;

  it("draws the stored threshold and line in a form that saves through the action", async () => {
    settings.readTransferOfferSettings.mockResolvedValue({ threshold: 5, line: "212-555-0100" });
    await renderPage();
    expect(settings.readTransferOfferSettings).toHaveBeenCalledTimes(1);
    const b = box();
    expect((within(b).getByLabelText("Advisors free before a transfer is offered") as HTMLInputElement).value).toBe("5");
    expect((within(b).getByLabelText("Transfer line") as HTMLInputElement).value).toBe("212-555-0100");
    expect(within(b).getByRole("button", { name: "Save live transfer" })).toBeTruthy();
  });

  it("unreadable: says so and offers no form, never the defaults", async () => {
    settings.readTransferOfferSettings.mockResolvedValue(null);
    await renderPage();
    const b = box();
    expect(b.textContent).toContain("Could not read the live transfer settings.");
    expect(within(b).queryByRole("textbox")).toBeNull();
    expect(within(b).queryAllByRole("button")).toEqual([]);
  });

  it("is read by nobody but a super admin", async () => {
    auth.currentUser.mockResolvedValue(user("admin"));
    expect(await fails(renderPage())).toBe("NEXT_NOT_FOUND");
    expect(settings.readTransferOfferSettings).not.toHaveBeenCalled();
  });
});
