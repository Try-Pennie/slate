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

// #2310: the booker and the manage page offer a time only inside the lead's
// calling window, judged in the DEVICE zone. These fixtures' times are ordinary
// Eastern daytime, so which are offered would otherwise depend on the machine
// running the suite. Pinned here, never inherited (L504).
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
// #2754: the booker's error boundary reads the query and reports what it caught.
// Neither the Booker nor the manage page imports any of these three, so the stubs
// reach only the boundary.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/lib/errors/report-boundary", () => ({ reportBoundaryCatch: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { act, fireEvent, render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import ManageBooking from "@/components/ManageBooking";
import ManageNotFound from "@/components/ManageNotFound";
import { AgentLinkUnavailable } from "@/components/AgentLinkUnavailable";
import BookError from "@/app/book/error";
import BookingError from "@/app/booking/[id]/error";
import { boundaryReference } from "@/lib/errors/boundary-copy";
import { formatSlotTime } from "@/lib/booking/slot-label";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import {
  ADD_TO_CALENDAR_COPY,
  AGENT_LINK_COPY,
  confirmedAdvisor,
  CONFIRMED_COPY,
  DETAILS_COPY,
  chosenWhen,
  confirmedWhen,
  longDayLabel,
  NEAREST_TIMES_COPY,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  allTimesTaken,
  closedUntil,
  MOVE_COPY,
  movedContactNote,
  TEST_MODE_COPY,
  BOOKER_BOUNDARY_COPY,
} from "@/lib/booking/booker-copy";
import {
  BEFORE_COPY,
  CANCEL_COPY,
  LIVE_COPY,
  NOT_FOUND_COPY,
  PHONE_COPY,
  RESCHEDULE_COPY,
  advisorWillCall,
  movedNote,
  phoneSaved,
} from "@/lib/booking/manage-copy";
import { bookerSlotIso } from "@/components/booker-test-slot";

const ZONE = "America/New_York";

