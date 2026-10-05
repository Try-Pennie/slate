import { describe, it, expect, vi, beforeEach } from "vitest";

// #2577: the deletion drain now ends a row Google has refused for good on its first
// pass and reports it as `refused`, apart from `stuck`. The wrapper in service.ts
// owes each population its own alert, because they send the reader to different
// remedies: stuck says check Google API health and wait, refused says a person has
// to fix an account (re-auth or remove for gone, a Workspace admin granting Calendar
// for never provisioned). And the stuck CONDITION's recovery must still be judged on
// stuck rows alone: a refused row is a finished incident, not an open state, so it
// must neither hold the stuck page open nor block the queue's all-clear.
//
// #1630: a refused calendar whose owner has LEFT is a departure, not an account to
// fix. Nobody can act on it, so it goes to the info channel on its own key and
// never pages; an owner still active, or one Slate could not read, keeps the page.

const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
  resolveRecovered: vi.fn(async (_r: { key: string; text: string }[]) => [] as string[]),
}));
vi.mock("@/lib/notify/dispatch", () => notify);

const drain = vi.hoisted(() => ({
  result: {
    deleted: 0,
    failed: 0,
    stuck: [] as unknown[],
    refused: [] as unknown[],
  },
  /** Set to stand in for who the refused calendars belong to; unset runs the real read. */
  facts: null as unknown,
}));
vi.mock("@/lib/booking/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/orchestration")>();
  return {
    ...actual,
    processPendingEventDeletions: vi.fn(async () => drain.result),
    describeRefusedDeletions: vi.fn((...args: Parameters<typeof actual.describeRefusedDeletions>) =>
      drain.facts ? Promise.resolve(drain.facts) : actual.describeRefusedDeletions(...args),
    ),
  };
});

// realDeps() is built but never exercised by the drain, which is the mock above.
// The owner read IS real when `drain.facts` is unset, and this refusal is how it
// fails: that is the case where Slate cannot tell whether anybody has left.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("the wrapper test must not reach the database");
  },
}));

import { processPendingEventDeletions } from "./service";

function row(id: string, email: string, eventId: string) {
  return {
    id,
    calendar_email: email,
    gcal_event_id: eventId,
    booking_id: null,
    attempts: 50,
    last_error: null,
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
  };
}

const sentKeys = () => notify.sendThrottledAlert.mock.calls.map((c) => (c as unknown as [string])[0]);
const sentText = (key: string) => {
  const call = notify.sendThrottledAlert.mock.calls.find((c) => (c as unknown as [string])[0] === key);
  return (call as unknown as [string, number, string] | undefined)?.[2] ?? "";
};
const recoveredKeys = () => (notify.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);

beforeEach(() => {
  vi.clearAllMocks();
  drain.result = { deleted: 0, failed: 0, stuck: [], refused: [] };
  drain.facts = null;
});

const infoKeys = () => notify.sendThrottledInfo.mock.calls.map((c) => (c as unknown as [string])[0]);
const infoText = (key: string) => {
  const call = notify.sendThrottledInfo.mock.calls.find((c) => (c as unknown as [string])[0] === key);
  return (call as unknown as [string, number, string] | undefined)?.[2] ?? "";
};

const LEFT_AT = "2026-10-05T14:43:27.000Z";

/** What `describeRefusedDeletions` answers for the given owners. */
function factsFor(
  refused: { row: ReturnType<typeof row>; kind: string; moved?: boolean | null }[],
  owners: Record<string, { name: string | null; deactivatedAt: string | null }>,
) {
  return {
    rows: refused.map((r) => ({
      calendarEmail: r.row.calendar_email,
      eventId: r.row.gcal_event_id,
      kind: r.kind,
      movedToAnotherAdvisor: r.moved ?? null,
    })),
    owners: new Map(Object.entries(owners)),
  };
}

