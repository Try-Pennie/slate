import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

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
  // The filters the retry and replay reads narrow by, and the status writes send() makes.
  filters: [] as { table: string; col: string; val: unknown }[],
  updates: [] as Record<string, unknown>[],
  // #2563: when set, the attempt claim is resolved by a REAL compare and swap
  // over this store (delivery id -> attempts) instead of the claimWins flag.
  // A race test driven by a flag we set ourselves only confirms our own
  // assumption about who wins (L70); this lets both actors read the same 0 and
  // makes exactly one of them win on the store's own arithmetic.
  cas: null as null | Map<string, number>,
  // #2085: an agent trait send reads the agent's CURRENT state by id.
  user: null as null | { bookable: boolean; deactivated_at: string | null },
  userError: null as null | { message: string },
  // #3495: emitWebhook writes its deliveries through ONE database function. Its
  // calls, a refusal it answers with, an answer that overrides the model below, and
  // the (endpoint, event, key) triples it has already written, for the dedupe.
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  enqueueError: null as null | { code?: string; message: string },
  enqueueAnswer: undefined as unknown,
  writtenKeys: new Set<string>(),
}));

/**
 * A model of `enqueue_webhook_deliveries` (migration 0173) over `state.endpoints`,
 * which every test treats as the org's active subscribers: the subscription filter
 * itself is proved in a real database (scripts/verify-webhook-enqueue-sql.ts), not
 * here. What the model keeps is the contract the TypeScript reads: one delivery per
 * subscriber, none for a key already written, suppressed when the caller's map names
 * a reason for the endpoint's format, a format the map does not name refused, and the
 * answer's shape, which both suites hold to scripts/fixtures/webhook-enqueue-answer.json.
 */
function enqueueModel(args: Record<string, unknown>) {
  if (state.enqueueError) return { data: null, error: state.enqueueError };
  if (state.enqueueAnswer !== undefined) return { data: state.enqueueAnswer, error: null };
  const suppression = args.p_suppression as Record<string, string | null>;
  const deliveries: Record<string, unknown>[] = [];
  for (const ep of state.endpoints) {
    const format = String(ep.format);
    if (!Object.hasOwn(suppression, format)) {
      return { data: null, error: { code: "22023", message: `no suppression decision for the ${format} format` } };
    }
    const key = args.p_dedupe_key === null ? null : `${String(ep.id)}|${String(args.p_event)}|${String(args.p_dedupe_key)}`;
    if (key !== null && state.writtenKeys.has(key)) continue;
    if (key !== null) state.writtenKeys.add(key);
    const reason = suppression[format];
    state.inserted.push({
      endpoint_id: ep.id,
      event: args.p_event,
      payload: args.p_payload,
      status: reason === null ? "pending" : "success",
      dedupe_key: args.p_dedupe_key,
      suppressed: reason !== null,
      last_response: reason,
    });
    // The first row is "d-new", the id the attempt claim tests seed their store with.
    const id = state.inserted.length === 1 ? "d-new" : `d-new-${state.inserted.length}`;
    deliveries.push({ id, suppressed: reason !== null, payload: args.p_payload, endpoint: ep });
  }
  return { data: { subscribers: state.endpoints.length, deliveries }, error: null };
}

const rpc = vi.hoisted(() => vi.fn());

function resolve(b: Record<string, unknown>, table: string) {
  if (table === "users") {
    if (state.userError) return { data: null, error: state.userError };
    return { data: state.user, error: null };
  }
  // The retry sweep's one read of the endpoints its deliveries name (#623).
  if (table === "webhook_endpoints") {
    return { data: b._single ? state.endpoints[0] : state.endpoints, error: null };
  }
  if (table === "webhook_deliveries") {
    if (b._updated) {
      // update().eq()...select("id") is the CAS claim; a bare update().eq() is
      // send()'s final status write.
      if (b._selectedAfterUpdate) {
        if (state.cas) {
          const eqs = b._eqs as { col: string; val: unknown }[];
          const idEq = eqs.find((e) => e.col === "id");
          const attemptsEq = eqs.find((e) => e.col === "attempts");
          // A claim that names no row or no expected attempt count is not a claim.
          if (!idEq || !attemptsEq) return { data: [] };
          const id = String(idEq.val);
          const expected = Number(attemptsEq.val);
          if (state.cas.get(id) !== expected) return { data: [] };
          state.cas.set(id, expected + 1);
          return { data: [{ id }] };
        }
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
    _eqs: [] as { col: string; val: unknown }[],
  };
  const self = () => b;
  b.select = () => {
    if (table === "webhook_endpoints" && !b._updated) state.endpointSelects++;
    if (b._updated) b._selectedAfterUpdate = true;
    return b;
  };
  b.in = (col: string, val: unknown) => {
    state.filters.push({ table, col, val });
    return b;
  };
  b.lt = self;
  b.gte = self;
  b.eq = (col: string, val: unknown) => {
    state.filters.push({ table, col, val });
    (b._eqs as { col: string; val: unknown }[]).push({ col, val });
    return b;
  };
  b.order = self;
  b.limit = self;
  b.update = (payload: Record<string, unknown>) => {
    b._updated = true;
    state.updates.push(payload);
    return b;
  };
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

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from, rpc }) }));
// #1151: a dead-lettering endpoint is a CONDITION, so a delivery that lands
// clears it. Hoisted so the silent-path test can assert on the real boundary.
const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
vi.mock("@/lib/notify/dispatch", () => notify);
// #2563: a first send that loses its claim skips, which is correct and should
// still leave a record, so the lost-claim line is asserted rather than assumed.
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import {
  emitWebhook,
  retryFailedDeliveries,
  resendDelivery,
  replayDeadLetteredDeliveries,
} from "./emit";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import { WEBHOOK_MAX_ATTEMPTS } from "@/lib/webhooks/retry";
import { WEBHOOK_EVENTS } from "@/lib/webhooks/events";
import { WEBHOOK_FORMATS } from "@/lib/webhooks/formats";

