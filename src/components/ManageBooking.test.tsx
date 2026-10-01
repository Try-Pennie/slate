// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #2310: the manage page offers a time only inside the lead's calling window,
// judged in the DEVICE zone. These fixtures' times are ordinary Eastern daytime,
// so which of them are offered would otherwise depend on the machine running the
// suite (CI runs in UTC). The zone is pinned here, never inherited (L504); the
// window's own behaviour across zones is tested in
// scripts/test-lead-calling-window.ts and use-slot-picker.test.tsx.
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";
import { NEAREST_TIMES_COPY } from "@/lib/booking/booker-copy";
import { RESCHEDULE_COPY, LIVE_COPY, DONE_COPY, movedNote, rescheduleNoTimes, callComesFrom } from "@/lib/booking/manage-copy";

// Regression coverage for the booker hardening (#168): cancel must use an
// in-DOM confirm (not native confirm()) and surface a failed POST instead of
// silently doing nothing; a failed reschedule must surface too.

const baseProps = {
  token: "tok1",
  bucketCode: "411",
  // #2982: built server side from the booking by `rebookHref`; the component
  // renders it as given.
  rebookHref: "/book?xbc=411&rebook=tok1",
  // #2827: a routed booking, whose move times are its bucket's pool.
  rescheduleTimesFrom: "pool" as const,
  startsAt: "2026-06-20T15:00:00.000Z",
  status: "confirmed",
  eventName: "Senior Loan Advisor Call",
  // #346: reason options are now props (server-resolved); coded defaults keep the
  // reason-label assertions below valid.
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  theme: "light" as const,
  durationMin: 20,
  attendeePhone: "(215) 555-0100",
  attendeeEmail: "dana@example.com",
  // #1334: no calling number known unless a test says otherwise.
  callingNumber: null as string | null,
  // #1338: the advisor is resolved live server-side and passed in; null means
  // unresolvable, and then no name is rendered anywhere.
  advisorName: "Aisha Bello",
  advisorRole: "Senior Loan Advisor",
};

type FetchResult = { ok: boolean; status?: number; body?: unknown };
function mockFetch(routes: { cancel?: FetchResult; reschedule?: FetchResult; availability?: FetchResult }) {
  const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url);
    const pick = u.includes("/cancel")
      ? routes.cancel
      : u.includes("/reschedule")
        ? routes.reschedule
        : routes.availability ?? { ok: true, body: { slots: [] } };
    const r = pick ?? { ok: true, body: {} };
    // #1549: the status is real, because the component now tells the two 409s
    // apart. A fake that answered `ok:false` with no status would let a surface
    // gated on the status pass while never being reachable in production.
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** #1336: the reschedule panel runs on the shared picker, so a day is chosen
 *  before any time is offered. The chips read "SUN 21 JUN": never a clock face,
 *  so the /:\d{2}/ slot query stays unambiguous. */
const dayChips = () =>
  screen.findAllByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
const dayChip = async () => (await dayChips())[0];
async function pickDay() {
  await userEvent.click(await dayChip());
}

/** Tap a time and then commit it. A tap only SELECTS since #2605, so every test
 *  that used to move a call with one click needs the second one. */
async function moveTo(slot: HTMLElement) {
  await userEvent.click(slot);
  await userEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
}

/** Parse the JSON body the component POSTed to a path containing `match`. */
function bodyFor(fn: ReturnType<typeof mockFetch>, match: string): Record<string, unknown> {
  const call = fn.mock.calls.find(([u]) => String(u).includes(match));
  return call ? JSON.parse((call[1] as RequestInit).body as string) : {};
}

