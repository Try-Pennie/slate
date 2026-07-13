import { describe, it, expect, vi, beforeEach } from "vitest";

// #623: the webhook retry sweep must (a) load endpoints in ONE query per sweep
// instead of one-per-delivery (N+1), and (b) claim each delivery row via a
// compare-and-swap on `attempts` before sending, so a concurrent manual resend
// (or a second actor) can't double-POST the same attempt. These tests mock the
// supabase query builder and route each awaited chain to a canned result based
// on the table and whether it was an update+select (the CAS claim).

const state = vi.hoisted(() => ({
  deliveries: [] as Record<string, unknown>[],
  endpoints: [] as Record<string, unknown>[],
  claimWins: true,
  endpointSelects: 0,
  inserted: [] as Record<string, unknown>[],
  // #771: the filters emitWebhook narrows webhook_endpoints by, the error the
  // delivery insert returns, and the status writes send() makes.
  filters: [] as { table: string; col: string; val: unknown }[],
  insertError: null as null | { code?: string; message: string },
  updates: [] as Record<string, unknown>[],
}));

function resolve(b: Record<string, unknown>, table: string) {
  if (table === "webhook_endpoints") {
    return { data: b._single ? state.endpoints[0] : state.endpoints };
  }
  if (table === "webhook_deliveries") {
    if (b._updated) {
      // update().eq()...select("id") is the CAS claim; a bare update().eq() is
      // send()'s final status write.
      if (b._selectedAfterUpdate) {
        return { data: state.claimWins ? [{ id: "claimed" }] : [] };
      }
      return { data: null };
    }
    return { data: b._single ? state.deliveries[0] : state.deliveries };
  }
  return { data: null };
}

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {
    _updated: false,
    _selectedAfterUpdate: false,
    _single: false,
  };
  const self = () => b;
  b.select = () => {
    if (table === "webhook_endpoints" && !b._updated) state.endpointSelects++;
    if (b._updated) b._selectedAfterUpdate = true;
    return b;
  };
  b.in = self;
  b.lt = self;
  b.gte = self;
  b.eq = (col: string, val: unknown) => {
    state.filters.push({ table, col, val });
    return b;
  };
  b.contains = (col: string, val: unknown) => {
    state.filters.push({ table, col, val });
    return b;
  };
  b.order = self;
  b.limit = self;
  b.update = (payload: Record<string, unknown>) => {
    b._updated = true;
    state.updates.push(payload);
    return b;
  };
  b.insert = (row: Record<string, unknown>) => {
    b._insert = true;
    state.inserted.push(row);
    return b;
  };
  // insert().select("id").single() -> the new delivery row emitWebhook then sends.
  // A 23505 here is the dedupe collision: a prior call already enqueued this event.
  b.single = () =>
    Promise.resolve(
      state.insertError
        ? { data: null, error: state.insertError }
        : { data: { id: "d-new" }, error: null },
    );
  b.maybeSingle = () => {
    b._single = true;
    return Promise.resolve(resolve(b, table));
  };
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolve(b, table)).then(onF, onR);
  return b;
}

const from = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: vi.fn(async () => {}) }));

import { emitWebhook, retryFailedDeliveries, resendDelivery } from "./emit";
import type { BookingEventPayload } from "@/lib/webhooks/types";

const endpoint = {
  id: "ep1",
  org_id: "o1",
  url: "https://receiver.example/webhook",
  format: "generic",
  secret: "s3cr3t",
  auth_header: null,
  active: true,
};

function delivery(id: string, attempts = 1): Record<string, unknown> {
  return {
    id,
    endpoint_id: "ep1",
    event: "booking.created",
    payload: { booking: { id: "bk1" } },
    attempts,
    // Well past the backoff window so isDueForRetry() is true.
    updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.deliveries = [];
  state.endpoints = [endpoint];
  state.claimWins = true;
  state.endpointSelects = 0;
  state.inserted = [];
  state.filters = [];
  state.insertError = null;
  state.updates = [];
  from.mockImplementation((table: string) => makeBuilder(table));
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
  vi.stubGlobal("fetch", fetchMock);
});

