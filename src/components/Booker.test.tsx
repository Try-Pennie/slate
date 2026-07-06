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

afterEach(() => vi.useRealTimers());
