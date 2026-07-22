// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";

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
};

async function fillAndConfirm() {
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
        return { ok: true, json: async () => ({ ...availability, slots: [] }) } as Response;
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
    await screen.findByRole("button", { name: /:\d{2}/ });
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/1 time available/i);
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

describe("Booker availability race on month change (#629)", () => {
  // Rapid month navigation issues overlapping availability fetches. If the older
  // (stale) month's response resolves last, its slots must NOT overwrite the
  // newer month the user actually landed on. Reproduced with two months both in
  // the 4-day horizon (today anchored to Jan 30 so Feb 1 still fetches).
  it("ignores a stale month's response that resolves after the newer month's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));

    const janSlots = ["2026-01-30T15:00:00.000Z", "2026-01-30T18:00:00.000Z"];
    const febSlots = ["2026-02-01T19:00:00.000Z"];
    const respFor = (url: string) =>
      url.includes("from=2026-02")
        ? { ...availability, slots: febSlots }
        : { ...availability, slots: janSlots };

    const pending: { url: string; settle: () => void }[] = [];
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const u = decodeURIComponent(String(url));
      return new Promise<Response>((resolve) => {
        pending.push({
          url: u,
          settle: () => resolve({ ok: true, json: async () => respFor(u) } as Response),
        });
      });
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} layout="month" />);

    // Settle the initial Jan load → two Jan slots on screen.
    await act(async () => {
      pending[0]!.settle();
      await Promise.resolve();
    });
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(2);

    // Rapid nav: Next (Feb, older request) then Prev (Jan, newest request).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    });

    const feb = pending.find((p) => p.url.includes("from=2026-02"))!;
    const janNewest = pending[pending.length - 1]!;
    // Newest (Jan) resolves first; the stale Feb resolves last and must be dropped.
    await act(async () => {
      janNewest.settle();
      await Promise.resolve();
    });
    await act(async () => {
      feb.settle();
      await Promise.resolve();
    });

    // Still the Jan month the user landed on: two slots, not Feb's single slot.
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(2);
    vi.useRealTimers();
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
    await screen.findByRole("button", { name: /:\d{2}/ });

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
    expect(await screen.findByText(/couldn.t load available times/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /:\d{2}/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    // The retry refetches, so the real slot appears and the error clears.
    expect(await screen.findByRole("button", { name: /:\d{2}/ })).toBeTruthy();
    expect(screen.queryByText(/couldn.t load available times/i)).toBeNull();
  });

  it("shows the empty-month message and disables paging past an empty future month (canNext cap)", async () => {
    // Anchor time so "next month" sits entirely beyond the ~4-day availability
    // horizon: the current month has a slot, the next does not. (The strip-layout
    // empty copy is already locked by the #585 test; this drives the month layout
    // to also pin the canNext cap.)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/availability")) {
        return {
          ok: true,
          json: async () => ({ ...availability, slots: ["2026-01-16T15:00:00.000Z"] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ startsAt: slotIso }) } as Response;
    }) as unknown as typeof fetch;

    render(<Booker {...baseProps} layout="month" />);

    // January loaded with a slot, so paging forward is allowed.
    await screen.findByRole("button", { name: /:\d{2}/ });
    const nextInJan = screen.getByRole("button", { name: /next month/i }) as HTMLButtonElement;
    expect(nextInJan.disabled).toBe(false);

    // February is beyond the horizon: it resolves empty without a fetch.
    await act(async () => {
      fireEvent.click(nextInJan);
      await Promise.resolve();
    });

    // The empty month is stated honestly and paging further is now blocked.
    expect(screen.getAllByText(/all times are taken/i).length).toBeGreaterThan(0);
    const nextInFeb = screen.getByRole("button", { name: /next month/i }) as HTMLButtonElement;
    expect(nextInFeb.disabled).toBe(true);

    vi.useRealTimers();
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
