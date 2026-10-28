// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReminderEmailStatus } from "@/components/admin/reminder-emails/ReminderEmailStatus";
import type { ReminderEmailStatusCounts, ReminderStatusReading } from "@/lib/booking/reminder-status";

// #4300: each reminder email's row on /admin/reminder-emails says what it sent, failed
// and skipped in the last 24 hours. A positive line only after a measured read; a read
// that failed is an error, never a row of zeros.

const counts = (over: Partial<ReminderEmailStatusCounts> = {}): ReminderEmailStatusCounts => ({
  sent: 0,
  failed: 0,
  skipped: 0,
  skippedByReason: {},
  legacyClaimed: 0,
  lastSentAtIso: null,
  undated: 0,
  ...over,
});
const read = (byEmail: Record<string, ReminderEmailStatusCounts>): ReminderStatusReading => ({ status: "read", atMs: 0, byEmail });

describe("ReminderEmailStatus", () => {
  it("says what a healthy email sent, as a plain line, after a measured read", () => {
    render(<ReminderEmailStatus reading={read({ e1: counts({ sent: 41, lastSentAtIso: "2026-10-27T18:14:00.000Z" }) })} emailId="e1" />);
    expect(screen.getByText("41 sent in the last 24 hours, none failed.")).toBeTruthy();
    expect(screen.getByText("Last sent Oct 27, 2:14 PM ET.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leads with a failure, in words as well as colour", () => {
    render(<ReminderEmailStatus reading={read({ e1: counts({ sent: 3, failed: 2 }) })} emailId="e1" />);
    const line = screen.getByText("2 failed and 3 sent in the last 24 hours.");
    expect(line.className).toContain("text-error");
  });

  it("shows an error, never zeros, when the read failed", () => {
    render(<ReminderEmailStatus reading={{ status: "unreadable", error: "boom" }} emailId="e1" />);
    expect(screen.getByRole("alert").textContent).toMatch(/not the same as none/i);
    expect(screen.queryByText(/None sent/)).toBeNull();
    expect(screen.queryByText(/sent in the last 24 hours/)).toBeNull();
  });

  it("treats an email the read did not answer as unread, not as zero", () => {
    render(<ReminderEmailStatus reading={read({})} emailId="e1" />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
