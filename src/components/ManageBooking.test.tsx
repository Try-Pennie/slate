import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManageBooking from "@/components/ManageBooking";

// Regression coverage for the booker hardening (#168): cancel must use an
// in-DOM confirm (not native confirm()) and surface a failed POST instead of
// silently doing nothing; a failed reschedule must surface too.

const baseProps = {
  token: "tok1",
  bucketCode: "411",
  startsAt: "2026-06-20T15:00:00.000Z",
  status: "confirmed",
  eventName: "Senior Loan Advisor Call",
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
    const slot = await screen.findByRole("button", { name: /Sun/i });
    await userEvent.click(slot);

    expect(await screen.findByText("That time was just taken.")).toBeTruthy();
  });

  it("requires a reason before a reschedule slot can be picked, and sends it", async () => {
    const fn = mockFetch({
      availability: { ok: true, body: { slots: ["2026-06-21T15:00:00.000Z"] } },
      reschedule: { ok: true, body: { startsAt: "2026-06-21T15:00:00.000Z" } },
    });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    // Slots are visible but disabled until a reason is chosen.
    const slot = (await screen.findByRole("button", { name: /Sun/i })) as HTMLButtonElement;
    expect(slot.disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    expect(slot.disabled).toBe(false);
    await userEvent.click(slot);

    await waitFor(() => expect(bodyFor(fn, "/reschedule").reason).toBe("found_better_time"));
    expect(bodyFor(fn, "/reschedule").start).toBe("2026-06-21T15:00:00.000Z");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
