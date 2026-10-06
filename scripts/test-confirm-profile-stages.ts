// A confirm charges its stages and its ladder rungs to the request's profile (#3300).
//
// On 2026-10-06 a confirm for bucket 112 answered 503 after 14.7 seconds, and the
// only thing the log could say was the total. This drives the real createBooking
// with the request's profile handed in, as the route hands it, and asserts what the
// profile then knows: the wait in the confirm line, the stages, every rung walked in
// order with its time, and the rung a deadline struck in. The clock is a counter the
// fakes move, so nothing here waits for real time (L524).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-profile-stages.ts
import { createBooking, bookViaApi, rescheduleBooking } from "../src/lib/booking/orchestration.ts";
import { makeConfirmProfile } from "../src/lib/booking/confirm-profile.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { bucket, createAsserter, eventType, input, makeBooking, makeDeps, NOW, RR } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function main() {
  // --- a confirm that drops two tiers: every rung walked, in order, with its time --
  {
    let t = 0;
    const { deps } = makeDeps({ candidatesByCode: { "411": [], "311": [], "211": ["a"] } });
    const profile = makeConfirmProfile({ now: () => t, startedAt: 0 });
    // Each rung's candidate read costs time on the profile's clock.
    const read = deps.roundRobinCandidates;
    deps.roundRobinCandidates = async (...args) => {
      t += args[0].code === "411" ? 4_000 : 1_000;
      return read(...args);
    };
    const result = await createBooking(input, { ...deps, profile });
    assert(result.booking.bucket_id !== undefined, "tier drop: the confirm booked");
    const r = profile.read(t);
    assert(
      JSON.stringify(r.rungs) === JSON.stringify([{ code: "411", ms: 4_000 }, { code: "311", ms: 1_000 }, { code: "211", ms: 1_000 }]),
      `tier drop: every rung walked, in ladder order, with its own time (got ${JSON.stringify(r.rungs)})`,
    );
    const names = r.stages.map((s) => s.stage);
    for (const want of ["confirm-line", "line-report", "assign-and-verify", "reserve", "complete-reservation", "load-advisor"]) {
      assert(names.includes(want), `tier drop: the ${want} stage is on the profile (got ${names.join(",")})`);
    }
    const assign = r.stages.find((s) => s.stage === "assign-and-verify");
    assert(assign?.ms === 6_000, `tier drop: the ladder's time is inside assign-and-verify (got ${assign?.ms})`);
    assert(r.stagedMs === 6_000 && r.unattributed.totalMs === 0, `tier drop: rungs are never counted twice (staged ${r.stagedMs})`);
  }

  // --- a deadline in the first rung's read: that rung is charged, the error unchanged --
  {
    let t = 0;
    const { deps } = makeDeps({ candidates: ["a"] });
    const profile = makeConfirmProfile({ now: () => t, startedAt: 0 });
    deps.roundRobinCandidates = async () => {
      t += 11_900;
      throw new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 });
    };
    let thrown: unknown = null;
    try {
      await createBooking({ ...input, salesforceId: "00QUi00000zhEUPMA2" }, { ...deps, profile });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof DeadlineExceededError, `deadline: the error leaves exactly as it was thrown (got ${String(thrown)})`);
    const r = profile.read(t);
    assert(
      JSON.stringify(r.rungs) === JSON.stringify([{ code: "411", ms: 11_900 }]),
      `deadline: the rung it struck in, with the time it took (got ${JSON.stringify(r.rungs)})`,
    );
    assert(r.stages.some((s) => s.stage === "assign-and-verify" && s.ms === 11_900), "deadline: the stage it struck in");
  }

  // --- the direct booking API: the person decision and the line are stages too ------
  {
    const t = 0;
    const { deps } = makeDeps({ candidates: ["a"] });
    const profile = makeConfirmProfile({ now: () => t, startedAt: 0 });
    await bookViaApi({ ...input }, { ...deps, profile });
    const names = profile.read(t).stages.map((s) => s.stage);
    for (const want of ["confirm-line", "person-decision", "assign-and-verify"]) {
      assert(names.includes(want), `api: the ${want} stage is on the profile (got ${names.join(",")})`);
    }
  }

  // --- #3401: a time change names its lead, off the booking it loads --------------
  {
    const ctx = { booking: makeBooking({ salesforce_id: "00QUi00000zhEUPMA2", assigned_user_id: "a" }), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, bookingById: ctx, candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const told: (string | null)[] = [];
    try {
      await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", { ...deps, noteLeadId: (id) => told.push(id) }, NOW);
    } catch {
      // Whatever the move answers, the lead was named once the booking loaded.
    }
    assert(JSON.stringify(told) === JSON.stringify(["00QUi00000zhEUP"]), `move: the booking's lead, 15 character key (got ${JSON.stringify(told)})`);

    // A booking with no lead id names nobody, rather than a guess.
    const bare = { booking: makeBooking({ salesforce_id: null, external_id: null, assigned_user_id: "a" }), bucket, eventType };
    const { deps: d2 } = makeDeps({ existing: bare, bookingById: bare, candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const told2: (string | null)[] = [];
    try {
      await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", { ...d2, noteLeadId: (id) => told2.push(id) }, NOW);
    } catch {
      // as above
    }
    assert(JSON.stringify(told2) === JSON.stringify([null]), `move: no lead id is said as none (got ${JSON.stringify(told2)})`);
  }

  // --- with no request profile, the confirm runs exactly as before ---------------
  {
    const { deps } = makeDeps({ candidates: ["a"] });
    const result = await createBooking(input, deps);
    assert(result.booking.assigned_user_id === "a", "no profile: books as it always did");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
