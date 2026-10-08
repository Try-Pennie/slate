// A confirm whose walk STANDS is refused only when nothing about the person says
// otherwise, and a bucket move never walks past claims at all (#3529).
//
// A walker that met a rung every advisor of which was claimed parks in its line, and
// when every claim it walked past has since booked the line hands it back marked
// `spent`: its own walk proves the ladder full, so it refuses at once rather than walk
// the ladder again (#3489 step 3). Two things the manual review of #3522 found that
// refusal could not see:
//
//  - a same instant bucket MOVE (#1465, a re-tiered lead confirming the time they
//    hold) walked past claims like a new booking, though `ClaimPlace.canWalk` says a
//    move never does. Parked and handed back spent, it answered the lead 409 where the
//    move's own rule answers `deduped` with the change declined.
//  - the refusal ran no person check. Every other refusal the line hands a confirm
//    first asks whether this person already sits at the instant (a double submit whose
//    first copy just booked), and answers them from their own booking.
//
// The line here is scripted: the first turn's seat reports every claimed rung spent to
// a walker, and a park hands back a turn marked spent. That reaches the branch on every
// run, where a timed crowd reaches it only inside a window two reads wide.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-line-walk-stands.ts
import { bookViaApi, type ApiBookingInput, type BookingDeps } from "../src/lib/booking/orchestration.ts";
import type { ClaimPlace, LeaderVerdict, LineTurn, SharedSeat } from "../src/lib/booking/confirm-queue.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { bucket, createAsserter, eventType, input, makeBooking, makeDeps } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** A line whose first turn finds every rung claimed to a walker, and whose park hands back a spent turn. */
function scriptedLine(onPark: () => void = () => {}) {
  const places: (ClaimPlace | undefined)[] = [];
  const reports: LeaderVerdict<unknown>[] = [];
  let parks = 0;
  const seat = (claimedToWalkers: boolean): SharedSeat => ({
    claimedByOthers: async () => new Set<string>(),
    claim: async () => {},
    claimFirst: async (candidates, place) => {
      places.push(place);
      if (claimedToWalkers && place?.canWalk && candidates.length > 0) return { pool: [], unclaimed: 0, spent: true };
      return { pool: [...candidates], unclaimed: candidates.length };
    },
    trying: async () => {},
    claimBeside: async () => {},
    pass: async () => {},
  });
  const turn = (spent: boolean): LineTurn<unknown> => ({
    kind: "lead",
    queued: spent,
    seat: seat(!spent),
    waiting: async () => 0,
    done: async (verdict) => {
      reports.push(verdict);
    },
    park: async () => {
      parks++;
      onPark();
      return turn(true);
    },
    ...(spent ? { spent: true as const } : {}),
  });
  const line = {
    enter: async () => turn(false),
    lookahead: async () => null,
    release: async () => {},
  } as unknown as BookingDeps["confirmQueue"];
  return { line, places, reports, parks: () => parks };
}

type Answer = { outcome?: string; booking?: Booking; bucketChangeDeclined?: string };
async function answer(p: Promise<unknown>): Promise<{ result?: Answer; err?: unknown }> {
  try {
    return { result: (await p) as Answer };
  } catch (err) {
    return { err };
  }
}

async function main() {
  // --- a same instant bucket move never walks past claims ----------------------------
  {
    const existing = makeBooking({ id: "bk-existing", external_id: "ext-1", bucket_id: "bkt-OLD", manage_token: "tokX", starts_at: input.startIso });
    const scripted = scriptedLine();
    const { deps } = makeDeps({
      personBookings: [existing],
      existing: { booking: existing, bucket, eventType },
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
    });
    const got = await answer(bookViaApi({ ...input, externalId: "ext-1", confirmReschedule: false } as ApiBookingInput, { ...deps, confirmQueue: scripted.line }));
    assert(
      got.err === undefined && (got.result?.outcome === "rescheduled" || got.result?.outcome === "deduped"),
      `move: the lead is moved or keeps their call, never refused (got ${got.result?.outcome ?? String(got.err)})`,
    );
    assert(scripted.places.length > 0, "move: the move did claim an advisor in the line (the check below looked at something)");
    assert(
      scripted.places.every((p) => p?.canWalk !== true),
      `move: no claim the move makes asks to walk past claims (got ${JSON.stringify(scripted.places)})`,
    );
    assert(scripted.parks() === 0, "move: so it never parks");
  }

  // --- a walk that stands asks first whether the person already holds the time -------
  //
  // The lead's first decision is a fresh booking; its walk finds the ladder claimed and
  // parks. While it waits, their other submit books the time. The line hands it back
  // spent, and the answer must be the call they hold, never "taken".
  {
    const personBookings: Booking[] = [];
    const theirs = makeBooking({ id: "bk-theirs", external_id: input.externalId ?? "ext-k", bucket_id: bucket.id, assigned_user_id: "a", starts_at: input.startIso });
    const scripted = scriptedLine(() => personBookings.push(theirs));
    const { deps } = makeDeps({ personBookings, candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const got = await answer(bookViaApi({ ...input, confirmReschedule: false } as ApiBookingInput, { ...deps, confirmQueue: scripted.line }));
    assert(scripted.parks() === 1, `stands: the walk parked once (got ${scripted.parks()})`);
    assert(
      got.err === undefined && got.result?.outcome === "deduped" && got.result.booking?.id === "bk-theirs",
      `stands: the lead is answered with the call they now hold (got ${got.result?.outcome ?? String(got.err)})`,
    );
  }

  // Control (L159): the same spent hand back with nobody of theirs at the instant still
  // refuses at once, so the case above passes for the person check and not because a
  // spent turn stopped refusing.
  {
    const scripted = scriptedLine();
    const { deps } = makeDeps({ personBookings: [], candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const got = await answer(bookViaApi({ ...input, confirmReschedule: false } as ApiBookingInput, { ...deps, confirmQueue: scripted.line }));
    assert(scripted.parks() === 1, `stands control: the walk parked once (got ${scripted.parks()})`);
    assert(got.err !== undefined && got.result === undefined, `stands control: nobody of theirs holds the time, so the walk stands and refuses (got ${got.result?.outcome ?? String(got.err)})`);
    assert(scripted.reports.length === 1 && scripted.reports[0]?.full === true, `stands control: and tells the line the ladder is full (got ${JSON.stringify(scripted.reports)})`);
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
