// #3351: the confirm path gives back whatever a lookahead kept for its enter.
//
// On the shared line a lookahead that finds the line idle (a lead) or busy past its
// bound (a ticket) keeps that answer for the `enter` that follows, saving a call. A
// confirm that ends between the two would leave that lead held on the object, and the
// line waits out the ack window behind it. So every exit from the line's entry, the
// normal one included, ends in `release`, which sends nothing once the enter came.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-release.ts
import { bookViaApi, type ApiBookingInput } from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

function watched(deps: ReturnType<typeof makeDeps>["deps"], opts: { enterThrows?: boolean } = {}) {
  const seen: string[] = [];
  const line = deps.confirmQueue;
  deps.confirmQueue = {
    ...line,
    lookahead: async (...a) => {
      seen.push("lookahead");
      return line.lookahead(...a);
    },
    enter: async (...a) => {
      seen.push("enter");
      if (opts.enterThrows) throw new Error("the line could not be entered");
      return line.enter(...a);
    },
    release: async () => {
      seen.push("release");
      return line.release();
    },
  };
  return seen;
}

async function run() {
  // --- a confirm that books releases once, after its enter ------------------------
  {
    const { deps } = makeDeps({ personBookings: [] });
    const seen = watched(deps);
    const res = await bookViaApi({ ...input, externalId: "ext-release", confirmReschedule: false } as ApiBookingInput, deps);
    assert(res.outcome === "created", `the confirm books (got ${res.outcome})`);
    assert(seen.join(",") === "lookahead,enter,release", `the line is released once its enter came (got ${seen.join(",")})`);
  }

  // --- a confirm whose entry fails still releases ---------------------------------
  {
    const { deps } = makeDeps({ personBookings: [] });
    const seen = watched(deps, { enterThrows: true });
    let threw = "";
    try {
      await bookViaApi({ ...input, externalId: "ext-release-throws", confirmReschedule: false } as ApiBookingInput, deps);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert(threw === "the line could not be entered", `the failure still reaches the caller (got ${threw})`);
    assert(seen.includes("release") && seen.indexOf("release") > seen.indexOf("lookahead"), `and whatever the lookahead kept is released (got ${seen.join(",")})`);
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
