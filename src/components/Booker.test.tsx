// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BOOKING_ERROR_COPY, NEAREST_TIMES_COPY } from "@/lib/booking/booker-copy";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import {
  EXTENSION_PHONE_PREFILL_NOTICE,
  INCOMPLETE_PHONE_NOTICE,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  MOVE_COPY,
  BOOKER_CANCEL_COPY,
  US_ONLY_PHONE_NOTICE,
  allTimesTaken,
  closedNoReopenDate,
  BOOKER_PHONE_COPY,
  DUPLICATE_COPY,
  DETAILS_COPY,
  longDayLabel,
} from "@/lib/booking/booker-copy";
import { PHONE_COPY, advisorWillCall } from "@/lib/booking/manage-copy";
import { DateTime } from "luxon";
import { bookerSlotIso } from "@/components/booker-test-slot";
import { messageLines } from "@/lib/booking/slot-picker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";
import { EMBED_MESSAGE, LINK_FAILED } from "@/lib/embed/lifecycle-events";

// The confirmation mark's dotLottie player, stood down for this file (#2560).
// It is a wasm runtime: jsdom has no IntersectionObserver for it to observe with
// and no server to fetch the wasm from, so every test reaching the confirmation
// screen paid several seconds to boot a player that can never draw and then
// threw out of a passive effect. What the player itself does is covered by
// src/components/confirmation-mark.test.tsx, and what it looks like is covered in
// a real browser; this file is about the booker.
vi.mock("@/components/ConfirmationMarkPlayer", () => ({
  ConfirmationMarkPlayer: () => null,
}));

// The early load of that player (#2636), watched rather than run: the mark itself
// stays real, and what the early load fetches is covered beside the mark.
const preload = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/components/ConfirmationMark", async (original) => ({
  ...(await original<typeof import("@/components/ConfirmationMark")>()),
  preloadConfirmationMark: () => {
    preload.calls += 1;
  },
}));

// #625: the confirm POST must not freeze the button in "Booking your call…" if
// the request rejects at the network layer (flaky mobile). It surfaces an error
// and re-enables so the lead can retry.
// #626: a confirm that HANGS (server accepted, never responds) must show a
// distinct "still working" state at ~10s, then convert to a retryable error at
// the 20s timeout; and a success that finds the lead already has another active
// booking must warn them on the confirmation screen.

// A fixed daytime hour in the booker's zone, never "now + 3 days" at whatever
// time the suite runs: the lead's calling window (#2310) hides anything else.
const slotIso = bookerSlotIso(3);

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
  // #1337: the Move offered to a lead who already has a call records a mandatory
  // reschedule reason, so the live option set is a prop. Coded defaults keep the
  // reason-label assertions valid.
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  // The suite's fixtures assume a 4-day window (see the horizon comments below).
  horizonDays: 4,
};

/** The strip's day chips read "TODAY 13 AUG" / "FRI 14 AUG": digits, but never a
 *  clock face, so the /:\d{2}/ query below still matches only times. */
const dayChip = () => screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });

/** #1336: no time renders until a day is chosen, on every surface. Every flow
 *  that reaches a time therefore goes through the strip first. */
async function pickFirstDay() {
  await userEvent.click(await dayChip());
}

async function fillAndConfirm() {
  await pickFirstDay();
  const slot = await screen.findByRole("button", { name: /:\d{2}/ });
  await userEvent.click(slot);
  // #2362: two fields, joined on submit, so the payload still carries "Dana Lead".
  await userEvent.type(screen.getByLabelText("First name"), "Dana");
  await userEvent.type(screen.getByLabelText("Last name"), "Lead");
  await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
  await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
}

beforeEach(() => vi.clearAllMocks());

