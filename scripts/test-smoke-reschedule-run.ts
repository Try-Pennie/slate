// #4060: the reschedule smoke must survive a crashed run before it.
//
// On 2026-10-21 run 39694932888 passed 4 checks, then lost the network on the
// concurrent reschedules, so its teardown cancel never landed and its booking stayed
// active. The next run booked with the SAME fixed phone, person dedupe weak matched
// the leftover and answered `409 confirm_required` carrying the OLD booking, and the
// script took that booking's manage token and rescheduled and cancelled it as its own.
//
// This drives the real run (scripts/lib/smoke-reschedule-run.ts) against an in
// memory booking API that applies person dedupe the way production does (a match on
// email OR phone with an active booking is a weak match, answered 409 with that
// booking), through an injected `post` that can throw a real shaped network error.
// No real network, no real clock: the teardown's backoff goes through an injected
// sleep.
//
// Run: node --experimental-strip-types scripts/test-smoke-reschedule-run.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { rescheduleSmokeExitCode, runRescheduleSmoke, type SmokePost } from "./lib/smoke-reschedule-run.ts";
import type { Json } from "./smoke-lib.ts";

type FakeBooking = {
  id: string;
  token: string;
  email: string;
  phone: string;
  externalId: string;
  startsAt: string;
  status: "active" | "cancelled";
  reschedules: number;
};

/** A booking API that dedupes people the way production does, kept in memory. */
class FakeBookingApi {
  bookings: FakeBooking[] = [];
  calls: string[] = [];
  private n = 0;
  /** Throw a transient network error on every call whose index is >= this. */
  downFrom = Infinity;
  /** Status codes to answer the next cancels with, before answering normally. */
  cancelStatuses: number[] = [];
  /** Throw a transient network error on the next N cancels, then answer normally. */
  cancelThrows = 0;
  /** Throw a NON transient error on cancel (a deterministic bug, never retried). */
  cancelBroken = false;

  seed(b: Omit<FakeBooking, "status" | "reschedules">): FakeBooking {
    const row: FakeBooking = { ...b, status: "active", reschedules: 0 };
    this.bookings.push(row);
    return row;
  }

  byToken(token: string): FakeBooking | undefined {
    return this.bookings.find((b) => b.token === token);
  }

  post: SmokePost = async (path, body) => {
    const index = this.calls.length;
    this.calls.push(path);
    if (index >= this.downFrom) throw networkError("ETIMEDOUT");
    if (path === "/api/bookings") return this.create(body);
    const m = path.match(/^\/api\/bookings\/([^/]+)\/(reschedule|cancel)$/);
    if (!m) return { status: 404, body: {} };
    const booking = this.byToken(m[1]);
    if (!booking) return { status: 404, body: { error: "not found" } };
    if (m[2] === "reschedule") {
      booking.startsAt = String(body.start);
      booking.reschedules += 1;
      return { status: 200, body: { startsAt: booking.startsAt } };
    }
    if (this.cancelBroken) throw new TypeError("fetch failed");
    if (this.cancelThrows > 0) {
      this.cancelThrows -= 1;
      throw networkError("ECONNRESET");
    }
    const status = this.cancelStatuses.shift();
    if (status !== undefined) return { status, body: { error: "write did not run" } };
    booking.status = "cancelled";
    return { status: 200, body: { ok: true } };
  };

  private create(body: Json): { status: number; body: Json } {
    const attendee = body.attendee as { email: string; phone: string };
    const match = this.bookings.find(
      (b) => b.status === "active" && (b.email === attendee.email || b.phone === attendee.phone),
    );
    if (match) {
      const both = match.email === attendee.email && match.phone === attendee.phone;
      if (both) {
        // A medium match: production moves the EXISTING booking and answers 200.
        match.startsAt = String(body.start);
        return { status: 200, body: { outcome: "rescheduled", booking: view(match) } };
      }
      return { status: 409, body: { outcome: "confirm_required", booking: view(match) } };
    }
    this.n += 1;
    const row = this.seed({
      id: `booking-${this.n}`,
      token: `token-${this.n}`,
      email: attendee.email,
      phone: attendee.phone,
      externalId: String(body.externalId),
      startsAt: String(body.start),
    });
    return { status: 200, body: { outcome: "created", booking: view(row) } };
  }
}

function view(b: FakeBooking): Json {
  return { id: b.id, startsAt: b.startsAt, manageUrl: `https://slate.example/booking/manage/${b.token}` };
}

