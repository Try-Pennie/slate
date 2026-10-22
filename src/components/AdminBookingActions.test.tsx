// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminBookingActions from "@/components/AdminBookingActions";
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASSIGN_REASONS,
} from "@/lib/booking/core";
import { PICKER_COPY } from "@/lib/booking/booker-copy";
import { messageLines } from "@/lib/booking/slot-picker";

// The admin panel shows days in the DEVICE zone and judges the lead's calling
// window in the booking's zone (#2310). Pinned, never inherited from the machine
// (L504), so a day heading reads the same on every machine.
vi.mock("@/lib/booking/timezones", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/timezones")>()),
  deviceTimeZone: () => "America/New_York",
}));

// #326 admin reschedule/cancel: a reason is mandatory (server + UI), recorded
// with initiator='admin'. These cover the UI gating + that the reason is sent.

// #346: reason options are passed in (server-resolved from the store). The coded
// defaults keep these tests' reason labels valid.
const TEST_REASON_OPTIONS = {
  reschedule: RESCHEDULE_REASONS,
  cancel: CANCEL_REASONS,
  reassign: REASSIGN_REASONS,
};

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

/** #1336: the admin reschedule panel runs on the shared picker, so a day is
 *  chosen before any time is offered. */
const dayChips = () =>
  screen.findAllByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });
const dayChip = async () => (await dayChips())[0];
async function pickDay() {
  await userEvent.click(await dayChip());
}