describe("Booker confirm", () => {
  it("starts loading the confirmation animation once a time is picked, not before (#2636)", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    preload.calls = 0;

    render(<Booker {...baseProps} />);
    await pickFirstDay();
    // A lead only looking at days never books, so they are not charged for it.
    expect(preload.calls).toBe(0);

    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    // Picked a time: the details form is a few seconds of typing, which is the
    // head start the animation needs to be ready on the confirmation screen.
    expect(preload.calls).toBeGreaterThan(0);
  });

  it("surfaces an error and re-enables Confirm when the booking POST rejects at the network layer", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      // POST /booking
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm booking/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByText("You're all set")).toBeNull();
  });

  it("sends the honeypot field empty on a real submission, and never surfaces it to the user (#1033)", async () => {
    let postedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      postedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    // The decoy is hidden from the accessibility tree, so it never appears as a
    // labelled field a real user could find and fill.
    expect(screen.queryByLabelText("Website")).toBeNull();
    await fillAndConfirm();

    expect(await screen.findByText("You're all set")).toBeTruthy();
    expect(postedBody).not.toBeNull();
    // A real submission carries the honeypot key, left blank.
    expect(postedBody!.website).toBe("");
  });

  it("enters the confirmed state on a successful booking", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You're all set")).toBeTruthy();
  });

  it("moves from the first moment, says 'still working' at 10s, and becomes a retryable error at the timeout", async () => {
    vi.useFakeTimers();
    // Availability resolves; the POST only settles when its AbortSignal fires —
    // a wedged request the 20s timeout must convert into an error.
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) {
        return Promise.resolve({ ok: true, json: async () => availability } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await act(async () => {}); // settle the availability load

    fireEvent.click(screen.getByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ }));
    fireEvent.click(screen.getByRole("button", { name: /:\d{2}/ }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
    await act(async () => { await Promise.resolve(); }); // submit starts, watchdog arms

    // The three states a time taking action has to keep apart, in order. STARTED
    // is the one this shipped without: the label swapped and nothing moved for a
    // full ten seconds, so a lead could not tell a request in flight from one
    // that had died (Dan, 2026-09-22: "the loading felt stuck after I submitted
    // my time. it wasn't stuck, it worked, but it didn't feel like it was
    // moving"). Asserted on the real booker rather than only on the button,
    // because the button cannot show a cue the call site never asks it for
    // (L718).
    expect(document.querySelector("[data-bob-dots]")).not.toBeNull();
    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    // Still alive is IN ADDITION to working, not instead of it.
    expect(document.querySelector("[data-bob-dots]")).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); // trip 20s abort
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm booking/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    // And FAILED stops claiming to be working, or the error and the cue would
    // contradict each other on the same screen.
    expect(document.querySelector("[data-bob-dots]")).toBeNull();
    vi.useRealTimers();
  });

  it("warns on the confirmation screen when the lead already has another active booking", async () => {
    const otherIso = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startsAt: slotIso,
          duplicateWarning: {
            disclose: true,
            startsAt: otherIso,
            manageUrl: "https://slate.test/booking/manage/tok-old",
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You're all set")).toBeTruthy();
    expect(screen.getByText(/already have (a|another) call booked/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /view or cancel/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://slate.test/booking/manage/tok-old");
  });

  // #1340: a weak (one-signal) identity match may be a housemate on a shared
  // phone or a couple on one email. The lead is still told they have another
  // call, so a genuine duplicate is not hidden, but NOTHING about that booking
  // reaches the screen: no time, and above all no manage link, since the manage
  // token can reschedule or cancel it.
  it("names no time and offers no manage link when the match is too weak to disclose (#1340)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startsAt: slotIso,
          manageUrl: "https://slate.test/booking/manage/tok-new",
          duplicateWarning: { disclose: false },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You're all set")).toBeTruthy();
    // The heads-up itself still shows.
    expect(screen.getByText(/already have another call booked/i)).toBeTruthy();
    // But it points at the invitation they already hold, not at the other booking
    // (#2364: it named a confirmation email Pennie never sends).
    expect(screen.getByText(DUPLICATE_COPY.checkYourEmail)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /view or cancel/i })).toBeNull();
    // No link anywhere on the screen points at another booking's manage token.
    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h?.includes("/booking/manage/"))).toEqual([
      // Only the lead's OWN new booking may be linked.
      "https://slate.test/booking/manage/tok-new",
    ]);
    expect(screen.queryByText(/It.s set for/i)).toBeNull();
  });

  // #637: the embed is the primary lead surface, but its confirmation used to
  // show only a 64px check badge while the standalone page got the branded
  // graphic. The design system calls for one branded delight moment on success,
  // so both surfaces render the SAME mark. That decision stands; #2163 only
  // changed which asset it is, so this asserts sameness rather than a filename.
  it("shows the same branded mark on the embedded confirmation as the standalone page (#637)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startsAt: slotIso,
          manageUrl: "https://slate.test/booking/manage/tok-new",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} embedded parentOrigin="https://host.test" />);
    await fillAndConfirm();

    await screen.findByText("You're all set");
    // Every viewer ends on the still coin: after the animation settles, or once
    // the hold runs out (#2636), or at once under reduced motion. The player is
    // stood down in this file and never paints, so this is the hold running out.
    // What #637 forbids is the embed being fobbed off with something smaller
    // than the standalone page shows.
    await waitFor(
      () => expect(document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`)).not.toBeNull(),
      { timeout: CONFIRMATION_MARK.holdMs + 1000 },
    );
  });

  // #637: the confirmation offered no way back to the booking. It now links to
  // the manage page (returned as manageUrl by POST /booking), opening in a new
  // tab so an embed lead does not navigate the iframe away from the confirmation.
  it("links to the manage page on a successful confirmation (#637)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startsAt: slotIso,
          manageUrl: "https://slate.test/booking/manage/tok-new",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    await screen.findByText("You're all set");
    const link = screen.getByRole("link", { name: /manage/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://slate.test/booking/manage/tok-new");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  // #585 / AUD-067: the empty-window copy used to say "No availability this
  // month. Try another month." while the next-month arrow is disabled (and the
  // real horizon is only ~4 days, so "month" is misleading). It now gives an
  // honest next step and never points at a disabled control.
  it("shows honest empty-window copy that doesn't point at a disabled control (#585)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        // A staffed week that is simply full, stated as such: an UNSTATED cause is
        // its own screen now (#1414), and this test is about the busy one.
        return {
          ok: true,
          json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    // Both the visible copy and the polite SR announcement carry the honest text.
    const empty = await screen.findAllByText(/all times are taken|check back/i);
    expect(empty.length).toBeGreaterThan(0);
    expect(screen.queryByText(/another month/i)).toBeNull();
  });

  // #633: a screen-reader lead selecting a day heard nothing when the skeletons
  // swapped for slots. The times panel now carries a polite role=status that
  // names the count (or the empty message) once the load settles.
  it("announces the available time count via role=status once slots load (#633)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    // Before a day is chosen the region asks for one; after, it names the count.
    expect((await screen.findByRole("status")).textContent).toMatch(/pick a day/i);
    await pickFirstDay();
    expect(screen.getByRole("status").textContent).toMatch(/1 time available on/i);
  });

  // #632: the attendee step used sr-only labels + a placeholder as the only
  // visible identification, which vanished once a value was typed. Each field
  // now has a persistent visible label and no longer leans on the placeholder.
  it("shows a persistent visible label for each attendee field (#632)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    for (const fieldName of ["First name", "Last name", "Email", "Phone"]) {
      const input = screen.getByLabelText(fieldName) as HTMLInputElement;
      const label = document.querySelector(`label[for="${input.id}"]`);
      expect(label).not.toBeNull();
      // Visible, not sr-only, so the field's purpose persists after typing.
      expect(label!.className).not.toMatch(/sr-only/);
      // The placeholder is no longer the sole (or a redundant) label.
      expect(input.getAttribute("placeholder")).toBeNull();
    }
  });
});

// #1337: a lead who already has an active call is DECLINED at confirm, before
// anything is created, and offered the choice of moving the call they have into
// the slot they just picked.
describe("Booker refuses a second booking (#1337)", () => {
  const existingIso = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();

  /** /api/availability succeeds; the confirm is declined with `existingCall`. */
  function declineWith(existingCall: unknown, reschedule?: { ok: boolean; status: number; body?: unknown }) {
    return vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      if (u.includes("/reschedule")) {
        return {
          ok: reschedule?.ok ?? true,
          status: reschedule?.status ?? 200,
          json: async () => reschedule?.body ?? { startsAt: slotIso },
        } as Response;
      }
      return { ok: false, status: 409, json: async () => ({ existingCall }) } as Response;
    }) as unknown as typeof fetch;
  }

  // #2166: on a link that IDENTIFIES the lead, the notice comes first. The id in
  // the path is the same strong match the confirm recognises them by, so waiting
  // for a picked time and a filled form put it one whole flow too late and read as
  // the product having forgotten them.
  it("puts the call they already have in front of them before they pick a time", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{
          disclose: true,
          startsAt: existingIso,
          advisorName: "Aisha Bello",
          manageToken: "tok-old",
          mayCancel: true,
          phone: null,
        }}
      />,
    );
    expect(await screen.findByText("You already have a call booked")).toBeTruthy();
    expect(screen.getByText(/with Aisha Bello\./)).toBeTruthy();
    // No time has been picked, so there is no move to offer and no reason to ask
    // for. Offering either would be a control that cannot work (L109).
    expect(screen.queryByRole("button", { name: /^Move my call/ })).toBeNull();
    expect(screen.queryByText(MOVE_COPY.reasonLegend)).toBeNull();
  });

  it("lets them carry on to the picker, which is what they came for", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    expect(screen.queryByText("You already have a call booked")).toBeNull();
    expect(await dayChip()).toBeTruthy();
  });

  it("shows the ordinary picker when nothing identifies the lead", async () => {
    // THE CONTROL. Without it, a version that showed the panel to everybody would
    // satisfy both cases above while stopping every anonymous lead from booking at
    // all (L1).
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(<Booker {...baseProps} />);
    expect(await dayChip()).toBeTruthy();
    expect(screen.queryByText("You already have a call booked")).toBeNull();
  });

  // #2203: the whole point of recognising them on arrival. The details form
  // collects NOTHING on this path: the lead is already identified by the id in
  // the link, so the only thing typing name, email and phone could achieve is a
  // 409 handing back the very call the panel showed them two clicks earlier
  // (L676). Picking a time takes them straight to the move.
  it("takes a recognised lead from the picker to the move with no form in between", async () => {
    global.fetch = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
      mayCancel: true,
      phone: null,
    });
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    // The panel is back, with the time behind it, so the move is offered.
    await screen.findByText("You already have a call booked");
    expect(screen.getByText(MOVE_COPY.reasonLegend)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Move my call to/ })).toBeTruthy();
    // And they were never asked to identify themselves again.
    expect(screen.queryByLabelText("First name")).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Phone")).toBeNull();
  });

  it("sends no blank details with a move nobody typed details for", async () => {
    // Without this the fix ships broken in the other direction: the move posts
    // `attendee: { name: "", email: "", phone: "" }` from the untouched state, and
    // `updateBookingContact` judges every field a caller SENDS, so three "Enter
    // your ..." refusals come back and the move fails for a correction the lead
    // never asked for (#2164).
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      posted.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toContain("/api/bookings/tok-old/reschedule");
    expect(posted[0].body.start).toBeTruthy();
    expect(posted[0].body.attendee).toBeUndefined();
  });

  it("carries the details the link DID arrive with onto the move", async () => {
    // THE OTHER DIRECTION, and the reason the rule is "only what has a value"
    // rather than "never send details". A landing link routinely carries the
    // lead's name and email, which is the same correction #2164 applied when they
    // were typed into the form, so dropping them would trade one defect for another.
    const posted: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      posted.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        attendee={{ name: "Dana Lead", email: "dana@example.com", phone: "" }}
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // The two that carry a value, and only those: an empty phone is not a
    // correction to a blank number, it is somebody who typed nothing.
    expect(posted[0].attendee).toEqual({ name: "Dana Lead", email: "dana@example.com" });
  });

  it("puts a recognised lead back on their call when they keep the time they have", async () => {
    // They still HAVE a call, so the way back is the panel about it. Dropping them
    // into the anonymous picker would set up the same 409 this removes (L676).
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getByRole("button", { name: /^Keep my / }));

    expect(await screen.findByRole("button", { name: MOVE_COPY.pickAnotherTime })).toBeTruthy();
    expect(screen.queryByText(MOVE_COPY.reasonLegend)).toBeNull();
  });

  it("keeps a recognised lead recognised when the move is refused", async () => {
    // The refusal path is the one that reintroduces the defect quietly: it puts
    // them back in the picker, and putting them back ANONYMOUS means the next time
    // they choose sends them to the form to be told, by a 409, about the call they
    // never stopped having (L676).
    global.fetch = declineWith(
      { disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null },
      { ok: false, status: 409, body: { reason: "slot_taken" } },
    );
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));

    // Told what happened, back among the times, and asked for nothing.
    expect(await screen.findByRole("alert")).toBeTruthy();
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    expect(await screen.findByText(MOVE_COPY.reasonLegend)).toBeTruthy();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  // #2207: the gap #2203 left. Taking the details form off this path also took
  // away the only place a lead could correct a wrong number, which #2164 had put
  // there on purpose, so the panel could move a call and cancel a call and not
  // change what we would ring. The person that hurts is the one the cancel was
  // built for: somebody who never got the invite email, so has no manage link
  // either (L677).
  const withPhone = { disclose: true as const, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: "(203) 555-5295" };

  it("names the number the advisor will ring, in full", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(<Booker {...baseProps} salesforceId="003xx" landingCall={withPhone} />);
    await screen.findByText("You already have a call booked");

    // The SAME builder the manage page renders, because the two surfaces now say
    // the same thing and one sentence with two spellings is what a shared builder
    // exists to prevent (#2213).
    expect(screen.getByText(advisorWillCall("(203) 555-5295"))).toBeTruthy();
    // And the digits themselves are on the page, stated separately from the
    // sentence above: a builder that went back to masking would still satisfy that
    // one and fail this.
    expect(document.body.textContent).toContain("(203) 555-5295");
    expect(screen.getByRole("button", { name: PHONE_COPY.trigger })).toBeTruthy();
  });

  it("corrects the number through the lead phone path, and reads back what was stored", async () => {
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      posted.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      // The STORED number, formatted as Slate formats it, not what was typed.
      return { ok: true, status: 200, json: async () => ({ phone: "(215) 555-0100" }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} salesforceId="003xx" landingCall={withPhone} />);
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    await userEvent.type(screen.getByLabelText(PHONE_COPY.label), "2155550100");
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.save }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // The same endpoint the manage page uses, so one correction path carries the
    // audit trail and the stale invite alert rather than two (L41).
    expect(posted[0].url).toContain("/api/bookings/tok-old/phone");
    expect(posted[0].body.phone).toBe("(215) 555-0100");
    // Read back on the screen they are standing on, as the SERVER stored it: the
    // line renders what Slate holds, never the keystrokes and never a rewriting of
    // them (#2213).
    expect(await screen.findByText(advisorWillCall("(215) 555-0100"))).toBeTruthy();
    expect(document.body.textContent).toContain("(215) 555-0100");
  });

  it("does not leave a refused number looking saved", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: false, status: 400, json: async () => ({ error: "Enter a number we can call." }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} salesforceId="003xx" landingCall={withPhone} />);
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    await userEvent.type(screen.getByLabelText(PHONE_COPY.label), "2155550100");
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.save }));

    // The server's own sentence, because "a number we cannot call" and "this link
    // is unknown" send the reader somewhere different (L11).
    expect(await screen.findByText("Enter a number we can call.")).toBeTruthy();
    // And the call still names the number it actually holds.
    expect(screen.queryByText(advisorWillCall("(215) 555-0100"))).toBeNull();
  });

  // #2210: two routes write the same field and only one of them knew about the
  // correction. The panel saves a number through the phone endpoint; the move
  // sends `attendee` built from the link's prefill, which `updateBookingContact`
  // applies before the move. So the stale number wins and the lead is told their
  // save worked, which it did, and then it is undone by the next thing they do
  // (L443: a field another writer owns must never be savable from a surface
  // holding an older copy).
  function moveWorld() {
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      posted.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      if (u.includes("/phone")) {
        return { ok: true, status: 200, json: async () => ({ phone: "(215) 555-0100" }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;
    return posted;
  }

  async function moveAfter(correct: boolean) {
    await screen.findByText("You already have a call booked");
    if (correct) {
      fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
      await userEvent.type(screen.getByLabelText(PHONE_COPY.label), "2155550100");
      fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.save }));
      await screen.findByText(advisorWillCall("(215) 555-0100"));
    }
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));
  }

  it("does not let the move write the link's number over one just corrected", async () => {
    const posted = moveWorld();
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        attendee={{ name: "Dana Lead", email: "dana@example.com", phone: "2035551111" }}
        landingCall={withPhone}
      />,
    );
    await moveAfter(true);

    await waitFor(() => expect(posted.filter((p) => p.url.includes("/reschedule"))).toHaveLength(1));
    const move = posted.find((p) => p.url.includes("/reschedule"))!;
    const sent = move.body.attendee as Record<string, string> | undefined;
    // The number they corrected stands. Nothing about it is sent again, so
    // nothing can write over it.
    expect(sent?.phone).toBeUndefined();
    // And the fields the panel offers no correction for still travel, so this is
    // a rule about the number rather than about the payload.
    expect(sent?.name).toBe("Dana Lead");
    expect(sent?.email).toBe("dana@example.com");
  });

  it("still carries the link's number when nothing was corrected", async () => {
    // THE CONTROL. Without it, a fix that simply stopped sending the number would
    // pass the test above while dropping the correction the link itself carries,
    // which is the #2164 case (L1).
    const posted = moveWorld();
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        attendee={{ name: "Dana Lead", email: "dana@example.com", phone: "2035551111" }}
        landingCall={withPhone}
      />,
    );
    await moveAfter(false);

    await waitFor(() => expect(posted.filter((p) => p.url.includes("/reschedule"))).toHaveLength(1));
    const move = posted.find((p) => p.url.includes("/reschedule"))!;
    expect((move.body.attendee as Record<string, string>).phone).toBe("(203) 555-1111");
  });

  it("keeps exactly one primary action on the panel while the number is being corrected", async () => {
    // Found by looking at it at a real window rather than by any test (L606):
    // with the field open the panel drew TWO sky filled buttons, "Save this
    // number" and "Pick another time", each claiming to be the thing to press.
    // Sky is the only action colour in the design system, so two fills on one
    // screen say nothing about which action is the one in hand.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(<Booker {...baseProps} salesforceId="003xx" landingCall={withPhone} />);
    await screen.findByText("You already have a call booked");

    // At rest the panel's own action is the primary one.
    expect(screen.getAllByTestId("panel-primary")).toHaveLength(1);
    expect(screen.getByTestId("panel-primary").textContent).toContain(MOVE_COPY.pickAnotherTime);

    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.trigger }));
    const primary = screen.getAllByTestId("panel-primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toContain(PHONE_COPY.save);

    // And it goes back when the sub task is dropped, rather than leaving the panel
    // with no emphasised action at all.
    fireEvent.click(screen.getByRole("button", { name: PHONE_COPY.cancel }));
    expect(screen.getAllByTestId("panel-primary")).toHaveLength(1);
    expect(screen.getByTestId("panel-primary").textContent).toContain(MOVE_COPY.pickAnotherTime);
  });

  it("says so when the call carries no number at all, and still offers to add one", async () => {
    // Not the same screen as a number that might be wrong. A booking with nobody
    // to ring cannot happen through the booker, but it can arrive through the API
    // and through an import, and saying nothing would leave the lead waiting for a
    // call that can never be placed.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(
      <Booker {...baseProps} salesforceId="003xx" landingCall={{ ...withPhone, phone: null }} />,
    );
    await screen.findByText("You already have a call booked");

    expect(screen.getByText(BOOKER_PHONE_COPY.noNumber)).toBeTruthy();
    expect(screen.getByRole("button", { name: BOOKER_PHONE_COPY.addTrigger })).toBeTruthy();
    expect(screen.queryByRole("button", { name: PHONE_COPY.trigger })).toBeNull();
  });

  it("still asks an UNrecognised lead for their details", async () => {
    // THE CONTROL. The form is where an anonymous lead's identity comes from, so a
    // version that removed it for everybody would satisfy every test above while
    // making the product unbookable by anyone the link does not name (L1).
    global.fetch = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
      mayCancel: true,
      phone: null,
    });
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    expect(screen.getByLabelText("First name")).toBeTruthy();
    expect(screen.getByLabelText("Last name")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Phone")).toBeTruthy();
    expect(screen.queryByText("You already have a call booked")).toBeNull();
  });

  // #2167: the exit. Cancel lived only on the manage link inside the calendar
  // invite, so a lead who lost that email, or never received it (the pilot
  // booking's went to an address they do not read), had NO way to cancel from
  // Slate at all. The panel that recognises them is the one place the product
  // knows exactly who they are, and it was the one place it withheld this.
  it("cancels the call they already have, through the lead cancel path", async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");

    // The control OPENS the question. Nothing is destroyed by pressing it.
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.start }));
    expect(calls).toHaveLength(0);
    expect(screen.getByText(BOOKER_CANCEL_COPY.heading)).toBeTruthy();
    // The specific consequence, naming the call being given up, not "this cannot
    // be undone" about no call in particular.
    expect(document.body.textContent).toContain("This gives up your call on");

    // A reason is mandatory, exactly as it is on the manage page (#326), and
    // since #2605 the refusal is said rather than expressed as a dead button.
    const confirm = screen.getByRole("button", { name: BOOKER_CANCEL_COPY.confirm });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(screen.getByText("Please choose a reason.")).toBeTruthy();
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.confirm }));

    await screen.findByText(BOOKER_CANCEL_COPY.doneHeading);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/bookings/tok-old/cancel");
    expect((calls[0].body as { reason?: string }).reason).toBeTruthy();
  });

  it("keeps the call when they back out of the confirmation", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      calls.push(u);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.start }));
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.keep }));
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime })).toBeTruthy();
  });

  it("says so when the cancel does not land, and leaves the call alone", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: false, status: 500, json: async () => ({ error: "Could not cancel" }) } as Response;
    }) as unknown as typeof fetch;

    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.start }));
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.confirm }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // NOT the cancelled screen: a refusal must never read as the call being gone.
    expect(screen.queryByText(BOOKER_CANCEL_COPY.doneHeading)).toBeNull();
  });

  it("does not offer the cancel on a match that only names the call", async () => {
    // THE CONTROL, and the rule #1340 exists for. A medium match is an email AND a
    // phone both matching, which is enough to name the call and to move it into a
    // time this same person just picked. Cancelling is the one action here that
    // destroys something and puts nothing in its place, so it is the id tiers only.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: existingIso, advisorName: null, manageToken: "tok-old", mayCancel: false, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    expect(screen.queryByRole("button", { name: BOOKER_CANCEL_COPY.start })).toBeNull();
    expect(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime })).toBeTruthy();
  });

  it("names the existing call and offers to move it, creating nothing", async () => {
    global.fetch = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
      mayCancel: true,
      phone: null,
    });
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You already have a call booked")).toBeTruthy();
    expect(screen.getByText(/with Aisha Bello\./)).toBeTruthy();
    // Not the success screen: nothing was created.
    expect(screen.queryByText("You're all set")).toBeNull();
    // No policy voice: the rule is never explained back to the lead.
    expect(document.body.textContent).not.toMatch(/one call per (person|lead)/i);
    expect(document.body.textContent).not.toMatch(/we have not booked/i);
  });

  it("asks for a reason before the Move is allowed, then moves the existing call", async () => {
    const fetchMock = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
      mayCancel: true,
      phone: null,
    });
    global.fetch = fetchMock;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");

    // REVERSED DELIBERATELY (#2605). The reason is still mandatory and nothing is
    // sent without one; the refusal is now SPOKEN by the control the lead pressed
    // rather than expressed by switching that control off, which is the one thing
    // that could have explained it (L109).
    const move = () => screen.getByRole("button", { name: /^move my call/i }) as HTMLButtonElement;
    expect(move().disabled).toBe(false);

    await userEvent.click(move());
    expect(await screen.findByText("Please choose a reason.")).toBeTruthy();
    expect(
      (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
        String(u).includes("/reschedule"),
      ),
    ).toBe(false);

    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await userEvent.click(move());

    // The move goes through the lead reschedule endpoint the emailed manage link
    // uses, carrying the chosen reason, so the audit trail matches.
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).includes("/reschedule"),
    );
    expect(String(call![0])).toContain("/api/bookings/tok-old/reschedule");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
      start: slotIso,
      reason: "schedule_conflict",
    });
    expect(await screen.findByText("You're all set")).toBeTruthy();
  });

  it("keeps the existing call and returns to the picker on Keep my time", async () => {
    global.fetch = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
      mayCancel: true,
      phone: null,
    });
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");

    await userEvent.click(screen.getByRole("button", { name: /^keep my /i }));
    // Back in the picker with no day chosen, and nothing was moved.
    expect(await dayChip()).toBeTruthy();
    expect(screen.queryByText("You already have a call booked")).toBeNull();
  });

  // The failure path #1337 requires: nobody holds the slot during the decision,
  // so it can be taken. The lead must be told and returned to the picker, never
  // left with neither call moved nor a new one booked.
  it("tells the lead and returns them to the picker when the slot goes before the Move", async () => {
    global.fetch = declineWith(
      { disclose: true, startsAt: existingIso, advisorName: "Aisha Bello", manageToken: "tok-old", mayCancel: true, phone: null },
      { ok: false, status: 409, body: { error: "That time is no longer available." } },
    );
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");

    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await userEvent.click(screen.getByRole("button", { name: /^move my call/i }));

    // Asserted through the BUILDER, not a copied literal. A literal here is a second copy of
    // the wording that goes stale the first time the sentence is improved, and this repo keeps
    // lead-facing strings in one place precisely so the preview shows what ships (L41).
    expect(await screen.findByText(BOOKING_ERROR_COPY.slotTaken)).toBeTruthy();
    // Not stuck on the refusal screen, and not falsely confirmed.
    expect(screen.queryByText("You already have a call booked")).toBeNull();
    expect(screen.queryByText("You're all set")).toBeNull();
    expect(await dayChip()).toBeTruthy();
  });

  // #1549: the same dead end #1319 removed from the confirm, on the OTHER refusal
  // this surface can hand a lead. They already have a call, they are trying to keep
  // it by moving it, and being told the time went with nowhere to go is the worst of
  // the three moments to leave empty.
  it("offers the soonest times still open when the slot goes before the Move", async () => {
    const other = new Date(Date.parse(slotIso) + 24 * 60 * 60 * 1000).toISOString();
    let loads = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) {
        loads += 1;
        // The reload after the refusal still carries the taken time, which is exactly
        // why the panel excludes it rather than showing the first few slots. The FIRST
        // load offers one day only, so the day strip is unambiguous while the lead is
        // still filling the form in.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...availability,
            slots: loads === 1 ? [slotIso] : [slotIso, other],
          }),
        } as Response;
      }
      if (u.includes("/reschedule")) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "That time is no longer available.",
            reason: "reschedule_slot_taken",
          }),
        } as Response;
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          existingCall: {
            disclose: true,
            startsAt: existingIso,
            advisorName: "Aisha Bello",
            manageToken: "tok-old",
            mayCancel: true,
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await userEvent.click(screen.getByRole("button", { name: /^move my call/i }));

    expect(await screen.findByText(BOOKING_ERROR_COPY.slotTaken)).toBeTruthy();
    const offered = await screen.findAllByTestId("nearest-time");
    expect(offered.map((b) => b.getAttribute("data-slot"))).toEqual([other]);
    // The move wording, not the booking one: this lead has not lost anything, and
    // telling them their DETAILS are saved answers a question they did not ask.
    expect(screen.getByText(NEAREST_TIMES_COPY.hintMove)).toBeTruthy();
    expect(screen.queryByText(NEAREST_TIMES_COPY.hint)).toBeNull();
    expect(loads).toBeGreaterThan(1);
  });

  // #1340: a weak one-signal match may be a housemate, so the call is declined
  // but nothing about it is shown and there is nothing to move from here.
  it("shows no time, no advisor and no Move on a match too weak to disclose", async () => {
    global.fetch = declineWith({ disclose: false });
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You already have a call booked")).toBeTruthy();
    expect(screen.getByText(DUPLICATE_COPY.checkYourEmail)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^move my call/i })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

// #1336: the rule the shared picker exists to hold. The booker used to derive
// its active day from the first available one, so a lead landed on a list of
// bare clock faces with a day already chosen for them. A time carries no date,
// so that let someone pick 10:00 on a day they never looked at. These two are
// the regression guards, one per layout, since each has its own day control.
describe("Booker offers no time until a day is chosen (#1336)", () => {
  const okFetch = () =>
    vi.fn(async () => ({ ok: true, json: async () => availability })) as unknown as typeof fetch;

  it("asks for a day, and renders no time, on the day-strip layout", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);

    // The strip has arrived, so the load is settled: this is not a loading state.
    await dayChip();
    expect(screen.queryAllByRole("button", { name: /:\d{2}/ })).toHaveLength(0);
    expect(
      screen.getAllByText("Pick a day above to see the times available.").length,
    ).toBeGreaterThan(0);

    await pickFirstDay();
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(1);
  });

});

describe("Booker embed postMessage origin (#593)", () => {
  // The postMessage(message, targetOrigin) call's second arg, as a plain string.
  const targetOf = (call: unknown[]) => call[1] as string;
  const availabilityOnlyFetch = () =>
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

  it("posts slate:resize to the known parent origin, never '*'", async () => {
    global.fetch = availabilityOnlyFetch();
    const postSpy = vi.spyOn(window.parent, "postMessage");

    render(<Booker {...baseProps} embedded parentOrigin="https://host.test" />);
    // Let the availability load + resize effect run.
    await dayChip();

    const resizes = postSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "slate:resize",
    );
    expect(resizes.length).toBeGreaterThan(0);
    expect(resizes.every((c) => targetOf(c) === "https://host.test")).toBe(true);
    expect(postSpy.mock.calls.some((c) => targetOf(c) === "*")).toBe(false);
    postSpy.mockRestore();
  });

  it("posts the PII-bearing slate:bookingSuccessful only to the known parent origin", async () => {
    global.fetch = availabilityOnlyFetch();
    const postSpy = vi.spyOn(window.parent, "postMessage");

    render(<Booker {...baseProps} embedded parentOrigin="https://host.test" />);
    await fillAndConfirm();
    await screen.findByText("You're all set");

    const success = postSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "slate:bookingSuccessful",
    );
    expect(success.length).toBe(1);
    expect(targetOf(success[0]!)).toBe("https://host.test");
    postSpy.mockRestore();
  });

  // #2644: the host ends a Slate booking by redirecting the whole window to its own
  // booking confirmed page on this message. A lead who MOVES the call they already
  // have experiences that as the same action, so the move must post the same
  // message, carrying the booking id the page looks the booking up by.
  const successMessages = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === "slate:bookingSuccessful");

  it("posts the fresh booking's success with its id and outcome created", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      return { ok: true, status: 200, json: async () => ({ id: "bk-new", startsAt: slotIso, manageUrl: "https://slate.test/booking/manage/t" }) } as Response;
    }) as unknown as typeof fetch;
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} embedded parentOrigin="https://host.test" />);
    await fillAndConfirm();
    await screen.findByText("You're all set");
    const [msg] = successMessages(postSpy);
    expect(msg?.[0]).toMatchObject({ data: { booking: { id: "bk-new" }, outcome: "created" } });
    postSpy.mockRestore();
  });

  function moveInEmbed(reschedule: Record<string, unknown>, embedded = true) {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      if (u.includes("/reschedule")) return { ok: true, status: 200, json: async () => reschedule } as Response;
      throw new Error(`unexpected request ${u}`);
    }) as unknown as typeof fetch;
    render(
      <Booker
        {...baseProps}
        embedded={embedded}
        parentOrigin="https://host.test"
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: slotIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
  }

  async function moveTheCall() {
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: MOVE_COPY.pickAnotherTime }));
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await screen.findByText(MOVE_COPY.reasonLegend);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Move my call to/ }));
  }

  it("posts the same success message when the lead moves the call they already have", async () => {
    const moved = {
      id: "bk-old",
      startsAt: slotIso,
      endsAt: slotIso,
      manageUrl: "https://slate.test/booking/manage/tok-old",
      calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
    };
    const postSpy = vi.spyOn(window.parent, "postMessage");
    moveInEmbed(moved);
    await moveTheCall();
    await waitFor(() => expect(successMessages(postSpy)).toHaveLength(1));
    const [msg] = successMessages(postSpy);
    expect(msg![1]).toBe("https://host.test");
    // The whole move response as `booking`, exactly as the fresh path posts its
    // confirm response, so the host reads data.booking.id either way.
    expect(msg![0]).toEqual({
      type: "slate:bookingSuccessful",
      data: { booking: moved, salesforceId: "003xx", outcome: "rescheduled" },
    });
    postSpy.mockRestore();
  });

  it("posts nothing for a move outside an embed", async () => {
    const postSpy = vi.spyOn(window.parent, "postMessage");
    moveInEmbed({ id: "bk-old", startsAt: slotIso }, false);
    await moveTheCall();
    await screen.findByText("You're all set");
    expect(successMessages(postSpy)).toHaveLength(0);
    postSpy.mockRestore();
  });

  // #2641: the browser drops a post whose target is not the real parent, with no
  // error anywhere, so a host that declares the wrong origin loses the resize and
  // the success message silently. The Booker reports the pair once per load.
  describe("a host whose declared origin is not the one that framed it (#2641)", () => {
    function withReferrer(referrer: string) {
      Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
    }
    afterEach(() => withReferrer(""));

    const reports = (spy: ReturnType<typeof vi.fn>) =>
      spy.mock.calls
        .filter((c) => String(c[0]).includes("/api/client-errors"))
        .map((c) => JSON.parse(String((c[1] as RequestInit).body)));

    it("reports the two origins once, and never the referrer's path", async () => {
      withReferrer("https://www.trypennie.com/booking/a04xx?email=k%40x.com");
      const fetchSpy = availabilityOnlyFetch() as unknown as ReturnType<typeof vi.fn>;
      global.fetch = fetchSpy as unknown as typeof fetch;
      render(<Booker {...baseProps} embedded parentOrigin="https://trypennie.com" />);
      await dayChip();
      await waitFor(() => expect(reports(fetchSpy)).toHaveLength(1));
      const [report] = reports(fetchSpy);
      expect(report).toMatchObject({
        kind: "origin_mismatch",
        message: "declared https://trypennie.com, framed by https://www.trypennie.com",
      });
      expect(JSON.stringify(report)).not.toContain("a04xx");
      expect(JSON.stringify(report)).not.toContain("email");
    });

    it("reports nothing when the host declared its own origin", async () => {
      withReferrer("https://trypennie.com/booking/a04xx");
      const fetchSpy = availabilityOnlyFetch() as unknown as ReturnType<typeof vi.fn>;
      global.fetch = fetchSpy as unknown as typeof fetch;
      render(<Booker {...baseProps} embedded parentOrigin="https://trypennie.com" />);
      await dayChip();
      expect(reports(fetchSpy)).toHaveLength(0);
    });

    it("reports nothing outside an embed", async () => {
      withReferrer("https://www.trypennie.com/");
      const fetchSpy = availabilityOnlyFetch() as unknown as ReturnType<typeof vi.fn>;
      global.fetch = fetchSpy as unknown as typeof fetch;
      render(<Booker {...baseProps} parentOrigin="https://trypennie.com" />);
      await dayChip();
      expect(reports(fetchSpy)).toHaveLength(0);
    });
  });

  it("does NOT broadcast bookingSuccessful when the parent origin is unknown", async () => {
    global.fetch = availabilityOnlyFetch();
    const postSpy = vi.spyOn(window.parent, "postMessage");

    // No parentOrigin prop and jsdom's default referrer is empty → unknown origin.
    render(<Booker {...baseProps} embedded />);
    await fillAndConfirm();
    await screen.findByText("You're all set");

    const success = postSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "slate:bookingSuccessful",
    );
    expect(success.length).toBe(0);
    expect(postSpy.mock.calls.some((c) => targetOf(c) === "*")).toBe(false);
    postSpy.mockRestore();
  });
});

// #2728: the confirm carries the ORIGIN of the page that framed the booker, so the
// off site check can judge a host that declared none. Never the referrer's path or
// query, which can carry a lead's details, and nothing at all when the booker is
// its own page, whose referrer is whatever linked to it rather than a host.
describe("Booker sends the framing page's origin with the confirm (#2728)", () => {
  function withReferrer(referrer: string) {
    Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  }
  function framed(on: boolean) {
    // jsdom's top is the window itself, which is what an unframed page reads.
    Object.defineProperty(window, "top", { value: on ? {} : window, configurable: true });
  }
  afterEach(() => {
    withReferrer("");
    framed(false);
  });

  async function confirmedBody(): Promise<Record<string, unknown>> {
    let postedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      if (String(url).includes("/api/client-errors")) return { ok: true, json: async () => ({}) } as Response;
      postedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;
    render(<Booker {...baseProps} embedded />);
    await fillAndConfirm();
    await screen.findByText("You're all set");
    expect(postedBody).not.toBeNull();
    return postedBody!;
  }

  it("sends the origin only, never the path or the query", async () => {
    framed(true);
    withReferrer("https://partner.example/test-page?email=k%40x.com&phone=2155550100");
    const body = await confirmedBody();
    expect(body.referrerOrigin).toBe("https://partner.example");
    expect(JSON.stringify(body)).not.toContain("test-page");
    expect(JSON.stringify(body)).not.toContain("k%40x.com");
  });

  it("sends nothing when the booker is not framed", async () => {
    framed(false);
    withReferrer("https://mail.google.com/mail/u/0/");
    const body = await confirmedBody();
    expect("referrerOrigin" in body).toBe(false);
  });
});

// #215 / #168 / #173: the availability panel has three states that are easy to
// break silently. A failed fetch must offer a retry (not a permanent dead end);
// a loaded-but-empty month must say so honestly; and the calendar must stop
// paging once a loaded month comes back empty (the cache-limited horizon), so a
// lead can never walk off into months that will never have slots.
// #2658: the booker lifecycle the host's GA4 funnel is built on. Each stage is a
// `slate:*` message to the known parent origin, and widget.js re-emits it under
// cal.com's name. What matters here is WHEN each is posted, that each is posted
// ONCE, and that none of them carries the lead's contact.
describe("Booker lifecycle messages (#2658)", () => {
  const HOST = "https://host.test";
  const endIso = new Date(Date.parse(slotIso) + 30 * 60 * 1000).toISOString();
  const ofType = (spy: { mock: { calls: unknown[][] } }, type: string) =>
    spy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === type);
  const slateMessages = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => String((c[0] as { type?: string })?.type ?? "").startsWith("slate:"));
  const availabilityWith = (slots: string[]) =>
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => ({ ...availability, slots }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "bk-new", startsAt: slotIso, endsAt: endIso }) } as Response;
    }) as unknown as typeof fetch;
  /** Let every pending promise and effect settle, so an absence is measured
   *  after the thing that could have produced it had its chance. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  };

  it("posts bookerViewed once, with slotsLoaded false while the times are still loading, then bookerReady once when they arrive", async () => {
    global.fetch = availabilityWith([slotIso]);
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} embedded parentOrigin={HOST} />);
    await dayChip();
    await settle();

    const viewed = ofType(postSpy, EMBED_MESSAGE.bookerViewed);
    expect(viewed).toHaveLength(1);
    expect(viewed[0]![0]).toEqual({ type: EMBED_MESSAGE.bookerViewed, data: { slotsLoaded: false } });
    expect(viewed[0]![1]).toBe(HOST);

    const ready = ofType(postSpy, EMBED_MESSAGE.bookerReady);
    expect(ready).toHaveLength(1);
    expect(ready[0]![0]).toEqual({ type: EMBED_MESSAGE.bookerReady, data: { slotsLoaded: true } });
    expect(ready[0]![1]).toBe(HOST);
    // Viewed before ready: the funnel reads them in that order.
    const firstIndexOf = (type: string) =>
      postSpy.mock.calls.findIndex((c) => (c[0] as { type?: string })?.type === type);
    expect(firstIndexOf(EMBED_MESSAGE.bookerViewed)).toBeLessThan(firstIndexOf(EMBED_MESSAGE.bookerReady));
    postSpy.mockRestore();
  });

  it("posts bookerViewed and never bookerReady when the availability holds no times, which is the empty calendar signal", async () => {
    let answered = false;
    const fetchSpy = availabilityWith([]);
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await fetchSpy(...args);
      answered = true;
      return res;
    }) as typeof fetch;
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} embedded parentOrigin={HOST} />);
    await waitFor(() => expect(answered).toBe(true));
    await settle();

    expect(ofType(postSpy, EMBED_MESSAGE.bookerViewed)).toHaveLength(1);
    expect(ofType(postSpy, EMBED_MESSAGE.bookerReady)).toHaveLength(0);
    postSpy.mockRestore();
  });

  it("posts linkFailed with availability_failed once when the times cannot be loaded, and again only when a retry fails again", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected request ${String(url)}`);
    }) as unknown as typeof fetch;
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} embedded parentOrigin={HOST} />);
    await screen.findByText("Could not load available times.");
    await settle();

    const failed = ofType(postSpy, EMBED_MESSAGE.linkFailed);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toEqual({ type: EMBED_MESSAGE.linkFailed, data: LINK_FAILED.availabilityFailed });
    expect(failed[0]![1]).toBe(HOST);
    expect(ofType(postSpy, EMBED_MESSAGE.bookerReady)).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(ofType(postSpy, EMBED_MESSAGE.linkFailed)).toHaveLength(2));
    postSpy.mockRestore();
  });

  it("posts bookingCancelled to the parent origin after a successful in embed cancel, carrying no contact", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      if (u.includes("/cancel")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, booking: { id: "bk-old", startsAt: slotIso, endsAt: endIso } }),
        } as Response;
      }
      throw new Error(`unexpected request ${u}`);
    }) as unknown as typeof fetch;
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(
      <Booker
        {...baseProps}
        embedded
        parentOrigin={HOST}
        salesforceId="003xx"
        attendee={{ name: "Dana Lead", email: "dana@example.com", phone: "+12035615295" }}
        landingCall={{ disclose: true, startsAt: slotIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: "+12035615295" }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.start }));
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.confirm }));
    await screen.findByText(BOOKER_CANCEL_COPY.doneHeading);

    const cancelled = ofType(postSpy, EMBED_MESSAGE.bookingCancelled);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]![1]).toBe(HOST);
    expect(cancelled[0]![0]).toEqual({
      type: EMBED_MESSAGE.bookingCancelled,
      data: {
        booking: { uid: "bk-old", startTime: slotIso, endTime: endIso, cancellationReason: CANCEL_REASONS[0].code },
      },
    });
    for (const call of postSpy.mock.calls) {
      const text = JSON.stringify(call[0]);
      expect(text).not.toContain("Dana");
      expect(text).not.toContain("dana@example.com");
      expect(text).not.toContain("5615295");
    }
    postSpy.mockRestore();
  });

  it("posts no bookingCancelled when the cancel does not land", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability")) return { ok: true, json: async () => availability } as Response;
      return { ok: false, status: 500, json: async () => ({ error: "Could not cancel" }) } as Response;
    }) as unknown as typeof fetch;
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(
      <Booker
        {...baseProps}
        embedded
        parentOrigin={HOST}
        salesforceId="003xx"
        landingCall={{ disclose: true, startsAt: slotIso, advisorName: null, manageToken: "tok-old", mayCancel: true, phone: null }}
      />,
    );
    await screen.findByText("You already have a call booked");
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.start }));
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: BOOKER_CANCEL_COPY.confirm }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await settle();
    expect(ofType(postSpy, EMBED_MESSAGE.bookingCancelled)).toHaveLength(0);
    postSpy.mockRestore();
  });

  it("carries the lead's name, email or phone in no message across a whole booking", async () => {
    global.fetch = availabilityWith([slotIso]);
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} embedded parentOrigin={HOST} />);
    await fillAndConfirm();
    await screen.findByText("You're all set");
    await settle();

    // The whole lifecycle happened: the control that this test measured something.
    expect(ofType(postSpy, EMBED_MESSAGE.bookerViewed)).toHaveLength(1);
    expect(ofType(postSpy, EMBED_MESSAGE.bookerReady)).toHaveLength(1);
    expect(ofType(postSpy, EMBED_MESSAGE.bookingSuccessful)).toHaveLength(1);
    expect(slateMessages(postSpy).every((c) => c[1] === HOST)).toBe(true);
    for (const call of postSpy.mock.calls) {
      const text = JSON.stringify(call[0]);
      expect(text).not.toContain("Dana");
      expect(text).not.toContain("dana@example.com");
      expect(text).not.toContain("5615295");
    }
    postSpy.mockRestore();
  });

  it("posts none of the lifecycle messages outside an embed", async () => {
    global.fetch = availabilityWith([slotIso]);
    const postSpy = vi.spyOn(window.parent, "postMessage");
    render(<Booker {...baseProps} parentOrigin={HOST} />);
    await dayChip();
    await settle();
    expect(slateMessages(postSpy)).toHaveLength(0);
    postSpy.mockRestore();
  });
});