const endpoint = {
  id: "ep1",
  org_id: "o1",
  url: "https://receiver.example/webhook",
  format: "generic",
  secret: "s3cr3t",
  events: ["booking.created", "booking.rescheduled", "booking.cancelled", "booking.reassigned"],
  auth_header: null,
  active: true,
  created_at: "2026-01-01T00:00:00+00:00",
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
  // #3091: the credentials are Worker secrets, never the endpoint row's columns,
  // so every test runs with both set as production does. Fixtures, not keys.
  vi.stubEnv("REGAL_WEBHOOK_KEY", "regal-key");
  vi.stubEnv("WEBHOOK_SIGNING_SECRET", "s3cr3t");
  state.deliveries = [];
  state.endpoints = [endpoint];
  state.claimWins = true;
  state.endpointSelects = 0;
  state.inserted = [];
  state.filters = [];
  state.updates = [];
  state.cas = null;
  state.user = null;
  state.userError = null;
  state.rpcCalls = [];
  state.enqueueError = null;
  state.enqueueAnswer = undefined;
  state.writtenKeys = new Set();
  from.mockImplementation((table: string) => makeBuilder(table));
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (fn !== "enqueue_webhook_deliveries") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    return enqueueModel(args);
  });
  fetchMock.mockResolvedValue(reply({ ok: true, status: 200, body: "ok" }));
  vi.stubGlobal("fetch", fetchMock);
});

/**
 * A fetch reply shaped like the real `Response` the sender reads.
 *
 * `headers` is not decoration: since #2418 `send()` reads `content-type` and
 * `cf-ray` to tell a subscriber's own error from a block page served by something
 * in front of them, and a fake missing them makes every reply throw. A double that
 * omits what the real interface always carries only ever confirms our assumption
 * about it (L52).
 */
function reply(opts: { ok: boolean; status: number; body: string; headers?: Record<string, string> }) {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: new Headers(opts.headers ?? {}),
    text: async () => opts.body,
  };
}

/**
 * The write `send()` makes to record the outcome, found by what it CARRIES rather
 * than by its position: since #2563 the attempt claim is an update too, and it
 * lands first. An assertion keyed on updates[0] would read the claim and report a
 * missing status.
 */
function statusWrite(): Record<string, unknown> {
  const row = state.updates.find((u) => typeof u.status === "string");
  if (!row) throw new Error("send() recorded no outcome for this delivery");
  return row;
}

