// The id-batch size that keeps a PostgREST `in` filter inside the request-URL limit
// (#1259). This guard exists because the number was got WRONG in code that shipped.
//
// PostgREST puts an `.in("id", ids)` filter in the QUERY STRING, so a batch of ids is
// a URL length problem, not just a row-count one. Measured against the real prod
// PostgREST on 2026-08-04 with 36-character uuids:
//
//     200 ids   7,478 bytes   200 OK
//     250 ids   9,328 bytes   200 OK
//     300 ids  11,178 bytes   200 OK
//     350 ids  13,028 bytes   200 OK
//     400 ids  14,878 bytes   REFUSED (transport failure)
//     450 ids  16,728 bytes   REFUSED
//    1000 ids  37,078 bytes   400 Bad Request
//    2000 ids  74,078 bytes   414 URI Too Long
//
// So the ceiling sits between 13,028 and 14,878 bytes. The batch that shipped in
// PR #1251 was 500 ids (18,578 bytes), which fails on EVERY request: the prune lane
// would have thrown nightly and pruned nothing.
//
// The mistake worth guarding against: 500 was justified by pointing at WRITE_CHUNK
// (500) in google/sync.ts. That constant carries Google event ids of ~27 characters,
// not 36-character uuids, so the precedent did not transfer. This asserts BYTES, the
// quantity that actually decides, rather than a count that looks similar.
import {
  ID_BATCH_ROWS,
  MAX_IN_FILTER_BYTES,
  inFilterBytes,
} from "../src/lib/db/id-batch.ts";
import { BUSY_PRUNE_BATCH_ROWS } from "../src/lib/busy/prune-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** The largest size measured ACCEPTED, and the smallest measured REFUSED. */
const MEASURED_OK_BYTES = 13_028;
const MEASURED_REFUSED_BYTES = 14_878;

// The ceiling must sit inside proven-good territory, not merely under the first
// failure: the limit is a platform detail that could tighten.
assert(
  MAX_IN_FILTER_BYTES <= MEASURED_OK_BYTES,
  `the byte ceiling (${MAX_IN_FILTER_BYTES}) is within the size measured working (${MEASURED_OK_BYTES})`,
);
assert(
  MAX_IN_FILTER_BYTES < MEASURED_REFUSED_BYTES,
  "the byte ceiling is below the smallest size measured refused",
);

// The shipped batch size has to fit under it.
assert(
  inFilterBytes(ID_BATCH_ROWS) <= MAX_IN_FILTER_BYTES,
  `a full batch of ${ID_BATCH_ROWS} uuids (${inFilterBytes(ID_BATCH_ROWS)} bytes) fits the ceiling`,
);

// Positive control: the guard must actually CATCH the value that shipped broken.
// Without this, the assertions above would still pass if the ceiling were raised to
// accommodate a bad batch size, and the guard would be decorative.
assert(
  inFilterBytes(500) > MAX_IN_FILTER_BYTES,
  "500 uuids, the size that shipped and fails in production, is rejected by this guard",
);
assert(
  inFilterBytes(500) >= MEASURED_REFUSED_BYTES,
  "and 500 uuids really is past the size prod refused, so the guard matches reality",
);

// Every batching caller shares one ceiling. A second copy of this number is how the
// two drift apart, and the prune lane is the one that already got it wrong.
assert(
  BUSY_PRUNE_BATCH_ROWS <= ID_BATCH_ROWS,
  `the prune lane's batch (${BUSY_PRUNE_BATCH_ROWS}) does not exceed the shared safe size (${ID_BATCH_ROWS})`,
);

// The estimator itself: a uuid plus its separator, inside the filter envelope. Pinned
// so a future edit cannot quietly make it optimistic.
eq(inFilterBytes(0) >= 0, true, "an empty batch has a non-negative size");
assert(
  inFilterBytes(200) >= 7_000 && inFilterBytes(200) <= 8_000,
  `the estimate for 200 ids (${inFilterBytes(200)}) matches the 7,478 bytes measured`,
);

finish();