describe("ManageBooking", () => {
  it("cancels through an in-DOM confirm, not a native confirm()", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const fn = mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    // The confirm is rendered in the page, the native dialog is never used.
    expect(screen.getByText("Cancel this booking?")).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();

    // A reason is mandatory: pick one to enable the confirm button.
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));
    expect(await screen.findByText("This booking is cancelled")).toBeTruthy();
    expect(bodyFor(fn, "/cancel").reason).toBe("booked_by_mistake");
  });

  it("says a reason is required rather than sitting there dead, and still refuses to send", async () => {
    // REVERSED DELIBERATELY (Dan, 2026-09-22). The reason is still mandatory and
    // nothing is sent without one; what changed is that the refusal is SPOKEN.
    // A predicate that disables the only control able to explain itself means the
    // refusal is never said at all, and the lead is left pressing a dead button
    // (L109). The sentence is `validateReason`'s own, which is the same one the
    // server answers with, so the two cannot drift (L41).
    const fn = mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    const yesCancel = () => screen.getByRole("button", { name: /yes, cancel/i }) as HTMLButtonElement;
    expect(yesCancel().disabled).toBe(false);

    await userEvent.click(yesCancel());
    expect(await screen.findByText("Please choose a reason.")).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).includes("/cancel"))).toBe(false);

    // "Other" needs its detail, and says which of the two is missing.
    await userEvent.click(screen.getByRole("radio", { name: /^other/i }));
    await userEvent.click(yesCancel());
    expect(await screen.findByText("Please tell us a bit more.")).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).includes("/cancel"))).toBe(false);

    await userEvent.type(screen.getByRole("textbox", { name: /tell us more/i }), "moving abroad");
    await userEvent.click(yesCancel());
    await waitFor(() => expect(bodyFor(fn, "/cancel").reason).toBe("other"));
  });

  it("surfaces an error when the cancel POST fails (no silent failure)", async () => {
    mockFetch({ cancel: { ok: false, body: {} } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/could not cancel/i)).toBeTruthy();
    // The booking is NOT shown as cancelled when the POST failed.
    expect(screen.queryByText("This booking is cancelled")).toBeNull();
  });

  it("backs out of the cancel confirm with Keep it", async () => {
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep my booking/i }));
    await waitFor(() => expect(screen.queryByText("Cancel this booking?")).toBeNull());
    expect(screen.getByRole("button", { name: /cancel booking/i })).toBeTruthy();
  });

  it("surfaces an error when a reschedule fails", async () => {
    mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
      reschedule: { ok: false, body: { error: "That time was just taken." } },
    });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    // A reason is mandatory before a slot can be picked.
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await pickDay();
    await moveTo(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));

    expect(await screen.findByText("That time was just taken.")).toBeTruthy();
  });

  it("shows the conflict message and does NOT enter the success state on a 409 reschedule conflict", async () => {
    // #439: a concurrent reschedule moved the booking; the loser gets a 409 with
    // the distinct conflict message and must NOT render the "rescheduled" success
    // state at the new time.
    mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
      reschedule: {
        ok: false,
        body: { error: "This booking was just changed. Refresh and try again." },
      },
    });
    const { container } = render(<ManageBooking {...baseProps} />);
    const heroTime = () => container.querySelector("[data-hero-time]")?.textContent;
    const headerTimeBefore = heroTime();

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await pickDay();
    await moveTo(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));

    expect(
      await screen.findByText("This booking was just changed. Refresh and try again."),
    ).toBeTruthy();
    // Success NOT entered: the hero time is unchanged (no setStart to the new slot).
    expect(heroTime()).toBe(headerTimeBefore);
  });

  it("lets a time be picked with no reason set, and moves nothing until the lead commits", async () => {
    // REVERSED DELIBERATELY (Dan, 2026-09-22): "i couldn't click a time without
    // selecting a reason. feels bad to be able to select a date and no time.
    // let's let them choose a time and just tell them the reason is required if
    // they try to submit without it."
    //
    // The tap used to BE the submit, which is why the reason had to be enforced
    // before it: there was no later moment. A tap selects now, so there is one.
    const fn = mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
      reschedule: { ok: true, body: { startsAt: "2026-06-21T15:00:00.000Z" } },
    });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();

    const slot = (await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ })) as HTMLButtonElement;
    expect(slot.disabled).toBe(false);
    await userEvent.click(slot);

    // A tap is not a commitment: nothing has been sent.
    expect(fn.mock.calls.some(([u]) => String(u).includes("/reschedule"))).toBe(false);
    expect(slot.getAttribute("aria-pressed")).toBe("true");

    // The commit names the time, so what is about to happen is on the control.
    const move = () => screen.getByRole("button", { name: /^move my call to/i }) as HTMLButtonElement;
    await userEvent.click(move());
    expect(await screen.findByText("Please choose a reason.")).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).includes("/reschedule"))).toBe(false);

    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    await userEvent.click(move());

    await waitFor(() => expect(bodyFor(fn, "/reschedule").reason).toBe("found_better_time"));
    expect(bodyFor(fn, "/reschedule").start).toBe("2026-06-21T15:00:00.000Z");
  });

  it("offers no commit until a time is picked, so the control never asks for nothing", async () => {
    mockFetch({ availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
    await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ });

    expect(screen.queryByRole("button", { name: /^move my call to/i })).toBeNull();
  });

  // #625: a network rejection (flaky mobile) must not freeze the button in its
  // busy state — the action surfaces an error and re-enables.
  it("surfaces an error and re-enables when the cancel POST rejects at the network layer", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/could not cancel/i)).toBeTruthy();
    // Button is back to its idle label (not stuck on "Cancelling…") and enabled.
    const yesCancel = screen.getByRole("button", { name: /yes, cancel/i }) as HTMLButtonElement;
    expect(yesCancel.disabled).toBe(false);
    expect(screen.queryByText("This booking is cancelled")).toBeNull();
  });

  it("surfaces an error and re-enables the slots when the reschedule POST rejects", async () => {
    let calls = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls++;
      if (String(url).includes("/availability")) {
        return { ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await pickDay();
    const slot = (await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ })) as HTMLButtonElement;
    await moveTo(slot);

    expect(await screen.findByText(/could not reschedule/i)).toBeTruthy();
    // Slot buttons re-enable (not stuck disabled / on "Moving…") so the user can retry.
    const slotAfter = screen.getByRole("button", { name: /^\d{1,2}:\d{2}/ }) as HTMLButtonElement;
    expect(slotAfter.disabled).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  // #627: opening Reschedule must not flash "No times left" while the
  // availability fetch is in flight, nor show it on a failed fetch. Loading,
  // error, and empty are three distinct states (mirrors the Booker).
  it("shows the working signal, not the empty copy, while availability is in flight", async () => {
    // Availability fetch never resolves: the panel stays in its loading state.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    // The visible line and the sr-only polite region carry the same sentence.
    await waitFor(() =>
      expect(screen.getAllByText("Finding the days you can book.").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/all times are taken/i)).toBeNull();
  });

  it("shows an error with Try again when the availability fetch fails, then recovers on retry", async () => {
    let attempt = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        attempt++;
        // First load fails; the retry succeeds with a slot.
        return attempt === 1
          ? ({ ok: false, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response);
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(await screen.findByText("Could not load available times.")).toBeTruthy();
    // Not conflated with the empty state.
    expect(screen.queryByText(/all times are taken/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await pickDay();
    expect(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ })).toBeTruthy();
  });

  it("shows an error when the availability fetch rejects at the network layer", async () => {
    // A rejection (flaky mobile) must land in the error state, not the empty state
    // — the original code had no .catch and mapped everything to an empty list.
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(await screen.findByText("Could not load available times.")).toBeTruthy();
    expect(screen.queryByText(/all times are taken/i)).toBeNull();
  });

  it("shows the empty copy only after a confirmed empty availability response", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        return { ok: true, json: async () => ({ slots: [] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(await screen.findByText(/all times are taken right now/i)).toBeTruthy();
    expect(screen.queryByText("Finding the days you can book.")).toBeNull();
  });

  // #2827: a call booked through an advisor's own link can only move to a time
  // that advisor can take, so the picker must never offer the bucket's pool.
  describe("an advisor link booking (#2827)", () => {
    const POOL_ONLY = "2026-06-21T16:00:00.000Z";
    const ADVISOR_FREE = "2026-06-21T15:00:00.000Z";
    /** A server where the pool has a time the advisor does not. */
    function twoSources() {
      return vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/availability?booking=")) {
          return { ok: true, status: 200, json: async () => ({ slots: [ADVISOR_FREE] }) } as Response;
        }
        if (u.includes("/availability?bucket=")) {
          return { ok: true, status: 200, json: async () => ({ slots: [ADVISOR_FREE, POOL_ONLY] }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
    }
    const zoned = { ...baseProps };

    it("reads the advisor's times by this page's token, never the bucket's pool", async () => {
      const fn = twoSources();
      global.fetch = fn as unknown as typeof fetch;
      render(<ManageBooking {...zoned} rescheduleTimesFrom="advisor" />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      await pickDay();
      const urls = fn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/availability"));
      expect(urls).toEqual(["/api/availability?booking=tok1"]);
      // Only the advisor's one time is a button; the pool-only one is not offered.
      expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(1);
    });

    it("a routed booking still reads the pool, where the pool-only time IS offered", async () => {
      const fn = twoSources();
      global.fetch = fn as unknown as typeof fetch;
      render(<ManageBooking {...zoned} rescheduleTimesFrom="pool" />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      await pickDay();
      const urls = fn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/availability"));
      expect(urls).toEqual(["/api/availability?bucket=411"]);
      expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(2);
    });

    it("says the advisor has nothing left, by name, rather than that all times are taken", async () => {
      mockFetch({ availability: { ok: true, body: { slots: [] } } });
      render(<ManageBooking {...zoned} rescheduleTimesFrom="advisor" />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      expect(
        await screen.findByText(rescheduleNoTimes({ from: "advisor", advisorName: "Aisha Bello" })),
      ).toBeTruthy();
      expect(screen.queryByText(/all times are taken/i)).toBeNull();
    });

    it("a refused read says so in the reschedule's own words and offers no retry", async () => {
      mockFetch({
        availability: { ok: false, status: 404, body: { error: "x", code: "RESCHEDULE_TIMES_UNAVAILABLE" } },
      });
      render(<ManageBooking {...zoned} rescheduleTimesFrom="advisor" />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      expect(await screen.findByText(RESCHEDULE_COPY.unavailable)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    });
  });

  it("shows a still-working cue when a cancel POST hangs (#626)", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/cancel")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ slots: [] }) } as Response);
    }) as unknown as typeof fetch;

    render(<ManageBooking {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    fireEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    vi.useRealTimers();
  });

  // #658: cancel and reschedule share one busy/stalled cue; the cancel hang is
  // covered above. Lock the reschedule hang too so a wedged move POST can't sit
  // on a silent spinner.
  it("shows a still-working cue when a reschedule POST hangs (#658)", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/reschedule")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }),
      } as Response);
    }) as unknown as typeof fetch;

    render(<ManageBooking {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /schedule conflict/i }));
    fireEvent.click(await dayChip());
    const slot = await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ });
    fireEvent.click(slot);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^move my call to/i }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    vi.useRealTimers();
  });

  // #633: the reschedule grid's settled state must be announced, not just the
  // loading skeletons. A polite role=status names the slot count when times
  // load and the empty message when there are none.
  it("announces the slot count via role=status when the reschedule list loads (#633)", async () => {
    mockFetch({
      availability: {
        ok: true,
        body: { slots: ["2026-06-21T15:00:00.000Z", "2026-06-21T16:00:00.000Z"] },
      },
    });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toMatch(/2 times available on/i));
  });

  it("announces the empty message via role=status when no reschedule times (#633)", async () => {
    mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    expect(await screen.findByText(/all times are taken right now/i)).toBeTruthy();
    // Nothing is bookable, so the strip draws nothing at all (#261).
    expect(screen.queryByRole("group", { name: "Available days" })).toBeNull();
  });

  // #1336: the rule the shared picker exists to hold, on this surface. The lead
  // reschedule panel used to render EVERY offered day's times in one flat list,
  // so a lead scrolling it could tap a clock face without ever registering which
  // day it belonged to.
  it("offers no time until a day is chosen (#1336)", async () => {
    mockFetch({
      availability: {
        ok: true,
        body: { slots: ["2026-06-21T15:00:00.000Z", "2026-06-22T15:00:00.000Z"] },
      },
    });
    render(<ManageBooking {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    // Both days are offered, so the load is settled and this is not a spinner.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^(MON|TUE|SUN)/ })).toHaveLength(2),
    );
    expect(screen.queryAllByRole("button", { name: /^\d{1,2}:\d{2}/ })).toHaveLength(0);
    expect(
      screen.getAllByText("Pick a day above to see the times available.").length,
    ).toBeGreaterThan(0);

    await pickDay();
    expect(screen.getAllByRole("button", { name: /^\d{1,2}:\d{2}/ })).toHaveLength(1);
  });

  // #1336: cancelling must not sit beside the times a lead is reading, so while
  // the reschedule panel is open the only way back is "Keep my current time".
  it("hides Cancel booking while rescheduling, and backs out without moving anything", async () => {
    const fn = mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
    });
    render(<ManageBooking {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(screen.queryByRole("button", { name: /cancel booking/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Keep my current time" }));

    // Back to the two actions, and nothing was rescheduled on the way out.
    expect(screen.getByRole("button", { name: /^reschedule$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel booking/i })).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).includes("/reschedule"))).toBe(false);
  });

  // #1338: the page is what someone opens days later from a calendar reminder,
  // so the time is the hero and the heading says how far off the call is.
  describe("the rebuilt page (#1338)", () => {
    /**
     * An instant that is `n` days from now IN THE ZONE THE PAGE DISPLAYS.
     *
     * #1849: the page shows a fixed US zone rather than the host's, so a fixture
     * built at 14:00 host-local is a different calendar day to the one being
     * asserted the moment the host is not that zone. Under CI's TZ=UTC, "today
     * at 14:00 UTC" is tomorrow in New York for most of the day, and the
     * countdown correctly said so.
     *
     * The zone is SET here rather than inherited, which is the general fix: when
     * the ambient configuration is what separates a right answer from a wrong
     * one, a test that reads it has made the host part of the assertion (L504).
     */
    const DISPLAY_ZONE = "America/New_York";
    const inDays = (n: number) =>
      DateTime.now()
        .setZone(DISPLAY_ZONE)
        .plus({ days: n })
        .set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toISO()!;

    it("heads the page with the booking's state, not with facts it states below", () => {
      // REPLACES the countdown heading (#2601). Dan, 2026-09-22, on "Tony, in
      // three days": "i hate this". It was built from the advisor and the date,
      // both of which the page already carries, so it was a duplication rather
      // than only a wording (L605).
      mockFetch({});
      render(<ManageBooking {...baseProps} startsAt={inDays(3)} />);

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(LIVE_COPY.heading);
      expect(screen.queryByText(/in three days/)).toBeNull();
    });

    it("spells the booking's own time, with the year, from the time it currently holds", () => {
      // What the countdown test was really protecting: the page reads the
      // booking's CURRENT time, so a reschedule moves it. With the year, like
      // every other readback of a committed time (#2205, #2579, L118).
      mockFetch({});
      const { unmount } = render(<ManageBooking {...baseProps} startsAt={inDays(0)} />);
      const today = DateTime.now().setZone(DISPLAY_ZONE);
      expect(screen.getByText(new RegExp(String(today.year)))).toBeTruthy();
      unmount();

      render(<ManageBooking {...baseProps} startsAt={inDays(3)} />);
      const then = DateTime.now().setZone(DISPLAY_ZONE).plus({ days: 3 });
      expect(screen.getByText(new RegExp(then.toFormat("MMMM d")))).toBeTruthy();
    });

    // Coverage reassignment and bulk reassign both move a booking, so the name is
    // whoever holds it NOW. The page renders what the server resolved live, so a
    // reassigned booking shows the current advisor and never the original.
    it("shows the advisor it is currently with", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} startsAt={inDays(2)} advisorName="Bea Cover" />);
      expect(screen.getByText("Bea Cover")).toBeTruthy();
      expect(screen.queryByText("Aisha Bello")).toBeNull();
    });

    it("states what, when and who as labelled rows", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} />);

      expect(screen.getByText(LIVE_COPY.whatLabel)).toBeTruthy();
      expect(screen.getByText(LIVE_COPY.whenLabel)).toBeTruthy();
      expect(screen.getByText(LIVE_COPY.youLabel)).toBeTruthy();
      expect(screen.getByText(baseProps.eventName)).toBeTruthy();
      expect(screen.getByText(baseProps.attendeeEmail)).toBeTruthy();
    });

    it("keeps what and when on a booking that is over, rather than dropping them", () => {
      // Caught by LOOKING at the render rather than by a test: the first cut had
      // these rows on the live state only, so a cancelled page said it was
      // cancelled and nothing else. The prior design deliberately kept the time
      // on screen, and the reader opened the page to check exactly that.
      mockFetch({});
      render(<ManageBooking {...baseProps} status="cancelled" />);

      expect(screen.getByText(LIVE_COPY.whatLabel)).toBeTruthy();
      expect(screen.getByText(LIVE_COPY.whenLabel)).toBeTruthy();
      expect(screen.getByText(baseProps.eventName)).toBeTruthy();
    });

    it("marks the booking as booked only while it IS booked", () => {
      mockFetch({});
      const live = render(<ManageBooking {...baseProps} />);
      // The tick sits on the advisor's face. A tick over a cancelled call would
      // contradict the heading directly under it.
      expect(live.container.querySelectorAll("svg").length).toBeGreaterThan(0);
      const liveMark = live.container.querySelector(".rounded-full.border-2");
      expect(liveMark).not.toBeNull();
      live.unmount();

      const dead = render(<ManageBooking {...baseProps} status="cancelled" />);
      expect(dead.container.querySelector(".rounded-full.border-2")).toBeNull();
      dead.unmount();

      const over = render(<ManageBooking {...baseProps} status="completed" />);
      expect(over.container.querySelector(".rounded-full.border-2")).toBeNull();
    });

    it("shows the advisor's photo when there is one", () => {
      mockFetch({});
      const { container } = render(
        <ManageBooking {...baseProps} advisorPhotoUrl="https://lh3.googleusercontent.com/a/x=s96-c" />,
      );

      const img = container.querySelector('img[src^="https://lh3.googleusercontent.com"]');
      expect(img).not.toBeNull();
      // Decorative: the name is right beside it, so a screen reader announcing
      // the face as well would say the same fact twice.
      expect(img!.getAttribute("alt")).toBe("");
      expect(screen.getByText("Aisha Bello")).toBeTruthy();
    });

    it("draws the initials when there is no photo", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} advisorPhotoUrl={null} />);

      // Every way a photo can be missing lands here, and none of them is a state
      // a lead should be able to tell from another: no assignee, no address on
      // file, a refused directory, or an agent who has never set one.
      expect(screen.getByText("AB")).toBeTruthy();
      expect(document.querySelector("img")).toBeNull();
    });

    it("falls back to the initials when the photo will not load", () => {
      mockFetch({});
      const { container } = render(
        <ManageBooking {...baseProps} advisorPhotoUrl="https://lh3.googleusercontent.com/a/gone=s96-c" />,
      );

      // The case a server render cannot see: the URL was good when the page was
      // built and the browser could not fetch it. Without this the lead gets a
      // broken image icon where a face should be.
      fireEvent.error(container.querySelector("img")!);
      expect(screen.getByText("AB")).toBeTruthy();
      expect(container.querySelector("img")).toBeNull();
    });

    it("renders no name at all when the advisor cannot be resolved", () => {
      mockFetch({});
      render(
        <ManageBooking {...baseProps} startsAt={inDays(2)} advisorName={null} advisorRole={null} />,
      );
      // No placeholder standing in for the missing name. "Your advisor will call
      // you at ..." is the intended impersonal line and is asserted below; what
      // must never appear is a stand-in for the NAME.
      expect(screen.queryByText(/\b(unknown|not set|unassigned|n\/a|tbc|advisor name)\b/i)).toBeNull();
      // The heading says the state, which is knowable whoever the advisor is, so
      // it can no longer be a half sentence with the name missing out of it.
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(LIVE_COPY.heading);
      // And the face goes with the name: an initials circle with nothing in it is
      // worse than no circle.
      expect(document.querySelector("img")).toBeNull();
      expect(screen.queryByText(baseProps.advisorRole)).toBeNull();
      // The rest of the page still works: the phone line never names anybody.
      expect(screen.getByText(/Your advisor will call you at/)).toBeTruthy();
    });

    // Nothing on the agent record says how a person wants to be referred to, a
    // name does not tell you, and a guess misgenders a colleague in front of a
    // customer. So no rendered state of this page may carry one.
    it("uses no gendered pronoun in any state", async () => {
      const pronouns = /\b(he|him|his|she|her|hers)\b/i;
      mockFetch({ availability: { ok: true, body: { slots: [] } } });
      const { container } = render(<ManageBooking {...baseProps} />);
      expect(container.textContent).not.toMatch(pronouns);

      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      expect(container.textContent).not.toMatch(pronouns);
      await userEvent.click(screen.getByRole("button", { name: "Keep my current time" }));

      await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
      expect(container.textContent).not.toMatch(pronouns);

      const { container: cancelled } = render(
        <ManageBooking {...baseProps} status="cancelled" />,
      );
      expect(cancelled.textContent).not.toMatch(pronouns);
    });

    // A completed call is terminal too: nothing to reschedule or cancel, and no
    // prep note for a call that already happened.
    it("offers no live actions on a completed booking", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} status="completed" />);
      expect(screen.queryByRole("button", { name: /^reschedule$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /cancel booking/i })).toBeNull();
      expect(screen.queryByText("Before the call")).toBeNull();
      expect(screen.getByText("This call has happened")).toBeTruthy();
    });

    it("marks the time cancelled rather than dropping it, and offers a way back", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} status="cancelled" />);
      // The time is still ON the page rather than dropped, and marked in words
      // beside it: colour is never the only carrier of a state (L20).
      expect(screen.getByText("Cancelled")).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        DONE_COPY.cancelledHeading,
      );
      expect(screen.getByRole("link", { name: /book a new time/i })).toBeTruthy();
    });

    // Cancel is not a peer of Reschedule: an accidental cancel costs far more
    // than an accidental reschedule click. Still a real control at rest (L49)
    // and still a 44px target, just not equal weight.
    it("gives Cancel booking less weight than Reschedule while staying a real control", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} />);
      const reschedule = screen.getByRole("button", { name: /^reschedule$/i });
      const cancel = screen.getByRole("button", { name: /cancel booking/i });
      expect(reschedule.className).toContain("pn-btn");
      // Underlined rose text, not a bordered button.
      expect(cancel.className).toContain("underline");
      expect(cancel.className).not.toContain("border-[var(--error)]");
      // Both keep a 44px target.
      expect(reschedule.className).toContain("min-h-[44px]");
      expect(cancel.className).toContain("min-h-[44px]");
    });

    // #2215: the confirmation is reachable ONLY from the action on this page. It
    // used to be gated on `status === "rescheduled"`, which a reschedule writes
    // onto the row permanently, so every later visit to the manage link was told
    // its call had just moved and that an invite the reader was standing in was
    // still on its way.
    it("states the outcome of a reschedule done on this page", async () => {
      mockFetch({
        availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
        reschedule: { ok: true, body: { startsAt: "2026-06-21T15:00:00.000Z" } },
      });
      render(<ManageBooking {...baseProps} />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
      await pickDay();
      await moveTo(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));

      // The two facts the card beneath cannot show: a fresh invite is coming, and
      // the time they were holding is gone. The new time itself is the hero above,
      // so it is not said a second time.
      expect(await screen.findByText(RESCHEDULE_COPY.moved)).toBeTruthy();
      expect(screen.getByText(movedNote(baseProps.attendeeEmail))).toBeTruthy();
    });

    // #2215, the defect itself: Dan opened the manage link FROM the reschedule
    // invite and was told his call was moved, having moved nothing.
    it("says nothing about a move on a visit that moved nothing", () => {
      mockFetch({});
      render(<ManageBooking {...baseProps} status="rescheduled" />);

      expect(screen.queryByText(RESCHEDULE_COPY.moved)).toBeNull();
      expect(screen.queryByText(/A new invite is on its way/)).toBeNull();
      // And the page is still the ordinary live one.
      expect(screen.getByRole("button", { name: /^reschedule$/i })).toBeTruthy();
    });

    // Reopening the panel is the lead saying this time is not right either, so the
    // confirmation of the last move must not sit over the times they are reading.
    it("clears the confirmation when the reschedule panel is opened again", async () => {
      mockFetch({
        availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
        reschedule: { ok: true, body: { startsAt: "2026-06-21T15:00:00.000Z" } },
      });
      render(<ManageBooking {...baseProps} />);
      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
      await pickDay();
      await moveTo(await screen.findByRole("button", { name: /^\d{1,2}:\d{2}/ }));
      expect(await screen.findByText(RESCHEDULE_COPY.moved)).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
      expect(screen.queryByText(RESCHEDULE_COPY.moved)).toBeNull();

      // And it does not come back when they leave the panel without moving anything.
      await userEvent.click(screen.getByRole("button", { name: "Keep my current time" }));
      expect(screen.queryByText(RESCHEDULE_COPY.moved)).toBeNull();
    });
  });

  // #634: a cancelled booking must not dead-end the lead. The terminal state
  // offers a warm "Book a new time" link back into the same bucket, and since
  // #2982 that link carries the lead's identity (the server builds it).
  it("offers a rebook link into the same bucket after cancelling", async () => {
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText("This booking is cancelled")).toBeTruthy();
    const rebook = screen.getByRole("link", { name: /book a new time/i });
    expect(rebook.getAttribute("href")).toBe(baseProps.rebookHref);
  });

  it("shows the rebook link when the booking is already cancelled on load", () => {
    render(<ManageBooking {...baseProps} status="cancelled" />);
    const rebook = screen.getByRole("link", { name: /book a new time/i });
    expect(rebook.getAttribute("href")).toBe(baseProps.rebookHref);
  });

  it("does not show a rebook link on an active booking", () => {
    render(<ManageBooking {...baseProps} />);
    expect(screen.queryByRole("link", { name: /book a new time/i })).toBeNull();
  });
});

