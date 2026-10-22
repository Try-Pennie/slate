// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReroutePanel from "@/components/ReroutePanel";
import { REQUEST_TIMEOUT_MS } from "@/lib/http";
import { REROUTE_TIMED_OUT, REROUTE_UNREACHABLE } from "@/lib/booking/reroute-copy";

// The reroute panel (#3250, phase 4 of #3244), built to the design settled with Dan
// (docs/design/reroute-panel.html, R1 to R17 on #3250). The routes are mocked at
// fetch, so this drives what a manager or admin does: choose the bucket, find an
// advisor, read the result, confirm or cancel. Words come from reroute-copy, whose
// own suite reads every sentence; this checks the panel shows them and sends the
// right request for each choice.

const bucket = (code: string) => ({ id: `b${code}`, code, name: `n${code}` });
const advisor = (name: string) => ({ userId: name, name, email: `${name}@x.com` });
const MOVE = {
  kind: "move", holdId: "11111111-2222-4333-8444-555555555555", expiresAt: "x", secondsRemaining: 272,
  advisor: advisor("Morgan Reyes"), bucket: bucket("412"), requested: bucket("512"), rungsDropped: 1,
};
const KEEP = { kind: "keep", lastResort: true, nobodyElse: false, advisor: advisor("Taylor Brooks"), bucket: bucket("512"), requested: bucket("512"), rungsDropped: 0 };
const NONE = { kind: "none", requested: bucket("512") };
const KEEP_NOBODY_ELSE = { ...KEEP, lastResort: false, nobodyElse: true };

