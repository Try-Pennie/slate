import { unwrap, unwrapCount } from "../src/lib/db/result.ts";
import { assert, finish } from "./lib/harness.ts";

// Success: error is null -> return the data through unchanged.
assert(
  JSON.stringify(unwrap({ data: [1, 2, 3], error: null }, "pool")) ===
    JSON.stringify([1, 2, 3]),
  "returns the data when there is no error",
);

// Not-found is NOT an error: maybeSingle()/empty selects return data:null with
// error:null, and the caller's own null-handling ('return null'/'?? []') must
// still run. unwrap only fails loud on a real query error, never on absence.
assert(
  unwrap({ data: null, error: null }, "bucket") === null,
  "returns null (not found) without throwing when there is no error",
);

// Failure: a real query error (e.g. the missing-column case during the 0037
// incident) must THROW, not silently degrade to an empty pool (#277).
{
  let threw = false;
  let message = "";
  try {
    unwrap({ data: null, error: { message: "column users.foo does not exist" } }, "pool");
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "throws when the query returned an error");
  assert(message.includes("pool"), "the thrown error names the read context");
  assert(
    message.includes("column users.foo does not exist"),
    "the thrown error includes the underlying DB message",
  );
}

// --- unwrapCount (#1165): the same fail-loud rule for a count-shaped result ---
// `const { count } = await db.from("t").delete({ count: "exact" })...` reports a
// FAILED delete as `count: null`, which `?? 0` then turns into "0 rows needed
// cleaning": a failure indistinguishable from a healthy no-op. unwrapCount is the
// count-shaped sibling of unwrap so both classes fail loud through one helper.

assert(unwrapCount({ count: 4, error: null }, "prune") === 4, "returns the count when there is no error");

// A null count with no error is "nothing matched", not a failure: PostgREST
// returns no count for a query that asked for none, and the callers treat an
// absent count as zero rows affected.
assert(unwrapCount({ count: null, error: null }, "prune") === 0, "treats a null count with no error as zero");

// Zero is a real answer and must survive: it must not be confused with absence.
assert(unwrapCount({ count: 0, error: null }, "prune") === 0, "returns a genuine zero count");

{
  let threw = false;
  let message = "";
  try {
    unwrapCount({ count: null, error: { message: "permission denied for table busy_blocks" } }, "pool-exit-prune");
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "throws when the count query returned an error");
  assert(message.includes("pool-exit-prune"), "the thrown error names the context");
  assert(
    message.includes("permission denied for table busy_blocks"),
    "the thrown error includes the underlying DB message",
  );
}

finish();