// #1000: the searchable full-IANA fallback #219 gave the booker must also exist
// on the manage/reschedule screen, so a lead whose device zone is wrong AND whose
// correct zone isn't curated can still pick it here too.
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

// #1549: the manage page had the same dead end the booker lost in #1319. A lead who
// clicks the link in their confirmation email to move their call can lose the time
// while they are deciding, and a refusal with nowhere to go risks them simply not
// rescheduling and not turning up. Same customer, same moment, arguably worse: this
// person already HAS a call and is trying to keep it.
describe("the soonest times still open, under a refused move (#1549)", () => {
  const SLOTS = [
    "2026-06-21T15:00:00.000Z",
    "2026-06-21T16:00:00.000Z",
    "2026-06-21T17:00:00.000Z",
  ];

  /** Open the panel, pick a reason, and tap the FIRST time offered. */
  async function moveIntoFirstTime(
    reschedule: FetchResult,
    beforeTap?: (container: HTMLElement) => void,
  ) {
    const fn = mockFetch({ availability: { ok: true, body: { slots: SLOTS } }, reschedule });
    const view = render(<ManageBooking {...baseProps} />);
    beforeTap?.(view.container);
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    await pickDay();
    const times = await screen.findAllByRole("button", { name: /^\d{1,2}:\d{2}/ });
    await moveTo(times[0]);
    return { fn, container: view.container };
  }

  it("offers the soonest times still open, leaving out the one that went", async () => {
    const heroBefore: { text?: string | null } = {};
    const { container } = await moveIntoFirstTime(
      {
        ok: false,
        status: 409,
        body: { error: "That time was just taken.", reason: "reschedule_slot_taken" },
      },
      (c) => {
        heroBefore.text = c.querySelector("[data-hero-time]")?.textContent;
      },
    );

    expect(await screen.findByText("That time was just taken.")).toBeTruthy();
    const chips = await screen.findAllByTestId("nearest-time");
    // The refused time is the one time we KNOW is gone, so offering it back would be
    // the same dead end wearing a helpful face.
    expect(chips.map((c) => c.getAttribute("data-slot"))).toEqual([SLOTS[1], SLOTS[2]]);
    // Nothing moved: the hero still shows the call's original time.
    expect(container.querySelector("[data-hero-time]")?.textContent).toBe(heroBefore.text);
  });

  it("says the call is still where it was, rather than implying anything was lost", async () => {
    await moveIntoFirstTime({
      ok: false,
      status: 409,
      body: { error: "That time was just taken.", reason: "reschedule_slot_taken" },
    });
    await screen.findAllByTestId("nearest-time");
    expect(screen.getByText(NEAREST_TIMES_COPY.hintMove)).toBeTruthy();
    // The booker's wording promises saved DETAILS, which is not the reassurance a
    // person moving an existing call needs.
    expect(screen.queryByText(NEAREST_TIMES_COPY.hint)).toBeNull();
  });

  it("tapping an offered time selects its day and does NOT move the call", async () => {
    const { fn } = await moveIntoFirstTime({
      ok: false,
      status: 409,
      body: { error: "That time was just taken.", reason: "reschedule_slot_taken" },
    });
    const chips = await screen.findAllByTestId("nearest-time");
    await userEvent.click(chips[0]);

    // One reschedule POST, the refused one. Moving the call on a glance, right after
    // the product has already surprised them once, turns a look into a commitment.
    const posts = fn.mock.calls.filter(([u]) => String(u).includes("/reschedule"));
    expect(posts.length).toBe(1);
  });

  it("re-reads availability, so the time that went is not left tappable", async () => {
    const { fn } = await moveIntoFirstTime({
      ok: false,
      status: 409,
      body: { error: "That time was just taken.", reason: "reschedule_slot_taken" },
    });
    await screen.findAllByTestId("nearest-time");
    const loads = fn.mock.calls.filter(([u]) => String(u).includes("/api/availability"));
    expect(loads.length).toBeGreaterThan(1);
  });

  it("offers NOTHING when the booking moved under the reader, so refresh stands alone", async () => {
    // #439 is the other 409: the page is showing a time that is no longer the
    // booking's, so a list of times to move it into walks them back into the same
    // refusal. The two causes need opposite answers (L11).
    await moveIntoFirstTime({
      ok: false,
      status: 409,
      body: {
        error: "This booking was just changed. Refresh and try again.",
        reason: "reschedule_conflict",
      },
    });
    expect(
      await screen.findByText("This booking was just changed. Refresh and try again."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("nearest-times")).toBeNull());
  });

  it("offers nothing on a failure that never measured whether the time is gone", async () => {
    // A verify outage means we could not check, which is not the same as knowing a
    // time went, and must not be dressed up as it.
    await moveIntoFirstTime({
      ok: false,
      status: 503,
      body: { error: "Could not check that time just now.", reason: "reschedule_verify_unavailable" },
    });
    expect(await screen.findByText("Could not check that time just now.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("nearest-times")).toBeNull());
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// #2957: the details block overflowed the card at 390px. jsdom does no layout, so
// the overflow itself was measured with a headless browser at 390 and 320px in both
// themes; this pins the three classes that fix it, so a refactor back to a bare
// `1fr` (whose min-content floor is what widened the column) fails here.
describe("ManageBooking details fit a phone (#2957)", () => {
  it("lets the value column shrink and the zone picker fill it", () => {
    mockFetch({});
    const { container } = render(<ManageBooking {...baseProps} />);
    const dl = container.querySelector("dl")!;
    expect(dl.className).toContain("grid-cols-[64px_minmax(0,1fr)]");
    for (const dd of dl.querySelectorAll("dd")) expect(dd.className).toContain("min-w-0");
    const picker = container.querySelector("#manage-tz")!.parentElement!;
    expect(picker.className).toContain("min-w-0");
    expect(picker.className).toContain("flex-1");
  });
});

// #1334: the number the call will come FROM, said beside the number the lead will be
// called AT, so a lead can save it before the call and get past call screening.
describe("ManageBooking calling number (#1334)", () => {
  it("names the calling number when it is known", () => {
    mockFetch({});
    render(<ManageBooking {...baseProps} callingNumber="+12197588170" />);
    expect(screen.getByText(callComesFrom("+12197588170")!)).toBeTruthy();
  });

  it("says nothing about a calling number when it is not known", () => {
    mockFetch({});
    const { container } = render(<ManageBooking {...baseProps} callingNumber={null} />);
    expect(container.textContent).not.toMatch(/come from/i);
    // The lead's own number is still there: only the calling line is absent.
    expect(screen.getByText(/Your advisor will call you at/)).toBeTruthy();
  });

  it("does not show it on a call that is over", () => {
    mockFetch({});
    const { container } = render(<ManageBooking {...baseProps} status="cancelled" callingNumber="+12197588170" />);
    expect(container.textContent).not.toMatch(/come from/i);
  });
});
