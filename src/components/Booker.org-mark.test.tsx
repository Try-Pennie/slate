// @vitest-environment jsdom
//
// #2629: the booker's header slot shows the Pennie logo mark, not "PE".
//
// The slot was the first build's stand in for the team logo cal.com draws there,
// filled with the first two letters of the organisation name. A lead has no way to
// know what "PE" means. Dan, 2026-09-22: the logo mark, not removing the slot.
//
// The mark is drawn in the text colour, so the one element follows whichever theme
// the booker (or the page embedding it) set. Its path is held against the app icon,
// which is the same mark, so the two cannot drift apart unnoticed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";

const slotIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

function serve(orgName: string) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      bucket: { code: "411" },
      orgName,
      eventType: { name: "Advisor Call", description: null, durationMin: 30 },
      slots: [slotIso],
    }),
  })) as unknown as typeof fetch;
}

const iconPath = readFileSync("src/app/icon.svg", "utf8").match(/ d="([^"]+)"/)![1];

beforeEach(() => vi.clearAllMocks());

describe("the booker's organisation mark (#2629)", () => {
  it("draws the Pennie mark, named for the organisation, and no initials", async () => {
    serve("Pennie");
    render(<Booker {...baseProps} />);

    const mark = await screen.findByRole("img", { name: "Pennie" });
    expect(mark.querySelector("path")?.getAttribute("d")).toBe(iconPath);
    // Drawn in the text colour, so it follows the booker's theme.
    expect(mark.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(screen.queryByText("PE")).toBeNull();
  });

  it("stays out of the accessibility tree when the organisation name did not load", async () => {
    // An unreadable name must not become an image called "" (L577): the mark is
    // still drawn, and a screen reader skips it rather than announcing nothing.
    serve("");
    render(<Booker {...baseProps} />);
    await screen.findByRole("heading", { name: "Advisor Call" });
    expect(screen.queryByRole("img", { name: "" })).toBeNull();
    expect(document.querySelector("[data-org-mark] path")?.getAttribute("d")).toBe(iconPath);
  });
});
