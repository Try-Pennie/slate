// Unit test for makeSharedInFlight, the one in flight load per key helper (#3123),
// which the roster sync's lock lease uses so concurrent askers share one renewal
// rather than racing each other over the same token (#3177).
//
// Settled by hand driven promises, never by a timer, so no case waits on the clock.
// Run: node --experimental-strip-types scripts/test-shared-in-flight.ts
import { makeSharedInFlight } from "../src/lib/concurrency.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function run() {
  {
    // Callers arriving while a load is pending get the SAME promise, one load.
    const shared = makeSharedInFlight<string, number>();
    const gate = deferred<number>();
    let loads = 0;
    const load = () => {
      loads++;
      return gate.promise;
    };
    const a = shared("k", load);
    const b = shared("k", load);
    eq(loads, 1, "a second caller during a pending load starts no second load");
    assert(a === b, "and is handed the same promise");
    gate.resolve(7);
    eq([await a, await b], [7, 7], "both callers see the one result");
  }
  {
    // Different keys never share.
    const shared = makeSharedInFlight<string, string>();
    let loads = 0;
    const [x, y] = await Promise.all([
      shared("x", async () => (loads++, "x")),
      shared("y", async () => (loads++, "y")),
    ]);
    eq([x, y, loads], ["x", "y", 2], "each key gets its own load");
  }
  {
    // A settled load is forgotten, so the next caller loads afresh.
    const shared = makeSharedInFlight<string, number>();
    let loads = 0;
    await shared("k", async () => ++loads);
    eq(await shared("k", async () => ++loads), 2, "a caller after the load settled starts a new one");
  }
  {
    // A rejection reaches every waiter and is never served to a later caller.
    const shared = makeSharedInFlight<string, number>();
    const gate = deferred<number>();
    const a = shared("k", () => gate.promise);
    const b = shared("k", () => gate.promise);
    gate.reject(new Error("down"));
    const outcomes = await Promise.allSettled([a, b]);
    assert(
      outcomes.every((o) => o.status === "rejected"),
      "every caller sharing a failed load sees the failure",
    );
    eq(await shared("k", async () => 5), 5, "the next caller after a failure retries at once");
  }
  {
    // A load that throws synchronously still becomes a rejection and is still forgotten.
    const shared = makeSharedInFlight<string, number>();
    let caught: unknown;
    try {
      await shared("k", () => {
        throw new Error("sync throw");
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error && caught.message === "sync throw", "a synchronous throw arrives as a rejection");
    eq(await shared("k", async () => 9), 9, "and does not wedge the key");
  }
  finish();
}

run();
