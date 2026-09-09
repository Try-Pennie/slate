// @vitest-environment jsdom
//
// #2160: the two controls that decide how a time is WRITTEN (the timezone and
// the 12h / 24h format) are one group and sit above the day strip.
//
// They were split apart and below it: the toggle right aligned on one line, the
// timezone left aligned on the next, with the day strip above both. So the
// reader chose a day, then met two settings that change how the times they were
// about to read are spelled, and the two never read as belonging to each other.
//
// The assertions are about DOCUMENT ORDER and shared ancestry rather than class
// names, because those are the two things the reader actually perceives: what
// comes first, and what looks like one group.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import { RESCHEDULE_REASONS } from "@/lib/booking/core";

const slotIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  horizonDays: 4,
};

const dayChip = () =>
  screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });

/** True when `a` comes before `b` in the rendered document. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => availability,
  })) as unknown as typeof fetch;
});

describe("Booker display controls (#2160)", () => {
  it("puts the timezone and the clock format on one line, above the day strip", async () => {
    render(<Booker {...baseProps} />);

    const strip = await dayChip();
    const zone = screen.getByLabelText("Timezone");
    const twelve = screen.getByRole("button", { name: "12h" });
    const twentyFour = screen.getByRole("button", { name: "24h" });

    // 1. One group: the two controls share a row of their own, and that row does
    //    not also contain the day strip (which would make "one line" meaningless).
    const row = twelve.closest("[data-display-controls]");
    expect(row).not.toBeNull();
    expect(row!.contains(zone)).toBe(true);
    expect(row!.contains(twentyFour)).toBe(true);
    expect(row!.contains(strip)).toBe(false);

    // 2. Settled before the reader starts choosing.
    expect(precedes(row!, strip)).toBe(true);
  });

  it("shows each control exactly once, so neither reads as two settings", async () => {
    render(<Booker {...baseProps} />);
    await dayChip();

    expect(screen.getAllByRole("button", { name: "12h" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "24h" })).toHaveLength(1);
    expect(screen.getAllByLabelText("Timezone")).toHaveLength(1);
  });

  it("still changes how the times are written", async () => {
    render(<Booker {...baseProps} />);
    await userEvent.click(await dayChip());

    // A 12 hour clock carries am or pm; a 24 hour clock never does.
    const twelveHour = await screen.findByRole("button", { name: /:\d{2}\s*(am|pm)/i });
    expect(twelveHour).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /:\d{2}\s*(am|pm)/i })).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /^\d{2}:\d{2}$/ })).toBeTruthy();
  });

  it("hides the display controls once a time is chosen, since nothing is being read then", async () => {
    render(<Booker {...baseProps} />);
    await userEvent.click(await dayChip());
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "12h" })).toBeNull();
    expect(screen.queryByLabelText("Timezone")).toBeNull();
  });
});