describe("Booker availability states (#215)", () => {
  it("shows the load-error notice with a working retry when availability fails to load", async () => {
    let calls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        calls += 1;
        // First load fails at the HTTP layer; the retry succeeds.
        if (calls === 1) return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);

    // The failed load surfaces the retry affordance, not a slot list or a
    // permanent empty message.
    // #1336 copy: two sentences, each on its own line, so match the first alone.
    expect(await screen.findByText("Could not load available times.")).toBeTruthy();
    expect(screen.getByText("Check your connection.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /:\d{2}/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    // The retry refetches, so the days come back and the error clears.
    expect(await dayChip()).toBeTruthy();
    expect(screen.queryByText("Could not load available times.")).toBeNull();
    await pickFirstDay();
    expect(await screen.findByRole("button", { name: /:\d{2}/ })).toBeTruthy();
  });

});

// #219: a lead whose device zone is wrong AND whose correct zone isn't curated
// can still select it through the searchable full-IANA fallback.
// #1849 DELETED the "more zones" fallback tests that were here.
//
// They drove a searchable full IANA combobox that let anybody reach a zone
// outside the curated list, and asserted that a valid pick applied and an
// invalid one did not. The list is a fixed US set now, so a way out of it is not
// a smaller version of that decision, it is the opposite, and a test whose whole
// content is a reversed decision becomes the guard defending it (L252).
//
// What replaces them is in scripts/test-timezones.ts: the list does not grow for
// anybody, and a zone outside it resolves to a named default rather than to a
// blank control or to whatever happens to be first.

afterEach(() => vi.useRealTimers());

// #1332 / #1333: the two things the booker's attendee step and event panel got
// wrong about phone numbers.
describe("Booker phone handling (#1332, #1333)", () => {
  const okFetch = () =>
    vi.fn(async () => ({ ok: true, json: async () => availability })) as unknown as typeof fetch;

  it("shapes and caps the number as the lead types it", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    const phone = screen.getByLabelText("Phone") as HTMLInputElement;
    await userEvent.type(phone, "215");
    expect(phone.value).toBe("(215");
    await userEvent.type(phone, "5550100");
    expect(phone.value).toBe("(215) 555-0100");
    // Digits past the tenth never make it in, so the lead is not told at submit.
    await userEvent.type(phone, "999");
    expect(phone.value).toBe("(215) 555-0100");
  });

  it("strips a pasted country code instead of shifting every digit", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    const phone = screen.getByLabelText("Phone") as HTMLInputElement;
    await userEvent.click(phone);
    await userEvent.paste("+1 (215) 555-0100");
    // Not "(121) 555-5010", which is a different number that looks just as valid.
    expect(phone.value).toBe("(215) 555-0100");
  });

  it("sends the formatted number, which validation still accepts", async () => {
    let postedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      postedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You're all set");
    expect((postedBody!.attendee as { phone: string }).phone).toBe("(203) 561-5295");
  });

  // #1333 / #1357: the panel's number is the LEAD's own, labelled as theirs. The
  // number that used to sit here was the main Pennie line, which read as a promise
  // about who would call, and agents are assigned round robin at confirm time from
  // their own lines. Dan's call on #1333: echo it back as a plain value, with no
  // sentence about the call at all, so the row cannot be read as either promise.
  it("reads the lead's own number back, labelled as theirs", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} attendee={{ name: "", email: "", phone: "(215) 555-0100" }} />);
    await dayChip();

    const panel = document.querySelector("aside");
    expect(panel).not.toBeNull();
    // Labelled as the lead's own, so it cannot be read as the number we dial FROM.
    // A BARE number in a row of facts would reintroduce exactly that.
    expect(panel!.textContent).toContain("Your number:");
    expect(panel!.textContent).toContain("(215) 555-0100");
    // The label and the number each take their own line, and the number never
    // breaks at its hyphen: in the 260px panel it used to wrap as "793-" / "7858".
    // The icon is centred on the pair rather than pinned to the first line.
    const number = within(panel as HTMLElement).getByText("(215) 555-0100");
    expect(number.className).toMatch(/\bblock\b/);
    expect(number.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(number.closest("div")!.className).toMatch(/\bitems-center\b/);
    expect(panel!.textContent).not.toMatch(/attendee phone/i);
    // And it makes no claim about the call itself, in either direction: the agent
    // is not chosen until confirm, so the panel cannot honestly say anything about
    // who dials or when.
    expect(panel!.textContent).not.toMatch(/call you|we will call/i);
    // Duration and timezone stay.
    expect(panel!.textContent).toMatch(/30m/);
    // #1849: the zone shown is one of the fixed US zones, NOT the host's. It used
    // to read the host and assert that back, which passed everywhere and asserted
    // nothing about the rule; under CI's TZ=UTC it then failed, correctly, because
    // UTC is no longer offered and resolves to Eastern.
    //
    // Asserted against the list rather than by re-deriving through the same
    // function the component uses, which would only prove that function is
    // consistent with itself (L70). Both halves are needed: that it shows a real
    // US city, and that it does NOT echo a host zone the list cannot show.
    const US_CITIES = ["New York", "Chicago", "Denver", "Phoenix", "Los Angeles", "Anchorage", "Honolulu"];
    expect(
      US_CITIES.some((city) => panel!.textContent?.includes(city)),
      `expected one of the US zones in: ${panel!.textContent}`,
    ).toBe(true);
    for (const notOffered of ["UTC", "London", "Paris", "Sydney"]) {
      expect(panel!.textContent).not.toContain(notOffered);
    }
  });

  it("shows no phone row at all until there is a number to read back", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    await dayChip();

    const panel = document.querySelector("aside")!;
    // No placeholder standing in for a value the lead has not given: a row reading
    // "Attendee phone number" is a label pretending to be a number, which is what
    // this panel got wrong in the first place.
    expect(panel.textContent).not.toMatch(/your number/i);
    expect(panel.textContent).not.toMatch(/attendee phone|phone number/i);
  });

  // This used to assert that the PANEL echoed the number back as it was typed.
  // #2208 settled where that number is stated on the details step, and the answer
  // is the field: the panel's row and the field said it twice on one composed
  // screen (L605), and only one of the two can be corrected. So the shape is
  // asserted where it now lives rather than the assertion being deleted, and
  // "the two never disagree" (#1332) is kept by there being one of them.
  it("shapes the number as the lead types it, in the field that carries it", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await userEvent.type(screen.getByLabelText("Phone"), "2155550100");

    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("(215) 555-0100");
    expect(document.querySelector("aside")!.textContent).not.toContain("(215) 555-0100");
  });

  // #1356, Dan's decision: Pennie can only CALL a US number, so a prefill that is
  // not one is dropped. The two halves have to move together, which is what the
  // issue was filed to settle: the field caps at ten digits, so a lead whose
  // number is dropped cannot type it back either.
  describe("a number we cannot call (#1356)", () => {
    it("drops it and says why, rather than leaving an unexplained empty field", async () => {
      global.fetch = okFetch();
      render(
        <Booker {...baseProps} attendee={{ name: "", email: "", phone: "+44 20 7946 0958" }} />,
      );
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      const phone = screen.getByLabelText("Phone") as HTMLInputElement;
      expect(phone.value).toBe("");
      // The explanation is the whole point of dropping it rather than passing it
      // through: without this they press confirm and are told "enter your phone
      // number", which is true and useless.
      expect(screen.getByText(US_ONLY_PHONE_NOTICE)).toBeTruthy();
    });

    it("stops explaining once they type, because the field is no longer empty", async () => {
      global.fetch = okFetch();
      render(
        <Booker {...baseProps} attendee={{ name: "", email: "", phone: "+44 20 7946 0958" }} />,
      );
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
      await userEvent.type(screen.getByLabelText("Phone"), "2155550100");

      expect(screen.queryByText(US_ONLY_PHONE_NOTICE)).toBeNull();
      expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("(215) 555-0100");
    });

    it("says nothing when the lead simply arrived without a number", async () => {
      global.fetch = okFetch();
      render(<Booker {...baseProps} />);
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      // An empty field is the ordinary case. Explaining a rule to somebody who was
      // never shown a number is noise, and it would read as an accusation.
      expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("");
      expect(screen.queryByText(US_ONLY_PHONE_NOTICE)).toBeNull();
    });

    // #1409, Dan's call: a partial number is dropped too, so the field never holds
    // something that cannot be submitted as it stands. The SENTENCE is the point:
    // it is not a number we refuse, it is an unfinished one, and explaining it with
    // the US rule would send that lead looking for a problem they do not have.
    it("drops a partial number and says it looks incomplete, not that it is foreign", async () => {
      global.fetch = okFetch();
      render(<Booker {...baseProps} attendee={{ name: "", email: "", phone: "215555" }} />);
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("");
      expect(screen.getByText(INCOMPLETE_PHONE_NOTICE)).toBeTruthy();
      expect(screen.queryByText(US_ONLY_PHONE_NOTICE)).toBeNull();
    });

    it("uses the OTHER sentence for a number we cannot call", async () => {
      global.fetch = okFetch();
      render(
        <Booker {...baseProps} attendee={{ name: "", email: "", phone: "+44 20 7946 0958" }} />,
      );
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      // Both directions, or a component wired to one constant would pass the test
      // above while being wrong for every other case.
      expect(screen.getByText(US_ONLY_PHONE_NOTICE)).toBeTruthy();
      expect(screen.queryByText(INCOMPLETE_PHONE_NOTICE)).toBeNull();
    });
  });

  // #1335: the description is editable in settings now, so the booker has to render
  // whatever an admin wrote, including the shape Dan's copy is actually in: a
  // description followed by an ask.
  describe("the event description (#1335)", () => {
    const withDescription = (description: string | null) => ({
      ...availability,
      eventType: { ...availability.eventType, description },
    });

    /** Paragraphs in the panel the heading sits in, which is where the description
     *  renders. Counted through ONE selector in both directions, so the empty case
     *  cannot pass merely by looking somewhere the paragraphs never were. */
    const panelParagraphs = async () => {
      const heading = await screen.findByRole("heading", { name: "Advisor Call" });
      return heading.parentElement!.querySelectorAll("p");
    };

    it("shows a description and an ask as separate paragraphs", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => withDescription("Twenty minutes with a senior advisor.\n\nA small ask: join from somewhere quiet."),
      }) as unknown as typeof fetch;
      render(<Booker {...baseProps} />);

      const paras = await panelParagraphs();
      // Two elements, not one containing both. Run together they read as one
      // paragraph and the ask stops reading as an ask.
      expect(paras.length).toBe(2);
      expect(paras[0]!.textContent).toBe("Twenty minutes with a senior advisor.");
      expect(paras[1]!.textContent).toBe("A small ask: join from somewhere quiet.");
    });

    it("renders nothing at all when no description is set", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => withDescription(null),
      }) as unknown as typeof fetch;
      render(<Booker {...baseProps} />);

      // Zero through the SAME selector that found two above, so this is the absence
      // of a paragraph rather than the absence of a place to look. An empty one would
      // be a gap nobody wrote, on the one panel a lead reads before committing.
      expect((await panelParagraphs()).length).toBe(0);
    });
  });

  // #1425, Dan's decision: Pennie asks for a number with no extension, and the
  // FIELD is where that has to hold. A mask that quietly trimmed one would leave a
  // lead believing we still have the digits that get past their switchboard.
  describe("a number carrying an extension (#1425)", () => {
    it("blanks a prefilled extension and asks for the number without one", async () => {
      global.fetch = okFetch();
      render(
        <Booker {...baseProps} attendee={{ name: "", email: "", phone: "215-555-0100 ext 4021" }} />,
      );
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("");
      expect(screen.getByText(EXTENSION_PHONE_PREFILL_NOTICE)).toBeTruthy();
      // Its own sentence. Both of the others would send this lead to fix something
      // that is not wrong with their number.
      expect(screen.queryByText(US_ONLY_PHONE_NOTICE)).toBeNull();
      expect(screen.queryByText(INCOMPLETE_PHONE_NOTICE)).toBeNull();
    });

    it("does not let one be typed into the field", async () => {
      global.fetch = okFetch();
      render(<Booker {...baseProps} />);
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      const phone = screen.getByLabelText("Phone") as HTMLInputElement;
      await userEvent.type(phone, "2155550100x4021");
      expect(phone.value).toBe("(215) 555-0100");
    });
  });

});

