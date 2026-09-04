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
