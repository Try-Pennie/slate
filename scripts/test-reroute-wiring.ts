// #1643: two refusals in the reroute's live wiring that no suite could reach.
//
// They lived as single lines inside `realRerouteDeps` in service.ts, a dependency
// object nothing exports, so deleting either one changed nothing any test could see.
// Moved into `src/lib/booking/reroute-wiring.ts` (the #1241 pattern) so they are
// driven here directly.
//
//   readClaimedRerouteHold   the claim RPC always answers one row, so an answer with
//                            none is refused by name rather than read as a claim
//                            with no advisor and no bucket.
//
//   rerouteReassignOutcome   an advisor over their daily cap is the one failure
//                            answered as an outcome (the reroute searches again);
//                            every other failure is thrown on, never read as moved.
//
// Pure-with-fakes, so the node harness (no module mocking).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-wiring.ts
import { readClaimedRerouteHold, rerouteReassignOutcome } from "../src/lib/booking/reroute-wiring.ts";
import { DailyCapExceededError } from "../src/lib/booking/orchestration.ts";
import { RerouteRefusedError } from "../src/lib/booking/reroute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

// --- the claim's row ------------------------------------------------------
{
  for (const [label, rows] of [
    ["an empty list", []],
    ["null", null],
  ] as const) {
    const err = thrown(() => readClaimedRerouteHold(rows, "bk-7"));
    assert(err instanceof Error, `a claim answered with ${label} is refused`);
    eq(
      (err as Error | null)?.message ?? null,
      "claim_reroute_hold returned no row for booking bk-7",
      `the refusal for ${label} names the RPC and the booking, not a TypeError about a missing row`,
    );
  }
}

{
  // CONTROL: the row the RPC answers is read through, a refusal word included.
  eq(
    readClaimedRerouteHold(
      [{ agent_user_id: "u-2", target_bucket_id: "b-2", refused: null, result: null }],
      "bk-7",
    ),
    { refused: null, result: null, agentUserId: "u-2", targetBucketId: "b-2" },
    "a claim that holds reads its advisor and bucket",
  );
  eq(
    readClaimedRerouteHold(
      [{ agent_user_id: null, target_bucket_id: null, refused: "hold_expired", result: null }],
      "bk-7",
    ).refused,
    "hold_expired",
    "a refusal word comes back as itself, for the caller to name",
  );
}

// --- the reassign's outcome -----------------------------------------------
async function outcomes(): Promise<void> {
  eq(await rerouteReassignOutcome(async () => {}), "moved", "CONTROL: a reassign that lands is a move");

  eq(
    await rerouteReassignOutcome(async () => {
      throw new DailyCapExceededError("sam@trypennie.com", "2026-10-20");
    }),
    "over_cap",
    "an advisor at their daily cap is answered as over_cap, so the reroute searches again",
  );

  // Every other failure propagates as itself. The reroute reads a hold that ran out
  // off the thrown error's class and code, so a swallowed error would lose that too.
  const expired = new RerouteRefusedError("hold_expired");
  let caught: unknown = null;
  let answered: unknown = null;
  try {
    answered = await rerouteReassignOutcome(async () => {
      throw expired;
    });
  } catch (err) {
    caught = err;
  }
  eq(answered, null, "a failed reassign is never answered as an outcome");
  assert(caught === expired, "a failed reassign throws the SAME error on, so its class and code survive");

  const boom = new Error("reassign_booking_swap failed for booking bk-7: deadlock detected");
  caught = null;
  try {
    await rerouteReassignOutcome(async () => {
      throw boom;
    });
  } catch (err) {
    caught = err;
  }
  assert(caught === boom, "an ordinary failure is thrown on too, never read as moved");
}

await outcomes();
finish();