describe("retryFailedDeliveries", () => {
  it("loads endpoints in a single query for many deliveries sharing one endpoint (no N+1)", async () => {
    state.deliveries = [delivery("d1"), delivery("d2"), delivery("d3")];

    const retried = await retryFailedDeliveries();

    expect(retried).toBe(3);
    expect(state.endpointSelects).toBe(1); // one webhook_endpoints read for the sweep
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a delivery whose updated_at stamp is unparseable (#1169)", async () => {
    // A corrupt stamp used to parse to NaN, so isDueForRetry compared false on
    // every sweep and the failed delivery sat stuck forever: never retried,
    // never dead-lettered, invisible. Unreadable must land on the DUE side
    // (as if last attempted long ago); the attempt then rewrites updated_at.
    state.deliveries = [{ ...delivery("d1"), updated_at: "not-a-timestamp" }];

    const retried = await retryFailedDeliveries();

    expect(retried).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  // #3495: who is sent to is decided by ONE database function, so the subscription
  // rule (this org, active, subscribed to the event) is proved in a real database by
  // scripts/verify-webhook-enqueue-sql.ts. Here: it is asked once, about this org and
  // this event, carrying the payload and the dedupe key, and nothing else reads the
  // endpoints table.
  it("asks the one enqueue function about this org and event, once, with the payload and key (#3495)", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "enqueue_webhook_deliveries",
      args: { p_org_id: "o1", p_event: "booking.created", p_payload: payload, p_dedupe_key: "bk1" },
    });
    expect(state.endpointSelects).toBe(0);
  });

  // The function refuses a format its map does not name rather than reading it as
  // "send" (L42), so the map must name EVERY format Slate knows, every time.
  it("decides suppression for every format Slate knows, and sends to none when the bucket is a test one (#3495)", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1", true);
    const map = state.rpcCalls[0]!.args.p_suppression as Record<string, string | null>;
    expect(Object.keys(map).sort()).toEqual(Object.keys(WEBHOOK_FORMATS).sort());
    expect(Object.values(map).every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);

    state.rpcCalls = [];
    await emitWebhook("o1", "booking.created", payload, "bk2", false);
    const sent = state.rpcCalls[0]!.args.p_suppression as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(WEBHOOK_FORMATS).sort());
    expect(Object.values(sent).every((reason) => reason === null)).toBe(true);
  });

  // The first send posts the payload AS STORED, which is what every retry posts, so a
  // booking is never described one way first and another way after.
  it("sends the payload the function stored, not the one it was handed (#3495)", async () => {
    state.enqueueAnswer = {
      subscribers: 1,
      deliveries: [{ id: "d-stored", suppressed: false, payload: { booking_id: "bk-as-stored", bucket_code: "411" }, endpoint }],
    };

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("bk-as-stored");
  });

  it("logs nobody subscribed, and sends nothing (#1459)", async () => {
    state.endpoints = [];

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith("webhook-emit", expect.objectContaining({ msg: "no subscriber for event", event: "booking.created" }));
  });

  // An answer this cannot read would otherwise be read as "nothing to send", the
  // silent drop #1036 was opened about. Thrown, so the outbox step retries; the rows
  // it may have written are pending and the retry sweep sends them.
  it("throws when the function's answer cannot be read, and sends nothing (#3495)", async () => {
    state.enqueueAnswer = { subscribers: "two" };

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).rejects.toThrow(/subscribers/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // With NO dedupe key the call that answered unreadably may still have written its
  // rows, and the caller's retry would write a second set and send both. So the step
  // is not failed: the rows it wrote are pending, the retry sweep sends them, and the
  // defect is logged. (With a key, above, a retry writes nothing twice.)
  it("does not fail the step when the answer is unreadable and there is no dedupe key, and logs it (#3495)", async () => {
    state.enqueueAnswer = { subscribers: "two" };

    await expect(emitWebhook("o1", "booking.cancelled", payload, null)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.error).toHaveBeenCalledWith(
      "webhook-emit",
      expect.objectContaining({ msg: "deliveries enqueue answer unreadable", deduped: false }),
      expect.any(Error),
    );
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
  // UNIQUE (endpoint_id, event, dedupe_key), so the function writes nothing for a
  // re-enqueue of the same logical event (a crash-resume re-running the side
  // effects) and hands back no delivery. The ORIGINAL delivery owns the send and its
  // retries, so this call must make neither a second row nor a second POST.
  it("drops both the row and the POST when the dedupe key collides (exactly-once)", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();

    // The same logical event again: the function writes no delivery, so nothing is sent.
    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(state.inserted).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // #1036: a refused call wrote NOTHING (the function is one transaction), so the
  // outbox step must not be marked done. Throw so the step fails and the drain
  // retries, instead of silently dropping the event.
  it("throws (so the outbox step retries) when the enqueue call is refused", async () => {
    state.enqueueError = { code: "08006", message: "connection failure" };

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).rejects.toThrow();

    // No row means nothing owns a retry, so posting here would be an unrecorded send.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A subscriber whose format the caller did not decide is refused, with nothing
  // written, rather than read as "send" (L42): the step fails and retries.
  it("throws (so the outbox step retries) when the function refuses a format it was not told about, instead of sending", async () => {
    state.endpoints = [{ ...endpoint, format: "smtp" }];

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).rejects.toThrow(/smtp/);

    expect(state.inserted).toHaveLength(0); // the function wrote nothing
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Failure paths. The booking has already committed by the time these run, so a
  // subscriber being down must never throw back into the booking flow. It must be
  // recorded as failed instead, which is what makes the retry sweep pick it up.
  it("marks the delivery failed (and does not throw) when the receiver rejects", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, status: 500, body: "boom" }));

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).resolves.toBeUndefined();

    expect(statusWrite()).toMatchObject({ status: "failed", attempts: 1 });
    expect(String(statusWrite().last_response)).toContain("500");
  });

  it("marks the delivery failed (and does not throw) when the receiver times out", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted"));

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).resolves.toBeUndefined();

    expect(statusWrite()).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("marks the delivery a success when the receiver accepts", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(statusWrite()).toMatchObject({ status: "success", attempts: 1 });
  });
});