// 15:00 in ZONE two days out, never `setHours` on a machine Date (#2310).
const slotIso = bookerSlotIso(2, 15, ZONE);

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
  cancelReasons: CANCEL_REASONS,
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

    // #2204 deleted the contact disclosure that used to be asserted here, and
    // this assertion went with it rather than being adjusted to point somewhere
    // else (L252). What replaces it is the rest of this test: the step's own
    // words, which is what that sentence was restating.

    // #2361: the step says what it is for, and states the chosen time in full.
    // The heading is asserted as a HEADING rather than as text, because the fault
    // it fixes was a step with no heading at all.
    expect(screen.getByRole("heading", { name: DETAILS_COPY.heading })).toBeTruthy();
    expect(screen.getByTestId("chosen-time").textContent).toBe(
      chosenWhen(longDayLabel(slotIso, ZONE, { year: true }), formatSlotTime(slotIso, ZONE)),
    );

    // #2362: the name is asked in two fields, in the builder's words, and the
    // preview's labels are the ones actually on screen.
    for (const label of Object.values(DETAILS_COPY.fields)) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  // #2364: the terminal screen for a link that resolved to nothing. Its words used
  // to live inline in the component, so the preview could not show them and nobody
  // read the one instruction on it until a lead followed it to an inbox with no
  // such email in it.
  // #2660: the test line is drawn on EVERY screen the booker can show, in the
  // treatment reserved for it, and on none of them when the booking is real.
  // Three screens are driven here: the picker, the confirmation, and the panel
  // for a lead who already has a call. A band on one screen and not the next is
  // the fault L678 names: the screen without it reads as nothing to warn about.
  it("draws the test line on the picker, the confirmation and the existing call panel, only in test mode", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ startsAt: slotIso, manageUrl: "https://slate.example/manage/tok1", isTest: true }),
      } as Response;
    }) as unknown as typeof fetch;

    const { unmount } = render(<Booker {...bookerProps} isTest />);
    await act(async () => {});
    expect(screen.getAllByTestId("test-mode-band")).toHaveLength(1);
    expect(pageText()).toContain(TEST_MODE_COPY.line);

    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    expect(screen.getAllByTestId("test-mode-band")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Pat" } });
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Tester" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pat@agency.example" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));
    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(screen.getAllByTestId("test-mode-band")).toHaveLength(1);
    expect(pageText()).toContain(TEST_MODE_COPY.line);
    unmount();

    // The existing call panel, reached on landing.
    render(
      <Booker
        {...bookerProps}
        isTest
        landingCall={{
          disclose: true,
          startsAt: slotIso,
          advisorName: null,
          manageToken: "tok-existing",
          rescheduleTimesFrom: "pool",
          mayCancel: true,
          phone: "(215) 555-0100",
        }}
      />,
    );
    await act(async () => {});
    expect(screen.getAllByTestId("test-mode-band")).toHaveLength(1);
    expect(pageText()).toContain(TEST_MODE_COPY.line);
  });

  it("draws no test line at all on a real booking", async () => {
    global.fetch = okFetch();
    render(<Booker {...bookerProps} />);
    await act(async () => {});
    expect(screen.queryByTestId("test-mode-band")).toBeNull();
    expect(pageText()).not.toContain(TEST_MODE_COPY.line);
  });

  it("uses the builder's words on the booking-not-found screen", () => {
    render(<ManageNotFound theme="light" />);
    for (const line of [NOT_FOUND_COPY.heading, NOT_FOUND_COPY.causes, NOT_FOUND_COPY.recovery]) {
      expect(pageText()).toContain(line);
    }
  });

  it("uses the builder's words on a refused advisor link, and offers the way on (#2831)", () => {
    render(<AgentLinkUnavailable href="/book?xbc=411" />);
    expect(pageText()).toContain(AGENT_LINK_COPY.unavailable);
    const link = screen.getByRole("link", { name: AGENT_LINK_COPY.bookAnother });
    expect(link.getAttribute("href")).toBe("/book?xbc=411");
    // A design system control, never the browser's default link.
    expect(link.className).toContain("pn-btn");
    expect(link.className).toContain("pn-btn--primary");
  });

  it.each([
    ["/book", BookError],
    ["/booking/[id]", BookingError],
  ] as const)("uses the builder's lead words when the booker cannot load, on %s (#2754)", (_route, Boundary) => {
    render(<Boundary error={Object.assign(new Error("boom"), { digest: "d1g3st" })} retry={() => {}} />);
    for (const line of [BOOKER_BOUNDARY_COPY.heading, BOOKER_BOUNDARY_COPY.body]) {
      expect(pageText()).toContain(line);
    }
    expect(screen.getByRole("button", { name: BOOKER_BOUNDARY_COPY.retry })).toBeTruthy();
    expect(pageText()).toContain(boundaryReference("d1g3st")!);
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
        json: async () => ({
          startsAt: slotIso,
          manageUrl: "https://slate.example/manage/tok1",
          advisorName: "Aisha Bello",
          calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...bookerProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));

    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(CONFIRMED_COPY.manageLink);
    // #2165: who will call, and the add to calendar group, in the builder's words.
    expect(pageText()).toContain(confirmedAdvisor("Aisha Bello"));
    for (const words of Object.values(ADD_TO_CALENDAR_COPY)) expect(pageText()).toContain(words);
    // #2205: the when-line is the other place a lead reads a committed time back,
    // so it is asserted against the SAME builder and the SAME full date the
    // details step commits with, rather than against a copy of the words.
    expect(pageText()).toContain(
      confirmedWhen(
        longDayLabel(slotIso, ZONE, { year: true }),
        formatSlotTime(slotIso, ZONE),
        ZONE.replace(/_/g, " "),
      ),
    );
  });

  // #2164: a lead who already has a call, comes back, and types different details.
  // The booker recognises them, offers the move, and the move carries the new
  // details onto the call. What it says afterwards is the half only a mounted
  // component can prove: a static scan cannot tell whether this sentence reached a
  // customer or only the preview.
  it("uses the builder's words for what a move ALSO changed", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      if (String(url).includes("/reschedule")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            startsAt: slotIso,
            contactChanged: { name: false, email: true, phone: true },
          }),
        } as Response;
      }
      // The confirm: declined, because this person already has a call. Nothing is
      // created and the move is offered instead (#1337).
      return {
        ok: false,
        status: 409,
        json: async () => ({
          existingCall: {
            disclose: true,
            startsAt: slotIso,
            advisorName: "Sam Advisor",
            manageToken: "tok-existing",
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...bookerProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.firstName), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText(DETAILS_COPY.fields.lastName), { target: { value: "Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: DETAILS_COPY.confirm }));

    // The move panel, reached by the 409 above. A reason is mandatory before it
    // will move anything (#326).
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call/ }));

    expect(await screen.findByText(CONFIRMED_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(
      movedContactNote({ name: false, email: true, phone: true }),
    );
  });
});