type Responder = (body: Record<string, unknown> | null) => { status?: number; body: unknown };
function mockFetch(routes: { current?: unknown; find?: Responder; confirm?: Responder; release?: Responder }) {
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const reply = (r: { status?: number; body: unknown }) =>
      ({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }) as Response;
    if (u.endsWith("/reroute/confirm")) return reply(routes.confirm?.(body) ?? { body: {} });
    if (u.endsWith("/reroute/hold")) return reply(routes.release?.(body) ?? { body: { released: true } });
    if (u.endsWith("/reroute") && method === "POST") return reply(routes.find?.(body) ?? { body: MOVE });
    if (u.endsWith("/reroute")) return reply({ body: { proposal: routes.current ?? null } });
    throw new Error(`unexpected fetch ${method} ${u}`);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
const sent = (fn: ReturnType<typeof mockFetch>, suffix: string, method = "POST") =>
  fn.mock.calls
    .filter(([u, i]) => String(u).endsWith(suffix) && (i?.method ?? "GET") === method)
    .map(([, i]) => (i?.body ? JSON.parse(String(i.body)) : null));

/**
 * Lets a held reply go and settles everything it sets off, inside React's act so
 * any render it causes has happened before the test reads the screen. The fakes
 * are promises with no timers, so one macrotask turn drains them: it waits on the
 * queue, not the clock.
 */
async function settle(letGo: () => void) {
  await act(async () => {
    letGo();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

/** Holds one route's reply until the returned function is called. */
function holdReply(fn: ReturnType<typeof mockFetch>, suffix: string, method: string) {
  let let_go!: () => void;
  const gate = new Promise<void>((r) => (let_go = r));
  const answer = fn.getMockImplementation()!;
  fn.mockImplementation(async (url, init) => {
    if (String(url).endsWith(suffix) && (init?.method ?? "GET") === method) await gate;
    return answer(url, init);
  });
  return let_go;
}

const onChanged = vi.fn();
const onReassign = vi.fn();
beforeEach(() => vi.clearAllMocks());

describe("ReroutePanel, as an admin (codes)", () => {
  it("finds an advisor for the code chosen and shows the drop first", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    await user.click(screen.getByRole("option", { name: "512" }));
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    expect(screen.getByText("Morgan Reyes is free. Nobody in 512 is.")).toBeTruthy();
    expect(screen.getByText("Held for 4:32")).toBeTruthy();
    expect(sent(fn, "/reroute")).toEqual([{ bucketCode: "512" }]);
  });

  it("lists all sixty codes", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    expect(screen.getAllByRole("option")).toHaveLength(60);
  });

  it("confirms the move with the hold and the note, then says what it did", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({ confirm: () => ({ body: { kind: "moved", advisor: advisor("Morgan Reyes"), bucket: bucket("412") } }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "lead is Ultra High");
    await user.click(screen.getByRole("button", { name: "Move to Morgan Reyes" }));
    await screen.findByText("Moved to Morgan Reyes, in 412.");
    expect(sent(fn, "/reroute/confirm")).toEqual([{ holdId: MOVE.holdId, note: "lead is Ultra High" }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("confirms a keep with the bucket and the bucket asked for", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({ find: () => ({ body: KEEP }), confirm: () => ({ body: { kind: "kept", bucket: bucket("512") } }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Taylor Brooks stays");
    expect(screen.queryByText(/Held for/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change the bucket to 512" }));
    await screen.findByText("The bucket is now 512.");
    expect(sent(fn, "/reroute/confirm")).toEqual([
      { holdId: null, bucketCode: "512", requestedBucketCode: "512", note: null },
    ]);
  });

  it("looks for a different advisor from a keep, excluding the current one (#3596)", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({ find: (body) => ({ body: body?.excludeCurrent ? MOVE : KEEP }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    await user.click(screen.getByRole("option", { name: "512" }));
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Taylor Brooks stays");
    await user.click(screen.getByRole("button", { name: "Look for a different advisor" }));
    await screen.findByText("One tier down, in 412");
    expect(sent(fn, "/reroute")).toEqual([
      { bucketCode: "512" },
      { bucketCode: "512", excludeCurrent: true },
    ]);
  });

  it("goes back to the keep when nobody else is free, and confirms it (#4079)", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({
      find: (body) => ({ body: body?.excludeCurrent ? KEEP_NOBODY_ELSE : KEEP }),
      confirm: () => ({ body: { kind: "kept", bucket: bucket("512") } }),
    });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Taylor Brooks stays");
    await user.click(screen.getByRole("button", { name: "Look for a different advisor" }));
    await screen.findByText("Nobody else is free");
    expect(screen.getByText("Taylor Brooks can keep this call. Nobody else in 512 or any tier below is free.")).toBeTruthy();
    expect(screen.getByLabelText("Note")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // Keep only: reassigning stays on the booking's own Reassign button, and asking
    // for a different advisor again would find the same nobody.
    expect(screen.queryByRole("button", { name: "Reassign to another advisor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for a different advisor" })).toBeNull();
    await user.type(screen.getByLabelText("Note"), "Lead asked for someone new");
    await user.click(screen.getByRole("button", { name: "Change the bucket to 512" }));
    await screen.findByText("Corrected");
    expect(sent(fn, "/reroute/confirm")).toEqual([
      { holdId: null, bucketCode: "512", requestedBucketCode: "512", note: "Lead asked for someone new" },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says why when the kept advisor can no longer take the call at confirm (#4079)", async () => {
    const user = userEvent.setup();
    mockFetch({
      find: () => ({ body: KEEP_NOBODY_ELSE }),
      confirm: () => ({ status: 409, body: { error: "The advisor is on time off for this call, so they cannot keep it. Find an advisor again." } }),
    });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Nobody else is free");
    await user.click(screen.getByRole("button", { name: "Change the bucket to 512" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The advisor is on time off for this call, so they cannot keep it. Find an advisor again.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("an advisor on time off with nobody else free is never a keep (#3487)", async () => {
    const user = userEvent.setup();
    const OUT = { ...NONE, current: { advisor: advisor("Taylor Brooks"), reason: "time_off" } };
    const fn = mockFetch({ find: () => ({ body: OUT }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Nobody is free");
    expect(
      screen.getByText(
        "Taylor Brooks is on time off for this call, and nobody else in 512 or any tier below is free. Nothing has changed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/stays/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Change the bucket/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for a different advisor" })).toBeNull();
    expect(sent(fn, "/reroute/confirm")).toEqual([]);
  });

  it("offers the booking's own Reassign on a nobody result, and opens it (#4043)", async () => {
    const user = userEvent.setup();
    const OUT = { ...NONE, current: { advisor: advisor("Taylor Brooks"), reason: "time_off" } };
    const fn = mockFetch({ find: () => ({ body: OUT }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Nobody is free");
    const reassign = screen.getByRole("button", { name: "Reassign to another advisor" });
    // The panel's secondary button, the same as Find an advisor beside it.
    expect(reassign.className).toBe(screen.getByRole("button", { name: "Find an advisor" }).className);
    await user.click(reassign);
    expect(onReassign).toHaveBeenCalledTimes(1);
    expect(sent(fn, "/reroute/confirm")).toEqual([]);
    expect(sent(fn, "/reroute/hold", "DELETE")).toEqual([]);
  });

  it("offers Reassign when the current advisor is left out and nobody at all is free (#4043)", async () => {
    const user = userEvent.setup();
    mockFetch({ find: (body) => ({ body: body?.excludeCurrent ? NONE : KEEP }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Taylor Brooks stays");
    expect(screen.queryByRole("button", { name: "Reassign to another advisor" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Look for a different advisor" }));
    await screen.findByText("Nobody is free");
    await user.click(screen.getByRole("button", { name: "Reassign to another advisor" }));
    expect(onReassign).toHaveBeenCalledTimes(1);
  });

  it("offers no Reassign on a move result (#4043)", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    expect(screen.queryByRole("button", { name: "Reassign to another advisor" })).toBeNull();
  });

  it("offers no different-advisor button on a move result (#3596)", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    expect(screen.queryByRole("button", { name: "Look for a different advisor" })).toBeNull();
  });

  it("cancelling a move releases the hold", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(1));
    expect(screen.queryByText("One tier down, in 412")).toBeNull();
  });

  it("releases a held advisor when the panel is closed, never leaving them blocked", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    const { unmount } = render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    // Sent as the panel closes, with no await, which the "nothing held" test relies on.
    unmount();
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(1);
  });

  it("keeps the hold when the panel closes mid confirm, which the server settles", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({ confirm: () => ({ body: { kind: "moved", advisor: advisor("Morgan Reyes"), bucket: bucket("412") } }) });
    const { unmount } = render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    const finish = holdReply(fn, "/reroute/confirm", "POST");
    await user.click(screen.getByRole("button", { name: "Move to Morgan Reyes" }));
    await waitFor(() => expect(sent(fn, "/reroute/confirm")).toHaveLength(1));
    unmount();
    finish();
    // The confirm settles (it reports the move) and nothing lets the hold go.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(0);
  });

  it("releases the advisor a search held after the panel had already closed", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    const { unmount } = render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    const finish = holdReply(fn, "/reroute", "POST");
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await waitFor(() => expect(sent(fn, "/reroute")).toHaveLength(1));
    unmount();
    finish();
    await waitFor(() => expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(1));
  });

  it("releases the next advisor a confirm held when it came back taken after the panel closed", async () => {
    const user = userEvent.setup();
    const NEXT = { ...MOVE, holdId: "22222222-3333-4444-8555-666666666666", advisor: advisor("Avery Lin") };
    const fn = mockFetch({ confirm: () => ({ body: { kind: "taken", previous: advisor("Morgan Reyes"), proposal: NEXT } }) });
    const { unmount } = render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    const finish = holdReply(fn, "/reroute/confirm", "POST");
    await user.click(screen.getByRole("button", { name: "Move to Morgan Reyes" }));
    await waitFor(() => expect(sent(fn, "/reroute/confirm")).toHaveLength(1));
    unmount();
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(0);
    finish();
    await waitFor(() => expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(1));
  });

  it("releases nothing on close when nothing is held", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({ find: () => ({ body: KEEP }) });
    const { unmount } = render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Taylor Brooks stays");
    // A release is sent as the panel closes, before any await, so it would be here now.
    unmount();
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(0);
  });

  it("control: the same late restore does land when the admin has not acted", async () => {
    const OLD = { ...MOVE, holdId: "33333333-4444-4555-8666-777777777777", advisor: advisor("Old Hold") };
    const fn = mockFetch({ current: OLD });
    const finishRestore = holdReply(fn, "/reroute", "GET");
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await settle(finishRestore);
    expect(screen.getByText("Old Hold is free. Nobody in 512 is.")).toBeTruthy();
  });

  it("clears a result, releasing its hold, when the bucket chosen changes after the search", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    await user.click(screen.getByRole("option", { name: "512" }));
    expect(screen.queryByText("One tier down, in 412")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to Morgan Reyes" })).toBeNull();
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(1);
  });

  it("holds off a new search until the release a changed choice sent has landed", async () => {
    // The release frees the booking's hold whatever it is, so one landing after a
    // new search placed its hold would free the new one and strand its Move button.
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    const finishRelease = holdReply(fn, "/reroute/hold", "DELETE");
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    await user.click(screen.getByRole("option", { name: "512" }));
    expect((screen.getByRole("button", { name: "Find an advisor" }) as HTMLButtonElement).disabled).toBe(true);
    await settle(finishRelease);
    expect((screen.getByRole("button", { name: "Find an advisor" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the result and its hold when the same bucket is picked again", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="512" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.click(screen.getByRole("combobox", { name: "Correct bucket" }));
    await user.click(screen.getByRole("option", { name: "512" }));
    expect(screen.getByText("One tier down, in 412")).toBeTruthy();
    expect(sent(fn, "/reroute/hold", "DELETE")).toHaveLength(0);
  });

  it("says the server answered, with its status, when a refusal carries no message", async () => {
    const user = userEvent.setup();
    mockFetch({ find: () => ({ status: 502, body: {} }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Slate could not finish that (error 502). Please try again.");
  });

  it("never lets a late restore replace a search the admin already ran", async () => {
    const user = userEvent.setup();
    const OLD = { ...MOVE, holdId: "33333333-4444-4555-8666-777777777777", advisor: advisor("Old Hold") };
    const fn = mockFetch({ current: OLD });
    const finishRestore = holdReply(fn, "/reroute", "GET");
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("Morgan Reyes is free. Nobody in 512 is.");
    // Settled the same way the control above proves shows a landed restore.
    await settle(finishRestore);
    expect(screen.queryByText(/Old Hold/)).toBeNull();
    expect(screen.getByText("Morgan Reyes is free. Nobody in 512 is.")).toBeTruthy();
  });

  it("restores a live hold after a reload", async () => {
    mockFetch({ current: MOVE });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await screen.findByText("One tier down, in 412");
    expect(screen.getByRole("button", { name: "Move to Morgan Reyes" })).toBeTruthy();
  });

  it("shows the next advisor when the held one was taken at confirm", async () => {
    const user = userEvent.setup();
    mockFetch({
      confirm: () => ({ body: { kind: "taken", previous: advisor("Morgan Reyes"), proposal: { ...MOVE, advisor: advisor("Casey Lin") } } }),
    });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.click(screen.getByRole("button", { name: "Move to Morgan Reyes" }));
    await screen.findByText(/Morgan Reyes was booked a moment ago, so Slate searched again\. Casey Lin is free/);
    expect(screen.getByRole("button", { name: "Move to Casey Lin" })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("names the advisor whose hold ran out, and offers to search again", async () => {
    const user = userEvent.setup();
    mockFetch({ confirm: () => ({ body: { kind: "expired" } }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in 412");
    await user.click(screen.getByRole("button", { name: "Move to Morgan Reyes" }));
    await screen.findByText("The hold ran out");
    expect(screen.getByText("Morgan Reyes may have been booked since. Nothing has changed.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Find an advisor" }).length).toBeGreaterThan(0);
  });

  it("shows the route's own sentence when a request is refused", async () => {
    const user = userEvent.setup();
    mockFetch({ find: () => ({ status: 409, body: { error: "This lead booked a specific advisor by link, so there is no bucket to correct.", code: "agent_link" } }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/specific advisor by link/);
  });

  // #3307: Find an advisor answered 200 after 24 seconds, having held somebody, and
  // the panel had stopped waiting at 20 and said the server was unreachable. A
  // request cut off by the panel's own timeout says the work may still be finishing.
  it("says the work may still be finishing when no answer comes in time, never that the server was unreachable", async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn((_u: RequestInfo | URL, init: RequestInit = {}) => {
        if ((init.method ?? "GET") === "GET") {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ proposal: null }) } as Response);
        }
        // The server is still working: nothing settles until the panel gives up.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }) as unknown as typeof fetch;
      render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
      fireEvent.click(screen.getByRole("button", { name: "Find an advisor" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
      expect(screen.getByRole("alert").textContent).toBe(REROUTE_TIMED_OUT);
      expect(screen.getByRole("alert").textContent).not.toMatch(/reach/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the unreachable sentence for a request that failed on the network", async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return { ok: true, status: 200, json: async () => ({ proposal: null }) } as Response;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    expect((await screen.findByRole("alert")).textContent).toBe(REROUTE_UNREACHABLE);
  });

  it("says a move was already made when a repeated confirm finds the first one landed", async () => {
    const user = userEvent.setup();
    mockFetch({ confirm: () => ({ body: { kind: "moved", advisor: advisor("Morgan Reyes"), bucket: bucket("412"), already: true } }) });
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await user.click(await screen.findByRole("button", { name: "Move to Morgan Reyes" }));
    await screen.findByText("Already moved");
    expect(screen.getByText("Moved to Morgan Reyes, in 412, by an earlier confirm. Nothing changed this time.")).toBeTruthy();
    // The page re-reads the booking, which may still show the advisor it had before.
    expect(onChanged).toHaveBeenCalled();
  });

  it("never offers nothing as success when the request did not complete", async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return { ok: true, status: 200, json: async () => ({ proposal: null }) } as Response;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
  });
});

describe("ReroutePanel, as a manager (pools)", () => {
  it("picks a backend, then a debt level, and keeps the rest of the booking's code", async () => {
    const user = userEvent.setup();
    const fn = mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="112" showCodes={false} onChanged={onChanged} onReassign={onReassign} />);
    expect(screen.queryByRole("combobox", { name: "Correct bucket" })).toBeNull();
    const backends = screen.getAllByRole("radio").map((r) => r.closest("label")?.textContent);
    expect(backends).toEqual(["Beyond", "Achieve", "Either"]);
    await user.click(screen.getByRole("radio", { name: "Achieve" }));
    await user.click(screen.getByRole("combobox", { name: "Debt level" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Very High", "Ultra High"]);
    await user.click(screen.getByRole("option", { name: "Ultra High" }));
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText(/tier down/);
    expect(sent(fn, "/reroute")).toEqual([{ bucketCode: "532" }]);
  });

  it("reads pools, never codes, in the result", async () => {
    const user = userEvent.setup();
    mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="100" showCodes={false} onChanged={onChanged} onReassign={onReassign} />);
    await user.click(screen.getByRole("button", { name: "Find an advisor" }));
    await screen.findByText("One tier down, in Very High");
    expect(screen.getByText("Morgan Reyes is free. Nobody in Ultra High is.")).toBeTruthy();
  });

  it("starts from the booking's own backend and debt level", () => {
    mockFetch({});
    render(<ReroutePanel bookingId="bk1" currentCode="332" showCodes={false} onChanged={onChanged} onReassign={onReassign} />);
    expect((screen.getByRole("radio", { name: "Achieve" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("combobox", { name: "Debt level" }).textContent).toMatch(/High/);
  });
});
