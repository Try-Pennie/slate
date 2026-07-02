import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminBookingActions from "@/components/AdminBookingActions";

// #326 admin reschedule/cancel: a reason is mandatory (server + UI), recorded
// with initiator='admin'. These cover the UI gating + that the reason is sent.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const AGENTS = [
  { id: "ag-1", name: "Bea Agent", email: "bea@x.com", bookable: true },
  { id: "ag-2", name: "Cole Agent", email: "cole@x.com", bookable: true },
];

function mockFetch(opts?: {
  /** Custom responder for the reassign POST, given its parsed body. */
  reassign?: (body: Record<string, unknown>) => Response;
}) {
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/availability")) {
      return { ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response;
    }
    if (u.includes("/api/admin/agents")) {
      return { ok: true, json: async () => ({ agents: AGENTS }) } as Response;
    }
    if (u.includes("/reassign") && opts?.reassign) {
      return opts.reassign(JSON.parse((init?.body as string) ?? "{}"));
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

  // #563: the at-cap path (DAILY_CAP_EXCEEDED 409 -> warning + 'Reassign anyway'
  // re-posting overrideCap:true) is the one reassign state not exercised in #556
  // (no over-cap booking to trigger it locally). Force the 409 here.
  function reassignPicks(fn: ReturnType<typeof mockFetch>) {
    return fn.mock.calls.filter(([u]) => String(u).includes("/bk1/reassign"));
  }

  it("at-cap reassign surfaces the warning, then re-posts with overrideCap:true on confirm", async () => {
    // First (overrideCap:false) attempt is declined at-cap; the override re-post succeeds.
    const fn = mockFetch({
      reassign: (body) =>
        body.overrideCap
          ? ({ ok: true, json: async () => ({ ok: true }) } as Response)
          : ({
              ok: false,
              json: async () => ({ code: "DAILY_CAP_EXCEEDED", day: "Mon, Jun 22" }),
            } as Response),
    });
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" currentAgentId="ag-9" />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /bea agent/i }));

    // The warning names the at-cap agent + day; the first post carried overrideCap:false.
    const warn = await screen.findByText(/at their daily cap/i);
    expect(warn.textContent).toContain("bea@x.com");
    expect(warn.textContent).toContain("Mon, Jun 22");
    expect(JSON.parse((reassignPicks(fn)[0][1] as RequestInit).body as string).overrideCap).toBe(false);

    // Two-step override: 'Reassign anyway' re-posts the same agent with overrideCap:true.
    await userEvent.click(screen.getByRole("button", { name: /reassign anyway/i }));
    const posts = reassignPicks(fn);
    expect(posts).toHaveLength(2);
    const override = JSON.parse((posts[1][1] as RequestInit).body as string);
    expect(override.overrideCap).toBe(true);
    expect(override.agentEmail).toBe("bea@x.com");
    expect(override.reason).toBe("owner_reassignment");
    expect(refresh).toHaveBeenCalled();
  });

  it("dismissing the at-cap warning returns to the picker without re-posting", async () => {
    const fn = mockFetch({
      reassign: () =>
        ({ ok: false, json: async () => ({ code: "DAILY_CAP_EXCEEDED", day: "" }) } as Response),
    });
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /bea agent/i }));
    await screen.findByText(/at their daily cap/i);

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.queryByText(/at their daily cap/i)).toBeNull();
    // Picker is back (search field), and no override was sent.
    expect(screen.getByLabelText(/search agents/i)).toBeTruthy();
    expect(reassignPicks(fn)).toHaveLength(1);
  });

  // #625: a network rejection must surface an error and re-enable the control,
  // never leave it frozen in its busy state.
  it("surfaces an error and re-enables when the admin cancel POST rejects", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm cancel/i }));

    expect(await screen.findByText(/could not cancel/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm cancel/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces an error and re-enables the slots when the admin reschedule POST rejects", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        return { ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    const slot = (await screen.findByRole("button", { name: /Sun/i })) as HTMLButtonElement;
    await userEvent.click(slot);

    expect(await screen.findByText(/could not reschedule/i)).toBeTruthy();
    const slotAfter = screen.getByRole("button", { name: /Sun/i }) as HTMLButtonElement;
    expect(slotAfter.disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces an error and re-enables when the admin reassign POST rejects", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/admin/agents")) {
        return { ok: true, json: async () => ({ agents: AGENTS }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" currentAgentId="ag-9" />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /bea agent/i }));

    expect(await screen.findByText(/could not reassign/i)).toBeTruthy();
    const agentBtn = screen.getByRole("button", { name: /bea agent/i }) as HTMLButtonElement;
    expect(agentBtn.disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
