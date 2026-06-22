import { unwrap } from "../src/lib/db/result.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

// Success: error is null -> return the data through unchanged.
ok(
  JSON.stringify(unwrap({ data: [1, 2, 3], error: null }, "pool")) ===
    JSON.stringify([1, 2, 3]),
  "returns the data when there is no error",
);

// Not-found is NOT an error: maybeSingle()/empty selects return data:null with
// error:null, and the caller's own null-handling ('return null'/'?? []') must
// still run. unwrap only fails loud on a real query error, never on absence.
ok(
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
  ok(threw, "throws when the query returned an error");
  ok(message.includes("pool"), "the thrown error names the read context");
  ok(
    message.includes("column users.foo does not exist"),
    "the thrown error includes the underlying DB message",
  );
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
