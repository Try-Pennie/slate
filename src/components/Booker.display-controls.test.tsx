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
    const zone = screen.getByRole("combobox", { name: "Timezone" });
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
    expect(screen.getAllByRole("combobox", { name: "Timezone" })).toHaveLength(1);
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

  it("keeps the display controls usable on the details step, where the day strip is still live", async () => {
    render(<Booker {...baseProps} />);
    await userEvent.click(await dayChip());
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    await screen.findByLabelText("Name");

    // The strip above them stays clickable on this step (a day chip takes the
    // lead back to that day's times), so a row that vanished while the control
    // under it stayed put would read as a layout fault rather than a boundary.
    expect(await dayChip()).toBeTruthy();
    expect(screen.getByRole("button", { name: "12h" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Timezone" })).toBeTruthy();
  });

  it("changes only the spelling: switching zone on the details step books the same instant", async () => {
    let posted: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      posted = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await userEvent.click(await dayChip());
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByLabelText("Name");

    const before = screen.getByTestId("chosen-time").textContent;

    // A zone the fixture is never in, so the displayed time has to move. The
    // rows exist only while the picker is open, so open it first.
    await userEvent.click(screen.getByRole("combobox", { name: "Timezone" }));
    await userEvent.click(await screen.findByRole("option", { name: /Pacific/i }));
    await waitFor(() => {
      expect(screen.getByTestId("chosen-time").textContent).not.toBe(before);
    });

    await userEvent.type(screen.getByLabelText("Name"), "Dana Lead");
    await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
    await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
    await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    // The instant the lead picked, unchanged: only its spelling moved.
    expect(posted!.start).toBe(slotIso);
    // And the zone they switched to IS recorded, because that is the zone they
    // read the time in and it is what the confirmation and the invite quote back.
    expect(String(posted!.timezone)).toMatch(/Los_Angeles|Pacific/i);
  });

  it("reformats the CHOSEN time on the details step, not only the list behind it", async () => {
    render(<Booker {...baseProps} />);
    await userEvent.click(await dayChip());
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    // The details step carries its own summary of the time that was picked. If
    // the toggle reformatted the list and not this line, the two halves of the
    // screen would disagree about what is being booked.
    const summary = await screen.findByTestId("chosen-time");
    expect(summary.textContent).toMatch(/\d{1,2}:\d{2}\s*(am|pm)/i);

    await userEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => {
      expect(screen.getByTestId("chosen-time").textContent).toMatch(/\d{2}:\d{2}/);
    });
    expect(screen.getByTestId("chosen-time").textContent).not.toMatch(/am|pm/i);
  });
});