/** The error undici throws for a connect timeout: `TypeError: fetch failed` with a code. */
function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code}`), { code });
  return err;
}

const SLOTS = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 22, 13, i * 10)).toISOString());

/** One run of the smoke, recording every check and every backoff it asked for. */
async function run(api: FakeBookingApi, nonce: number) {
  const results: { ok: boolean; msg: string }[] = [];
  const sleeps: number[] = [];
  let crashed: unknown = null;
  try {
    await runRescheduleSmoke({
      bucket: "SMOKE",
      nonce,
      post: api.post,
      slots: async () => SLOTS,
      check: (ok, msg) => results.push({ ok, msg }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
    });
  } catch (err) {
    crashed = err;
  }
  const failures = results.filter((r) => !r.ok).map((r) => r.msg);
  return { results, failures, sleeps, crashed };
}

async function main(): Promise<void> {
  // --- The incident: a crash before teardown, then the next run ---
  {
    const api = new FakeBookingApi();
    // Calls: 0 create, 1 reschedule, then the network goes: the two concurrent
    // reschedules and every teardown cancel attempt throw ETIMEDOUT.
    api.downFrom = 2;
    const first = await run(api, 1_761_090_000_000);
    assert(first.crashed instanceof TypeError, "run 1 crashes on the network error, as on 2026-10-21");
    // The slot count check, then the 4 booking checks the incident run passed
    // (create, manage token, reschedule, lands on the new time).
    eq(first.results.filter((r) => r.ok).length, 5, "run 1 passed the slot check and 4 booking checks before the crash");
    const left = api.bookings[0];
    eq(left?.status, "active", "run 1 left its booking active (the cancel never landed)");
    const cancelAttempts = api.calls.filter((c) => c.endsWith("/cancel")).length;
    eq(cancelAttempts, 3, "the teardown tried the cancel 3 times on a network error");
    eq(first.sleeps.length, 2, "and backed off between attempts through the injected sleep");
    assert(
      first.failures.some((f) => f.includes(left.id) && /left active/.test(f)),
      `run 1 records that booking ${left.id} was left active (got: ${first.failures.join(" | ")})`,
    );

    // Run 2: the network is back, the leftover is still active.
    api.downFrom = Infinity;
    const callsBefore = api.calls.length;
    const second = await run(api, 1_761_092_160_123);
    eq(second.crashed, null, "run 2 does not crash");
    eq(second.failures.length, 0, `run 2 passes with the leftover still there (failures: ${second.failures.join(" | ")})`);
    assert(
      !second.results.some((r) => /got 409/.test(r.msg)),
      "run 2's create is not a 409 against the leftover",
    );
    const touchedLeftover = api.calls.slice(callsBefore).some((c) => c.includes(`/${left.token}/`));
    assert(!touchedLeftover, "run 2 never reschedules or cancels run 1's booking");
    eq(left.reschedules, 1, "run 1's booking keeps only its own reschedule");
    const own = api.bookings[1];
    eq(own?.status, "cancelled", "run 2 cancelled its OWN booking at teardown");
  }

  // --- A dedupe onto another booking stops the run instead of reusing its token ---
  {
    const api = new FakeBookingApi();
    const nonce = 1_761_100_000_000;
    // A leftover that weak matches this run on phone alone, however it came to.
    const { rescheduleSmokeIdentity } = await import("./lib/smoke-reschedule-identity.ts");
    const mine = rescheduleSmokeIdentity(SLOTS[0], nonce);
    const other = api.seed({
      id: "leftover",
      token: "leftover-token",
      email: "smoketest+resched-1@trypennie.com",
      phone: mine.phone,
      externalId: "smoke-resched-old",
      startsAt: SLOTS[3],
    });
    const r = await run(api, nonce);
    assert(
      r.failures.some((f) => /create -> 200/.test(f) && f.includes("409") && f.includes("leftover")),
      `the create check fails and names the booking it matched (got: ${r.failures.join(" | ")})`,
    );
    assert(!r.results.some((x) => x.ok && /manage token/.test(x.msg)), "no manage token is taken from a 409");
    eq(api.calls.length, 1, "nothing but the create was sent");
    eq(other.status, "active", "the other booking is not cancelled");
    eq(other.reschedules, 0, "the other booking is not rescheduled");
  }

  // --- A 200 that moved an EXISTING booking (a medium match) is refused too ---
  {
    const api = new FakeBookingApi();
    const nonce = 1_761_110_000_000;
    const { rescheduleSmokeIdentity } = await import("./lib/smoke-reschedule-identity.ts");
    const mine = rescheduleSmokeIdentity(SLOTS[0], nonce);
    const other = api.seed({ id: "same-person", token: "same-token", ...mine, startsAt: SLOTS[5] });
    const r = await run(api, nonce);
    assert(
      r.failures.some((f) => /create/.test(f) && f.includes("rescheduled") && f.includes("same-person")),
      `a 200 'rescheduled' create fails and names the booking (got: ${r.failures.join(" | ")})`,
    );
    eq(api.calls.length, 1, "nothing but the create was sent after a non created outcome");
    eq(other.status, "active", "the moved booking is not cancelled by this run");
  }

  // --- Teardown: one transient blip, then the cancel lands ---
  {
    const api = new FakeBookingApi();
    api.cancelThrows = 1;
    const r = await run(api, 1_761_120_000_000);
    eq(r.failures.length, 0, `a cancel that throws once then lands passes (failures: ${r.failures.join(" | ")})`);
    eq(api.bookings[0]?.status, "cancelled", "the booking is cancelled");
    eq(r.sleeps.length, 1, "one backoff, through the injected sleep");
  }

  // --- Teardown: a 503 (the gated write did not run) is retried, it can succeed ---
  {
    const api = new FakeBookingApi();
    api.cancelStatuses = [503];
    const r = await run(api, 1_761_130_000_000);
    eq(r.failures.length, 0, "a 503 cancel retried into a 200 passes");
    eq(api.bookings[0]?.status, "cancelled", "the booking is cancelled after the 503");
  }

  // --- Teardown: a non retryable refusal is recorded once, naming the booking ---
  {
    const api = new FakeBookingApi();
    api.cancelStatuses = [409];
    const r = await run(api, 1_761_140_000_000);
    eq(api.calls.filter((c) => c.endsWith("/cancel")).length, 1, "a 409 cancel is not retried");
    eq(r.sleeps.length, 0, "and no backoff is spent on it");
    assert(
      r.failures.some((f) => f.includes("booking-1") && /left active/.test(f) && f.includes("409")),
      `the 409 is recorded as a booking left active (got: ${r.failures.join(" | ")})`,
    );
  }

  // --- Teardown: a deterministic error is not retried and its reason is short ---
  {
    const api = new FakeBookingApi();
    api.cancelBroken = true;
    const r = await run(api, 1_761_150_000_000);
    eq(api.calls.filter((c) => c.endsWith("/cancel")).length, 1, "a non transient error is not retried");
    const line = r.failures.find((f) => /left active/.test(f)) ?? "";
    assert(line.includes("booking-1") && line.includes("fetch failed"), `the reason is named (got: ${line})`);
    assert(!line.includes("\n") && !line.includes("    at "), "the reason carries no stack trace");
  }

  // --- Too few slots: the run stops before booking, and the script exits 1 ---
  {
    const api = new FakeBookingApi();
    const results: { ok: boolean; msg: string }[] = [];
    const outcome = await runRescheduleSmoke({
      bucket: "SMOKE",
      nonce: 1_761_160_000_000,
      post: api.post,
      slots: async () => SLOTS.slice(0, 18),
      check: (ok, msg) => results.push({ ok, msg }),
      log: () => {},
    });
    eq(outcome, "too_few_slots", "18 slots -> too_few_slots");
    eq(api.calls.length, 0, "nothing is booked when the bucket cannot host the run");
    assert(results.some((r) => !r.ok && /19 future slots/.test(r.msg)), "the slot shortfall is a failed check");
  }

  // --- The script's exit code, for every way a run returns ---
  eq(rescheduleSmokeExitCode("too_few_slots", 0), 1, "too few slots exits 1 even with no other failure");
  eq(rescheduleSmokeExitCode("too_few_slots", 1), 1, "too few slots exits 1");
  eq(rescheduleSmokeExitCode("ran", 0), 0, "a run with every check passing exits 0");
  eq(rescheduleSmokeExitCode("ran", 1), 1, "a run with a failed check exits 1 (a refused create returns early)");
  eq(rescheduleSmokeExitCode("ran", 4), 1, "a run with several failed checks exits 1");

  finish();
}

void main();
