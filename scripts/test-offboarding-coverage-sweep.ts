// #1241: when the offboarding automation deactivates an agent by API, their
// upcoming appointments move on their own. Two pure decisions carry that, and both
// are here because both fail SILENTLY if they are wrong.
//
//   planOffboardingCoverageSweep  which lifecycle outcomes sweep, and with what
//                                 idempotency key. A key that is not stable across
//                                 a retry makes the database constraint useless and
//                                 a second sweep appears; a plan returned for the
//                                 admin UI path would auto move a customer's
//                                 appointment where a human was asked to confirm.
//
//   coverageSweepActor            who is accountable for a sweep's moves. The drain
//                                 refuses a job with no actor, deliberately. A
//                                 system triggered sweep legitimately has none, and
//                                 the ONLY thing separating it from an actor that
//                                 was lost by accident is the recorded reason for
//                                 having none.
//
// Pure-with-fakes → node harness (no module mocking).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-offboarding-coverage-sweep.ts
import { planOffboardingCoverageSweep } from "../src/lib/offboarding/coverage-trigger.ts";
import { coverageSweepActor } from "../src/lib/booking/coverage-sweep-actor.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const STAMP = "2026-08-31T14:00:00.000Z";

// --- which outcomes sweep -------------------------------------------------
{
  const plan = planOffboardingCoverageSweep({
    action: "deactivate",
    userId: "u1",
    deactivatedAtIso: STAMP,
  });
  assert(plan !== null, "a deactivation through the automation endpoint sweeps");
  eq(plan?.outUserId, "u1", "the sweep is for the agent who left");
  eq(plan?.deactivatedAtIso, STAMP, "the deactivation stamp is the sweep's window start");
}

{
  // The retry case. The stamp is the row's stored deactivated_at, not a fresh
  // clock read, so a second call carries the SAME key and the unique index on
  // (out_user_id, offboarding_deactivated_at) settles it into one sweep. A plan
  // keyed on "now" would produce a new key per call and the constraint would never
  // fire (L186: a record that stops an action repeating is only as durable as its key).
  const first = planOffboardingCoverageSweep({
    action: "deactivate",
    userId: "u1",
    deactivatedAtIso: STAMP,
  });
  const retry = planOffboardingCoverageSweep({
    action: "deactivate",
    userId: "u1",
    deactivatedAtIso: STAMP,
  });
  eq(retry?.deactivatedAtIso, first?.deactivatedAtIso, "a retry carries the same idempotency key");
}

{
  // #1219's decision, made explicit rather than left as an accident: appointments
  // moved while the agent was away STAY moved. Reactivation is not an undo.
  eq(
    planOffboardingCoverageSweep({ action: "reactivate", userId: "u1", deactivatedAtIso: null }),
    null,
    "reactivating never sweeps, so nothing that was moved is moved back",
  );
  eq(
    planOffboardingCoverageSweep({ action: "reactivate", userId: "u1", deactivatedAtIso: STAMP }),
    null,
    "reactivating never sweeps even while a stamp is still on the row",
  );
}

{
  eq(
    planOffboardingCoverageSweep({ action: "deactivate", userId: null, deactivatedAtIso: STAMP }),
    null,
    "an unknown user (not_found) sweeps nothing",
  );
  eq(
    planOffboardingCoverageSweep({ action: "deactivate", userId: "u1", deactivatedAtIso: null }),
    null,
    "a user who ended the call NOT deactivated sweeps nothing",
  );
  eq(
    planOffboardingCoverageSweep({ action: "deactivate", userId: "u1", deactivatedAtIso: "   " }),
    null,
    "a blank stamp is not a key, so it sweeps nothing rather than keying on empty",
  );
}

// --- who is accountable for the moves -------------------------------------
{
  const actor = coverageSweepActor({
    created_by: "admin1",
    acting_as_user_id: null,
    offboarding_deactivated_at: null,
  });
  eq(actor.kind, "staff", "an admin started sweep moves bookings as that admin");
  eq(actor.kind === "staff" ? actor.userId : null, "admin1", "the accountable user is carried through");
}

{
  const actor = coverageSweepActor({
    created_by: "admin1",
    acting_as_user_id: "agent7",
    offboarding_deactivated_at: null,
  });
  eq(
    actor.kind === "staff" ? actor.actingAsUserId : null,
    "agent7",
    "impersonation is carried through, so the audit trail keeps both people",
  );
}

{
  const actor = coverageSweepActor({
    created_by: null,
    acting_as_user_id: null,
    offboarding_deactivated_at: STAMP,
  });
  eq(
    actor.kind,
    "system",
    "an offboarding triggered sweep has no human actor and says so, rather than borrowing one",
  );
}

{
  // The guard that must NOT be weakened by the line above. A job with no actor and
  // no recorded reason for having none is an actor lost by accident, and moving a
  // customer's appointment on it would be an unaccountable change (L93: a fallback
  // only chooses which defect to ship).
  let threw = "";
  try {
    coverageSweepActor({
      created_by: null,
      acting_as_user_id: null,
      offboarding_deactivated_at: null,
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(
    /accountable actor/.test(threw),
    `a sweep with neither an actor nor a reason for having none is refused (got: ${threw || "no throw"})`,
  );
}

{
  // A staff actor wins even on an offboarding job: if somebody is recorded, the
  // move is theirs.
  const actor = coverageSweepActor({
    created_by: "admin1",
    acting_as_user_id: null,
    offboarding_deactivated_at: STAMP,
  });
  eq(actor.kind, "staff", "a recorded actor is never downgraded to a system move");
}

finish();