describe("AdminBookingActions", () => {
  it("shows no actions for a terminal booking", () => {
    mockFetch();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="cancelled" reasonOptions={TEST_REASON_OPTIONS} />);
    expect(screen.queryByRole("button", { name: /reschedule/i })).toBeNull();
  });

  it("requires a reason before an admin cancel, then sends it", async () => {
    const fn = mockFetch();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^cancel booking$/i }));
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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

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

  // #566: out-of-pool (bookable=false) agents are still selectable for coverage
  // reassignment, but must render greyed with a "not in rotation" flag and sort
  // below in-pool agents. rankReassignAgents is unit-tested; this locks the
  // component rendering + that clicking a flagged agent still POSTs the reassign.
  // Ada is out-of-rotation and alphabetically first, so its position below Bea
  // proves the below-sort is not just alphabetical.
  const MIXED_AGENTS = [
    { id: "ag-1", name: "Bea Agent", email: "bea@x.com", bookable: true },
    { id: "ag-2", name: "Ada Agent", email: "ada@x.com", bookable: false },
  ];

  function mockFetchMixed() {
    const fn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/admin/agents")) {
        return { ok: true, json: async () => ({ agents: MIXED_AGENTS }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("renders an out-of-rotation agent greyed with a 'not in rotation' flag, sorted below in-pool", async () => {
    mockFetchMixed();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));

    const inPool = await screen.findByRole("button", { name: /bea agent/i });
    const outOfPool = screen.getByRole("button", { name: /ada agent/i });

    // The flag text sits only on the out-of-rotation agent.
    expect(outOfPool.textContent).toMatch(/not in rotation/i);
    expect(inPool.textContent).not.toMatch(/not in rotation/i);

    // Greyed style on the flagged agent; the in-pool agent keeps the plain surface.
    expect(outOfPool.className).toContain("bg-fg/[0.04]");
    expect(inPool.className).not.toContain("bg-fg/[0.04]");

    // Sorted below the in-pool agent despite coming first alphabetically.
    expect(inPool.compareDocumentPosition(outOfPool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // #565: handing a booking to an out-of-rotation agent is the more unusual
  // action, so it gets the same two-step confirm as the at-cap case (was a
  // single unguarded click). Picking a flagged agent surfaces a warning and does
  // NOT post until 'Reassign anyway'.
  it("confirms before reassigning to an out-of-rotation agent, then POSTs on 'Reassign anyway'", async () => {
    const fn = mockFetchMixed();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /ada agent/i }));

    // Warning names the agent + explains; nothing posted yet.
    const warn = await screen.findByText(/not in the bookable rotation/i);
    expect(warn.textContent).toContain("Ada Agent");
    expect(reassignPicks(fn)).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /reassign anyway/i }));
    const body = bodyFor(fn, "/api/admin/bookings/bk1/reassign");
    expect(body.agentEmail).toBe("ada@x.com");
    expect(body.overrideCap).toBe(false);
    expect(body.reason).toBe("owner_reassignment");
    expect(refresh).toHaveBeenCalled();
  });

  it("dismissing the out-of-rotation warning returns to the picker without posting", async () => {
    const fn = mockFetchMixed();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /ada agent/i }));
    await screen.findByText(/not in the bookable rotation/i);

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.queryByText(/not in the bookable rotation/i)).toBeNull();
    expect(screen.getByLabelText(/search agents/i)).toBeTruthy();
    expect(reassignPicks(fn)).toHaveLength(0);
  });

  it("still posts immediately (no extra confirm) for an in-rotation agent", async () => {
    const fn = mockFetch();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reassign$/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /owner reassignment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /bea agent/i }));

    const body = bodyFor(fn, "/api/admin/bookings/bk1/reassign");
    expect(body.agentEmail).toBe("bea@x.com");
    expect(refresh).toHaveBeenCalled();
  });

  // #625: a network rejection must surface an error and re-enable the control,
  // never leave it frozen in its busy state.
  it("surfaces an error and re-enables when the admin cancel POST rejects", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^cancel booking$/i }));
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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await userEvent.click(screen.getByRole("radio", { name: /found a better time/i }));
    await pickDay();
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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    await waitFor(() =>
      expect(screen.getAllByText("Finding the days you can book.").length).toBeGreaterThan(0),
    );
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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    expect(await screen.findByText("Could not load available times.")).toBeTruthy();
    expect(screen.queryByText(/no open times/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await pickDay();
    expect(await screen.findByRole("button", { name: /:\d{2}/ })).toBeTruthy();
  });

  it("shows the empty copy only after a confirmed empty reschedule response", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        return { ok: true, json: async () => ({ slots: [] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));

    // Visible copy is "No open times."; the sr-only status says "No open times",
    // so target the visible line by its trailing period.
    expect(await screen.findByText(/no open times\./i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toMatch(/loading/i);
  });

  it("shows loading skeletons, not the empty copy, while the reassign agent list loads", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

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
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />);

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

    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel booking$/i }));
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

    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);
    fireEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /found a better time/i }));
    fireEvent.click(await dayChip());
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
      <AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" currentAgentId="ag-9" reasonOptions={TEST_REASON_OPTIONS} />,
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

  // #1336: the rule the shared picker exists to hold, on this surface. The admin
  // panel used to render every offered day's times in one flat list, grouped in
  // the MACHINE zone while the lead's panel grouped in theirs.
  it("offers no time until a day is chosen (#1336)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/availability")) {
        return {
          ok: true,
          json: async () => ({
            slots: ["2026-06-21T15:00:00.000Z", "2026-06-22T15:00:00.000Z"],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    // Both days are offered, so the load is settled and this is not a spinner.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^(MON|TUE|SUN)/ })).toHaveLength(2),
    );
    expect(screen.queryAllByRole("button", { name: /:\d{2}/ })).toHaveLength(0);

    await pickDay();
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(1);
  });

  // #633: announce the reschedule grid's settled state via a polite role=status,
  // not just the loading skeletons.
  it("announces the reschedule slot count via role=status (#633)", async () => {
    mockFetch(); // availability responds with one slot
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toMatch(/1 time available on/i));
  });
});

