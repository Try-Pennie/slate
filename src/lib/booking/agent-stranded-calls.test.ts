import { describe, it, expect } from "vitest";

import {
  loadAgentStrandedCalls,
  type AgentStrandedBookingRow,
  type AgentStrandedItemRow,
  type AgentStrandedJobRow,
  type AgentStrandedReads,
} from "@/lib/booking/agent-stranded-calls";

// #3595: the agent page lists this agent's calls the last coverage sweep could not
// place. What counts is decided by `countStranded`, the predicate the coverage
// needs human alert pages on (#3303, #3597), so the page and the alert can never
// disagree about which calls are waiting for a person. Under test is the loader's
// assembly: which reads it makes, what it hands that predicate, and what comes back.

const NOW = Date.parse("2026-10-21T15:00:00Z");
const AGENT = "agent-a";

function booking(over: Partial<AgentStrandedBookingRow> = {}): AgentStrandedBookingRow {
  return {
    id: "b1",
    starts_at: "2026-10-23T14:00:00Z",
    attendee_name: "Marisol Ortega",
    assigned_user_id: AGENT,
    // Out of the pool: not bookable and no activation owed.
    users: { bookable: false, deactivated_at: null, bookable_pending_since: null },
    ...over,
  };
}

function item(over: Partial<AgentStrandedItemRow> = {}): AgentStrandedItemRow {
  return {
    booking_id: "b1",
    status: "unplaceable",
    job_id: "j1",
    updated_at: "2026-10-11T23:55:00Z",
    detail: "No other advisor was free at this time",
    ...over,
  };
}

function job(over: Partial<AgentStrandedJobRow> = {}): AgentStrandedJobRow {
  return {
    id: "j1",
    out_user_id: AGENT,
    status: "done",
    created_at: "2026-10-11T23:57:00Z",
    updated_at: "2026-10-12T00:02:00Z",
    redistribute_marked_at: "2026-10-11T23:57:00Z",
    ...over,
  };
}

/** Fake reads that record what they were asked, so a test can see the scoping. */
function readsOf(rows: {
  bookings?: AgentStrandedBookingRow[];
  items?: AgentStrandedItemRow[];
  jobs?: AgentStrandedJobRow[];
}): AgentStrandedReads & { asked: { bookingsFor: string[]; itemsFor: string[][]; jobsFor: string[][] } } {
  const asked = { bookingsFor: [] as string[], itemsFor: [] as string[][], jobsFor: [] as string[][] };
  return {
    asked,
    async upcomingBookings(agentId, nowIso) {
      asked.bookingsFor.push(`${agentId}@${nowIso}`);
      return rows.bookings ?? [];
    },
    async actionableItems(bookingIds) {
      asked.itemsFor.push(bookingIds);
      return (rows.items ?? []).filter((i) => bookingIds.includes(i.booking_id));
    },
    async jobs(jobIds) {
      asked.jobsFor.push(jobIds);
      return (rows.jobs ?? []).filter((j) => jobIds.includes(j.id));
    },
  };
}

