// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// #974: the bulk coverage-reassign admin panel. getJson/postJson are mocked so
// this exercises the panel's behavior: a live preview count, starting a sweep,
// rendering progress with the actionable "couldn't place" list linked to the
// single-reassign override, and surfacing a start failure (the distinct failed
// state, not a silent no-op).
const http = vi.hoisted(() => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));
vi.mock("@/lib/http", () => http);

import BulkReassignCoverage from "@/components/BulkReassignCoverage";
import { REASSIGN_REASONS } from "@/lib/booking/core";
import {
  ACTIONABLE_ITEM_STATUSES,
  isBulkReassignProgress,
  SKIPPED_ITEM_STATUSES,
  summarizeBulkReassignItems,
} from "@/lib/booking/bulk-reassign";

const progressFixture = {
  job: {
    id: "job1",
    out_user_id: "out1",
    status: "done",
    range_start: "2026-08-12T00:00:00.000Z",
    range_end: "2026-08-19T23:59:59.999Z",
  },
  summary: {
    total: 2,
    counts: { pending: 0, moved: 1, unplaceable: 1, skipped: 0, failed: 0, cancelled: 0 },
    done: true,
  },
  actionable: [
    {
      bookingId: "bk-stuck",
      status: "unplaceable",
      detail: "No agent was free and under their daily cap at the original time.",
      startsAt: "2026-07-25T17:00:00.000Z",
      attendeeName: "Kris",
    },
  ],
  skipped: [],
};

/** A finished move with one of each outcome, which is the shape the panel meets
 *  most and the one where the mark has to tell three things apart (#2122). */
const mixedFixture = {
  ...progressFixture,
  summary: {
    total: 3,
    counts: { pending: 0, moved: 1, unplaceable: 1, skipped: 1, failed: 0, cancelled: 0 },
    done: true,
  },
  skipped: [
    {
      bookingId: "bk-gone",
      status: "skipped",
      detail: "Booking was cancelled before it could be moved.",
      startsAt: "2026-07-26T15:00:00.000Z",
      attendeeName: "Alex",
    },
  ],
};

/** A move that had nothing to move: the #2122 p0. */
const emptyFixture = {
  ...progressFixture,
  summary: { total: 0, counts: { pending: 0, moved: 0, unplaceable: 0, skipped: 0, failed: 0, cancelled: 0 }, done: true },
  actionable: [],
  skipped: [],
};

/** Mid run, so the mark has something waiting and something being worked on. */
const runningFixture = {
  ...progressFixture,
  job: {
    id: "job1",
    out_user_id: "out1",
    status: "active",
    range_start: "2026-08-12T00:00:00.000Z",
    range_end: "2026-08-19T23:59:59.999Z",
  },
  summary: { total: 10, counts: { pending: 6, moved: 4, unplaceable: 0, skipped: 0, failed: 0, cancelled: 0 }, done: false },
  actionable: [],
  skipped: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: preview reads return a count; jobId reads return the finished job.
  http.getJson.mockImplementation(async (url: string) =>
    url.includes("jobId=")
      ? { ok: true, status: 200, data: progressFixture }
      : { ok: true, status: 200, data: { count: 5 } },
  );
});