// #884: on a user-facing path (create confirm, cancel, reschedule) the customer's
// response should not wait on the outbound Regal/Cadence round-trip. emitWebhook
// still writes the durable pending row synchronously (so the retry sweep is the
// backstop for a dropped send), but hands the POST to a scheduler (Next after())
// when one is supplied. The cron drains pass none and keep sending inline, so
// their bounded fan-out still caps simultaneous connections.
// #1151: a dead-lettering endpoint is a CONDITION that ends when a delivery
// lands, and the delivery path is the only place that can observe it.
describe("dead-letter recovery notice", () => {
  const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

  it("announces recovery on a delivery that succeeds, keyed to the endpoint", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(notify.resolveAlert).toHaveBeenCalledTimes(1);
    expect(notify.resolveAlert.mock.calls[0][0]).toBe("webhook_dead:ep1");
  });

  // The silent path (#1152): a delivery that FAILED is not evidence the endpoint
  // is healthy, so it must not clear the page saying it is dead.
  it("sends NO all-clear when the delivery fails", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, status: 500, body: "boom" }));

    await emitWebhook("o1", "booking.created", payload, "bk1");

    expect(notify.resolveAlert).not.toHaveBeenCalled();
  });

  it("clears one endpoint without clearing another that is still failing", async () => {
    state.endpoints = [endpoint, { ...endpoint, id: "ep2", url: "https://other.example/hook" }];
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("other.example")
        ? reply({ ok: false, status: 500, body: "boom" })
        : reply({ ok: true, status: 200, body: "ok" }),
    );

    await emitWebhook("o1", "booking.created", payload, "bk1");

    const cleared = notify.resolveAlert.mock.calls.map((c) => c[0]);
    expect(cleared).toEqual(["webhook_dead:ep1"]);
  });
});