describe("loadAgentStrandedCalls (#3595)", () => {
  it("returns the calls a finished sweep could not place, with the row the move's own list draws", async () => {
    const reads = readsOf({ bookings: [booking()], items: [item()], jobs: [job()] });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res.calls).toEqual([
      {
        bookingId: "b1",
        status: "unplaceable",
        detail: "No other advisor was free at this time",
        startsAt: "2026-10-23T14:00:00Z",
        attendeeName: "Marisol Ortega",
      },
    ]);
    expect(res.moves).toEqual(["2026-10-11T23:57:00Z"]);
    // Scoped to this agent's upcoming calls, as of the clock it was handed.
    expect(reads.asked.bookingsFor).toEqual([`${AGENT}@2026-10-21T15:00:00.000Z`]);
  });

  it("returns an empty list for an agent with nothing stranded, and asks nothing further", async () => {
    const reads = readsOf({ bookings: [booking()], items: [], jobs: [job()] });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res).toEqual({ calls: [], moves: [] });
    expect(reads.asked.jobsFor).toEqual([]);
  });

  it("asks for no items at all when the agent holds no upcoming calls", async () => {
    const reads = readsOf({ bookings: [], items: [item()], jobs: [job()] });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res).toEqual({ calls: [], moves: [] });
    expect(reads.asked.itemsFor).toEqual([]);
  });

  it("keeps a failed move, which also needs a person", async () => {
    const reads = readsOf({
      bookings: [booking()],
      items: [item({ status: "failed", detail: "The move failed partway" })],
      jobs: [job()],
    });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res.calls.map((c) => c.status)).toEqual(["failed"]);
  });

  // #3597, settled for both surfaces: a Redistribute flap that cleared puts the agent
  // back in the pool, and they will take the call. The alert stopped paging about it,
  // so the page does not list it either.
  it("drops a call whose Redistribute sweep's agent is back in the pool", async () => {
    const reads = readsOf({
      bookings: [booking({ users: { bookable: true, deactivated_at: null, bookable_pending_since: null } })],
      items: [item()],
      jobs: [job()],
    });
    expect((await loadAgentStrandedCalls(AGENT, NOW, reads)).calls).toEqual([]);
  });

  // ...but approved time off moves calls out of an agent who STAYS in the pool and is
  // away during the window, so an in pool holder there is still stranded.
  it("keeps a time off sweep's call even though the agent is in the pool", async () => {
    const reads = readsOf({
      bookings: [booking({ users: { bookable: true, deactivated_at: null, bookable_pending_since: null } })],
      items: [item()],
      jobs: [job({ redistribute_marked_at: null })],
    });
    expect((await loadAgentStrandedCalls(AGENT, NOW, reads)).calls).toHaveLength(1);
  });

  it("drops a call now with this agent that a sweep of SOMEBODY ELSE gave up on", async () => {
    const reads = readsOf({
      bookings: [booking()],
      items: [item()],
      jobs: [job({ out_user_id: "agent-b" })],
    });
    expect((await loadAgentStrandedCalls(AGENT, NOW, reads)).calls).toEqual([]);
  });

  // A sweep still running has more to settle; its progress view is where those show.
  it("leaves out a give up from a sweep still running", async () => {
    const reads = readsOf({
      bookings: [booking()],
      items: [item({ updated_at: "2026-10-21T14:55:00Z" })],
      jobs: [job({ status: "active", updated_at: "2026-10-21T14:55:00Z" })],
    });
    expect((await loadAgentStrandedCalls(AGENT, NOW, reads)).calls).toEqual([]);
  });

  it("lists one row per call however many sweeps gave up on it, carrying the latest attempt", async () => {
    const reads = readsOf({
      bookings: [booking()],
      items: [
        item({ job_id: "j1", updated_at: "2026-10-11T23:55:00Z", detail: "first" }),
        item({ job_id: "j2", updated_at: "2026-10-14T13:05:00Z", detail: "second" }),
      ],
      jobs: [
        job(),
        job({ id: "j2", created_at: "2026-10-14T13:00:00Z", updated_at: "2026-10-14T13:06:00Z" }),
      ],
    });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res.calls.map((c) => c.detail)).toEqual(["second"]);
    expect(res.moves).toEqual(["2026-10-14T13:00:00Z"]);
  });

  it("orders the calls soonest first and names every move that left one, newest first", async () => {
    const reads = readsOf({
      bookings: [
        booking({ id: "late", starts_at: "2026-10-27T20:00:00Z", attendee_name: "Luis" }),
        booking({ id: "soon", starts_at: "2026-10-23T14:00:00Z", attendee_name: "Marisol" }),
      ],
      items: [item({ booking_id: "late", job_id: "j1" }), item({ booking_id: "soon", job_id: "j2" })],
      jobs: [job(), job({ id: "j2", created_at: "2026-10-14T13:00:00Z" })],
    });
    const res = await loadAgentStrandedCalls(AGENT, NOW, reads);
    expect(res.calls.map((c) => c.attendeeName)).toEqual(["Marisol", "Luis"]);
    expect(res.moves).toEqual(["2026-10-14T13:00:00Z", "2026-10-11T23:57:00Z"]);
  });

  // The page's error state hangs off a throw. A read that failed must never come back
  // as an empty list, which would read as "nothing is waiting" (L10).
  it("throws when a read fails, rather than reporting nothing stranded", async () => {
    const reads = readsOf({ bookings: [booking()] });
    reads.actionableItems = async () => {
      throw new Error("items unreadable");
    };
    await expect(loadAgentStrandedCalls(AGENT, NOW, reads)).rejects.toThrow("items unreadable");
  });
});
