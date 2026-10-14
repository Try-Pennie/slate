// @vitest-environment jsdom
//
// #3718: the inline card, the booker drawn inside a landing page by cal.com's
// `Cal("inline")` (widget.js asks for `layout=inline`). The settled design is
// docs/design/inline-booker.html. What this pins:
//  - the card's own title and panel label, from the copy file, and none of the
//    full booker's side panel (the event name, the Pennie mark);
//  - the first bookable day is chosen for the lead, so times show at once;
//  - six times, then View more times;
//  - the ordinary booker is untouched when no layout is asked for.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { INLINE_CARD_COPY, PICKER_COPY } from "@/lib/booking/booker-copy";

const firstDay = Array.from({ length: 9 }, (_, i) => bookerSlotIso(3, 9 + i));
const secondDay = [bookerSlotIso(4, 10), bookerSlotIso(4, 11)];

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
  embedded: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      bucket: { code: "411" },
      orgName: "Pennie",
      eventType: { name: "Advisor Call", description: null, durationMin: 30 },
      slots: [...firstDay, ...secondDay],
    }),
  })) as unknown as typeof fetch;
});

const timeButtons = () =>
  screen.queryAllByRole("button").filter((b) => /^\d{1,2}:\d{2}\s?(am|pm)$/i.test((b.textContent ?? "").trim()));

describe("the inline card (#3718)", () => {
  it("draws the card's title and panel label, and none of the full booker's side panel", async () => {
    render(<Booker {...baseProps} layout="inline" />);
    expect(await screen.findByText(INLINE_CARD_COPY.title)).toBeTruthy();
    expect(screen.getByText(INLINE_CARD_COPY.chooseTime)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Advisor Call" })).toBeNull();
    expect(document.querySelector("[data-org-mark]")).toBeNull();
  });

  it("opens on the first bookable day, showing six of its times and a way to the rest", async () => {
    render(<Booker {...baseProps} layout="inline" />);
    await screen.findByRole("button", { name: PICKER_COPY.viewMore });
    expect(timeButtons()).toHaveLength(6);
    // The chosen day chip already names the day, so no "Times on" line repeats it (L605).
    expect(screen.queryByText(/^Times on /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: PICKER_COPY.viewMore }));
    expect(timeButtons()).toHaveLength(9);
  });

  it("leaves the ordinary booker as it was when no layout is asked for", async () => {
    render(<Booker {...baseProps} />);
    expect(await screen.findByRole("heading", { name: "Advisor Call" })).toBeTruthy();
    expect(screen.queryByText(INLINE_CARD_COPY.title)).toBeNull();
    // No day is chosen for the lead on the ordinary booker.
    expect(await screen.findByText(PICKER_COPY.pickADay, { selector: "span.block" })).toBeTruthy();
  });
});