describe("retryFailedDeliveries", () => {
  it("loads endpoints in a single query for many deliveries sharing one endpoint (no N+1)", async () => {
    state.deliveries = [delivery("d1"), delivery("d2"), delivery("d3")];

    const retried = await retryFailedDeliveries();

    expect(retried).toBe(3);
    expect(state.endpointSelects).toBe(1); // one webhook_endpoints read for the sweep
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips a delivery whose attempt claim is lost to a concurrent send (no double-POST)", async () => {
    state.deliveries = [delivery("d1")];
    state.claimWins = false; // another actor already bumped this attempt

    const retried = await retryFailedDeliveries();

    expect(retried).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// #771: emitWebhook is the function EVERY booking webhook flows through, and it had
// no direct coverage. Its three jobs: pick the right subscribers, record the delivery,
// and never deliver the same logical event twice. That last one is the exactly-once
// guarantee Regal and Cadence rely on, and it was only tested indirectly.
describe("emitWebhook", () => {
  const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

  it("delivers only to this org's ACTIVE endpoints subscribed to this event", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");

    const eps = state.filters.filter((f) => f.table === "webhook_endpoints");
    // A leak here would post one org's bookings to another org's receiver, or wake a
    // deactivated endpoint, or send a subscriber an event it never asked for.
    expect(eps).toContainEqual({ table: "webhook_endpoints", col: "org_id", val: "o1" });
    expect(eps).toContainEqual({ table: "webhook_endpoints", col: "active", val: true });
    expect(eps).toContainEqual({
      table: "webhook_endpoints",
      col: "events",
      val: ["booking.created"],
    });
  });

  it("fans out to every subscribed endpoint, one delivery row each", async () => {
    state.endpoints = [endpoint, { ...endpoint, id: "ep2", url: "https://other.example/hook" }];

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(state.inserted).toHaveLength(2);
    expect(state.inserted.map((r) => r.endpoint_id)).toEqual(["ep1", "ep2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the delivery with its event, payload and dedupe key before sending", async () => {
    await emitWebhook("o1", "booking.cancelled", payload, "evt-9");

    expect(state.inserted[0]).toMatchObject({
      endpoint_id: "ep1",
      event: "booking.cancelled",
      payload,
      status: "pending",
      dedupe_key: "evt-9",
      suppressed: false,
    });
  });

  it("does nothing at all when no endpoint subscribes", async () => {
    state.endpoints = [];

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(state.inserted).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The exactly-once guarantee (#436). The dedupe key is written under a partial
  // UNIQUE (endpoint_id, event, dedupe_key), so a re-enqueue of the same logical
  // event (a crash-resume re-running the side effects) hits a 23505. The ORIGINAL
  // delivery owns the send and its retries, so this call must drop BOTH the second
  // row and the second POST. Without this, a resumed booking double-fires into Regal.
  it("drops both the row and the POST when the dedupe key collides (exactly-once)", async () => {
    state.insertError = { code: "23505", message: "duplicate key value" };

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves no delivery half-sent when the insert fails for any other reason", async () => {
    state.insertError = { code: "08006", message: "connection failure" };

    await emitWebhook("o1", "booking.created", payload, "bk1");

    // No row means nothing owns a retry, so posting here would be an unrecorded send.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Failure paths. The booking has already committed by the time these run, so a
  // subscriber being down must never throw back into the booking flow. It must be
  // recorded as failed instead, which is what makes the retry sweep pick it up.
  it("marks the delivery failed (and does not throw) when the receiver rejects", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).resolves.toBeUndefined();

    expect(state.updates[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(String(state.updates[0].last_response)).toContain("500");
  });

  it("marks the delivery failed (and does not throw) when the receiver times out", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted"));

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).resolves.toBeUndefined();

    expect(state.updates[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("marks the delivery a success when the receiver accepts", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(state.updates[0]).toMatchObject({ status: "success", attempts: 1 });
  });
});

// #459: a booking on an is_test bucket (the smoke test's hidden bucket) must never
// reach Regal/Cadence. The delivery is still RECORDED, so the exactly-once dedupe
// stays observable in production (scripts/smoke-create-resume.ts counts these rows),
// but the external POST is skipped and the row is marked suppressed so no later send
// path can resurrect it.
describe("emitWebhook suppression", () => {
  const payload = { booking_id: "bk1", bucket_code: "999" } as unknown as BookingEventPayload;

  it("records the delivery but never POSTs it when suppressed", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1", true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].suppressed).toBe(true);
    // Terminal status, so the retry sweep (which picks up pending/failed) can never
    // pick it up and POST it after the fact.
    expect(state.inserted[0].status).toBe("success");
    // The row still carries its dedupe key, which is what makes the re-fire on a
    // crash-resume collapse on the partial unique index.
    expect(state.inserted[0].dedupe_key).toBe("bk1");
  });

  it("POSTs normally for a real bucket", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1", false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.inserted[0].suppressed).toBe(false);
    expect(state.inserted[0].status).toBe("pending");
  });

  it("refuses to resend a suppressed delivery (an admin cannot leak it downstream)", async () => {
    state.deliveries = [{ ...delivery("d1"), suppressed: true }];

    await resendDelivery("d1", "o1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resendDelivery", () => {
  it("re-fires when it wins the attempt claim", async () => {
    state.deliveries = [delivery("d1")];

    await resendDelivery("d1", "o1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send when it loses the attempt claim to a concurrent sweep", async () => {
    state.deliveries = [delivery("d1")];
    state.claimWins = false;

    await resendDelivery("d1", "o1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