// #1328: the empty state must not say times are taken when the office is shut.
// Both halves of "All times are taken right now. Check back soon." are untrue
// then: nothing is taken, we are shut, and soon may be a week.
describe("Booker empty-state honesty (#1328)", () => {
  const emptyWith = (emptyBecause: unknown) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...availability, slots: [], emptyBecause }),
    })) as unknown as typeof fetch;

  it("names the day we are back when the reason is a closure", async () => {
    global.fetch = emptyWith({ kind: "closed", reopensOn: "2026-08-17" });
    render(<Booker {...baseProps} />);

    expect(await screen.findByText("We are closed until Monday, August 17.")).toBeTruthy();
    expect(screen.queryByText(/all times are taken/i)).toBeNull();
  });

  it("keeps the busy copy when the office is open and nothing is free", async () => {
    global.fetch = emptyWith({ kind: "busy" });
    render(<Booker {...baseProps} />);

    // An open day with nobody free is genuinely about supply. Claiming a closure
    // here would be the same lie in the other direction.
    expect(await screen.findByText(/all times are taken right now/i)).toBeTruthy();
    expect(screen.queryByText(/we are closed/i)).toBeNull();
  });

  it("says it could not work out why, rather than claiming a full week (#1414)", async () => {
    global.fetch = emptyWith(null);
    render(<Booker {...baseProps} />);

    // #1328's rule holds and is unchanged: a wrongly claimed closure names a date
    // the lead would act on, so an unknown must never become one. What #1414 adds
    // is that it must not become the OTHER claim either. "All times are taken" is a
    // measurement, and nobody made it.
    expect(await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE)).toBeTruthy();
    expect(screen.queryByText(/we are closed/i)).toBeNull();
    expect(screen.queryByText(allTimesTaken())).toBeNull();
  });

  it("says we are closed without a date when there is no reopening day to give", async () => {
    global.fetch = emptyWith({ kind: "closed", reopensOn: null });
    render(<Booker {...baseProps} />);

    expect(await screen.findByText("We are closed right now.")).toBeTruthy();
  });

});

