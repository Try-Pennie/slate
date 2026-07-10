// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    const slot = (await screen.findByRole("button", { name: /:\d{2}/ })) as HTMLButtonElement;
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
    const slot = (await screen.findByRole("button", { name: /:\d{2}/ })) as HTMLButtonElement;
    await userEvent.click(slot);

    expect(await screen.findByText(/could not reschedule/i)).toBeTruthy();
    const slotAfter = screen.getByRole("button", { name: /:\d{2}/ }) as HTMLButtonElement;
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

  // #627: the reschedule slot list and the reassign agent list must show
  // distinct loading / error / empty states, never "no times"/"no agents"
  // while the fetch is still in flight or after it failed.
  it("shows loading skeletons, not the empty copy, while reschedule availability loads", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    expect(screen.queryByText(/no open times/i)).toBeNull();
  });

  it("shows an error with Try again when reschedule availability fails, then recovers on retry", async () => {
    let attempt = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        attempt++;
        return attempt === 1
          ? ({ ok: false, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }) } as Response);
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
    expect(screen.queryByText(/no open times/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /:\d{2}/ })).toBeTruthy();
  });

  it("shows the empty copy only after a confirmed empty reschedule response", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        return { ok: true, json: async () => ({ slots: [] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    // Visible copy is "No open times."; the sr-only status says "No open times",
    // so target the visible line by its trailing period.
    expect(await screen.findByText(/no open times\./i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toMatch(/loading/i);
  });

  it("shows loading skeletons, not the empty copy, while the reassign agent list loads", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));

    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    expect(screen.queryByText(/no matching agents/i)).toBeNull();
  });

  it("shows an error with Try again when the reassign agent list fails, then recovers on retry", async () => {
    let attempt = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/admin/agents")) {
        attempt++;
        return attempt === 1
          ? ({ ok: false, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({ agents: AGENTS }) } as Response);
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" currentAgentId="ag-9" />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));

    expect(await screen.findByText(/couldn.t load/i)).toBeTruthy();
    expect(screen.queryByText(/no matching agents/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /bea agent/i })).toBeTruthy();
  });

  it("shows a still-working cue when an admin cancel POST hangs (#626)", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/cancel")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }) as unknown as typeof fetch;

    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByRole("radio", { name: /booked by mistake/i }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /confirm cancel/i }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    vi.useRealTimers();
  });

  // #658: the still-working cue shares one busy/stalled mechanism across all
  // three admin actions; the cancel path proves it above. Lock reschedule and
  // reassign too so a wedged POST on either can't sit on a silent spinner.
  it("shows a still-working cue when an admin reschedule POST hangs (#658)", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/availability")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ slots: ["2026-06-21T15:00:00.000Z"] }),
        } as Response);
      }
      // The reschedule POST wedges until its AbortSignal fires.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);
    fireEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /found a better time/i }));
    const slot = await screen.findByRole("button", { name: /:\d{2}/ });

    vi.useFakeTimers();
    fireEvent.click(slot);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows a still-working cue when an admin reassign POST hangs (#658)", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/admin/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ agents: AGENTS }),
        } as Response);
      }
      // The reassign POST wedges until its AbortSignal fires.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    render(
      <AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" currentAgentId="ag-9" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    const agentBtn = await screen.findByRole("button", { name: /bea agent/i });

    vi.useFakeTimers();
    fireEvent.click(agentBtn);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/still working/i)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText(/still working/i)).toBeTruthy();
    vi.useRealTimers();
  });

  // #633: announce the reschedule grid's settled state via a polite role=status,
  // not just the loading skeletons.
  it("announces the reschedule slot count via role=status (#633)", async () => {
    mockFetch(); // availability responds with one slot
    render(<AdminBookingActions bookingId="bk1" bucketCode="411" status="confirmed" />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toMatch(/1 time available/i));
  });
});

afterEach(() => vi.useRealTimers());
