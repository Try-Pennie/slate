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
  b.eq = self;
  b.contains = self;
  b.order = self;
  b.limit = self;
  b.update = () => {
    b._updated = true;
    return b;
  };
  b.insert = (row: Record<string, unknown>) => {
    b._insert = true;
    state.inserted.push(row);
    return b;
  };
  // insert().select("id").single() -> the new delivery row emitWebhook then sends.
  b.single = () => Promise.resolve({ data: { id: "d-new" }, error: null });
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