// #1329 / #1339: during a genuine closure, "check back soon" gives a lead nothing
// to act on and no idea when soon is, so they leave. The panel names the reason and
// offers the way through, and the longer search runs only when the button is
// pressed so the cost falls on the few who arrive during a shutdown.
describe("Booker closure state (#1329, #1339)", () => {
  // 10:00 twenty days out, in the zone the BOOKER shows (#2310), never the
  // machine's. `setHours` on a Date used the machine zone, so under TZ=UTC the
  // slot was 10:00 UTC while the booker, falling back to Eastern, read it as
  // 06:00: outside the lead's calling window, filtered out, and the test failed
  // only in CI. Built from the booker's own zone resolution, the time is inside
  // 08:00 to 20:00 whatever zone the machine is in.
  const far = () => new Date(bookerSlotIso(20, 10));

  /** Empty near window with a closure reason; /next answers as told. */
  function closedWith(next: { ok: boolean; slots?: string[] }) {
    return vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/availability/next")) {
        return {
          ok: next.ok,
          status: next.ok ? 200 : 500,
          json: async () => ({ slots: next.slots ?? [] }),
        } as Response;
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
  }

  it("offers the way through, and looks no further until asked", async () => {
    const fetchMock = closedWith({ ok: true, slots: [far().toISOString()] });
    global.fetch = fetchMock;
    render(<Booker {...baseProps} />);

    expect(await screen.findByText("We are closed until Monday, August 17.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "See our next available days" });
    // The expensive search has NOT run: that is the whole point of the button.
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([u]) => String(u).includes("/next"))).toBe(false);

    await userEvent.click(button);

    // The days arrive, said to start where they actually start, because these are
    // not the next few days and a bare strip would read as though they were.
    expect(await screen.findByText(/Our next available days, from /)).toBeTruthy();
    expect(await dayChip()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See our next available days" })).toBeNull();
  });

  it("shows the same working cue every other button on this surface shows, while it looks", async () => {
    // #2604 put the cue inside BookerButton so a call site cannot omit it. This
    // one hand rolled its own beside the button instead, which worked only
    // because this variant is not filled: the dots it drew carried the accent,
    // and a primary button IS the accent, so the day anyone changed this
    // button's variant the cue would have disappeared into it.
    let release: (r: Response) => void = () => {};
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/next")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
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
    render(<Booker {...baseProps} />);

    const button = await screen.findByRole("button", { name: "See our next available days" });
    expect(button.querySelector("[data-bob-dots]")).toBeNull();

    await userEvent.click(button);

    const looking = screen.getByRole("button", { name: /looking/i });
    // Inside the button, from the shared mechanism, alongside the word that
    // carries it for anyone who cannot see the dots.
    expect(looking.querySelector("[data-bob-dots]")).not.toBeNull();
    expect(looking.textContent).toContain(NEXT_DAYS_COPY.looking);

    await act(async () => {
      release({ ok: true, json: async () => ({ slots: [far().toISOString()] }) } as Response);
    });
  });

  it("still shows no time until one of the revealed days is picked", async () => {
    global.fetch = closedWith({ ok: true, slots: [far().toISOString()] });
    render(<Booker {...baseProps} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "See our next available days" }),
    );
    await dayChip();

    // The far side of a closure must not quietly become the one place times appear
    // without being asked for (#1336).
    expect(screen.queryAllByRole("button", { name: /:\d{2}/ })).toHaveLength(0);
    await pickFirstDay();
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(1);
  });

  it("moves focus to the first revealed day, since the button is gone", async () => {
    global.fetch = closedWith({ ok: true, slots: [far().toISOString()] });
    render(<Booker {...baseProps} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "See our next available days" }),
    );

    const chip = await dayChip();
    // Otherwise focus drops to <body> and a keyboard user has to walk the whole
    // page again to reach the days they just asked for.
    await waitFor(() => expect(document.activeElement).toBe(chip));
  });

  it("says we looked and found nothing, rather than offering the button again", async () => {
    global.fetch = closedWith({ ok: true, slots: [] });
    render(<Booker {...baseProps} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "See our next available days" }),
    );

    expect(await screen.findByText(/could not find a day to offer yet/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See our next available days" })).toBeNull();
  });

  // An error state and an empty state are different screens: "we looked and there
  // is nothing" must never be shown for "we could not look".
  it("says it could not look when the search fails, and offers a retry", async () => {
    global.fetch = closedWith({ ok: false });
    render(<Booker {...baseProps} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "See our next available days" }),
    );

    expect(await screen.findByText(/could not look further ahead/i)).toBeTruthy();
    expect(screen.queryByText(/could not find a day to offer yet/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  // The button appears whenever the near window came back empty, closure or not
  // (#1329). A fully booked window is arguably the strongest case for it: the lead
  // has nothing to book either way, and the next free day is the one useful fact.
  // The copy above it still differs, because the REASON differs.
  // Dan, 2026-08-12: closures only. A week that is merely full is a staffing
  // problem to fix, not a lead to send weeks into the future, and the far ahead
  // search is the slowest action in the product. Being told about it is what
  // #1412 is for; a lead is told to check back.
  it("does NOT offer the far ahead search when the week is merely full", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
    })) as unknown as typeof fetch;
    render(<Booker {...baseProps} />);

    expect(await screen.findByText(/all times are taken right now/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeNull();
    // And it does not claim a closure it cannot support.
    expect(screen.queryByText(/we are closed/i)).toBeNull();
  });

  // The server not knowing WHY is the case that decides whether this rule is safe.
  // An unknown cause could be either, and offering the search there would put it
  // back on every busy week, which is exactly what was just removed.
  it("does NOT offer it when the server could not say why the window is empty", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...availability, slots: [] }),
    })) as unknown as typeof fetch;
    render(<Booker {...baseProps} />);

    // The unknown window has its own sentence (#1414); what matters here is that it
    // is not treated as a closure, since that is what would offer the search.
    expect(await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeNull();
  });

  it("still offers it for a closure with no reopening date", async () => {
    // We know we are SHUT, we just cannot date it. That is still a closure, and a
    // lead facing one has nowhere else to go.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...availability,
        slots: [],
        emptyBecause: { kind: "closed", reopensOn: null },
      }),
    })) as unknown as typeof fetch;
    render(<Booker {...baseProps} />);

    expect(await screen.findByText(closedNoReopenDate())).toBeTruthy();
    expect(screen.getByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeTruthy();
  });

  // #1364: the three states every time-taking action must keep visibly distinct.
  // This search walks up to eight windows, each doing real calendar work per
  // bookable agent, so it is plausibly the slowest lead-facing action in the
  // product. A static word cannot tell a lead that it is progressing.
  describe("the still-alive signal on the search (#1364)", () => {
    it("shows a moving working signal while it looks, not just a word", async () => {
      let release: ((r: Response) => void) | null = null;
      global.fetch = vi.fn((url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/availability/next")) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...availability,
            slots: [],
            emptyBecause: { kind: "closed", reopensOn: "2026-08-17" },
          }),
        } as Response);
      }) as unknown as typeof fetch;

      render(<Booker {...baseProps} />);
      const button = await screen.findByRole("button", { name: "See our next available days" });
      fireEvent.click(button);
      await act(async () => { await Promise.resolve(); });

      // Bobbing dots, the same working signal the picker uses. Position only, so a
      // glance away cannot land on a dim half and read as nothing happening.
      const looking = screen.getByRole("button", { name: /looking/i });
      expect(looking.querySelector("[data-bob-dots]")).not.toBeNull();
      // The dots are decorative, so the label still has to carry the state in words
      // for anyone who cannot see them.
      expect(looking.textContent).toMatch(/looking/i);
      expect(looking.querySelector("[data-bob-dots]")!.getAttribute("aria-hidden")).toBe("true");

      await act(async () => {
        release!({ ok: true, status: 200, json: async () => ({ slots: [] }) } as Response);
        await Promise.resolve();
      });
    });

    it("says it is still alive once the search runs long, then fails at the timeout", async () => {
      vi.useFakeTimers();
      // A wedged search: it settles only when its own AbortSignal fires, which is
      // what the shared request ceiling exists to guarantee will happen.
      global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/availability/next")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...availability,
            slots: [],
            emptyBecause: { kind: "closed", reopensOn: "2026-08-17" },
          }),
        } as Response);
      }) as unknown as typeof fetch;

      render(<Booker {...baseProps} />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "See our next available days" }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.queryByText(/still looking/i)).toBeNull();
      await act(async () => { vi.advanceTimersByTime(10000); });
      const alive = screen.getByText(/still looking/i);
      expect(alive).toBeTruthy();
      // Announced, so it reaches somebody who is not watching the button.
      expect(alive.closest("[role=status]")).not.toBeNull();

      // The whole point of the ceiling: a hang BECOMES the failed state, with its
      // retry, instead of sitting on "Looking" forever.
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(screen.getByText(/could not look further ahead/i)).toBeTruthy();
      const retry = screen.getByRole("button", { name: /try again/i }) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
      // And the still-alive line is gone: it claimed the search was alive, and it
      // is not any more.
      expect(screen.queryByText(/still looking/i)).toBeNull();
      vi.useRealTimers();
    });

    it("drops the working signal the moment the search comes back", async () => {
      global.fetch = closedWith({ ok: true, slots: [far().toISOString()] });
      render(<Booker {...baseProps} />);
      fireEvent.click(await screen.findByRole("button", { name: "See our next available days" }));

      await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
      expect(document.querySelector("[data-bob-dots]")).toBeNull();
      expect(screen.queryByText(/still looking/i)).toBeNull();
    });
  });


  // The three guards #1339 asks for by name. Each pins a way this state could look
  // right while being wrong about something a lead would act on.
  describe("the guards this state needs (#1339)", () => {
    it("does NOT appear for an ordinary busy week", async () => {
      // A staffed week that happens to be full is not a closure. Naming a return
      // day there would be inventing one, and "nobody is available before then"
      // would be false: they are available, they are booked.
      global.fetch = vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
        }) as Response,
      ) as unknown as typeof fetch;

      render(<Booker {...baseProps} />);
      expect(await screen.findByText(allTimesTaken())).toBeTruthy();
      expect(screen.queryByText(/Nobody is available before then/)).toBeNull();
      expect(screen.queryByText(/We are closed/)).toBeNull();
    });

    it("does NOT claim a return day when the server could not name one", async () => {
      // The vaguer sentence is the honest one here, and the body hangs off a day
      // that does not exist, so it must not render either.
      global.fetch = vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            ...availability,
            slots: [],
            emptyBecause: { kind: "closed", reopensOn: null },
          }),
        }) as Response,
      ) as unknown as typeof fetch;

      render(<Booker {...baseProps} />);
      expect(await screen.findByText(closedNoReopenDate())).toBeTruthy();
      expect(screen.queryByText(/Nobody is available before then/)).toBeNull();
    });

    it("shows no times on the revealed days until one is picked", async () => {
      // #1336's rule, and the far side of a closure is the tempting place to break
      // it: the lead has already asked once, so it feels like they asked for times.
      // They asked for DAYS.
      // In the booker's own zone, never the machine's (#2310, L504): see `far`
      // in the describe above for what setHours on a machine Date did.
      const far = new Date(bookerSlotIso(20, 10));
      const alsoFar = new Date(bookerSlotIso(20, 14));

      global.fetch = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/availability/next")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ slots: [far.toISOString(), alsoFar.toISOString()] }),
          } as Response;
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

      render(<Booker {...baseProps} />);
      fireEvent.click(await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask }));

      // The day chips arrive...
      await screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
      // ...and not one time with them.
      expect(screen.queryByRole("button", { name: /:\d{2}/ })).toBeNull();
      // getAllByText: the line is both shown and announced, which is deliberate.
      expect(screen.getAllByText(PICKER_COPY.pickADay).length).toBeGreaterThan(0);
    });

    it("names the revealed block from the first genuinely bookable day", async () => {
      // Not the first day after the gap, which is the easy mistake: a Monday we
      // reopen on with no bookable time is not a day to send anyone to.
      const monday = "2026-08-17T14:00:00.000Z";
      const wednesday = "2026-08-19T14:00:00.000Z";
      global.fetch = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/availability/next")) {
          // The server returns only days that really have times, so the first slot
          // IS the first bookable day. The heading must follow the slots rather
          // than the reopening date it was told about.
          return {
            ok: true,
            status: 200,
            json: async () => ({ slots: [wednesday] }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            ...availability,
            slots: [],
            emptyBecause: { kind: "closed", reopensOn: monday.slice(0, 10) },
          }),
        } as Response;
      }) as unknown as typeof fetch;

      render(<Booker {...baseProps} />);
      fireEvent.click(await screen.findByRole("button", { name: NEXT_DAYS_COPY.ask }));

      const heading = await screen.findByText(/Our next available days, from/);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const expected = DateTime.fromISO(wednesday, { zone }).toFormat("cccc, LLLL d");
      expect(heading.textContent).toContain(expected);
      // And explicitly NOT the reopening day it was handed.
      const reopen = DateTime.fromISO(monday, { zone }).toFormat("cccc, LLLL d");
      expect(heading.textContent).not.toContain(reopen);
    });
  });


  // #1414, Dan's call: an empty window nobody can explain is a signal, not a quiet
  // day. `emptyBecause` is set whenever the server CAN tell, so its absence means
  // either an older response shape or a classifier that did not run, and smoothing
  // that into "all times are taken" hides both.
  describe("an empty window nobody can explain (#1414)", () => {
    const emptyWithNoCause = () =>
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...availability, slots: [] }),
      })) as unknown as typeof fetch;

    it("says we could not work it out, and offers a retry", async () => {
      global.fetch = emptyWithNoCause();
      render(<Booker {...baseProps} />);

      expect(await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE)).toBeTruthy();
      expect(screen.getByRole("button", { name: UNCLASSIFIED_EMPTY_RETRY })).toBeTruthy();
    });

    it("does NOT blame the lead's connection", async () => {
      // The read SUCCEEDED. Telling somebody to check their connection is a claim
      // the check never measured, and it would send them to restart a router over a
      // server side classification gap (L11).
      global.fetch = emptyWithNoCause();
      render(<Booker {...baseProps} />);

      await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE);
      expect(screen.queryByText(/check your connection/i)).toBeNull();
    });

    it("does not claim a closure it cannot support, or a full week it did not measure", async () => {
      global.fetch = emptyWithNoCause();
      render(<Booker {...baseProps} />);

      await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE);
      expect(screen.queryByText(/we are closed/i)).toBeNull();
      expect(screen.queryByText(allTimesTaken())).toBeNull();
      // And no far ahead search: we do not know there is a far side to look at.
      expect(screen.queryByRole("button", { name: NEXT_DAYS_COPY.ask })).toBeNull();
    });

    it("re-runs the availability read when the retry is pressed", async () => {
      const fetchMock = emptyWithNoCause();
      global.fetch = fetchMock;
      render(<Booker {...baseProps} />);

      await screen.findByText(UNCLASSIFIED_EMPTY_NOTICE);
      const before = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: UNCLASSIFIED_EMPTY_RETRY }));
      await act(async () => {});

      const after = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(after).toBeGreaterThan(before);
    });

    // The three empty states must stay apart, or they collapse back into each
    // other one edit at a time.
    it("a busy window keeps its own sentence and offers no retry", async () => {
      global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...availability, slots: [], emptyBecause: { kind: "busy" } }),
      })) as unknown as typeof fetch;
      render(<Booker {...baseProps} />);

      expect(await screen.findByText(allTimesTaken())).toBeTruthy();
      expect(screen.queryByText(UNCLASSIFIED_EMPTY_NOTICE)).toBeNull();
      expect(screen.queryByRole("button", { name: UNCLASSIFIED_EMPTY_RETRY })).toBeNull();
    });

    it("a genuine fetch failure still says the load failed", async () => {
      // A real network failure, which is what the connection message is ABOUT.
      global.fetch = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch;
      render(<Booker {...baseProps} />);

      // messageLines puts each sentence on its own line (#1336), so they are
      // separate nodes and the whole string never appears in one of them.
      for (const sentence of messageLines(PICKER_COPY.failed)) {
        expect(await screen.findByText(sentence)).toBeTruthy();
      }
      expect(screen.queryByText(UNCLASSIFIED_EMPTY_NOTICE)).toBeNull();
    });
  });

});

