// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import {
  INCOMPLETE_PHONE_NOTICE,
  NEXT_DAYS_COPY,
  PICKER_COPY,
  UNCLASSIFIED_EMPTY_NOTICE,
  UNCLASSIFIED_EMPTY_RETRY,
  US_ONLY_PHONE_NOTICE,
  allTimesTaken,
  closedNoReopenDate,
} from "@/lib/booking/booker-copy";
import { DateTime } from "luxon";
import { messageLines } from "@/lib/booking/slot-picker";
import { RESCHEDULE_REASONS } from "@/lib/booking/core";

// #625: the confirm POST must not freeze the button in "Booking your call…" if
// the request rejects at the network layer (flaky mobile). It surfaces an error
// and re-enables so the lead can retry.
// #626: a confirm that HANGS (server accepted, never responds) must show a
// distinct "still working" state at ~10s, then convert to a retryable error at
// the 20s timeout; and a success that finds the lead already has another active
// booking must warn them on the confirmation screen.

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
  // #1337: the Move offered to a lead who already has a call records a mandatory
  // reschedule reason, so the live option set is a prop. Coded defaults keep the
  // reason-label assertions valid.
  rescheduleReasons: RESCHEDULE_REASONS,
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
  await userEvent.type(screen.getByLabelText("Name"), "Dana Lead");
  await userEvent.type(screen.getByLabelText("Email"), "dana@example.com");
  await userEvent.type(screen.getByLabelText("Phone"), "(203) 561-5295");
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
}

beforeEach(() => vi.clearAllMocks());

