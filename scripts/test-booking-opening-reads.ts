// A confirm's two reads by the lead's key start together (#3491).
//
// The idempotency replay and the in flight reservation are both read by the lead's
// key alone, and ran one after the other with the bucket, the person check and the
// calling window between them. Load runs 20 and 21 measured each at about 130 to
// 220ms median and 440 to 590ms p95 under steady load, so a confirm waited for both.
// Now the in flight read starts with the replay and is USED where it always was: a
// replay still answers first, a refusal between them still refuses first, and a
// failure of the early read surfaces only where the confirm would have read it.
//
// No wall clock: the overlap is shown by holding the replay read open and turning
// the event loop, which only lets already started work run.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-opening-reads.ts
import { createBooking } from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** One turn of the event loop: lets started work run, waits on no timer. */
const turn = () => new Promise<void>((r) => setImmediate(r));

let unhandled: unknown[] = [];
process.on("unhandledRejection", (err) => {
  unhandled.push(err);
});

async function main() {
  // --- the in flight read starts while the replay read is still out --------------------------
  {
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    let releaseReplay!: () => void;
    const replayHeld = new Promise<void>((r) => (releaseReplay = r));
    const replay = made.deps.findBookingByIdempotencyKey;
    let replayCalls = 0;
    made.deps.findBookingByIdempotencyKey = async function (this: unknown, key: string) {
      replayCalls++;
      if (replayCalls === 1) await replayHeld;
      return replay.call(this, key);
    };
    let inFlightCalls = 0;
    const inFlight = made.deps.loadReservationByKey;
    made.deps.loadReservationByKey = async function (this: unknown, key: string) {
      inFlightCalls++;
      return inFlight.call(this, key);
    };
    const done = createBooking(input, made.deps);
    for (let i = 0; i < 5; i++) await turn();
    assert(replayCalls === 1 && inFlightCalls === 1, `with the replay read still held open, the in flight read has already been made (replay ${replayCalls}, in flight ${inFlightCalls})`);
    releaseReplay();
    const res = await done;
    assert(res.booking.id === "bk-new", `and the confirm books as before (got ${res.booking.id})`);
    assert(inFlightCalls === 1, `the in flight read is made once (got ${inFlightCalls})`);
  }

  // --- a replay still answers first, and a failed early read is never an unhandled error ------
  {
    unhandled = [];
    const existing = makeBooking({ id: "bk-existing", manage_token: "tok-existing" });
    const made = makeDeps({ existingByKey: existing });
    made.deps.loadReservationByKey = async () => {
      throw new Error("in flight read failed");
    };
    const res = await createBooking(input, made.deps);
    await turn();
    assert(res.booking.id === "bk-existing", `a replay is answered with the existing booking (got ${res.booking.id})`);
    assert(unhandled.length === 0, `the abandoned in flight read's failure is not left unhandled (got ${unhandled.length})`);
  }

  // --- a refusal between the two still refuses first ----------------------------------------
  {
    unhandled = [];
    const made = makeDeps({ unknownBucket: true });
    made.deps.loadReservationByKey = async () => {
      throw new Error("in flight read failed");
    };
    let threw: unknown = null;
    try {
      await createBooking(input, made.deps);
    } catch (err) {
      threw = err;
    }
    await turn();
    assert(threw instanceof Error && !/in flight read failed/.test(threw.message), `the bucket refusal is what the lead gets, not the early read's failure (got ${String(threw)})`);
    assert(unhandled.length === 0, `and the early read's failure is not left unhandled (got ${unhandled.length})`);
  }

  // --- with nothing before it, the early read's failure fails the confirm where it always did --
  {
    unhandled = [];
    const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    made.deps.loadReservationByKey = async () => {
      throw new Error("in flight read failed");
    };
    let threw: unknown = null;
    try {
      await createBooking(input, made.deps);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && /in flight read failed/.test(threw.message), `a failed in flight read still fails the confirm (got ${String(threw)})`);
    assert(made.calls.createEvent.length === 0, "before anything is written to a calendar");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