// #1416: the availability window used to be intersected with the calendar month
// being viewed, which the deleted month grid needed and the day strip never did.
// At a month boundary that CLIPPED the horizon, so a lead near the end of a month
// was offered fewer days than the org had configured.
describe("Booker availability window (#1416)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the whole horizon even when it crosses a month boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The 30th, with a four day horizon: the window has to reach into September.
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));

    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(decodeURIComponent(String(url)));
      return { ok: true, json: async () => availability } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await act(async () => {});

    const availabilityCall = urls.find((u) => u.includes("/api/availability?"));
    expect(availabilityCall).toBeDefined();
    // Four days on from 30 August is 3 September, so a window that stops at the
    // 31st is the clip this guards against.
    const to = /to=([^&]+)/.exec(availabilityCall ?? "")?.[1];
    expect(to).toBeDefined();
    expect(new Date(to!).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-03T00:00:00Z").getTime(),
    );
  });

  it("asks from today, not from the start of the month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));

    const urls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(decodeURIComponent(String(url)));
      return { ok: true, json: async () => availability } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await act(async () => {});

    const from = /from=([^&]+)/.exec(urls.find((u) => u.includes("/api/availability?")) ?? "")?.[1];
    expect(from).toBeDefined();
    // Nothing before now: a window opening on the 1st would ask the server to
    // compute two thirds of a month nobody can book.
    expect(new Date(from!).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-08-20T00:00:00Z").getTime(),
    );
  });
});

