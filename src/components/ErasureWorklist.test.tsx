// @vitest-environment jsdom
/**
 * The erasure purge worklist screen (#1124).
 *
 * A static scan cannot mount React, so this is where the claims that matter get
 * proved on a real DOM:
 *
 *   - an unreadable trail renders the UNREADABLE screen, never an empty list. The
 *     two are one keystroke apart in the code and read as opposites to a person.
 *   - an unmeasured residual renders as unknown, never as clean.
 *   - a failed purge, and a purge we stopped waiting for, each surface as their
 *     own state and leave the control usable again. A time taking action must show
 *     started, still alive, and failed as visibly distinct things.
 *   - each control says its own SCOPE before it runs, and sends the request that
 *     matches what it said.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/http", () => ({ postJson: vi.fn(), REQUEST_TIMEOUT_MS: 20000 }));

import { ErasureWorklist } from "./ErasureWorklist";
import { postJson } from "@/lib/http";
import {
  emptyTrailText,
  entryPurgeLabel,
  purgeAllLabel,
} from "@/lib/snowflake/erasure-worklist-copy";
import type { ErasureWorklistState } from "@/lib/snowflake/erasure-worklist";

/** #1961: the ages on this page are measured from an instant the SERVER takes
 *  and passes in, so the tests pin it rather than reading a clock. Fifteen days
 *  after the fixture entry's erasure. */
const NOW = Date.parse("2026-09-04T09:00:00+00:00");

const entry = (over: Record<string, unknown> = {}) => ({
  auditId: "a1",
  createdAt: "2026-08-20T09:00:00+00:00",
  emailSha256: "bf887269aa11223344556677889900aabbccddeeff00112233445566778899aa",
  bookingIds: ["bk1", "bk2"],
  residuals: [{ table: "bookings", residual: 0 }],
  unmeasuredReason: null,
  ...over,
});

