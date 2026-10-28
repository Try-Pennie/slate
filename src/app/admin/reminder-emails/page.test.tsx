// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #4299: /admin/reminder-emails, who may open it and what it says when it cannot read.
//
// An unreadable list must never draw as an empty one: "no reminder emails" tells an
// admin leads get nothing before their call, and the obvious correction is adding an
// email that already exists (L10).
const auth = vi.hoisted(() => ({ currentUser: vi.fn(), getImpersonation: vi.fn(async () => null) }));
const db = vi.hoisted(() => ({
  emails: { data: [] as unknown[] | null, error: null as null | { message: string; code?: string } },
  versions: { data: [] as unknown[], error: null as null | { message: string } },
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/env", () => ({ consoleHiddenFor: () => false, googleHostedDomain: () => "trypennie.com" }));
vi.mock("@/app/admin/reminder-emails/actions", () => ({
  saveReminderEmail: vi.fn(),
  restoreReminderEmailVersion: vi.fn(),
  sendReminderEmailTest: vi.fn(),
}));
// #4300: the status read has its own suite (scripts/test-reminder-status.ts); here only
// what the page does with a reading, measured or not.
const statusRead = vi.hoisted(() => ({
  reading: { status: "read", atMs: 0, byEmail: {} } as unknown,
  calls: [] as string[][],
}));
vi.mock("@/lib/booking/reminder-status-store", () => ({
  loadReminderEmailStatus: async (_db: unknown, ids: string[]) => {
    statusRead.calls.push(ids);
    return statusRead.reading;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        then: (resolve: (v: unknown) => unknown) => {
          if (table === "reminder_emails") return Promise.resolve(db.emails).then(resolve);
          if (table === "reminder_email_versions")
            return Promise.resolve({ ...db.versions, count: db.versions.data.length }).then(resolve);
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return q;
    },
  }),
}));

import ReminderEmailsPage from "./page";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";

const EMAIL = {
  id: "e1",
  slug: "day",
  name: "24 hour reminder",
  minutes_before: 1440,
  late_booking: "send_now",
  enabled: true,
  subject: "Your Pennie call {when}",
  body: "Hi, {call with} is {when}.\n\n{signature}",
  card_block: true,
  placeholder_sends: true,
  updated_at: "2026-10-27T10:00:00Z",
};

async function draw(sp: Record<string, string> = {}) {
  render(await ReminderEmailsPage({ searchParams: Promise.resolve(sp) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.emails = { data: [EMAIL], error: null };
  db.versions = { data: [], error: null };
  auth.getImpersonation.mockResolvedValue(null);
  statusRead.calls = [];
  statusRead.reading = {
    status: "read",
    atMs: 0,
    byEmail: {
      e1: { sent: 41, failed: 0, skipped: 0, skippedByReason: {}, legacyClaimed: 0, lastSentAtIso: null, undated: 0 },
    },
  };
});

describe("/admin/reminder-emails", () => {
  it("says the emails could not be read, and never that there are none", async () => {
    auth.currentUser.mockResolvedValue({ id: "a1", role: "admin", org_id: "o1", email: "dana@trypennie.com" });
    db.emails = { data: null, error: { message: "boom" } };
    await draw();
    expect(screen.getByRole("alert").textContent).toBe(REMINDER_COPY.unreadable);
    expect(screen.queryByText(REMINDER_COPY.noEmails)).toBeNull();
    expect(screen.queryByText(REMINDER_COPY.addEmail)).toBeNull();
  });

  it("refuses an agent", async () => {
    auth.currentUser.mockResolvedValue({ id: "g1", role: "agent", org_id: "o1", email: "g@trypennie.com" });
    await draw();
    expect(screen.getByText(/You need a manager or admin account/)).toBeTruthy();
  });

  it("shows a manager the emails read only", async () => {
    auth.currentUser.mockResolvedValue({ id: "m1", role: "manager", org_id: "o1", email: "m@trypennie.com" });
    await draw();
    expect(screen.getByRole("link", { name: "24 hour reminder" })).toBeTruthy();
    expect(screen.getByText(REMINDER_COPY.readOnly)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(REMINDER_COPY.addEmail)).toBeNull();
  });

  it("gives an admin the editor, and the way to add one", async () => {
    auth.currentUser.mockResolvedValue({ id: "a1", role: "admin", org_id: "o1", email: "dana@trypennie.com" });
    await draw();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("24 hour reminder");
    expect(screen.getByText(REMINDER_COPY.addEmail)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send me a test" })).toBeTruthy();
  });

  it("is read only for an admin viewing as someone else", async () => {
    auth.currentUser.mockResolvedValue({ id: "a2", role: "admin", org_id: "o1", email: "viewed@trypennie.com" });
    auth.getImpersonation.mockResolvedValue({ real: { id: "s1" }, target: { id: "a2" } } as never);
    await draw();
    expect(screen.getAllByText(REMINDER_COPY.viewingAs).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send me a test" })).toBeNull();
  });

  it("shows each email's last 24 hours in its own last column", async () => {
    auth.currentUser.mockResolvedValue({ id: "m1", role: "manager", org_id: "o1", email: "m@trypennie.com" });
    await draw();
    expect(statusRead.calls).toEqual([["e1"]]);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.at(-1)).toBe("Last 24 hours");
    const row = screen.getByRole("link", { name: "24 hour reminder" }).closest("tr")!;
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(headers.length);
    expect(cells[cells.length - 1]!.textContent).toContain("41 sent in the last 24 hours, none failed.");
    // The name's cell holds the name alone (and the open marker for a screen reader).
    expect(cells[0]!.textContent).toBe("24 hour reminder (open below)");
  });

  it("shows the could not read notice in the status cell, never zeros, when the read failed", async () => {
    auth.currentUser.mockResolvedValue({ id: "m1", role: "manager", org_id: "o1", email: "m@trypennie.com" });
    statusRead.reading = { status: "unreadable", error: "boom" };
    await draw();
    const row = screen.getByRole("link", { name: "24 hour reminder" }).closest("tr")!;
    const last = row.querySelectorAll("td")[row.querySelectorAll("td").length - 1]!;
    expect(last.querySelector('[role="alert"]')?.textContent).toMatch(/not the same as none/i);
    expect(last.textContent).not.toMatch(/sent in the last 24 hours/);
  });

  it("says the history could not be read, rather than showing none", async () => {
    auth.currentUser.mockResolvedValue({ id: "a1", role: "admin", org_id: "o1", email: "dana@trypennie.com" });
    db.versions = { data: [], error: { message: "boom" } };
    await draw();
    expect(screen.getByText(REMINDER_COPY.historyUnreadable)).toBeTruthy();
  });
});
