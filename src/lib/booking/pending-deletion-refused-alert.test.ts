import { describe, it, expect, vi, beforeEach } from "vitest";

// #2577: the deletion drain now ends a row Google has refused for good on its first
// pass and reports it as `refused`, apart from `stuck`. The wrapper in service.ts
// owes each population its own alert, because they send the reader to different
// remedies: stuck says check Google API health and wait, refused says a person has
// to fix an account (re-auth or remove for gone, a Workspace admin granting Calendar
// for never provisioned). And the stuck CONDITION's recovery must still be judged on
// stuck rows alone: a refused row is a finished incident, not an open state, so it
// must neither hold the stuck page open nor block the queue's all-clear.

const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
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
}));
vi.mock("@/lib/booking/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/orchestration")>();
  return {
    ...actual,
    processPendingEventDeletions: vi.fn(async () => drain.result),
  };
});

// realDeps() is built but never exercised: the drain itself is the mock above.
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
});

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
    expect(recoveredKeys()).toEqual(["pending_event_deletions"]);
  });
});