describe("emitWebhook deferred send (#884)", () => {
  const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

  it("records the delivery synchronously but hands the outbound POST to the scheduler", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const deferSend = (work: () => Promise<void>) => {
      scheduled.push(work);
    };

    await emitWebhook("o1", "booking.created", payload, "bk1", false, deferSend);

    // The durable pending row IS written on the hot path: this is what makes a
    // dropped after() send recoverable by the retry sweep.
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ status: "pending", suppressed: false });
    // But the POST is deferred, not awaited: nothing has left the door yet.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    // Running the scheduled work is what performs the send and marks the row.
    await scheduled[0]();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusWrite()).toMatchObject({ status: "success", attempts: 1 });
  });

  it("sends inline when no scheduler is supplied (unchanged for cron drains)", async () => {
    await emitWebhook("o1", "booking.created", payload, "bk1", false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never schedules a send for a suppressed delivery", async () => {
    const scheduled: Array<() => Promise<void>> = [];

    await emitWebhook("o1", "booking.created", payload, "bk1", true, (w) => scheduled.push(w));

    expect(scheduled).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserted[0].suppressed).toBe(true);
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

// #600: a Regal endpoint with no API key is a misconfiguration. buildRequest refuses to
// build the delivery rather than posting an unauthenticated event Regal will reject.
//
// The refusal must stay INSIDE the webhook machinery. emitWebhook is awaited by the
// booking flow, so letting it throw would fail real bookings over a webhook config
// mistake, and the outbox would retry the throw forever. Fail loud, but in the right
// place: a failed delivery row, visible in the log, retried once the key is set.
describe("misconfigured Regal endpoint (#600)", () => {
  const regalNoKey = {
    ...endpoint,
    id: "ep1",
    format: "regal",
    url: "https://events.regalvoice.com/events",
    auth_header: null,
  };

  it("does not throw into the booking path when the API key is missing", async () => {
    state.endpoints = [regalNoKey];
    const p = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

    await expect(emitWebhook("o1", "booking.created", p, "bk1")).resolves.toBeUndefined();
  });

  it("never posts an unauthenticated event, and records the delivery as failed", async () => {
    // #3091: "no key" is the Worker secret being unset, not the column.
    vi.stubEnv("REGAL_WEBHOOK_KEY", "");
    state.endpoints = [regalNoKey];
    const p = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

    await emitWebhook("o1", "booking.created", p, "bk1");

    // The whole point: nothing goes out the door without the key.
    expect(fetchMock).not.toHaveBeenCalled();

    const failed = state.updates.find((u) => u.status === "failed");
    expect(failed).toBeTruthy();
    // The log has to say WHY, or the admin cannot act on it.
    expect(String(failed?.last_response)).toMatch(/api key/i);
  });
});

// #2073: a booking through an advisor's own link reaches Regal as "Client Sync
// Action" for a create, a move and a cancel, which is all cal.com's personal link
// ever sent. A reassign has no equivalent, so Regal gets nothing,
// while a non Regal subscriber still receives the event as before.
describe("agent link bookings and Regal (#2073)", () => {
  const regal = { ...endpoint, id: "ep-regal", format: "regal", url: "https://events.regalvoice.com/events", auth_header: "key" };
  const generic = { ...endpoint, id: "ep-generic" };
  const named = {
    booking_id: "bk1",
    bucket_code: "411",
    booking_kind: "agent_link",
    starts_at: "2026-09-28T15:20:00.000Z",
    agent: { id: "u1", name: "Jane", email: "jane@trypennie.com" },
    attendee: { name: "Dana Lee", email: "dana@example.com", phone: "+12155550100" },
    prefill: {},
  } as unknown as BookingEventPayload;

  for (const event of ["booking.reassigned"] as const) {
    it(`sends Regal nothing for an agent link ${event}, and still sends other subscribers`, async () => {
      state.endpoints = [regal, generic];
      await emitWebhook("o1", event, named, `bk1:${event}`);
      const regalRow = state.inserted.find((r) => r.endpoint_id === "ep-regal");
      expect(regalRow).toMatchObject({ suppressed: true, status: "success" });
      expect(String(regalRow?.last_response)).toMatch(/2073/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain("regalvoice");
    });
  }

  it("sends Regal a Client Sync Action for an agent link create", async () => {
    state.endpoints = [regal];
    await emitWebhook("o1", "booking.created", named, "bk1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.name).toBe("Client Sync Action");
    expect(body.properties).toMatchObject({ action: "BOOKING_CREATED", scheduled_at: "2026-09-28T15:20:00.000Z", agent_email: "jane@trypennie.com" });
  });

  it("still sends a ROUTED reassign to Regal", async () => {
    state.endpoints = [regal];
    const routed = { ...named, booking_kind: "routed", event_type: "Call", reason: null, routing: undefined } as unknown as BookingEventPayload;
    await emitWebhook("o1", "booking.reassigned", routed, "bk1:r");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).name).toBe("Slate Booking Reassigned");
  });
});

// #2915: `booking.completed` is no longer an event Slate sends, and delivery rows
// written before that still carry it. No path may POST one again: Regal has no event
// name for it any more, so a resend would reach it nameless. The resend says why it
// refused rather than reading as a delivery that went.
describe("an event Slate no longer sends (#2915)", () => {
  const retired = (id: string, status = "success"): Record<string, unknown> => ({
    ...delivery(id),
    event: "booking.completed",
    status,
    suppressed: false,
    payload_erased: false,
  });

  it("resendDelivery refuses it: no POST, returns 'retired-event'", async () => {
    state.deliveries = [retired("d1")];
    const res = await resendDelivery("d1", "o1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toBe("retired-event");
  });

  it("the retry and replay reads ask only for events Slate still sends, so a retired row never holds a slot", async () => {
    state.deliveries = [];
    await retryFailedDeliveries();
    await replayDeadLetteredDeliveries("o1", new Date(Date.now() - 3_600_000).toISOString());
    const eventFilters = state.filters.filter((f) => f.table === "webhook_deliveries" && f.col === "event");
    expect(eventFilters).toHaveLength(2);
    for (const f of eventFilters) {
      expect([...(f.val as string[])].sort()).toEqual([...WEBHOOK_EVENTS].sort());
      expect(f.val as string[]).not.toContain("booking.completed");
    }
  });

  it("retryFailedDeliveries never POSTs it, and still sends a current event beside it", async () => {
    state.deliveries = [retired("d1", "failed"), delivery("d2")];
    const retried = await retryFailedDeliveries();
    expect(retried).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// #1073: a delivery whose payload was blanked for PII retention (payload_erased)
// must never be re-sent, or the admin resend / dead-letter replay would POST an
// empty {} body (a fake success on a generic endpoint, a throw on Regal). Mirrors
// the `suppressed` guard: refusal is structural, on every send path.
describe("payload_erased guard (#1073)", () => {
  function erased(id: string): Record<string, unknown> {
    return {
      id,
      endpoint_id: "ep1",
      event: "booking.created",
      payload: {},
      attempts: 5,
      status: "failed",
      suppressed: false,
      payload_erased: true,
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
    };
  }

  it("resendDelivery refuses an erased row: no POST, returns 'payload-erased'", async () => {
    state.deliveries = [erased("d1")];
    const res = await resendDelivery("d1", "o1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toBe("payload-erased");
  });

  it("resendDelivery sends a normal row and returns 'sent'", async () => {
    state.deliveries = [
      { ...delivery("d2"), status: "failed", suppressed: false, payload_erased: false },
    ];
    const res = await resendDelivery("d2", "o1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res).toBe("sent");
  });

  it("retryFailedDeliveries excludes erased rows via a payload_erased=false filter", async () => {
    state.deliveries = [];
    await retryFailedDeliveries();
    expect(
      state.filters.some(
        (f) => f.table === "webhook_deliveries" && f.col === "payload_erased" && f.val === false,
      ),
    ).toBe(true);
  });

  it("replayDeadLetteredDeliveries excludes erased rows via a payload_erased=false filter", async () => {
    state.deliveries = [];
    await replayDeadLetteredDeliveries("o1", new Date(Date.now() - 3_600_000).toISOString());
    expect(
      state.filters.some(
        (f) => f.table === "webhook_deliveries" && f.col === "payload_erased" && f.val === false,
      ),
    ).toBe(true);
  });
});

// #2418: what the dead letter page is allowed to SAY about a subscriber's reply.
//
// The classification and the wording are pure and are pinned offline in
// scripts/test-webhook-dead-letter-copy.ts. What only a mocked send can prove is
// the WIRING: that the reply's HEADERS are read, that the summary is what lands on
// the delivery row, and that the text handed to sendThrottledAlert is the built
// copy rather than a kilobyte of the reply. Before this, a WAF answering 403 with
// an HTML block page put `<!DOCTYPE html>...` cut mid tag on somebody's phone, with
// nothing saying the subscriber's API had never seen the request.
describe("dead-letter page never carries the reply body (#2418)", () => {
  const BLOCK_PAGE =
    '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>' +
    "<body><h1>Sorry, you have been blocked</h1>" +
    "<p>Ray ID: 8f2c1a9b4d5e6f70</p>".repeat(20) +
    "</body></html>";

  /** Drive one send at the attempt that dead-letters, and return the alert text. */
  async function deadLetter(): Promise<string> {
    state.deliveries = [delivery("d1", 4)];
    await retryFailedDeliveries();
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    return String((notify.sendThrottledAlert.mock.calls[0] as unknown as unknown[])[2]);
  }

  it("names the intermediary, keeps its markup out, and hands over the cf-ray", async () => {
    fetchMock.mockResolvedValue(
      reply({
        ok: false,
        status: 403,
        body: BLOCK_PAGE,
        headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "8f2c1a9b4d5e6f70-EWR" },
      }),
    );

    const text = await deadLetter();

    expect(text).not.toContain("<");
    expect(text).not.toContain("Cloudflare");
    expect(text).toContain("never saw the request");
    expect(text).toContain("8f2c1a9b4d5e6f70-EWR");
    // The delivery row carries the classification too, so the admin webhooks page
    // is not showing a kilobyte of somebody else's HTML either.
    const row = state.updates[state.updates.length - 1];
    expect(String(row.last_response)).toBe("403 intermediary HTML page, cf-ray 8f2c1a9b4d5e6f70-EWR");
  });

  it("does NOT call a genuine API error an intermediary, and keeps its reason", async () => {
    fetchMock.mockResolvedValue(
      reply({
        ok: false,
        status: 401,
        body: '{"error":"invalid api key"}',
        headers: { "content-type": "application/json" },
      }),
    );

    const text = await deadLetter();

    expect(text).not.toContain("never saw the request");
    expect(text).toContain("401");
    expect(text).toContain("invalid api key");
  });

  it("says a reply carried no body rather than trailing off after the status", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, status: 503, body: "" }));

    const text = await deadLetter();

    expect(text).toContain("503 no reply body");
    expect(String(state.updates[state.updates.length - 1].last_response)).toBe("503 no reply body");
  });

  it("gives a reply it could not read its own sentence, not another's", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({ "cf-ray": "8f2c1a9b4d5e6f70-EWR" }),
      text: async () => {
        throw new Error("network error reading body");
      },
    });

    const text = await deadLetter();

    expect(text).toContain("502 reply body could not be read");
    expect(text).toContain("8f2c1a9b4d5e6f70-EWR");
    expect(text).not.toContain("no reply body");
    expect(text).not.toContain("never saw the request");
  });
});

/**
 * #2563: the FIRST send was the one delivery path that posted without claiming the
 * attempt. Every other path (the retry sweep, a manual resend) compare-and-swaps
 * `attempts` first, so exactly one actor owns an attempt; the first send did not,
 * and the protection everywhere else read as covering it.
 *
 * These tests drive the race directly rather than asserting the claim was called:
 * the fake holds a real attempts store, both actors read the same 0, and the store's
 * own arithmetic decides the winner. A test that set a claimWins flag itself would
 * only confirm the assumption it encodes (L70).
 */
describe("first send attempt claim (#2563)", () => {
  const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;

  it("posts ONCE when a first send and the retry sweep race the same delivery row", async () => {
    // The state a first send that hangs leaves behind: the row is durable, pending,
    // and still at attempt 0, which is exactly what the sweep picks up.
    state.cas = new Map([["d-new", 0]]);
    state.deliveries = [delivery("d-new", 0)];

    await Promise.all([
      emitWebhook("o1", "booking.created", payload, "bk1"),
      retryFailedDeliveries(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.cas.get("d-new")).toBe(1);
  });

  it("does not POST, and does not throw into the booking path, when the first send loses the claim", async () => {
    // Another actor has already advanced this attempt, so the first send must stand
    // down. It must not throw: emitWebhook is awaited by the booking flow, and a
    // throw here would fail a real booking over a webhook it does not own.
    state.cas = new Map([["d-new", 3]]);

    await expect(emitWebhook("o1", "booking.created", payload, "bk1")).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserted).toHaveLength(1); // the durable row is still recorded
    // Skipping is right, and silence is not: the sweep can only beat a first send
    // that hung past the one minute backoff, which should never happen while the
    // send times out at five seconds. If it starts happening, the only way to find
    // out is this line, since nothing else counts a lost first claim (L77).
    expect(logged.warn).toHaveBeenCalledWith(
      "webhook-emit",
      expect.objectContaining({ msg: "first send lost the attempt claim" }),
    );
  });

  it("claims inside the deferred send, not at emit time, so both actors read the same attempt", async () => {
    // Placement is load bearing. Claiming at emit time would leave the sweep reading
    // attempts=1 and claiming 1 to 2, which is a second POST rather than a refusal.
    state.cas = new Map([["d-new", 0]]);
    const scheduled: (() => void | Promise<void>)[] = [];

    await emitWebhook("o1", "booking.created", payload, "bk1", false, (fn) => {
      scheduled.push(fn);
    });

    expect(state.cas.get("d-new")).toBe(0); // nothing claimed while the send is queued
    expect(fetchMock).not.toHaveBeenCalled();

    await scheduled[0]!();

    expect(state.cas.get("d-new")).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts ONCE when two replays race one dead-lettered row", async () => {
    // The site the review did not name: replayDeadLetteredDeliveries sent without a
    // claim too, so an operator clicking replay twice, or a replay racing a manual
    // resend (which ignores the cap), double POSTs the same dead letter.
    state.cas = new Map([["d-dead", WEBHOOK_MAX_ATTEMPTS]]);
    state.deliveries = [
      { ...delivery("d-dead", WEBHOOK_MAX_ATTEMPTS), status: "failed" },
    ];

    const [a, b] = await Promise.all([
      replayDeadLetteredDeliveries("o1", new Date(Date.now() - 86_400_000).toISOString()),
      replayDeadLetteredDeliveries("o1", new Date(Date.now() - 86_400_000).toISOString()),
    ]);

    expect(a + b).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// #2085: `agent.bookable_changed` rides the SAME delivery path as the booking
// events, so a trait Regal never received is recorded, retried and dead-lettered
// rather than dropped. Three things differ, and each is pinned here: a test
// agent's trait is recorded terminal and never sent, every send states the
// agent's state AT THAT SEND (so a retried stale value cannot win), and a send
// whose state cannot be read is a failed attempt rather than a blind POST.
describe("agent bookable trait delivery (#2085)", () => {
  const regalEndpoint = {
    ...endpoint,
    format: "regal",
    auth_header: "regal-key",
  };
  const trait = { user_id: "u1", email: "agent@trypennie.com", slate_bookable: false };

  it("records an is_test agent's trait as a terminal suppressed delivery and never POSTs it", async () => {
    state.endpoints = [regalEndpoint];
    await emitWebhook("o1", "agent.bookable_changed", trait, null, true);

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      event: "agent.bookable_changed",
      status: "success",
      suppressed: true,
    });
    expect(String(state.inserted[0].last_response)).toMatch(/is_test agent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the traits only body to the Regal endpoint with its key", async () => {
    state.endpoints = [regalEndpoint];
    state.user = { bookable: false, deactivated_at: null };
    await emitWebhook("o1", "agent.bookable_changed", trait);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe(endpoint.url);
    expect(init.body).toBe(JSON.stringify({ userId: "agent@trypennie.com", traits: { slateBookable: false } }));
    expect(init.headers.authorization).toBe("regal-key");
    expect(statusWrite().status).toBe("success");
  });

  it("records a refused POST as failed, never done, and the retry sweep sends it again", async () => {
    state.endpoints = [regalEndpoint];
    state.user = { bookable: false, deactivated_at: null };
    fetchMock.mockResolvedValueOnce(reply({ ok: false, status: 503, body: "unavailable" }));

    await emitWebhook("o1", "agent.bookable_changed", trait);
    expect(statusWrite()).toMatchObject({ status: "failed", attempts: 1 });

    state.updates = [];
    state.deliveries = [
      {
        id: "d-new",
        endpoint_id: "ep1",
        event: "agent.bookable_changed",
        payload: trait,
        attempts: 1,
        updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ];
    const retried = await retryFailedDeliveries();
    expect(retried).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statusWrite()).toMatchObject({ status: "success", attempts: 2 });
  });

  it("a retry states the agent's CURRENT value, and the log is rewritten to what was sent", async () => {
    // Recorded false; by the time the retry runs the agent is routable again. The
    // retry must not put the stale false back into Regal.
    state.endpoints = [regalEndpoint];
    state.user = { bookable: true, deactivated_at: null };
    state.deliveries = [
      {
        id: "d-old",
        endpoint_id: "ep1",
        event: "agent.bookable_changed",
        payload: trait,
        attempts: 2,
        updated_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ];
    await retryFailedDeliveries();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).traits.slateBookable).toBe(true);
    expect(statusWrite().payload).toEqual({ ...trait, slate_bookable: true });
  });

  it("a trait whose current state cannot be read is a failed attempt, not a blind POST", async () => {
    state.endpoints = [regalEndpoint];
    state.userError = { message: "connection reset" };
    await emitWebhook("o1", "agent.bookable_changed", trait);

    expect(fetchMock).not.toHaveBeenCalled();
    const w = statusWrite();
    expect(w.status).toBe("failed");
    expect(String(w.last_response)).toMatch(/connection reset/);
    // Nothing was stated, so the recorded value stays.
    expect("payload" in w).toBe(false);
  });

  it("a booking delivery reads no user row and keeps its stored payload", async () => {
    const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;
    await emitWebhook("o1", "booking.created", payload, "bk1");
    expect(from.mock.calls.map((c) => c[0])).not.toContain("users");
    expect("payload" in statusWrite()).toBe(false);
  });
});

// #3091: the two credentials move into Worker secrets, expand then contract. The
// Worker secret wins when it is set, the endpoint row's column answers only while
// it is not, and each delivery logs which one it used, never the value. Every key
// below is a fixture.
describe("outbound credentials come from the Worker first (#3091)", () => {
  const regalEndpoint = { ...endpoint, format: "regal", auth_header: "fixture-db-key" };
  const trait = { user_id: "u1", email: "agent@trypennie.com", slate_bookable: false };

  afterEach(() => vi.unstubAllEnvs());

  it("sends the Worker key, not the column, and logs the source as worker", async () => {
    vi.stubEnv("REGAL_WEBHOOK_KEY", "fixture-worker-key");
    state.endpoints = [regalEndpoint];
    state.user = { bookable: false, deactivated_at: null };
    await emitWebhook("o1", "agent.bookable_changed", trait);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("fixture-worker-key");
    const line = logged.info.mock.calls.find((c) => c[0] === "webhook-credentials");
    expect(line?.[1]).toMatchObject({ source: "worker", format: "regal" });
    expect(JSON.stringify(logged.info.mock.calls)).not.toContain("fixture-worker-key");
  });

  // The contract half (migration 0163): the column is never a fallback. A value
  // left in it does not become the credential; the delivery is refused, recorded
  // as failed, and the log says the secret is missing.
  it("never falls back to the column: an unset Worker key refuses the delivery and warns", async () => {
    vi.stubEnv("REGAL_WEBHOOK_KEY", "");
    state.endpoints = [regalEndpoint];
    state.user = { bookable: false, deactivated_at: null };
    await emitWebhook("o1", "agent.bookable_changed", trait);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusWrite().status).toBe("failed");
    const line = logged.warn.mock.calls.find((c) => c[0] === "webhook-credentials");
    expect(line?.[1]).toMatchObject({ source: "missing" });
    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain("fixture-db-key");
  });

  it("signs a generic delivery with the Worker signing secret when it is set", async () => {
    vi.stubEnv("WEBHOOK_SIGNING_SECRET", "fixture-worker-signing");
    const payload = { booking_id: "bk1", bucket_code: "411" } as unknown as BookingEventPayload;
    await emitWebhook("o1", "booking.created", payload, "bk1");

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    const ts = init.headers["x-slate-timestamp"];
    const expected =
      "sha256=" + createHmac("sha256", "fixture-worker-signing").update(`${ts}.${init.body}`).digest("hex");
    expect(init.headers["x-slate-signature"]).toBe(expected);
  });
});