const ready = (over: Partial<Extract<ErasureWorklistState, { kind: "ready" }>> = {}) =>
  ({
    kind: "ready",
    nowMs: NOW,
    entries: [entry()],
    trail: { entryCount: 1, bookingCount: 2, otherOrgBookingCount: 0 },
    warehouse: { kind: "measured" },
    ...over,
  }) as ErasureWorklistState;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ErasureWorklist: reading the state", () => {
  it("renders the unreadable screen, not an empty list, when the trail read failed", () => {
    render(<ErasureWorklist state={{ kind: "trail-unreadable", reason: "permission denied" }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read/i);
    expect(screen.getByRole("alert").textContent).toMatch(/permission denied/);
    // The reassuring screen must be absent, not merely different.
    expect(screen.queryByText(emptyTrailText())).toBeNull();
    // And nothing destructive is offered off a state we could not read.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the empty trail as its own measured sentence", () => {
    render(
      <ErasureWorklist
        state={ready({ entries: [], trail: { entryCount: 0, bookingCount: 0, otherOrgBookingCount: 0 } })}
      />,
    );
    expect(screen.getByText(emptyTrailText())).toBeTruthy();
    expect(screen.queryByText(entryPurgeLabel())).toBeNull();
  });

  it("shows an unmeasured residual as unknown, never as clean", () => {
    render(
      <ErasureWorklist
        state={ready({
          warehouse: { kind: "unreadable", reason: "Snowflake returned 503" },
          entries: [entry({ residuals: null, unmeasuredReason: "Snowflake returned 503" })],
        })}
      />,
    );
    expect(screen.getByText(/Not measured/)).toBeTruthy();
    expect(screen.queryByText(/Clean in the warehouse/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/503/);
  });

  it("says an unconfigured mirror is a different thing from an unreadable one", () => {
    render(<ErasureWorklist state={ready({ warehouse: { kind: "unconfigured" } })} />);
    expect(screen.getByRole("alert").textContent).toMatch(/not configured/i);
    // Nothing to purge against, so no destructive control is offered.
    expect(screen.queryByText(entryPurgeLabel())).toBeNull();
    expect(screen.queryByText(purgeAllLabel())).toBeNull();
  });

  it("names the erasure by its hash, and never renders a cleartext address", () => {
    render(<ErasureWorklist state={ready()} />);
    expect(screen.getByText(/bf887269/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/@/);
  });
});

describe("ErasureWorklist: scope per control", () => {
  it("asks before purging one erasure, naming that erasure's bookings only", () => {
    render(<ErasureWorklist state={ready()} />);
    fireEvent.click(screen.getByText(entryPurgeLabel()));
    const confirm = screen.getByRole("alertdialog").textContent ?? "";
    expect(confirm).toMatch(/this erasure only/i);
    expect(confirm).toMatch(/2 bookings/);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("sends only that erasure's booking ids when confirmed", async () => {
    vi.mocked(postJson).mockResolvedValue({ ok: true, status: 200, data: { ok: true, bookingIds: ["bk1", "bk2"], rowsByTable: {}, residualAfter: {}, reasons: [] } });
    render(<ErasureWorklist state={ready()} />);
    fireEvent.click(screen.getByText(entryPurgeLabel()));
    await act(async () => {
      fireEvent.click(screen.getByText(/Yes, purge/i));
    });
    expect(vi.mocked(postJson).mock.calls[0][0]).toBe("/api/admin/erasure-purge");
    expect(vi.mocked(postJson).mock.calls[0][1]).toEqual({ bookingIds: ["bk1", "bk2"] });
  });

  it("asks before purging the whole trail, and sends no ids so the route takes all of it", async () => {
    vi.mocked(postJson).mockResolvedValue({ ok: true, status: 200, data: { ok: true, bookingIds: ["bk1", "bk2"], rowsByTable: {}, residualAfter: {}, reasons: [] } });
    render(<ErasureWorklist state={ready()} />);
    fireEvent.click(screen.getByText(purgeAllLabel()));
    const confirm = screen.getByRole("alertdialog").textContent ?? "";
    expect(confirm).toMatch(/every booking in the erasure trail/i);
    expect(confirm).toMatch(/already clean/i);
    await act(async () => {
      fireEvent.click(screen.getByText(/Yes, purge/i));
    });
    expect(vi.mocked(postJson).mock.calls[0][1]).toEqual({});
  });

  it("lets the reader back out of the confirmation without sending anything", () => {
    render(<ErasureWorklist state={ready()} />);
    fireEvent.click(screen.getByText(entryPurgeLabel()));
    fireEvent.click(screen.getByText(/Leave it/i));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("ErasureWorklist: the three progress states", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  function startPurge() {
    render(<ErasureWorklist state={ready()} />);
    fireEvent.click(screen.getByText(entryPurgeLabel()));
    fireEvent.click(screen.getByText(/Yes, purge/i));
  }

  it("shows elapsed time while it works, so a live run and a dead one look different", async () => {
    vi.mocked(postJson).mockImplementation(() => new Promise(() => {}));
    startPurge();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    const live = screen.getByRole("status").textContent ?? "";
    expect(live).toMatch(/Purging in the warehouse/);
    expect(live).toMatch(/3s/);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status").textContent).toMatch(/5s/);
  });

  it("changes to a still going message once it runs long", async () => {
    vi.mocked(postJson).mockImplementation(() => new Promise(() => {}));
    startPurge();
    await act(async () => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByRole("status").textContent).toMatch(/Still going after 20s/);
  });

  it("surfaces a refused purge as a failure, with the server's reason, and re-enables the control", async () => {
    vi.mocked(postJson).mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: "a purge is already running" },
    });
    startPurge();
    await act(async () => {});
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/did not run/i);
    expect(alert).toMatch(/a purge is already running/);
    expect(alert).not.toMatch(/finished|complete/i);
    // The control has to come back, or the only diagnosis left is reloading.
    expect(screen.getByText(entryPurgeLabel())).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("surfaces a purge that ran but left data behind as a failure, not a success", async () => {
    vi.mocked(postJson).mockResolvedValue({
      ok: false,
      status: 500,
      data: {
        ok: false,
        bookingIds: ["bk1"],
        rowsByTable: { bookings: 1 },
        residualAfter: { bookings: 1 },
        reasons: ["bookings: 1 row(s) still hold contact PII after the purge"],
      },
    });
    startPurge();
    await act(async () => {});
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/still holds contact data/i);
    expect(alert).toMatch(/bookings: 1 row/);
    expect(alert).not.toMatch(/no contact data left/i);
  });

  it("converts a request that never came back into an actionable timeout, not a hang", async () => {
    // postJson resolves { ok:false, status:0 } on its own abort; that is the shape
    // a wedged request arrives in.
    vi.mocked(postJson).mockResolvedValue({ ok: false, status: 0, data: {} });
    startPurge();
    await act(async () => {});
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/stopped waiting/i);
    expect(alert).toMatch(/try again/i);
    expect(alert).not.toMatch(/did not run/i);
    expect(screen.getByText(entryPurgeLabel())).toBeTruthy();
  });

  it("reports a completed purge with the counts the warehouse gave back", async () => {
    vi.mocked(postJson).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        bookingIds: ["bk1", "bk2"],
        rowsByTable: { bookings: 2, booking_events: 1 },
        residualAfter: { bookings: 0 },
        reasons: [],
      },
    });
    startPurge();
    await act(async () => {});
    const done = screen.getByRole("alert").textContent ?? "";
    expect(done).toMatch(/Purge finished for 2 bookings/);
    expect(done).toMatch(/bookings 2 rows/);
  });
});