describe("BulkReassignCoverage", () => {
  it("shows a live preview count for the range", async () => {
    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);
    expect(await screen.findByText(/5 bookings would be reassigned/)).toBeTruthy();
  });

  it("starts a sweep and renders progress with the actionable override link", async () => {
    http.postJson.mockResolvedValueOnce({ ok: true, status: 200, data: { jobId: "job1", itemCount: 2 } });
    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);

    fireEvent.click(await screen.findByRole("button", { name: /move these bookings/i }));

    // The start POST hit the agent's endpoint.
    await waitFor(() => expect(http.postJson).toHaveBeenCalledWith("/api/admin/agents/out1/bulk-reassign", expect.anything()));
    // Progress renders with the per-status counts...
    expect(await screen.findByText(/Move complete/)).toBeTruthy();
    // ...and the couldn't-place item links to the single-reassign override page.
    const link = await screen.findByRole("link", { name: /place by hand/i });
    expect(link.getAttribute("href")).toBe("/admin/bookings/bk-stuck");
  });

  it("defaults the reason to the first available option, not a retired hardcoded code (#987)", async () => {
    // Admin retired "coverage" via #346, so it is absent from the passed list.
    const reasons = [
      { code: "escalation", label: "Escalation" },
      { code: "other", label: "Other" },
    ];
    http.postJson.mockResolvedValueOnce({ ok: true, status: 200, data: { jobId: "job1", itemCount: 2 } });
    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={reasons} />);

    fireEvent.click(await screen.findByRole("button", { name: /move these bookings/i }));

    // The reason sent is the first option in the list, never the retired "coverage".
    await waitFor(() =>
      expect(http.postJson).toHaveBeenCalledWith(
        "/api/admin/agents/out1/bulk-reassign",
        expect.objectContaining({ reason: "escalation" }),
      ),
    );
  });

  it("surfaces a start failure instead of silently doing nothing", async () => {
    http.postJson.mockResolvedValueOnce({ ok: false, status: 500, data: { error: "Something broke" } });
    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);

    fireEvent.click(await screen.findByRole("button", { name: /move these bookings/i }));

    expect(await screen.findByText(/Something broke/)).toBeTruthy();
    // No progress view: the panel stayed on the start form.
    expect(screen.queryByText(/Move complete/)).toBeNull();
  });
});