describe("Booker confirm", () => {
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

  it("shows a 'still working' state while the confirm hangs, then a retryable error at the timeout", async () => {
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
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Lead" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(203) 561-5295" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
    await act(async () => { await Promise.resolve(); }); // submit starts, watchdog arms

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); // trip 20s abort
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm booking/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
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
    // But it points at the email they already hold, not at the other booking.
    expect(screen.getByText(/confirmation email/i)).toBeTruthy();
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
  // show only a 64px check badge while the standalone page got the branded coins
  // illustration. The design system calls for one branded delight moment on
  // success, so both surfaces now render the same illustration.
  it("shows the branded coins illustration on the embedded confirmation (#637)", async () => {
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
    const coins = document.querySelector('img[src="/brand/pic-1-coins.png"]');
    expect(coins).not.toBeNull();
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

    for (const fieldName of ["Name", "Email", "Phone"]) {
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

  it("names the existing call and offers to move it, creating nothing", async () => {
    global.fetch = declineWith({
      disclose: true,
      startsAt: existingIso,
      advisorName: "Aisha Bello",
      manageToken: "tok-old",
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
    });
    global.fetch = fetchMock;
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");

    const move = () => screen.getByRole("button", { name: /^move my call/i }) as HTMLButtonElement;
    expect(move().disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    expect(move().disabled).toBe(false);
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
      { disclose: true, startsAt: existingIso, advisorName: "Aisha Bello", manageToken: "tok-old" },
      { ok: false, status: 409, body: { error: "That time is no longer available." } },
    );
    render(<Booker {...baseProps} />);
    await fillAndConfirm();
    await screen.findByText("You already have a call booked");

    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await userEvent.click(screen.getByRole("button", { name: /^move my call/i }));

    expect(await screen.findByText("That time was just taken. Please pick another.")).toBeTruthy();
    // Not stuck on the refusal screen, and not falsely confirmed.
    expect(screen.queryByText("You already have a call booked")).toBeNull();
    expect(screen.queryByText("You're all set")).toBeNull();
    expect(await dayChip()).toBeTruthy();
  });

  // #1340: a weak one-signal match may be a housemate, so the call is declined
  // but nothing about it is shown and there is nothing to move from here.
  it("shows no time, no advisor and no Move on a match too weak to disclose", async () => {
    global.fetch = declineWith({ disclose: false });
    render(<Booker {...baseProps} />);
    await fillAndConfirm();

    expect(await screen.findByText("You already have a call booked")).toBeTruthy();
    expect(screen.getByText(/confirmation email/i)).toBeTruthy();
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

// #215 / #168 / #173: the availability panel has three states that are easy to
// break silently. A failed fetch must offer a retry (not a permanent dead end);
// a loaded-but-empty month must say so honestly; and the calendar must stop
// paging once a loaded month comes back empty (the cache-limited horizon), so a
// lead can never walk off into months that will never have slots.
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
describe("Booker timezone fallback", () => {
  const okFetch = () =>
    vi.fn(async () => ({ ok: true, json: async () => availability })) as unknown as typeof fetch;

  it("applies a non-curated zone picked from the 'more zones' search and collapses it", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    const select = screen.getByLabelText("Timezone") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: /more zones/i })).toBeTruthy();

    // Reveal the search, then type a real IANA zone that isn't in the curated list.
    fireEvent.change(select, { target: { value: "__more_zones__" } });
    const search = (await screen.findByLabelText("Search all timezones")) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Australia/Sydney" } });

    // The zone is applied (the select now shows it) and the search collapses.
    expect(select.value).toBe("Australia/Sydney");
    expect(screen.queryByLabelText("Search all timezones")).toBeNull();
  });

  it("ignores an invalid zone typed into the fallback search (no bad zone applied)", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    const select = screen.getByLabelText("Timezone") as HTMLSelectElement;
    const before = select.value;

    fireEvent.change(select, { target: { value: "__more_zones__" } });
    const search = (await screen.findByLabelText("Search all timezones")) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Not/AZone" } });

    // Junk is rejected: the applied zone is unchanged and the search stays open.
    expect(select.value).toBe(before);
    expect(screen.getByLabelText("Search all timezones")).toBeTruthy();
  });
});

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
    expect(panel!.textContent).not.toMatch(/attendee phone/i);
    // And it makes no claim about the call itself, in either direction: the agent
    // is not chosen until confirm, so the panel cannot honestly say anything about
    // who dials or when.
    expect(panel!.textContent).not.toMatch(/call you|we will call/i);
    // Duration and timezone stay. The zone is the VIEWER's, so it must not be
    // pinned to a name: CI runs in UTC and a developer's machine does not, and a
    // test that reads the host clock is the #1039 class of flake.
    expect(panel!.textContent).toMatch(/30m/);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");
    expect(panel!.textContent).toContain(zone);
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

  it("reads back the number as the lead types it, in the shape the field shows", async () => {
    global.fetch = okFetch();
    render(<Booker {...baseProps} />);
    await pickFirstDay();
    await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
    await userEvent.type(screen.getByLabelText("Phone"), "2155550100");

    // The panel and the field never disagree about the same number (#1332).
    const panel = document.querySelector("aside")!;
    expect(panel.textContent).toContain("Your number:");
    expect(panel.textContent).toContain("(215) 555-0100");
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

  // #1423: an extension is part of the number, not a longer number. The rule lives
  // in one helper, but the FIELD is where a lead would lose it: a mask that judged
  // on digit count alone ate the extension on the keystroke that typed it, so the
  // half of the number that gets past a switchboard could never be entered and a
  // prefilled one was silently thrown away.
  describe("a number carrying an extension (#1423)", () => {
    it("keeps a prefilled extension instead of dropping the number as foreign", async () => {
      global.fetch = okFetch();
      render(
        <Booker {...baseProps} attendee={{ name: "", email: "", phone: "215-555-0100 ext 4021" }} />,
      );
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe(
        "(215) 555-0100 x4021",
      );
      expect(screen.queryByText(US_ONLY_PHONE_NOTICE)).toBeNull();
      expect(screen.queryByText(INCOMPLETE_PHONE_NOTICE)).toBeNull();
    });

    it("lets a lead type one, marker first, without the mask eating it", async () => {
      global.fetch = okFetch();
      render(<Booker {...baseProps} />);
      await pickFirstDay();
      await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));

      const phone = screen.getByLabelText("Phone") as HTMLInputElement;
      await userEvent.type(phone, "2155550100");
      // The keystroke that starts the extension has no digits after it yet. A mask
      // that cannot tell that apart from no extension at all removes the marker
      // here, and the first extension digit can never be reached.
      await userEvent.type(phone, "x");
      expect(phone.value).toBe("(215) 555-0100 x");
      await userEvent.type(phone, "4021");
      expect(phone.value).toBe("(215) 555-0100 x4021");
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
  const far = () => {
    const d = new Date();
    d.setDate(d.getDate() + 20);
    d.setHours(10, 0, 0, 0);
    return d;
  };

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
      const far = new Date();
      far.setDate(far.getDate() + 20);
      far.setHours(10, 0, 0, 0);
      const alsoFar = new Date(far);
      alsoFar.setHours(14, 0, 0, 0);

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
