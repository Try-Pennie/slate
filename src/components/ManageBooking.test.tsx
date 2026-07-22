// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageBooking from "@/components/ManageBooking";
import { RESCHEDULE_REASONS, CANCEL_REASONS } from "@/lib/booking/core";

// Regression coverage for the booker hardening (#168): cancel must use an
// in-DOM confirm (not native confirm()) and surface a failed POST instead of
// silently doing nothing; a failed reschedule must surface too.

const baseProps = {
  token: "tok1",
  bucketCode: "411",
  startsAt: "2026-06-20T15:00:00.000Z",
  status: "confirmed",
  eventName: "Senior Loan Advisor Call",
  // #346: reason options are now props (server-resolved); coded defaults keep the
  // reason-label assertions below valid.
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  theme: "light" as const,
};

type FetchResult = { ok: boolean; body?: unknown };
function mockFetch(routes: { cancel?: FetchResult; reschedule?: FetchResult; availability?: FetchResult }) {
  const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url);
    const pick = u.includes("/cancel")
      ? routes.cancel
      : u.includes("/reschedule")
        ? routes.reschedule
        : routes.availability ?? { ok: true, body: { slots: [] } };
    const r = pick ?? { ok: true, body: {} };
    return { ok: r.ok, json: async () => r.body ?? {} } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
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
    expect(await screen.findByText("This booking is cancelled.")).toBeTruthy();
    expect(bodyFor(fn, "/cancel").reason).toBe("booked_by_mistake");
  });

  it("requires a reason before cancelling (button disabled until chosen)", async () => {
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    const yesCancel = () => screen.getByRole("button", { name: /yes, cancel/i }) as HTMLButtonElement;
    expect(yesCancel().disabled).toBe(true);

    // Choosing "Other" still requires the free-text detail before it enables.
    await userEvent.click(screen.getByRole("radio", { name: /^other/i }));
    expect(yesCancel().disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox", { name: /tell us more/i }), "moving abroad");
    expect(yesCancel().disabled).toBe(false);
  });

  it("surfaces an error when the cancel POST fails (no silent failure)", async () => {
    mockFetch({ cancel: { ok: false, body: {} } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText(/could not cancel/i)).toBeTruthy();
    // The booking is NOT shown as cancelled when the POST failed.
    expect(screen.queryByText("This booking is cancelled.")).toBeNull();
  });

  it("backs out of the cancel confirm with Keep it", async () => {
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
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
    const slot = await screen.findByRole("button", { name: /:\d{2}/ });
    await userEvent.click(slot);

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
    const headerTimeBefore = container.querySelector("p span.tabular-nums")?.textContent;

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /schedule conflict/i }));
    const slot = await screen.findByRole("button", { name: /:\d{2}/ });
    await userEvent.click(slot);

    expect(
      await screen.findByText("This booking was just changed. Refresh and try again."),
    ).toBeTruthy();
    // Success NOT entered: the header time is unchanged (no setStart to the new slot).
    expect(container.querySelector("p span.tabular-nums")?.textContent).toBe(headerTimeBefore);
  });

  it("requires a reason before a reschedule slot can be picked, and sends it", async () => {
    const fn = mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
      reschedule: { ok: true, body: { startsAt: "2026-06-21T15:00:00.000Z" } },
    });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    // Slots are visible but disabled until a reason is chosen.
    const slot = (await screen.findByRole("button", { name: /:\d{2}/ })) as HTMLButtonElement;
    expect(slot.disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    expect(slot.disabled).toBe(false);
    await userEvent.click(slot);

    await waitFor(() => expect(bodyFor(fn, "/reschedule").reason).toBe("found_better_time"));
    expect(bodyFor(fn, "/reschedule").start).toBe("2026-06-21T15:00:00.000Z");
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
    expect(screen.queryByText("This booking is cancelled.")).toBeNull();
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
    const slot = (await screen.findByRole("button", { name: /:\d{2}/ })) as HTMLButtonElement;
    await userEvent.click(slot);

    expect(await screen.findByText(/could not reschedule/i)).toBeTruthy();
    // Slot buttons re-enable (not stuck disabled / on "Moving…") so the user can retry.
    const slotAfter = screen.getByRole("button", { name: /:\d{2}/ }) as HTMLButtonElement;
    expect(slotAfter.disabled).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  // #627: opening Reschedule must not flash "No times left" while the
  // availability fetch is in flight, nor show it on a failed fetch. Loading,
  // error, and empty are three distinct states (mirrors the Booker).
  it("shows loading skeletons, not the empty copy, while availability is in flight", async () => {
    // Availability fetch never resolves: the slot list stays in its loading state.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    expect(screen.queryByText(/no times left/i)).toBeNull();
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

    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
    // Not conflated with the empty state.
    expect(screen.queryByText(/no times left/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /:\d{2}/ })).toBeTruthy();
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

    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
    expect(screen.queryByText(/no times left/i)).toBeNull();
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

    // The visible empty copy carries the trailing "pick another"; the sr-only
    // status region says just "No times left", so target the visible line.
    expect(await screen.findByText(/no times left, pick another/i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toMatch(/loading/i);
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
    const slot = await screen.findByRole("button", { name: /:\d{2}/ });

    vi.useFakeTimers();
    fireEvent.click(slot);
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
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toMatch(/2 times available/i));
  });

  it("announces the empty message via role=status when no reschedule times (#633)", async () => {
    mockFetch({ availability: { ok: true, body: { slots: [] } } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    expect(await screen.findByText(/no times left, pick another/i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/no times/i);
  });

  // #634: a cancelled booking must not dead-end the lead. The terminal state
  // offers a warm "Book a new time" link back into the same bucket.
  it("offers a rebook link into the same bucket after cancelling", async () => {
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));

    expect(await screen.findByText("This booking is cancelled.")).toBeTruthy();
    const rebook = screen.getByRole("link", { name: /book a new time/i });
    expect(rebook.getAttribute("href")).toBe("/book?xbc=411");
  });

  it("shows the rebook link when the booking is already cancelled on load", () => {
    render(<ManageBooking {...baseProps} status="cancelled" />);
    const rebook = screen.getByRole("link", { name: /book a new time/i });
    expect(rebook.getAttribute("href")).toBe("/book?xbc=411");
  });

  it("does not show a rebook link on an active booking", () => {
    render(<ManageBooking {...baseProps} />);
    expect(screen.queryByRole("link", { name: /book a new time/i })).toBeNull();
  });
});

// #1000: the searchable full-IANA fallback #219 gave the booker must also exist
// on the manage/reschedule screen, so a lead whose device zone is wrong AND whose
// correct zone isn't curated can still pick it here too.
describe("ManageBooking timezone fallback", () => {
  it("applies a non-curated zone picked from the 'more zones' search and collapses it", async () => {
    mockFetch({});
    render(<ManageBooking {...baseProps} />);
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
    mockFetch({});
    render(<ManageBooking {...baseProps} />);
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});