// #1239: the time off queue links straight to the sweep a request enqueued, so the
// panel has to open ON that job rather than on an empty start form. Without this the
// link lands on a page showing no sign of the sweep the manager was just told about.
describe("BulkReassignCoverage opened on an existing job (#1239)", () => {
  it("polls the job it was given and shows its progress", async () => {
    render(
      <BulkReassignCoverage
        agentId="out1"
        agentName="Adam"
        reassignReasons={REASSIGN_REASONS}
        initialJobId="job1"
      />,
    );

    await waitFor(() =>
      expect(http.getJson).toHaveBeenCalledWith("/api/admin/agents/out1/bulk-reassign?jobId=job1"),
    );
    // The progress view, not the start form: the panel is reporting, not offering.
    expect((await screen.findAllByText(/Couldn't place/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /move these bookings/i })).toBeNull();
  });
});

// #2122. The panel drew a FINISHED progress bar over zero work: `pct = total === 0
// ? 100`, so a move that moved nothing showed a full sky bar, a green Done pill,
// the heading "Move complete" and a figure reading "Moved 0". A completed bar and
// a count of nothing contradict each other, and the bar was the loudest thing on
// the panel. This is also the panel an admin lands on straight from a time off
// approval, which is exactly when somebody needs to know whether coverage happened.
describe("BulkReassignCoverage: what the move says it did (#2122)", () => {
  const openOnJob = async (fixture: unknown) => {
    http.getJson.mockImplementation(async (url: string) =>
      url.includes("jobId=")
        ? { ok: true, status: 200, data: fixture }
        : { ok: true, status: 200, data: { count: 5 } },
    );
    render(
      <BulkReassignCoverage
        agentId="out1"
        agentName="Adam"
        reassignReasons={REASSIGN_REASONS}
        initialJobId="job1"
      />,
    );
    await screen.findByText(/Nothing to move|Move complete|Moving/);
  };

  it("says nothing was moved in words, and draws no mark at all", async () => {
    await openOnJob(emptyFixture);

    expect(screen.getByText("Nothing to move")).toBeTruthy();
    expect(screen.getByText(/no upcoming bookings between/i)).toBeTruthy();
    // The defect itself: no bar, no percentage, and no claim that a move completed.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(screen.queryByText(/Move complete/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/100\s*%/);
    // And a way onward, so the panel is not a dead end.
    expect(screen.getByRole("button", { name: /start a move/i })).toBeTruthy();
  });

  it("draws one mark per booking, telling the three outcomes apart", async () => {
    await openOnJob(mixedFixture);

    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    // One per BOOKING, not per percent, so the mark can never disagree with the
    // counts beside it: 4 marks for 3 bookings is the fault Dan caught by counting.
    const marks = bar.querySelectorAll("span");
    expect(marks.length).toBe(3);
    // Three different treatments for three different outcomes. A skip is not a
    // failure: the engine's own rule is that a booking gone, cancelled or
    // completed is skipped and never a failure.
    const classes = [...marks].map((m) => m.className);
    expect(new Set(classes).size).toBe(3);
  });

  it("tells a screen reader what it measures, and the range", async () => {
    await openOnJob(runningFixture);

    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    // A bare aria-valuenow announces a number with nothing saying what it means.
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("10");
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-label")).toMatch(/moving/i);
    expect(bar.getAttribute("aria-label")).toMatch(/10/);
  });

  it("says the counts once, with no full stop while it is still running", async () => {
    await openOnJob(runningFixture);

    expect(screen.getByText("Moved 4 of 10")).toBeTruthy();
    // The two lines that said nothing: one is obvious from watching it, the other
    // is the count again.
    expect(document.body.textContent).not.toMatch(/one at a time/i);
    expect(document.body.textContent).not.toMatch(/to go/i);
    // And no percentage anywhere: the mark states the proportion, once.
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
  });

  it("counts each exception once in the sentence, and explains it once on its row", async () => {
    await openOnJob(mixedFixture);

    expect(screen.getByText("Moved 1 of 3. 1 could not be placed. 1 skipped.")).toBeTruthy();
    // The reason lives on the row, not in the sentence as well.
    expect(screen.getByText(/No agent was free/)).toBeTruthy();
    expect(screen.getByText(/cancelled before it could be moved/)).toBeTruthy();
  });

  it("lists the skipped bookings, with no control, because there is nothing to do", async () => {
    await openOnJob(mixedFixture);

    expect(screen.getByText("Skipped (1)")).toBeTruthy();
    // The one a person must place has a link; the one nobody can place does not,
    // because a control that cannot do what it says is worse than none.
    expect(screen.getByRole("link", { name: /place by hand/i })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /place by hand/i })).toHaveLength(1);
  });

  // The predicate is asked of the ENGINE's own list, not of a string compared in
  // the component. Driven FROM the constant, so a status added to it is covered
  // here by construction and the two sides cannot drift into disagreeing about
  // what a skip is (L263). The drift would be a Place by hand link on a booking
  // that no longer exists, which is a control that cannot do what it says.
  it("offers no control for any status the engine calls a skip", async () => {
    for (const status of SKIPPED_ITEM_STATUSES) {
      cleanup();
      await openOnJob({
        ...mixedFixture,
        actionable: [],
        summary: summarizeBulkReassignItems([{ status }]),
        skipped: [
          {
            bookingId: "bk-gone",
            status,
            detail: "Booking was cancelled before it could be moved.",
            startsAt: "2026-07-26T15:00:00.000Z",
            attendeeName: "Alex",
          },
        ],
      });
      expect(screen.getByText(/cancelled before it could be moved/)).toBeTruthy();
      expect(screen.queryByRole("link", { name: /place by hand/i })).toBeNull();
    }
  });

  // And the positive half, or the assertion above passes on a panel that renders
  // no links at all (L159).
  it("does offer the control for a status the engine calls actionable", async () => {
    for (const status of ACTIONABLE_ITEM_STATUSES) {
      cleanup();
      await openOnJob({
        ...mixedFixture,
        skipped: [],
        summary: summarizeBulkReassignItems([{ status }]),
        actionable: [
          {
            bookingId: "bk-stuck",
            status,
            detail: "No agent was free at the original time.",
            startsAt: "2026-07-25T17:00:00.000Z",
            attendeeName: "Kris",
          },
        ],
      });
      expect(screen.getByRole("link", { name: /place by hand/i })).toBeTruthy();
    }
  });

  it("drops the instruction above the rows, since every row carries it", async () => {
    await openOnJob(mixedFixture);
    expect(document.body.textContent).not.toMatch(/Open each one to place it by hand/i);
  });
});

/**
 * The fixtures above stand in for what the server sends, so they are held to the
 * predicate the panel judges a real reply by (#2135). Without this, a fixture
 * that drifted from the server's shape would quietly exercise the unreadable
 * path while every assertion below still read as coverage (L48).
 */
describe("BulkReassignCoverage fixtures", () => {
  it("are shapes the panel would accept from the server", () => {
    for (const [name, fixture] of [
      ["progress", progressFixture],
      ["mixed", mixedFixture],
      ["empty", emptyFixture],
      ["running", runningFixture],
    ] as const) {
      expect(isBulkReassignProgress(fixture), name).toBe(true);
    }
  });
});

/**
 * A 200 the panel cannot read (#2135).
 *
 * `const done = progress?.summary.done` guarded a null progress and not a progress
 * whose `summary` is missing, so an unexpected body threw during render and the
 * admin page's error boundary blanked the WHOLE page. Seen live on 2026-09-09.
 * `getJson` already refuses a non-ok response, so this is the successful but wrong
 * case: a shape change, a page older than the server (L598), or something else
 * answering 200.
 */
describe("BulkReassignCoverage: a progress reply it cannot read (#2135)", () => {
  const openOnUnreadable = async (body: unknown) => {
    http.getJson.mockImplementation(async (url: string) =>
      url.includes("jobId=")
        ? { ok: true, status: 200, data: body }
        : { ok: true, status: 200, data: { count: 5 } },
    );
    render(
      <BulkReassignCoverage
        agentId="out1"
        agentName="Adam"
        reassignReasons={REASSIGN_REASONS}
        initialJobId="job1"
      />,
    );
  };

  it("says so, in its own words, instead of throwing", async () => {
    // The exact body observed live: a 200 whose summary is not there.
    await openOnUnreadable({ job: { id: "job1" }, actionable: [], skipped: [] });

    expect(await screen.findByText(/couldn't read the move's progress/i)).toBeTruthy();
    // Not a blank and not a success (L10, L11).
    expect(screen.queryByText(/Move complete/)).toBeNull();
    expect(screen.queryByText("Nothing to move")).toBeNull();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("is a THIRD state, not the lost contact one", async () => {
    await openOnUnreadable({ error: "Not found" });
    await screen.findByText(/couldn't read the move's progress/i);
    // Lost contact is a reply that never came. This one came and did not fit, and
    // the remedy is different, so the two must not share a message.
    expect(screen.queryByText(/lost contact/i)).toBeNull();
    expect(screen.getByText(/reloading this page/i)).toBeTruthy();
  });

  it("recovers on the next readable poll rather than staying stuck", async () => {
    let reads = 0;
    http.getJson.mockImplementation(async (url: string) => {
      if (!url.includes("jobId=")) return { ok: true, status: 200, data: { count: 5 } };
      reads += 1;
      return { ok: true, status: 200, data: reads === 1 ? { nonsense: true } : progressFixture };
    });
    vi.useFakeTimers();
    try {
      render(
        <BulkReassignCoverage
          agentId="out1"
          agentName="Adam"
          reassignReasons={REASSIGN_REASONS}
          initialJobId="job1"
        />,
      );
      // The first poll is unreadable.
      await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
      // The panel keeps polling, so a reply it can read puts it back on progress.
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toMatch(/couldn't read the move's progress/i),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The same shape question, on the OTHER read in this panel (#2135). Swept for in
 * the fix's own diff, because the place a defect class is most likely to be
 * repeated is the change that fixes it (L387).
 */
describe("BulkReassignCoverage: a preview count it cannot read", () => {
  it("says the count is unknown rather than printing it at the reader", async () => {
    http.getJson.mockImplementation(async (url: string) =>
      url.includes("jobId=")
        ? { ok: true, status: 200, data: progressFixture }
        : { ok: true, status: 200, data: { count: { total: 5 } } },
    );
    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);

    expect(await screen.findByText(/enter a range to see how many bookings would move/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\[object Object\]|NaN|undefined bookings/);
  });
});

/**
 * The zero outcome (#2142, #2136). Two arrivals, two different truths.
 */
describe("BulkReassignCoverage: a move that had nothing to move", () => {
  it("goes back to the form when the reader started it here, and never says another", async () => {
    let previews = 0;
    http.getJson.mockImplementation(async (url: string) => {
      if (url.includes("jobId=")) return { ok: true, status: 200, data: emptyFixture };
      previews += 1;
      // The race this state IS: the preview counted bookings, the engine found
      // none by the time it ran. The preview agrees on the next read.
      return { ok: true, status: 200, data: { count: previews === 1 ? 5 : 0 } };
    });
    http.postJson.mockResolvedValueOnce({ ok: true, status: 200, data: { jobId: "job1", itemCount: 0 } });

    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);
    fireEvent.click(await screen.findByRole("button", { name: /move these bookings/i }));

    // Back on the form, with the range controls the reader would reach for next.
    expect(await screen.findByText(/nothing moved/i)).toBeTruthy();
    expect(screen.getByLabelText(/^From$/)).toBeTruthy();
    expect(screen.getByLabelText(/Until/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /move these bookings/i })).toBeTruthy();
    // The false claim: nothing was started, so nothing can be started AGAIN.
    expect(screen.queryByRole("button", { name: /start another/i })).toBeNull();
    expect(screen.queryByText("Nothing to move")).toBeNull();
  });

  it("keeps the range the reader chose rather than resetting it", async () => {
    http.getJson.mockImplementation(async (url: string) =>
      url.includes("jobId=")
        ? { ok: true, status: 200, data: emptyFixture }
        : { ok: true, status: 200, data: { count: 0 } },
    );
    http.postJson.mockResolvedValueOnce({ ok: true, status: 200, data: { jobId: "job1", itemCount: 0 } });

    render(<BulkReassignCoverage agentId="out1" agentName="Adam" reassignReasons={REASSIGN_REASONS} />);
    const until = screen.getByLabelText(/Until/) as HTMLInputElement;
    fireEvent.change(until, { target: { value: "2026-09-30" } });
    const from = screen.getByLabelText(/^From$/) as HTMLInputElement;
    const chosenFrom = from.value;

    fireEvent.click(await screen.findByRole("button", { name: /move these bookings/i }));
    await screen.findByText(/nothing moved/i);

    expect((screen.getByLabelText(/Until/) as HTMLInputElement).value).toBe("2026-09-30");
    expect((screen.getByLabelText(/^From$/) as HTMLInputElement).value).toBe(chosenFrom);
  });

  it("names the window instead of claiming the reader chose it, on a sweep it was opened on", async () => {
    http.getJson.mockImplementation(async (url: string) =>
      url.includes("jobId=")
        ? { ok: true, status: 200, data: emptyFixture }
        : { ok: true, status: 200, data: { count: 5 } },
    );
    render(
      <BulkReassignCoverage
        agentId="out1"
        agentName="Adam"
        reassignReasons={REASSIGN_REASONS}
        initialJobId="job1"
      />,
    );

    expect(await screen.findByText("Nothing to move")).toBeTruthy();
    // A time off approval or an offboarding chose this window, not the reader.
    expect(document.body.textContent).not.toMatch(/range you chose/i);
    expect(screen.getByText(/no upcoming bookings between/i)).toBeTruthy();
    // Nothing was started here either, so the reset control cannot say another.
    expect(screen.queryByRole("button", { name: /start another/i })).toBeNull();
    expect(screen.getByRole("button", { name: /start a move/i })).toBeTruthy();
  });
});
