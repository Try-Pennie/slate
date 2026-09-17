// @vitest-environment jsdom
//
// #2163: the confirmation screen's one branded moment.
//
// Dan, 2026-09-09, seeing the graphic that was there: "what the hell is this
// image?" It was a scatter of blank iridescent discs, which says money rather
// than "your call is booked", and it is the LAST thing a lead sees.
//
// Pennie already has the right asset and it is the one the live cal.com
// confirmation shows today: an iridescent coin with a tick struck into it, as a
// 2.1 second animation and as a still. Both are vendored into public/brand.
//
// What is asserted here is everything about it that fails SILENTLY. A video that
// autoplays with sound, one that loops forever on a resting screen, one that
// plays for somebody who asked their system for less motion, and one that shows
// an empty box where a browser cannot decode it, all look fine in review and in
// any test that only checks the element is present.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

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
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

/** Answer `prefers-reduced-motion` the way a browser would. jsdom has no media
 *  query engine at all, so without this every query returns false and the
 *  reduced-motion branch is simply never reachable, which reads as a pass. */
function withReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce && q.includes("prefers-reduced-motion"),
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

async function book() {
  await userEvent.click(
    await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
  await userEvent.type(screen.getByLabelText("First name"), "Dana");
  await userEvent.type(screen.getByLabelText("Last name"), "Lead");
  await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
  await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
  return screen.findByText("You're all set");
}

beforeEach(() => {
  vi.clearAllMocks();
  withReducedMotion(false);
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/availability")) {
      return { ok: true, json: async () => availability } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
  }) as unknown as typeof fetch;
});

describe("confirmation mark (#2163)", () => {
  it("plays the check mark once, silently, and holds its last frame", async () => {
    render(<Booker {...baseProps} />);
    await book();

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe(CONFIRMATION_MARK.video);

    // Autoplay is refused without muted in every browser, and a confirmation
    // screen that makes noise is worse than one with no animation at all.
    expect(video.muted || video.hasAttribute("muted")).toBe(true);
    // A resting screen, so it plays once and stays on the check mark.
    expect(video.hasAttribute("loop")).toBe(false);
    expect(video.hasAttribute("autoplay")).toBe(true);
    // iOS refuses to play inline without this and takes over the whole screen.
    expect(video.hasAttribute("playsinline")).toBe(true);
  });

  it("shows the still where the video cannot be decoded, rather than an empty box", async () => {
    render(<Booker {...baseProps} />);
    await book();

    const video = document.querySelector("video") as HTMLVideoElement;
    // Headless Chromium cannot decode H.264 AT ALL (canPlayType returns ""), and
    // it is not alone. A poster means those viewers get the same picture, still.
    expect(video.getAttribute("poster")).toBe(CONFIRMATION_MARK.still);
  });

  it("shows the still, and no video, for a lead who asked for less motion", async () => {
    withReducedMotion(true);
    render(<Booker {...baseProps} />);
    await book();

    // The CSS guard in globals.css reaches animation-duration and
    // transition-duration, which a playing video is neither of, so this branch is
    // the only thing standing between that lead and a full speed animation.
    expect(document.querySelector("video")).toBeNull();
    const still = document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`);
    expect(still).not.toBeNull();
  });

  it("gives way to the still coin when it ends, rather than resting on its own last frame", async () => {
    render(<Booker {...baseProps} />);
    await book();

    const video = document.querySelector("video") as HTMLVideoElement;
    // The animation resolves to a small pale flat tick, which is a weak thing to
    // leave on screen and is a DIFFERENT picture from the one a reduced motion
    // lead sees. Every lead ends up looking at the same mark.
    expect(video.getAttribute("data-ended")).toBe("false");

    // The still is already underneath, which is what makes this a reveal rather
    // than a swap, and is why nothing can flash empty in between.
    const still = document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`);
    expect(still).not.toBeNull();

    fireEvent.ended(video);
    expect(video.getAttribute("data-ended")).toBe("true");
    expect(video.className).toContain("opacity-0");
  });

  it("is decorative in the accessibility tree, because the words carry the news", async () => {
    render(<Booker {...baseProps} />);
    await book();

    const marks = Array.from(document.querySelectorAll("video, img[src*='checkmark']"));
    expect(marks.length).toBeGreaterThan(0);
    // The heading, the recap and the live region already say a booking was made.
    // A described graphic here would make a screen reader say it twice, and BOTH
    // layers are in the tree at once, so both have to be silent.
    for (const mark of marks) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("names one size for the mark, so the embed's height does not jump as it loads", async () => {
    render(<Booker {...baseProps} />);
    await book();

    const video = document.querySelector("video") as HTMLVideoElement;
    // The host sizes the iframe from the Booker's own resize message, so an
    // element that arrives with no intrinsic size and then gets one posts two
    // different heights and the frame visibly jumps.
    expect(video.getAttribute("width")).toBe(String(CONFIRMATION_MARK.size));
    expect(video.getAttribute("height")).toBe(String(CONFIRMATION_MARK.size));
  });
});
