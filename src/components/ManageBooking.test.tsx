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
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    const pick = u.includes("/cancel")
      ? routes.cancel
      : u.includes("/reschedule")
        ? routes.reschedule
        : routes.availability ?? { ok: true, body: { slots: [] } };
    const r = pick ?? { ok: true, body: {} };
    return { ok: r.ok, json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
}

describe("ManageBooking", () => {
  it("cancels through an in-DOM confirm, not a native confirm()", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    mockFetch({ cancel: { ok: true } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
    // The confirm is rendered in the page, the native dialog is never used.
    expect(screen.getByText("Cancel this booking?")).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /yes, cancel/i }));
    expect(await screen.findByText("This booking is cancelled.")).toBeTruthy();
  });

  it("surfaces an error when the cancel POST fails (no silent failure)", async () => {
    mockFetch({ cancel: { ok: false, body: {} } });
    render(<ManageBooking {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel booking/i }));
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
    const slot = await screen.findByRole("button", { name: /Sun/i });
    await userEvent.click(slot);

    expect(await screen.findByText("That time was just taken.")).toBeTruthy();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
