// Unit test (#2373) for the one place a gated booking write is classified.
//
// THE DEFECT. `claimCancellation`, `commitReschedule` and the gated claims beside
// them read only `data` and returned `data.length > 0`, so a failed UPDATE and a
// lost race produced the SAME answer. On the cancel path that answer is false,
// which the route reported as `{ ok: true }`: the lead read "Your call is
// cancelled" while the booking, the Google invite and the advisor's slot all
// stood (L12, L260).
//
// The two causes send two different people to do two different things, so they
// have to be two outcomes, decided once, in one place, and read by everybody
// through that classification rather than re-derived from an error string (L35).
//
// Both causes are driven here, and each is asserted to produce its OWN outcome:
// a control that only drove one of them would be satisfied by a classifier
// hard-wired to a single answer (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-gated-write.ts
import {
  BookingWriteFailedError,
  GATED_WRITE_CAUSES,
  classifyGatedWrite,
  gatedWriteRows,
  isBookingWriteFailure,
} from "@/lib/booking/gated-write";
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";
import { assert, eq, fail, finish } from "./lib/harness.ts";

// --- the classification itself ------------------------------------------------

{
  const applied = classifyGatedWrite<{ id: string }>({
    data: [{ id: "b1" }],
    error: null,
  });
  eq(applied.cause, "applied", "rows returned means THIS write made the transition");
  eq(
    applied.cause === "applied" ? applied.rows.map((r) => r.id).join(",") : "",
    "b1",
    "and the rows it transitioned are carried, so a batch can fire for exactly those",
  );
}

{
  const raced = classifyGatedWrite<{ id: string }>({ data: [], error: null });
  eq(raced.cause, "lost_race", "zero rows with no error is somebody else getting there first");
}

{
  // PostgREST answers a refused statement with a null `data` AND an error. The
  // null alone used to be indistinguishable from the empty array above, which is
  // the whole defect.
  const failed = classifyGatedWrite<{ id: string }>({
    data: null,
    error: { message: 'column "status" does not exist' },
  });
  eq(failed.cause, "write_failed", "an error is the write not running, never a lost race");
  assert(
    failed.cause === "write_failed" && failed.reason.includes("does not exist"),
    "and the reason travels for the log, separately from what the lead is told",
  );
}

{
  // The two causes are DISTINCT, which is the property the issue is about. Asserted
  // directly rather than inferred from the two cases above passing separately.
  const raced = classifyGatedWrite<{ id: string }>({ data: [], error: null });
  const failed = classifyGatedWrite<{ id: string }>({
    data: null,
    error: { message: "statement timeout" },
  });
  assert(
    raced.cause !== failed.cause,
    "a lost race and a failed write never share an outcome, so neither answers for the other",
  );
  eq(
    GATED_WRITE_CAUSES.filter((c) => c === raced.cause || c === failed.cause).length,
    2,
    "and both are named in the one list every reader branches on",
  );
}

{
  // A null `data` with NO error is the same nothing-happened as an empty array.
  // It must not read as a failure, or an ordinary lost race would page.
  const none = classifyGatedWrite<{ id: string }>({ data: null, error: null });
  eq(none.cause, "lost_race", "no rows and no error is still just a lost race");
}

// --- what a caller gets -------------------------------------------------------

{
  const rows = gatedWriteRows("cancel_claim", { data: [{ id: "b1" }], error: null });
  eq(rows?.length ?? -1, 1, "an applied write hands its rows back");
  eq(
    gatedWriteRows("cancel_claim", { data: [], error: null }),
    null,
    "a lost race is null: the caller's own no-op, not an error anybody is paged about",
  );
}

{
  try {
    gatedWriteRows("cancel_claim", { data: null, error: { message: "permission denied" } });
    fail("a failed write throws rather than reporting a lost race");
  } catch (err) {
    assert(isBookingWriteFailure(err), "and it throws the one classified failure type");
    const e = err as BookingWriteFailedError;
    eq(e.op, "cancel_claim", "which names the write that failed, for the log");
    assert(
      e.reason.includes("permission denied"),
      "and carries the database's own reason, for the log and never for the lead",
    );
    assert(
      !e.message.includes("permission denied"),
      "the sentence the lead reads never carries the raw database text (#1133)",
    );
  }
}

{
  // Every reader branches on the CLASSIFICATION, so the predicate must be the
  // thing they call, and it must not be satisfied by any other error.
  assert(
    !isBookingWriteFailure(new Error("That time is no longer available.")),
    "an ordinary domain error is not a write failure, however it is worded",
  );
  assert(!isBookingWriteFailure(null), "nor is nothing at all");
}

// --- the lead's sentence lives in the copy builder ----------------------------

{
  const e = new BookingWriteFailedError("reschedule_commit", "statement timeout");
  eq(
    e.message,
    BOOKING_ERROR_COPY.writeFailed,
    "the lead reads the copy builder's sentence, so `pnpm preview:booker` renders what ships (L41)",
  );
  assert(
    !/pick another|another time/i.test(e.message),
    "and it never names an action the lead cannot take: nothing they choose repairs a failed write",
  );
  assert(
    /nothing/i.test(e.message),
    "it states that nothing changed, which is the fact the old shared message got wrong",
  );
}

finish();