describe("the preview shows what the manage page actually renders (#1343)", () => {
  const manageProps = {
    token: "tok1",
    bucketCode: "411",
    rescheduleTimesFrom: "pool" as const,
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
    calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
  };

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ slots: [] }) }) as Response,
    ) as unknown as typeof fetch;
  });

  // #2660: the manage page is the one screen a tester keeps a link to, and the
  // one a stray lead would come back to from the invite, so it carries the same
  // line the booker does, and none of it for a real booking.
  it("draws the test line on a test booking's manage page, and not on a real one", async () => {
    const { unmount } = render(<ManageBooking {...manageProps} isTest />);
    await act(async () => {});
    expect(screen.getAllByTestId("test-mode-band")).toHaveLength(1);
    expect(pageText()).toContain(TEST_MODE_COPY.line);
    unmount();

    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    expect(screen.queryByTestId("test-mode-band")).toBeNull();
    expect(pageText()).not.toContain(TEST_MODE_COPY.line);
  });

  it("uses the builder's words for the live booking", async () => {
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});

    // The number sentence is the one that must never lose its fallback, so it is
    // compared through the builder rather than as a literal.
    expect(pageText()).toContain(advisorWillCall(manageProps.attendeePhone));
    expect(pageText()).toContain(LIVE_COPY.changeYourPlans);
    // #2165: the same group the confirmation draws, in the same words.
    for (const words of Object.values(ADD_TO_CALENDAR_COPY)) expect(pageText()).toContain(words);
    expect(pageText()).toContain(BEFORE_COPY.heading);
    expect(pageText()).toContain(BEFORE_COPY.body);
    expect(screen.getByRole("button", { name: LIVE_COPY.cancel })).toBeTruthy();
  });

  // #1549: the soonest times still open, under a refused move. The preview lists two
  // hints for this one panel, and the whole point of the second is that the manage
  // page renders IT rather than the booker's. A static scan cannot tell which one a
  // component reaches for, so this is the half that can.
  it("uses the builder's move wording when a move is refused, not the booking one", async () => {
    const SLOTS = [
      "2026-06-21T15:00:00.000Z",
      "2026-06-21T16:00:00.000Z",
      "2026-06-21T17:00:00.000Z",
    ];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/reschedule")) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "That time was just taken.",
            reason: "reschedule_slot_taken",
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slots: SLOTS }) } as Response;
    }) as unknown as typeof fetch;

    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    fireEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^(MON|TUE|WED|THU|FRI|SAT|SUN|TODAY)/ }))[0]);
    // A tap selects and the commit moves (#2605), so both presses are needed to
    // reach the state this reads the copy off.
    fireEvent.click((await screen.findAllByRole("button", { name: /^\d{1,2}:\d{2}/ }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /^move my call to/i }));

    await screen.findAllByTestId("nearest-time");
    expect(pageText()).toContain(NEAREST_TIMES_COPY.heading);
    expect(pageText()).toContain(NEAREST_TIMES_COPY.hintMove);
    expect(pageText()).not.toContain(NEAREST_TIMES_COPY.hint);
  });

  // #2215: what a move done on this page says for itself. It was inline in the
  // component until this change, so the preview never carried it and nobody could
  // read it before it shipped. The state is reached by actually moving the call,
  // because it is now reachable from the action and from nothing else.
  it("uses the builder's words for a move made on this page", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/reschedule")) {
        return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slots: [slotIso] }) } as Response;
    }) as unknown as typeof fetch;

    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: LIVE_COPY.reschedule }));
    fireEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^(MON|TUE|WED|THU|FRI|SAT|SUN|TODAY)/ }))[0]);
    // A tap selects and the commit moves (#2605), so both presses are needed to
    // reach the state this reads the copy off.
    fireEvent.click((await screen.findAllByRole("button", { name: /^\d{1,2}:\d{2}/ }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
    await act(async () => {});

    expect(await screen.findByText(RESCHEDULE_COPY.moved)).toBeTruthy();
    expect(pageText()).toContain(movedNote(manageProps.attendeeEmail));
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

  // #1341: the phone correction. A static scan cannot mount React, so without
  // this the component could go back to holding its own inline sentence while the
  // preview rendered happily from the builder, showing text that no longer ships.
  it("uses the builder's words when correcting the number", async () => {
    render(<ManageBooking {...manageProps} />);
    await act(async () => {});

    const trigger = screen.getByRole("button", { name: PHONE_COPY.trigger });
    fireEvent.click(trigger);

    expect(await screen.findByLabelText(PHONE_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(PHONE_COPY.hint);
    expect(screen.getByRole("button", { name: PHONE_COPY.save })).toBeTruthy();
    expect(screen.getByRole("button", { name: PHONE_COPY.cancel })).toBeTruthy();
  });

  // The failure path, because a save that did not commit must never leave the new
  // number on screen looking accepted (L12). The server's own sentence is what a
  // lead reads, so a generic fallback here would flatten "we cannot call that
  // number" into "invalid" and they would try the same number again.
  it("keeps the old number on screen and shows the server's reason when a save fails", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/phone")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "We can only call US numbers." }),
        } as Response;
      }
      return { ok: true, json: async () => ({ slots: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    const field = await screen.findByLabelText(PHONE_COPY.heading);
    fireEvent.change(field, { target: { value: "2155559999" } });
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.save }));
    await act(async () => {});

    expect((await screen.findByRole("alert")).textContent).toContain("We can only call US numbers.");
    // Still open, and still saying the number we actually hold.
    expect(screen.getByLabelText(PHONE_COPY.heading)).toBeTruthy();
    expect(pageText()).toContain(advisorWillCall(manageProps.attendeePhone));
  });

  it("formats the number as STORED for reading, in the sentence and the edit field (#2616)", async () => {
    // Essentially every booking stores this shape, so it is the one to render.
    render(<ManageBooking {...manageProps} attendeePhone="+16317937858" />);
    await act(async () => {});

    expect(pageText()).toContain("Your advisor will call you at (631) 793-7858.");
    expect(pageText()).not.toContain("+16317937858");
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    const field = (await screen.findByLabelText(PHONE_COPY.heading)) as HTMLInputElement;
    expect(field.value).toBe("(631) 793-7858");
  });

  it("shows the STORED number after a save that committed", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/phone")) {
        // The server formats it; the page must render what came BACK, not what
        // was typed, or the two disagree the moment formatting differs.
        return { ok: true, json: async () => ({ phone: "(215) 555-9999" }) } as Response;
      }
      return { ok: true, json: async () => ({ slots: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<ManageBooking {...manageProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    fireEvent.change(await screen.findByLabelText(PHONE_COPY.heading), {
      target: { value: "2155559999" },
    });
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.save }));
    await act(async () => {});

    expect(pageText()).toContain(advisorWillCall("(215) 555-9999"));
    expect(pageText()).toContain(phoneSaved("(215) 555-9999"));
    expect(pageText()).not.toContain(advisorWillCall(manageProps.attendeePhone));
  });
});
