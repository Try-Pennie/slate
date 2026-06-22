import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminBookingActions from "@/components/AdminBookingActions";

// #326 admin reschedule/cancel: a reason is mandatory (server + UI), recorded
// with initiator='admin'. These cover the UI gating + that the reason is sent.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function mockFetch() {
  const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/availability")) {
      return { ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function bodyFor(fn: ReturnType<typeof mockFetch>, match: string): Record<string, unknown> {
  const call = fn.mock.calls.find(([u]) => String(u).includes(match));
  return call ? JSON.parse((call[1] as RequestInit).body as string) : {};
}

beforeEach(() => vi.clearAllMocks());

describe("AdminBookingActions", () => {
  it("shows no actions for a terminal booking", () => {
    mockFetch();
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="cancelled" />);
    expect(screen.queryByRole("button", { name: /reschedule/i })).toBeNull();
  });

  it("requires a reason before an admin cancel, then sends it", async () => {
    const fn = mockFetch();
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    const confirm = () => screen.getByRole("button", { name: /confirm cancel/i }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    expect(confirm().disabled).toBe(false);
    await userEvent.click(confirm());

    expect(bodyFor(fn, "/api/admin/bookings/bk1/cancel").reason).toBe("booked_by_mistake");
    expect(refresh).toHaveBeenCalled();
  });

  it("requires a reason before an admin reschedule slot, then sends it", async () => {
    const fn = mockFetch();
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    const slot = (await screen.findByRole("button", { name: /Sun/i })) as HTMLButtonElement;
    expect(slot.disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    expect(slot.disabled).toBe(false);
    await userEvent.click(slot);

    const body = bodyFor(fn, "/api/admin/bookings/bk1/reschedule");
    expect(body.reason).toBe("found_better_time");
    expect(body.start).toBe("2026-06-21T15:00:00.000Z");
  });
});