describe("the deletion drain wrapper alerts refused rows apart from stuck ones (#2577)", () => {
  it("sends the refused alert with per kind copy, and still clears the stuck condition", async () => {
    drain.result = {
      deleted: 0,
      failed: 2,
      stuck: [],
      refused: [
        { row: row("p1", "new-hire@x.com", "evt-1"), kind: "not-provisioned" },
        { row: row("p2", "left@x.com", "evt-2"), kind: "gone" },
      ],
    };

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual(["pending_event_deletions_refused"]);
    const text = sentText("pending_event_deletions_refused");
    expect(text).toContain("new-hire@x.com");
    expect(text).toContain("left@x.com");
    expect(text).toContain("Workspace admin");
    expect(text).toMatch(/re-authenticate/i);
    expect(text).not.toMatch(/^\s*Slate\b/i);
    // Nothing is stuck, so the stuck condition's all-clear still goes out: a
    // refused row is over, it is not an open state on the queue.
    expect(recoveredKeys()).toEqual(["pending_event_deletions"]);
  });

  it("sends only the stuck alert for stuck rows, and no recovery", async () => {
    drain.result = {
      deleted: 0,
      failed: 1,
      stuck: [row("p3", "fine@x.com", "evt-3")],
      refused: [],
    };

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual(["pending_event_deletions"]);
    expect(sentText("pending_event_deletions")).toContain("evt-3");
    expect(notify.resolveRecovered).not.toHaveBeenCalled();
  });

  it("sends both when both populations are present, and no recovery", async () => {
    drain.result = {
      deleted: 0,
      failed: 2,
      stuck: [row("p3", "fine@x.com", "evt-3")],
      refused: [{ row: row("p1", "new-hire@x.com", "evt-1"), kind: "not-provisioned" }],
    };

    await processPendingEventDeletions(20);

    expect(sentKeys().sort()).toEqual(["pending_event_deletions", "pending_event_deletions_refused"]);
    expect(sentText("pending_event_deletions")).not.toContain("evt-1");
    expect(sentText("pending_event_deletions_refused")).not.toContain("evt-3");
    expect(notify.resolveRecovered).not.toHaveBeenCalled();
  });

  it("sends nothing and clears the stuck condition on a clean pass", async () => {
    drain.result = { deleted: 3, failed: 0, stuck: [], refused: [] };

    await processPendingEventDeletions(20);

    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
    expect(notify.sendThrottledInfo).not.toHaveBeenCalled();
    expect(recoveredKeys()).toEqual(["pending_event_deletions"]);
  });
});

describe("a refused calendar whose owner has left is a departure, not a page (#1630)", () => {
  const leftRows = [
    { row: row("p1", "left@x.com", "evt-1"), kind: "not-provisioned", moved: true },
    { row: row("p2", "left@x.com", "evt-2"), kind: "not-provisioned", moved: true },
  ];

  it("sends the departure to the info channel on its own key, and never pages", async () => {
    drain.result = { deleted: 0, failed: 2, stuck: [], refused: leftRows };
    drain.facts = factsFor(leftRows, { "left@x.com": { name: "Jane Doe", deactivatedAt: LEFT_AT } });

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual([]);
    expect(infoKeys()).toEqual(["pending_event_deletions_departed"]);
    const text = infoText("pending_event_deletions_departed");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("left on Mon, Oct 5 at 10:43am ET");
    expect(text).toContain("Both calls were moved to other advisors");
    expect(text).toContain("No account needs fixing");
    expect(text).not.toMatch(/Workspace admin|re-authenticate/);
    expect(recoveredKeys()).toEqual(["pending_event_deletions"]);
  });

  it("keeps today's page, word for word, for an owner who is still active", async () => {
    const activeRows = [{ row: row("p3", "new-hire@x.com", "evt-3"), kind: "not-provisioned" }];
    drain.result = { deleted: 0, failed: 1, stuck: [], refused: activeRows };
    drain.facts = factsFor(activeRows, { "new-hire@x.com": { name: "New Hire", deactivatedAt: null } });

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual(["pending_event_deletions_refused"]);
    expect(sentText("pending_event_deletions_refused")).toContain("Workspace admin");
    expect(notify.sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("falls back to today's page when who owns the calendar cannot be read", async () => {
    // drain.facts unset: the REAL owner read runs against a database that refuses.
    drain.result = { deleted: 0, failed: 2, stuck: [], refused: leftRows };

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual(["pending_event_deletions_refused"]);
    expect(sentText("pending_event_deletions_refused")).toContain("left@x.com");
    expect(sentText("pending_event_deletions_refused")).toContain("Workspace admin");
    expect(notify.sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("sends both for a mix, each naming only its own calendars", async () => {
    const mixed = [...leftRows, { row: row("p3", "new-hire@x.com", "evt-3"), kind: "gone" }];
    drain.result = { deleted: 0, failed: 3, stuck: [], refused: mixed };
    drain.facts = factsFor(mixed, {
      "left@x.com": { name: "Jane Doe", deactivatedAt: LEFT_AT },
      "new-hire@x.com": { name: "New Hire", deactivatedAt: null },
    });

    await processPendingEventDeletions(20);

    expect(sentKeys()).toEqual(["pending_event_deletions_refused"]);
    expect(infoKeys()).toEqual(["pending_event_deletions_departed"]);
    expect(sentText("pending_event_deletions_refused")).toContain("new-hire@x.com");
    expect(sentText("pending_event_deletions_refused")).not.toContain("left@x.com");
    expect(infoText("pending_event_deletions_departed")).toContain("left@x.com");
    expect(infoText("pending_event_deletions_departed")).not.toContain("new-hire@x.com");
  });
});
