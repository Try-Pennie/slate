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
  idFilterBytes,
  chunkIdsByUrlBudget,
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

// --- #1268: keys that are NOT uuids -------------------------------------------------
//
// `inFilterBytes` above assumes 36-character uuids. Google event ids are not uuids
// and are not one length: measured in production, `bookings.gcal_event_id` averages
// 67 characters, and #1268 measured `busy_blocks.gcal_event_id` at 43 on average
// reaching 181. A batch SIZE calibrated on one of those numbers is wrong for the
// others, and the 181-character outliers make any average optimistic exactly when a
// calendar is unusual.
//
// So the chunker measures the ids it is actually given rather than assuming a length.
// Nothing has to be recalibrated when a key type changes, which is the whole failure
// this file already records: 500 was copied from a 27-character precedent onto
// 36-character uuids and shipped broken.
{
  const ids = (n: number, len: number) =>
    Array.from({ length: n }, (_, i) => String(i).padStart(len, "a"));

  const fits = (chunk: string[]) => idFilterBytes(chunk) <= MAX_IN_FILTER_BYTES;

  // Google event ids at the average measured in busy_blocks (#1268).
  {
    const chunks = chunkIdsByUrlBudget(ids(1000, 43));
    assert(chunks.every(fits), "every chunk of 43-character ids fits the byte ceiling");
    eq(chunks.flat().length, 1000, "no id is dropped");
    eq(new Set(chunks.flat()).size, 1000, "and none is duplicated");
    assert(
      chunks[0].length < 500,
      `a chunk of 43-character ids is smaller than the 500 that fails (got ${chunks[0].length})`,
    );
  }

  // The worst case measured in production: 181 characters. A count tuned for the
  // average would send roughly four times too many bytes here.
  {
    const chunks = chunkIdsByUrlBudget(ids(500, 181));
    assert(chunks.every(fits), "every chunk of 181-character ids fits too, without retuning");
    assert(
      chunks[0].length < chunkIdsByUrlBudget(ids(500, 43))[0].length,
      "a longer id yields a SMALLER chunk, because bytes are what is being budgeted",
    );
  }

  // Slate's own event ids, measured at 67 characters on bookings.
  assert(
    chunkIdsByUrlBudget(ids(1000, 67)).every(fits),
    "every chunk of 67-character Slate event ids fits the byte ceiling",
  );

  // Degenerate inputs. A single id past the whole budget must still be ATTEMPTED in a
  // chunk of its own: dropping it would silently leave a stale block behind, and
  // refusing to emit it would loop forever.
  {
    eq(chunkIdsByUrlBudget([]).length, 0, "no ids means no requests");
    const huge = "x".repeat(MAX_IN_FILTER_BYTES * 2);
    const chunks = chunkIdsByUrlBudget([huge, "short"]);
    assert(
      chunks.some((c) => c.length === 1 && c[0] === huge),
      "an id larger than the entire budget gets its own chunk rather than being dropped",
    );
    eq(chunks.flat().length, 2, "and the ids around it are still sent");
  }

  // Positive control: the guard has to CATCH the shape that fails. A 500-id batch of
  // real-length Google event ids must be over the ceiling, or none of the above means
  // anything.
  assert(
    idFilterBytes(ids(500, 43)) > MAX_IN_FILTER_BYTES,
    `500 ids at the measured 43-character average (${idFilterBytes(ids(500, 43))} bytes) is over the ceiling`,
  );
  assert(
    idFilterBytes(ids(500, 43)) >= MEASURED_REFUSED_BYTES,
    "and it is past the size production actually refused, so the control matches reality",
  );

  // The two estimators must agree on uuids, or the uuid callers and the byte-aware
  // ones are budgeting against different rulers.
  {
    const uuids = ids(200, 36);
    const drift = Math.abs(idFilterBytes(uuids) - inFilterBytes(200));
    assert(drift <= 10, `both estimators size 200 uuids the same (drift ${drift} bytes)`);
  }
}

finish();
