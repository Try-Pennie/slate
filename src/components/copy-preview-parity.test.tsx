// @vitest-environment jsdom
//
// The preview and the shipped screen must resolve the SAME string (#1343).
//
// `pnpm preview:booker` is only worth reading because it calls the real copy
// builders and holds no wording of its own (L41). `scripts/test-booker-preview-coverage.ts`
// checks that statically: no literal is assigned to a `text` in the preview. But a
// static scan cannot mount React, so it cannot see the other half of the same
// promise: that the COMPONENT calls those builders too.
//
// Both halves are needed, and each is blind where the other looks. If a component
// went back to holding its own inline sentence, the preview would still render
// happily from the builder, would still pass every static check, and would be
// showing text that no longer ships. That is worse than having no preview, because
// it would be believed.
//
// So this mounts the real components in representative states and asserts the
// builder's exact output is on screen. It deliberately asserts against the BUILDER
// rather than against a copy of the words: a test carrying its own literal would
// have to be edited alongside every wording change, which is the same drift one
// level out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import {
  CONFIRMED_COPY,
  DETAILS_COPY,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  allTimesTaken,
  closedUntil,
} from "@/lib/booking/booker-copy";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  LIVE_COPY,
  advisorWillCall,
} from "@/lib/booking/manage-copy";

const ZONE = "America/New_York";

const slotIso = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(15, 0, 0, 0);
  return d.toISOString();
})();

const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};

const bookerProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  horizonDays: 4,
};

const okFetch = () =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => availability }) as Response) as unknown as typeof fetch;

/** The whole page's text, so an assertion cannot pass on a hidden duplicate. */
const pageText = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the preview shows what the booker actually renders (#1343)", () => {
  it("uses the builder's words for the pick-a-day and details states", async () => {
    global.fetch = okFetch();
    render(<Booker {...bookerProps} />);
    await act(async () => {});

    // Days are offered and none is chosen: THE state the picker exists to hold.
    expect(pageText()).toContain(PICKER_COPY.pickADay);

    // The details step only exists once a time is chosen, so reach it before
    // asserting its words rather than asserting them on the wrong screen.
    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    expect(screen.getByRole("button", { name: DETAILS_COPY.confirm })).toBeTruthy();
  });

  it("uses the builder's words for the closed state and the search button", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability/next")) {
        return { ok: true, status: 200, json: async () => ({ slots: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          ...availability,
          slots: [],
          emptyBecause: { kind: "closed", reopensOn: "2026-08-17" },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...bookerProps} />);
    // The date is formatted by the builder, in the viewer's zone, so comparing
    // against the builder is also what stops the day sliding by one here.
    expect(await screen.findByText(closedUntil("2026-08-17", ZONE))).toBeTruthy();
    expect(screen.getByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeTruthy();
  });

  it("uses the builder's words for every-time-taken, which is a different cause", async () => {
    // Stated as busy: an UNSTATED cause is its own screen with its own sentence
    // (#1414), so this fixture has to say which week it means.
    global.fetch = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
      }) as Response,
    ) as unknown as typeof fetch;

    render(<Booker {...bookerProps} />);
    expect(await screen.findByText(allTimesTaken())).toBeTruthy();
  });

  it("uses the builder's words on the confirmation", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ startsAt: slotIso, manageUrl: "https://slate.example/manage/tok1" }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...bookerProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));

    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(CONFIRMED_COPY.manageLink);
  });
});

describe("the preview shows what the manage page actually renders (#1343)", () => {
  const manageProps = {
    token: "tok1",
    bucketCode: "411",
    startsAt: slotIso,
    status: "confirmed",
    eventName: "Debt consultation",
    rescheduleReasons: RESCHEDULE_REASONS,
    cancelReasons: CANCEL_REASONS,
    theme: "light" as const,
    durationMin: 20,
    attendeePhone: "(215) 555-0100",
    attendeeEmail: "dana@example.com",
    advisorName: "Aisha Bello",
    advisorRole: "Senior Loan Advisor",
  };

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ slots: [] }) }) as Response,
    ) as unknown as typeof fetch;
  });

  it("uses the builder's words for the live booking", async () => {
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});

    // The number sentence is the one that must never lose its fallback, so it is
    // compared through the builder rather than as a literal.
    expect(pageText()).toContain(advisorWillCall(manageProps.attendeePhone));
    expect(pageText()).toContain(LIVE_COPY.changeYourPlans);
    expect(pageText()).toContain(BEFORE_COPY.heading);
    expect(pageText()).toContain(BEFORE_COPY.body);
    expect(screen.getByRole("button", { name: LIVE_COPY.cancel })).toBeTruthy();
  });

  it("uses the builder's words when confirming a cancel", async () => {
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: LIVE_COPY.cancel }));

    expect(await screen.findByText(CANCEL_COPY.heading)).toBeTruthy();
    // The sentence stating what it costs is the one a lead reads before an
    // irreversible action, so it is the one worth pinning hardest.
    expect(pageText()).toContain(CANCEL_COPY.consequence);
    expect(screen.getByRole("button", { name: CANCEL_COPY.keep })).toBeTruthy();
  });
});
