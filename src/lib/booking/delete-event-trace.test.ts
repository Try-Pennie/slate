import { describe, it, expect, vi, beforeEach } from "vitest";

// #1049: deleteEventBestEffort is the last line of defence for a Google event
// Slate no longer wants. The live delete failing is expected and handled: the
// event goes on the retry queue. But the ENQUEUE was wrapped in a bare catch, so
// if the queue write failed too, the event was orphaned on the agent's calendar
// with nothing anywhere recording that it existed.
//
// That is the worst kind of silent failure in this codebase: the agent keeps
// showing as busy for a booking that is gone, availability stays wrong, and there
// is no id to search for. The contract is unchanged (it must never throw into the
// booking flow), so the only thing that can make it findable is a log line.
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn() } }));

import { deleteEventBestEffort } from "./orchestration";

type Deps = Parameters<typeof deleteEventBestEffort>[0];

/** Only the two seams this path touches; the rest of BookingDeps is unreachable
 *  from here, so a partial fake keeps the test about the behaviour. */
function deps(over: {
  deleteEvent?: () => Promise<void>;
  enqueueEventDeletion?: () => Promise<void>;
}): Deps {
  return {
    deleteEvent: over.deleteEvent ?? (async () => {}),
    enqueueEventDeletion: over.enqueueEventDeletion ?? (async () => {}),
  } as unknown as Deps;
}

beforeEach(() => vi.clearAllMocks());

describe("deleteEventBestEffort", () => {
  it("deletes cleanly and neither enqueues nor logs", async () => {
    const enqueueEventDeletion = vi.fn(async () => {});
    await deleteEventBestEffort(
      deps({ enqueueEventDeletion }),
      "agent@trypennie.com",
      "gcal-evt-1",
      "bk-1",
    );
    expect(enqueueEventDeletion).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  // The EXPECTED failure: the live delete fails, the queue takes it. Still silent,
  // because the retry drain will handle it and nothing is lost.
  it("falls back to the retry queue when the live delete fails, without logging", async () => {
    const enqueueEventDeletion = vi.fn(async () => {});
    await deleteEventBestEffort(
      deps({
        deleteEvent: async () => {
          throw new Error("503 backendError");
        },
        enqueueEventDeletion,
      }),
      "agent@trypennie.com",
      "gcal-evt-1",
      "bk-1",
    );
    expect(enqueueEventDeletion).toHaveBeenCalledTimes(1);
    // Handled, recoverable, and the drain owns it: this must not page or log.
    expect(logError).not.toHaveBeenCalled();
  });

  // THE ORPHAN CASE. Both failed, so nothing will ever retry this event.
  it("logs with the booking and event ids when the queue write ALSO fails", async () => {
    await deleteEventBestEffort(
      deps({
        deleteEvent: async () => {
          throw new Error("503 backendError");
        },
        enqueueEventDeletion: async () => {
          throw new Error("pending_event_deletions insert denied");
        },
      }),
      "agent@trypennie.com",
      "gcal-evt-1",
      "bk-1",
    );

    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, fields, err] = logError.mock.calls[0] as [
      string,
      Record<string, unknown>,
      unknown,
    ];
    expect(tag).toBe("booking");
    // Both ids, because either one is how a human finds the orphaned event.
    expect(fields.booking_id).toBe("bk-1");
    expect(fields.gcal_event_id).toBe("gcal-evt-1");
    // The Error goes through so Cloudflare serializes the stack.
    expect(err).toBeInstanceOf(Error);
  });

  it("still does not throw when both fail, so the booking flow proceeds", async () => {
    // The whole reason this is best-effort: a cancel must not fail because a
    // calendar tidy-up did.
    await expect(
      deleteEventBestEffort(
        deps({
          deleteEvent: async () => {
            throw new Error("boom");
          },
          enqueueEventDeletion: async () => {
            throw new Error("also boom");
          },
        }),
        "agent@trypennie.com",
        "gcal-evt-1",
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it("records a null booking id rather than omitting it (reservation cleanup path)", async () => {
    // Some callers have no booking yet (a reservation's event). The line must
    // still be emitted; the event id alone is enough to find it.
    await deleteEventBestEffort(
      deps({
        deleteEvent: async () => {
          throw new Error("boom");
        },
        enqueueEventDeletion: async () => {
          throw new Error("also boom");
        },
      }),
      "agent@trypennie.com",
      "gcal-evt-9",
      null,
    );
    const [, fields] = logError.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.gcal_event_id).toBe("gcal-evt-9");
    expect(fields.booking_id).toBeNull();
  });
});
