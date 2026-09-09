// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

const progressFixture = {
  job: { id: "job1", out_user_id: "out1", status: "done" },
  summary: {
    total: 2,
    counts: { pending: 0, moved: 1, unplaceable: 1, skipped: 0, failed: 0 },
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
    counts: { pending: 0, moved: 1, unplaceable: 1, skipped: 1, failed: 0 },
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
  summary: { total: 0, counts: { pending: 0, moved: 0, unplaceable: 0, skipped: 0, failed: 0 }, done: true },
  actionable: [],
  skipped: [],
};

/** Mid run, so the mark has something waiting and something being worked on. */
const runningFixture = {
  ...progressFixture,
  job: { id: "job1", out_user_id: "out1", status: "active" },
  summary: { total: 10, counts: { pending: 6, moved: 4, unplaceable: 0, skipped: 0, failed: 0 }, done: false },
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
    expect(screen.getByText(/no upcoming bookings in the range you chose/i)).toBeTruthy();
    // The defect itself: no bar, no percentage, and no claim that a move completed.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(screen.queryByText(/Move complete/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/100\s*%/);
    // And a way onward, so the panel is not a dead end.
    expect(screen.getByRole("button", { name: /start another/i })).toBeTruthy();
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

  it("drops the instruction above the rows, since every row carries it", async () => {
    await openOnJob(mixedFixture);
    expect(document.body.textContent).not.toMatch(/Open each one to place it by hand/i);
  });
});