// #2310, L659: the shared picker's quiet hours sentence says "your time" to a
// lead. On this panel the reader is staff and the clock is the LEAD's, so the
// sentence must name the lead's zone and never address the reader's own hours.
describe("the lead's calling hours on the admin panel (#2310)", () => {
  it("names the lead's zone, not the reader's, when a day's times are all outside it", async () => {
    // 15:00Z is 05:00 in Honolulu: the only time that day is outside the window.
    mockFetch();
    render(
      <AdminBookingActions
        showCodes
        bookingId="bk1"
        bucketCode="411"
        rescheduleTimesFrom="pool"
        leadTimeZone="Pacific/Honolulu"
        status="confirmed"
        reasonOptions={TEST_REASON_OPTIONS}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();

    const expected = PICKER_COPY.outsideCallingHoursForStaff("Sun, Jun 21", "Pacific/Honolulu");
    for (const line of messageLines(expected)) {
      expect(screen.getAllByText(line).length).toBeGreaterThan(0);
    }
    expect(expected).toContain("Hawaii (Honolulu)");
    expect(document.body.textContent).not.toContain("your time");
    expect(screen.queryAllByRole("button", { name: /:\d{2}/ })).toHaveLength(0);
  });
});

// #2827: a call booked through an advisor's own link can only move to a time that
// advisor can take, so the admin move must never offer the bucket's pool.
describe("the admin move of an advisor link booking (#2827)", () => {
  const ADVISOR_FREE = "2026-06-21T15:00:00.000Z";
  const POOL_ONLY = "2026-06-21T16:00:00.000Z";
  function twoSources() {
    const fn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === "/api/admin/bookings/bk1/availability") {
        return { ok: true, status: 200, json: async () => ({ slots: [ADVISOR_FREE] }) } as Response;
      }
      if (u.includes("/api/availability?bucket=")) {
        return { ok: true, status: 200, json: async () => ({ slots: [ADVISOR_FREE, POOL_ONLY] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }
  const availabilityReads = (fn: ReturnType<typeof twoSources>) =>
    fn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("availability"));

  it("reads the advisor's times through the staff route, and the pool-only time is not offered", async () => {
    const fn = twoSources();
    render(
      <AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="advisor" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
    expect(availabilityReads(fn)).toEqual(["/api/admin/bookings/bk1/availability"]);
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(1);
  });

  it("a routed booking reads the pool, where the pool-only time IS offered", async () => {
    const fn = twoSources();
    render(
      <AdminBookingActions showCodes bookingId="bk1" bucketCode="411" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule$/i }));
    await pickDay();
    expect(availabilityReads(fn)).toEqual(["/api/availability?bucket=411"]);
    expect(screen.getAllByRole("button", { name: /:\d{2}/ })).toHaveLength(2);
  });
});

afterEach(() => vi.useRealTimers());

// #3250: Reroute is the fourth action (R1). Its panel opens under a divider and the
// action row stays on screen with Reroute marked as the open one, so the backend
// buttons never read as more actions.
describe("AdminBookingActions reroute (#3250)", () => {
  it("offers Reroute between Reassign and Cancel booking, and keeps the row open beside its panel", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="100" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Reschedule", "Reassign", "Reroute", "Cancel booking"]);
    await user.click(screen.getByRole("button", { name: "Reroute" }));
    expect(screen.getByRole("button", { name: "Reroute" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Reassign" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("combobox", { name: "Correct bucket" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find an advisor" })).toBeTruthy();
  });

  it("gives a manager the backend and debt level controls, not codes", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<AdminBookingActions showCodes={false} bookingId="bk1" bucketCode="100" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);
    await user.click(screen.getByRole("button", { name: "Reroute" }));
    expect(screen.queryByRole("combobox", { name: "Correct bucket" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Debt level" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("opens the booking's own Reassign picker from a nobody result, with focus inside it (#4043)", async () => {
    const user = userEvent.setup();
    const OUT = {
      kind: "none",
      requested: { id: "b512", code: "512", name: "n512" },
      current: { advisor: { userId: "u1", name: "Taylor Brooks", email: "t@x.com" }, reason: "time_off" },
    };
    const fn = mockFetch();
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/reroute") && init?.method === "POST") return { ok: true, status: 200, json: async () => OUT } as Response;
      if (u.endsWith("/reroute")) return { ok: true, status: 200, json: async () => ({ proposal: null }) } as Response;
      return base(url, init);
    });
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="100" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} currentAgentId="u1" />);
    await user.click(screen.getByRole("button", { name: "Reroute" }));
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await user.click(await screen.findByRole("button", { name: "Reassign to another advisor" }));
    // The same picker the booking's own Reassign opens: its reason, then its agents.
    // The button that was pressed is gone, so focus moves to the picker's first choice.
    const group = screen.getByRole("group", { name: "Why are you reassigning?" });
    expect(document.activeElement).toBe(within(group).getAllByRole("radio")[0]);
    expect(await screen.findByRole("button", { name: "Bea Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Find an advisor" })).toBeNull();
  });

  it("leaves Reroute when another action is chosen", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<AdminBookingActions showCodes bookingId="bk1" bucketCode="100" rescheduleTimesFrom="pool" leadTimeZone="America/New_York" status="confirmed" reasonOptions={TEST_REASON_OPTIONS} />);
    await user.click(screen.getByRole("button", { name: "Reroute" }));
    await user.click(screen.getByRole("button", { name: "Reassign" }));
    expect(screen.queryByRole("button", { name: "Find an advisor" })).toBeNull();
  });
});