describe("nearest free times after a refused confirm (#1319)", () => {
  // A refusal at confirm is not rare by design: the booker reads a cached availability index
  // and the only live check happens at confirm, so the gap between what was shown and what is
  // true closes at exactly that step. The lead has already filled in every field and pressed
  // the final button. Answering with a refusal and nothing else is where an otherwise willing
  // customer gives up.

  const taken = slotIso;
  const later = (days: number) =>
    new Date(Date.parse(slotIso) + days * 24 * 60 * 60 * 1000).toISOString();

  /**
   * First availability load offers `taken`; the confirm 409s; the RELOAD that follows answers
   * with `after`. That second answer is what the alternatives are drawn from, which is the
   * point: they must be times that are free NOW, not the stale list the lead was looking at.
   */
  function refuseThenReload(after: string[] | "fail") {
    let loads = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ error: "That time is no longer available." }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      loads += 1;
      if (loads > 1 && after === "fail") return new Response("nope", { status: 500 });
      const slots = loads === 1 ? [taken] : (after as string[]);
      return new Response(JSON.stringify({ ...availability, slots }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("keeps the honest error AND offers the soonest times still open", async () => {
    global.fetch = refuseThenReload([taken, later(1), later(2)]) as never;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    // The explanation is not replaced by the alternatives (L10).
    expect(await screen.findByText(BOOKING_ERROR_COPY.slotTaken)).toBeTruthy();
    expect(await screen.findByText(NEAREST_TIMES_COPY.heading)).toBeTruthy();
    // And it is obvious a tap does not book, so nobody taps one to look at it and finds
    // themselves booked.
    expect(screen.getByText(NEAREST_TIMES_COPY.hint)).toBeTruthy();
  });

  it("never offers back the time that was just taken", async () => {
    // The one time we KNOW is gone. Re-offering it is the same dead end wearing a helpful
    // face, and it is exactly what a naive "show the first few slots" would do, because the
    // reload can still carry it.
    global.fetch = refuseThenReload([taken, later(1)]) as never;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText(NEAREST_TIMES_COPY.heading);

    const offered = screen.getAllByTestId("nearest-time").map((b) => b.getAttribute("data-slot"));
    expect(offered).not.toContain(taken);
    expect(offered).toContain(later(1));
  });

  it("selects a tapped alternative rather than booking it", async () => {
    global.fetch = refuseThenReload([later(1)]) as never;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText(NEAREST_TIMES_COPY.heading);

    const posts = () =>
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "POST",
      ).length;
    const postsBefore = posts();
    await userEvent.click(screen.getAllByTestId("nearest-time")[0]!);

    // Settle any pending work before judging. Counting immediately after the click passes
    // even when the tap DOES book, because the request has not been issued yet, and that
    // vacuous version of this test let a booking-on-tap mutation through (L1).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(posts()).toBe(postsBefore);
    // And the positive half: they are still on the form, not on a confirmation they never
    // asked for. This is the assertion that would catch a booking made by some other route.
    expect(screen.queryByText(/you're all set/i)).toBeNull();
    expect(screen.getByRole("button", { name: /confirm booking/i })).toBeTruthy();
    // And their details survived, so the recovery really is a tap and a confirm rather than
    // filling the form again.
    expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Dana");
    expect((screen.getByLabelText("Last name") as HTMLInputElement).value).toBe("Lead");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("dana@example.com");
  });

  it("says plainly when nothing else is open, rather than showing an empty area", async () => {
    // A settled, measured answer: we looked and there is nothing. Distinct from the failure
    // below, and it must not render as a heading over nothing (L10, L22).
    global.fetch = refuseThenReload([taken]) as never;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText(NEAREST_TIMES_COPY.none)).toBeTruthy();
    expect(screen.queryByTestId("nearest-time")).toBeNull();
    expect(screen.queryByText(NEAREST_TIMES_COPY.heading)).toBeNull();
  });

  it("says something DIFFERENT when the re-check itself failed", async () => {
    // "We could not look" is not "there is nothing", and telling a lead there are no times
    // when we simply failed to load them sends them away for a reason that is not true (L11).
    global.fetch = refuseThenReload("fail") as never;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText(NEAREST_TIMES_COPY.lookupFailed)).toBeTruthy();
    expect(screen.queryByText(NEAREST_TIMES_COPY.none)).toBeNull();
    // A way out of it, rather than a statement they can do nothing with (L80), and exactly
    // ONE of them: the picker's own load-error notice already carries a retry, and two
    // identical controls a few lines apart read as a broken page.
    expect(screen.getAllByRole("button", { name: NEAREST_TIMES_COPY.retry })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The details step, read as one COMPOSED screen (#2208, #2205, #2204).
//
// Each of these was found by looking at the whole step rather than at a
// component: the panel and the field both stated the number, the line above the
// form named a day with no month and no year, and the last line before the
// button explained the button.
const plainFetch = () =>
  vi.fn(async () => ({ ok: true, json: async () => availability }) as Response) as unknown as typeof fetch;

describe("the booker details step", () => {
  it("brings the details step in with the product's own entrance, not a jump", async () => {
    // Dan, 2026-09-22: "clicking the time (like 8am) felt bad. it jumped
    // immediately to the next page. I like the speed but it was jarring." The
    // step swapped in the same frame, so there was nothing for the eye to
    // follow. It is the SHARED entrance rather than one invented here, which is
    // what keeps the booker to one vocabulary of motion, and it is opacity and
    // transform only because the embed posts scrollHeight and a height
    // animation jitters the iframe.
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => availability })) as never;
    const { container } = render(<Booker {...baseProps} />);
    await act(async () => {});

    await userEvent.click(await dayChip());
    // Nothing is entering yet: the times list is where the lead already was.
    expect(container.querySelector(".pn-confirm-enter")).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));

    const step = container.querySelector(".pn-confirm-enter");
    expect(step).not.toBeNull();
    // On the step that arrived, not on the panel around it, or the chrome that
    // stayed put would animate too and the swap would read as a whole redraw.
    expect(step!.querySelector("#booker-firstName")).not.toBeNull();
  });

  // #2208: somebody the landing link already identifies is not asked to retype
  // what Slate holds. The server resolves it (`landingAttendee`); what matters
  // here is that it arrives in fields the lead can READ and CHANGE, so an
  // inference is never presented as a recorded fact (L192).
  it("starts the form with what Slate already knows, in fields the lead can correct", async () => {
    global.fetch = plainFetch();
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        attendee={{ name: "Dana Lead", email: "dana@example.com", phone: "(203) 561-5295" }}
      />,
    );
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    // The name is SPLIT in front of them (#2362), so the guess Slate made is the
    // thing being shown rather than something hidden behind one box.
    expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Dana");
    expect((screen.getByLabelText("Last name") as HTMLInputElement).value).toBe("Lead");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("dana@example.com");
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("(203) 561-5295");

    // And correcting one really takes: a value that could not be edited would be
    // presented as a fact about them rather than as a starting point.
    await userEvent.clear(screen.getByLabelText("Email"));
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("new@example.com");
  });

  // L605, read as the composed page: the number was stated twice on this one
  // step, in the panel's row and in the field the lead is typing it into. The
  // FIELD survives, because it is the one they can change and the one that
  // decides what is submitted.
  it("states the lead's number once on the step, in the field that owns it", async () => {
    global.fetch = plainFetch();
    render(<Booker {...baseProps} attendee={{ name: "", email: "", phone: "(215) 555-0100" }} />);

    // Before a time is picked there is no field, so the panel is the ONLY place a
    // prefilled lead can read back what Slate holds. That row stays.
    const panel = () => document.querySelector("aside")!;
    await dayChip();
    expect(panel().textContent).toContain("(215) 555-0100");

    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("(215) 555-0100");
    expect(panel().textContent).not.toContain("(215) 555-0100");
    expect(panel().textContent).not.toMatch(/your number/i);
    // The panel's other facts are untouched: this is one row standing down, not
    // the panel emptying.
    expect(panel().textContent).toMatch(/30m/);
  });

  // #2204: the sentence between the Phone field and the Confirm button explained
  // the screen back to the reader (L604). Every fact in it was already on the
  // page, said better by the page itself.
  it("explains neither the button nor the field it sat between", async () => {
    global.fetch = plainFetch();
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

    const step = document.body.textContent ?? "";
    expect(step).not.toMatch(/Booking this call means/i);
    expect(step).not.toMatch(/specialist will phone you/i);
    // What the step DOES say is still all there, so this is a deletion rather than
    // the step having lost its words.
    expect(screen.getByRole("heading", { name: DETAILS_COPY.heading })).toBeTruthy();
    expect(screen.getByRole("button", { name: DETAILS_COPY.confirm })).toBeTruthy();
  });
});

// #2205: a lead reads back a committed time in more than one place, and the
// places must spell it the same way (L118). The details step already carried the
// full date with the year (#2361); these two did not.
describe("a committed time is spelled the same way wherever it is read back (#2205)", () => {
  const ZONE_HERE = "America/New_York";

  it("names the full date, with the year, on the confirmation screen", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return { ok: true, json: async () => availability } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You're all set");

    const full = longDayLabel(slotIso, ZONE_HERE, { year: true });
    expect(document.body.textContent).toContain(full);
    // The year is the half easiest to argue away and the one that decides a
    // booking made in late December, so it is asserted on its own.
    expect(full).toMatch(/, \d{4}$/);
  });

  it("names the full date, with the year, on the call a recognised lead already has", async () => {
    const existing = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    global.fetch = plainFetch();
    render(
      <Booker
        {...baseProps}
        salesforceId="003xx"
        landingCall={{
          disclose: true,
          startsAt: existing,
          advisorName: null,
          manageToken: "tok-old",
          mayCancel: true,
          phone: null,
        }}
      />,
    );
    await screen.findByText("You already have a call booked");
    expect(document.body.textContent).toContain(longDayLabel(existing, ZONE_HERE, { year: true }));
  });
});
